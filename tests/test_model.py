"""Model invariants on fixture databases only; no network or production cache access."""
import copy
import io
import json
import math
import random
import subprocess
import sys
import tempfile
import unittest
import zlib
from collections.abc import Callable, Sequence
from contextlib import ExitStack, closing
from pathlib import Path
from unittest import mock

import test_data

import model
import store
import timeline

START = 1_000_000
STEP = 2_000_000
NOW = 500_000


def digest(blue_lead_per_min=0, winner=100, minutes=25):
    gold = [[1000 + m * 300 + (blue_lead_per_min / 5 * m if i < 5 else 0)
             for i in range(10)] for m in range(minutes)]
    # A negative gold lead must not make any participant's total gold negative.
    if blue_lead_per_min < 0:
        gold = [[1000 + m * 300 + (-blue_lead_per_min / 5 * m if i >= 5 else 0)
                 for i in range(10)] for m in range(minutes)]
    zeros = [[0] * 10 for _ in range(minutes)]
    return {"v": timeline.DIGEST_VERSION, "map_id": 11, "pids": list(range(1, 11)),
            "teams": [100] * 5 + [200] * 5, "puuids": [f"p{i}" for i in range(10)],
            "ts": [m * 60 for m in range(minutes - 1)] + [minutes * 60], "valid": [True] * minutes,
            "gold": gold, "xp": zeros, "cs": zeros, "pos": [[None] * 20 for _ in range(minutes)],
            "kills": [], "monsters": [], "buildings": [], "wards": [], "plates": [],
            "end": minutes * 60, "winner": winner}


def put_digest(db, mid, dg):
    db.execute("INSERT OR REPLACE INTO timeline_digest VALUES (?, ?)",
               (mid, zlib.compress(json.dumps(dg).encode())))


def put_match(db, mid, blue_won, start, lead=0, champions=None, known_players=False, dg=None):
    match = test_data.match_fixture(mid, puuid=f"{mid}-me")
    info = match["info"]
    dg = dg or digest(lead, 100 if blue_won else 200)
    info["gameStartTimestamp"] = start
    info["gameDuration"] = dg["end"]
    for i, player in enumerate(info["participants"]):
        player["win"] = (i < 5) == blue_won
        if champions:
            player["championId"] = champions[i]
        if known_players:
            player["puuid"] = f"known-{i}"
    for team in info["teams"]:
        team["win"] = (team["teamId"] == 100) == blue_won
    store.save_match(db, "FIXTURE", match)
    put_digest(db, mid, dg)


def fill(db, count=80, known_players=False, reverse_holdout=False):
    for k in range(count):
        strong_blue = k % 2 == 0
        blue_won = strong_blue if k % 8 else not strong_blue
        if reverse_holdout and k >= int(count * 0.8):
            blue_won = not blue_won
        champions = [1 if (i < 5) == strong_blue else 2 for i in range(10)]
        put_match(db, f"G{k:03}", blue_won, START + k * STEP,
                  lead=1000 if strong_blue else -1000, champions=champions, known_players=known_players)
    db.commit()


def swap_labels(db, ids):
    for mid in ids:
        db.execute("UPDATE teams SET win = 1 - win WHERE match_id = ?", (mid,))
        db.execute("UPDATE participants SET win = 1 - win WHERE match_id = ?", (mid,))
        row = db.execute("SELECT data FROM timeline_digest WHERE match_id = ?", (mid,)).fetchone()
        dg = json.loads(zlib.decompress(row[0]))
        dg["winner"] = 200 if dg["winner"] == 100 else 100
        put_digest(db, mid, dg)
    db.commit()


def players(known=False):
    return [{"team_id": 100 if i < 5 else 200, "position": model.ROLES[i % 5],
             "champion_id": 1 if i < 5 else 2, **({"puuid": f"known-{i}"} if known else {})}
            for i in range(10)]


def state():
    return {"m": 20, "gold": 4000, "xp": 1000, "towers": [3, 1], "inhibs": [1, 0],
            "dragons": [2, 3], "soul": 1, "baron": [1, 0], "elder": [0, 0],
            "grubs": [3, 0], "heralds": [0, 1], "atakhan": [0, 0]}


def mirror(s):
    out = copy.deepcopy(s)
    out["gold"], out["xp"] = -s["gold"], -s["xp"]
    out["soul"] = None if s["soul"] is None else 1 - s["soul"]
    for key in ("towers", "inhibs", "dragons", "baron", "elder", "grubs", "heralds", "atakhan"):
        out[key] = s[key][::-1]
    return out


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.db = test_data.fixture_db()
        self.addCleanup(self.db.close)
        model._loaded.clear()
        self.addCleanup(model._loaded.clear)
        self.stack.enter_context(mock.patch.object(model, "MIN_GAMES", 50))
        self.stack.enter_context(mock.patch.object(model, "TRAIN_DAYS", 10 ** 6))
        self.stack.enter_context(mock.patch.object(store, "connect", side_effect=AssertionError("Live DB forbidden")))

    def trained(self, trainer: Callable[..., tuple[dict, dict] | None], **kwargs):
        result = trainer(self.db, now=NOW, **kwargs)
        assert result is not None, "Expected enough eligible fixture training data"
        return result

    def train_pregame(self, known=False):
        fill(self.db, known_players=known)
        result = self.trained(model.train_pregame)
        self.assertTrue(result[1]["ready"], result[1].get("reason"))
        return result


class FitTests(unittest.TestCase):
    def test_solve_small_and_singular_systems(self):
        x = model.solve([[2.0, 1.0], [1.0, 3.0]], [5.0, 10.0])
        self.assertAlmostEqual(x[0], 1.0)
        self.assertAlmostEqual(x[1], 3.0)
        self.assertEqual(model.solve([[0.0]], [0.0]), [0.0])
        self.assertEqual(model.solve([], []), [])

    def test_sigmoid_extreme_negative_tail_and_symmetry(self):
        for z in (0, 1, 30, 700, 1000, math.inf):
            self.assertTrue(math.isfinite(model.sigmoid(-z)))
            self.assertAlmostEqual(model.sigmoid(z), 1 - model.sigmoid(-z))
        self.assertEqual(model.sigmoid(-1000), 0)
        with self.assertRaises(ValueError):
            model.sigmoid(math.nan)

    def test_newton_recovers_known_weights(self):
        rng = random.Random(1)
        rows = [(rng.gauss(0, 1), rng.gauss(0, 1)) for _ in range(4000)]
        truth = (0.3, 1.0, -2.0)
        ys = [int(rng.random() < model.sigmoid(truth[0] + truth[1] * a + truth[2] * b)) for a, b in rows]
        for got, want in zip(model.fit(rows, ys, l2=0.01), truth):
            self.assertAlmostEqual(got, want, delta=0.15)

    def test_offsets_and_no_intercept(self):
        rng = random.Random(2)
        rows = [(rng.gauss(0, 1),) for _ in range(3000)]
        offsets = [rng.gauss(0, 1) for _ in rows]
        ys = [int(rng.random() < model.sigmoid(o + 0.8 * x)) for (x,), o in zip(rows, offsets)]
        (beta,) = model.fit(rows, ys, l2=0.01, offsets=offsets, intercept=False)
        self.assertAlmostEqual(beta, 0.8, delta=0.15)

    def test_empty_constant_single_class_and_separable_rows_remain_finite(self):
        self.assertEqual(model.fit([], []), [0.0])
        self.assertEqual(model.fit([], [], intercept=False), [])
        cases: list[tuple[Sequence[tuple[float, ...]], list[int]]] = [
            ([()] * 5, [1] * 5), ([(0, 0)] * 5, [0] * 5),
            ([(1e9, 1)] * 10, [0, 1] * 5),
            ([(-1, -1)] * 20 + [(1, 1)] * 20, [0] * 20 + [1] * 20),
        ]
        for rows, labels in cases:
            w = model.fit(rows, labels, l2=0)
            self.assertTrue(all(math.isfinite(v) for v in w))
            self.assertTrue(all(math.isfinite(model.predict(w, row)) for row in rows))
        self.assertTrue(all(math.isfinite(v) for v in model.fit([(1,), (-1,)], [0, 1], offsets=[-1000, 1000])))

    def test_invalid_fit_or_prediction_inputs_fail_explicitly(self):
        for rows, labels in (([(math.nan,)], [0]), ([(math.inf,)], [1]), ([(1,), (1, 2)], [0, 1]),
                             ([(1,)], []), ([(1,)], [2])):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                model.fit(rows, labels)
        with self.assertRaises(ValueError):
            model.predict([0, 1], (math.nan,))
        with self.assertRaises(ValueError):
            model.predict([1], (1,))

    def test_grade_distinguishes_samples_games_and_calibration(self):
        g = model.grade([0.9, 0.8, 0.2, 0.6], [1, 1, 0, 0], ["a", "a", "b", "b"], baseline_prob=0.25)
        self.assertEqual((g["samples"], g["games"], g["accuracy"]), (4, 2, 0.75))
        self.assertAlmostEqual(g["brier"], (0.01 + 0.04 + 0.04 + 0.36) / 4)
        self.assertEqual(sum(b["samples"] for b in g["calibration"]), 4)
        for b in g["calibration"]:
            self.assertEqual(b["observed"], b["wins"] / b["samples"])
        self.assertAlmostEqual(g["baseline"]["log_loss"], -0.5 * math.log(0.25) - 0.5 * math.log(0.75))
        self.assertEqual(model.grade([], []), {"samples": 0, "games": 0})
        self.assertAlmostEqual(model.grade([0.5] * 4, [1] * 4)["coin_log_loss"], math.log(2),
                               msg="Baseline must not learn the holdout's all-win prevalence")
        self.assertTrue(math.isfinite(model.grade([0, 1], [1, 0])["log_loss"]))


class ChronologyTests(FixtureTests):
    def test_split_groups_equal_starts_and_excludes_unresolved_training_games(self):
        games = [model.Game(f"g{k}", start, start + 50, "16.1", k % 2, {}, {})
                 for k, start in enumerate((100, 200, 300, 400, 500, 600, 700, 800, 800, 900))]
        games[6] = games[6]._replace(end=850)
        train, test, excluded = model._split_games(games)
        self.assertEqual([g.mid for g in test], ["g7", "g8", "g9"])
        self.assertEqual(excluded, 1)
        self.assertTrue(all(g.end < test[0].start for g in train))
        self.assertFalse({g.mid for g in train} & {g.mid for g in test})

    def test_database_order_and_player_groups_are_chronological(self):
        # Insertion/ID order is not the timestamp order.
        for k, mid in enumerate(("z", "a", "y", "b", "x", "c", "w", "d", "v", "e")):
            put_match(self.db, mid, k % 2 == 0, START + k * STEP, known_players=True)
        games = model._games(self.db, 0, NOW * 1000, draft=True)
        train, test, _ = model._split_games(games)
        self.assertEqual([g.mid for g in train], ["z", "a", "y", "b", "x", "c", "w", "d"])
        self.assertEqual([g.mid for g in test], ["v", "e"])
        rows, _, _, _ = model._pregame_rows(train)
        self.assertEqual(len(rows), len(train), "Ten participants are one match observation, not ten split rows")
        self.assertEqual([r[2] for r in rows], [g.mid for g in train])

    def test_training_rows_cannot_see_their_own_future_or_same_start_labels(self):
        fill(self.db)
        games = model._games(self.db, 0, NOW * 1000, draft=True)
        original, _, _, _ = model._pregame_rows(games)
        changed = [g._replace(win=1 - g.win) if k >= 30 else g for k, g in enumerate(games)]
        modified, _, _, _ = model._pregame_rows(changed)
        self.assertEqual([r[0] for r in original[:31]], [r[0] for r in modified[:31]])
        self.assertEqual(original[0][0], (0.0,) * 5)
        pair = [games[0], games[1]._replace(start=games[0].start)]
        tied, _, _, _ = model._pregame_rows(pair)
        self.assertEqual([r[0] for r in tied], [(0.0,) * 5, (0.0,) * 5])
        # A match that started earlier but hasn't ended is not available history.
        overlap = [games[0], games[1]._replace(start=games[0].end)]
        self.assertEqual(model._pregame_rows(overlap)[0][1][0], (0.0,) * 5)

    def test_population_stats_require_cutoff_and_ignore_later_labels(self):
        fill(self.db)
        with self.assertRaises(ValueError):
            model.population_stats(self.db, 0)
        boundary = START + 64 * STEP
        expected = model.population_stats(self.db, 0, boundary)
        swap_labels(self.db, [f"G{k:03}" for k in range(64, 80)])
        self.assertEqual(model.population_stats(self.db, 0, boundary), expected)

    def test_holdout_participant_outcomes_cannot_change_eligibility_or_split(self):
        fill(self.db)
        first = self.trained(model.train_pregame)
        self.db.execute("UPDATE teams SET win = 1 - win WHERE match_id >= 'G064'")
        self.db.commit()
        changed_team_labels = self.trained(model.train_pregame)
        self.assertEqual(first[0]["weights"], changed_team_labels[0]["weights"])
        self.assertEqual(first[0]["training_match_ids"], changed_team_labels[0]["training_match_ids"])
        self.db.execute("UPDATE participants SET win = 1 - win WHERE match_id >= 'G064'")
        self.db.commit()
        changed_player_labels = self.trained(model.train_pregame)
        self.assertEqual(first[0]["weights"], changed_player_labels[0]["weights"])

    def test_game_cap_bounds_lineups_before_participant_loading(self):
        fill(self.db)
        with mock.patch.object(model, "MAX_GAMES", 10):
            games = model._games(self.db, 0, NOW * 1000, draft=True)
        self.assertEqual([g.mid for g in games], [f"G{k:03}" for k in range(70, 80)])


class InGameTests(FixtureTests):
    def test_features_and_predictions_are_symmetric_finite_and_capped(self):
        s = state()
        s["gold"] = 3000
        f = model.ingame_features(s)
        self.assertEqual(f[:4], (3.0, 3.0, 3.0, 1.0))
        self.assertEqual(f[4:], (2, 1, -1, -1, 1, 0, 3, -1, 0))
        fill(self.db)
        params, report = self.trained(model.train_ingame)
        self.assertTrue(report["ready"], report["reason"])
        chance = model.ingame_chance(params)
        assert chance is not None
        self.assertGreater(chance(state()), 0.5)
        self.assertAlmostEqual(chance(state()), 1 - chance(mirror(state())))
        huge = state()
        huge["gold"], huge["xp"] = 1e100, -1e100
        self.assertTrue(math.isfinite(chance(huge)))
        self.assertIsNone(model.ingame_chance(None))
        self.assertIsNone(model.ingame_chance({"weights": [0]}))

    def test_training_weights_and_heldout_predictions_ignore_holdout_labels(self):
        fill(self.db)
        first = self.trained(model.train_ingame)
        swap_labels(self.db, [f"G{k:03}" for k in range(64, 80)])
        second = self.trained(model.train_ingame)
        self.assertEqual(first[0]["weights"], second[0]["weights"])
        self.assertEqual(model.predict(first[0]["weights"], model.ingame_features(state())),
                         model.predict(second[0]["weights"], model.ingame_features(state())))
        self.assertNotEqual(first[1]["overall"]["log_loss"], second[1]["overall"]["log_loss"])
        self.assertFalse(second[1]["ready"])

    def test_final_partial_frame_end_states_and_winner_are_not_features(self):
        dg = digest(minutes=25)
        # Index 24 looks pre-end, but its actual timestamp is the irregular GAME_END frame.
        dg["gold"][-1] = [1e9] * 5 + [0] * 5
        put_match(self.db, "partial", True, START, dg=dg)
        rows = list(model._ingame_rows(self.db, ["partial"]))
        self.assertEqual([r[2] for r in rows], list(range(2, 24, 2)))
        self.assertTrue(all(r[0][0] == 0 for r in rows))
        for winner in (200, None):
            dg["winner"] = winner
            put_digest(self.db, "partial", dg)
            self.assertEqual(rows, list(model._ingame_rows(self.db, ["partial"])))
        dg["end"] = 20 * 60
        put_digest(self.db, "partial", dg)
        self.assertEqual([r[2] for r in model._ingame_rows(self.db, ["partial"])], list(range(2, 20, 2)))
        dg["buildings"] = [[14 * 60, 200, "NEXUS_BUILDING", "MID_LANE", ""]]
        put_digest(self.db, "partial", dg)
        self.assertEqual([r[2] for r in model._ingame_rows(self.db, ["partial"])], list(range(2, 14, 2)))

    def test_corrupt_empty_nonfinite_and_oversized_digests_are_skipped(self):
        put_match(self.db, "bad", True, START)
        for payload in (b"not-zlib", zlib.compress(b"{}"),
                        zlib.compress(b" " * (model.MAX_DIGEST_BYTES + 1)),
                        zlib.compress(json.dumps(digest(minutes=2)).encode())):
            self.db.execute("UPDATE timeline_digest SET data = ? WHERE match_id = 'bad'", (payload,))
            self.assertEqual(list(model._ingame_rows(self.db, ["bad"])), [])
        dg = digest()
        dg["gold"][2][0] = math.nan
        put_digest(self.db, "bad", dg)
        self.assertEqual(list(model._ingame_rows(self.db, ["bad"])), [])
        # A explicitly missing participant counter invalidates just that snapshot, not earlier observations.
        dg["gold"][2][0] = None
        put_digest(self.db, "bad", dg)
        rows = list(model._ingame_rows(self.db, ["bad"]))
        self.assertEqual([r[2] for r in rows], list(range(4, 24, 2)))
        dg["v"] = 1
        put_digest(self.db, "bad", dg)
        self.assertEqual(list(model._ingame_rows(self.db, ["bad"])), [], "Legacy timestamps must not be invented")

    def test_report_calibration_counts_minutes_as_samples_not_games(self):
        fill(self.db)
        _, report = self.trained(model.train_ingame)
        self.assertEqual((report["games"], report["train_games"], report["test_games"]), (80, 64, 16))
        self.assertEqual(report["overall"]["games"], 16)
        self.assertEqual(report["overall"]["samples"], 16 * 11)
        self.assertEqual(report["train_samples"], 64 * 11)
        self.assertEqual(sum(g["samples"] for g in report["by_minute"]), report["test_samples"])
        for g in report["by_minute"]:
            self.assertLess(g["minute"], 24)
            self.assertEqual((g["games"], g["samples"]), (16, 16))
            self.assertEqual(sum(b["samples"] for b in g["calibration"]), g["samples"])
            self.assertTrue(all("observed" in b for b in g["calibration"]))

    def test_reservoir_caps_and_degenerate_training(self):
        fill(self.db)
        _, report = self.trained(model.train_ingame, cap=40)
        self.assertEqual((report["train_samples"], report["test_samples"]), (40, 10))
        self.assertIsNone(model.train_ingame(self.db, now=NOW, cap=0))
        self.db.execute("UPDATE teams SET win = (team_id = 100)")
        self.assertIsNone(model.train_ingame(self.db, now=NOW))

    def test_too_few_games_means_no_model(self):
        put_match(self.db, "only", True, START)
        self.assertIsNone(model.train_ingame(self.db, now=NOW))

    def test_replay_odds_are_labeled_retrospective_even_for_older_stored_v2_models(self):
        fill(self.db)
        params, report = self.trained(model.train_ingame)
        self.assertEqual(params["label"], model.INGAME_LABEL)
        self.assertFalse(report["interpretation"]["historical_prediction"])
        self.assertFalse(report["interpretation"]["independent_story_prediction"])
        self.assertIn("holdout", report["interpretation"]["validation_scope"])
        # Existing v2 weights remain usable, but load adds the caveat without training or writing.
        params.pop("label")
        report.pop("interpretation")
        model.save(self.db, "ingame", (params, report), now=123)
        original_rows = tuple(self.db.execute("SELECT * FROM models WHERE name = 'ingame'").fetchone())
        changes = self.db.total_changes
        with (mock.patch.object(model, "fit", side_effect=AssertionError("Request-time fit forbidden")),
              mock.patch.object(model, "train_all", side_effect=AssertionError("Request-time job forbidden")),
              mock.patch.object(model, "train_ingame", side_effect=AssertionError("Request-time training forbidden")),
              mock.patch.object(model, "train_pregame", side_effect=AssertionError("Request-time training forbidden"))):
            loaded, loaded_report, _ = model.load(self.db, "ingame", ttl=0)
            assert loaded is not None and loaded_report is not None
            self.assertEqual(loaded["label"], model.INGAME_LABEL)
            self.assertEqual(loaded["weights"], params["weights"])
            self.assertEqual(loaded_report["interpretation"], model.INGAME_INTERPRETATION)
            self.assertIsNotNone(model.ingame_chance(loaded))
        self.assertEqual(self.db.total_changes, changes)
        self.assertEqual(tuple(self.db.execute("SELECT * FROM models WHERE name = 'ingame'").fetchone()), original_rows)


class PreGameTests(FixtureTests):
    def test_draft_utility_shrinks_and_mirrors(self):
        lineup = {(team, role): 1 if team == 100 else 2 for team in (100, 200) for role in model.ROLES}
        champ = {("16.1", role, 1): (10, 8) for role in model.ROLES} | {("16.1", role, 2): (10, 2) for role in model.ROLES}
        matchups = {(role, 1, 2): (4, 3) for role in model.ROLES}
        draft, matchup = model.draft_features(lineup, "16.1", champ, matchups)
        self.assertAlmostEqual(draft, 5 * (model._shrunk_logit(8, 10, model.CHAMP_PRIOR)
                                         - model._shrunk_logit(2, 10, model.CHAMP_PRIOR)))
        self.assertAlmostEqual(matchup, 5 * model._shrunk_logit(3, 4, model.MATCHUP_PRIOR))
        flipped = {(300 - team, role): champion for (team, role), champion in lineup.items()}
        self.assertEqual(model.draft_features(flipped, "16.1", champ, matchups), (-draft, -matchup))
        loo, _ = model.draft_features(lineup, "16.1", champ, matchups, own_win=1)
        self.assertAlmostEqual(loo, 5 * (model._shrunk_logit(7, 9, model.CHAMP_PRIOR)
                                       - model._shrunk_logit(2, 9, model.CHAMP_PRIOR)))

    def test_player_features_only_use_strictly_earlier_games(self):
        history = [(1, 7, 1), (2, 7, 1), (3, 8, 0), (5, 7, 0), (9, 7, 0)]
        games, skill, form = model.player_features(history, 7, before=5)
        self.assertAlmostEqual(games, math.log1p(2))
        self.assertAlmostEqual(skill, model._shrunk_logit(2, 2, 6))
        self.assertAlmostEqual(form, model._shrunk_logit(2, 3, 10))

    def test_training_storage_and_prediction_roundtrip(self):
        result = self.train_pregame()
        params, report = result
        self.assertGreater(params["weights"][1], 0)
        self.assertEqual((report["train_samples"], report["test_samples"]), (64, 16))
        self.assertIsNone(params["player_weights"])
        self.assertEqual(sum(row[3] for row in params["champion_counts"]), 640)
        model.save(self.db, "pregame", result, now=123)
        self.assertEqual(model.load(self.db, "pregame")[2], 123)
        self.assertFalse(self.db.in_transaction)
        out = model.pregame_prediction(self.db, players(), "16.1", start_cutoff=NOW * 1000)
        self.assertTrue(out["ready"], out["reason"])
        self.assertGreater(out["blue"], 0.5)
        self.assertAlmostEqual(out["blue"] + out["red"], 1)
        self.assertEqual(out["trained_at"], 123)
        self.assertEqual(out["coverage"]["draft"]["supported_slots"], 10)
        self.assertEqual(out["features"]["used"], model.PREGAME_FEATURES)
        self.assertFalse(self.db.in_transaction, "Inference must close its owned read snapshot")
        # Optional cutoff defaults to now without writing any cached player/model data.
        self.assertTrue(model.pregame_prediction(self.db, players(), "16.1")["ready"])
        self.assertEqual(model.scorecards(self.db)["pregame"]["report"], report)

    def test_holdout_labels_do_not_change_weights_counts_offsets_or_inference(self):
        with mock.patch.object(model, "PLAYER_MIN_GAMES", 5):
            first = self.train_pregame(known=True)
            self.assertIsNotNone(first[0]["player_weights"])
            model.save(self.db, "pregame", first, now=123)
            before = model.pregame_prediction(self.db, players(known=True), "16.1", start_cutoff=NOW * 1000)
            swap_labels(self.db, [f"G{k:03}" for k in range(64, 80)])
            after = model.pregame_prediction(self.db, players(known=True), "16.1", start_cutoff=NOW * 1000)
            second = self.trained(model.train_pregame)
        self.assertEqual(before["blue"], after["blue"])
        self.assertEqual(before["features"], after["features"])
        for key in ("weights", "player_weights", "champion_counts", "matchup_counts", "training_match_ids"):
            self.assertEqual(first[0][key], second[0][key], key)
        self.assertNotEqual(first[1]["overall"]["log_loss"], second[1]["overall"]["log_loss"])
        self.assertEqual(first[1]["players"]["train_samples"], 59)
        self.assertEqual(first[1]["players"]["test_games_with_history"], 16)
        self.assertFalse(second[1]["ready"])
        model.save(self.db, "pregame", second, now=124)
        self.assertIsNone(model.load(self.db, "pregame")[0], "Rejected weights must not be published")

    def test_team_swap_complements_prediction_even_with_partial_known_history(self):
        with mock.patch.object(model, "PLAYER_MIN_GAMES", 5):
            result = self.train_pregame(known=True)
            model.save(self.db, "pregame", result, now=123)
            known = players(known=True)
            known[0].pop("puuid")
            flipped = [{**p, "team_id": 300 - p["team_id"]} for p in known]
            a = model.pregame_prediction(self.db, known, "16.1", start_cutoff=NOW * 1000)
            b = model.pregame_prediction(self.db, flipped, "16.1", start_cutoff=NOW * 1000)
        self.assertTrue(a["ready"])
        self.assertAlmostEqual(a["blue"], 1 - b["blue"])
        self.assertEqual(a["coverage"]["players"]["identified"], 9)
        self.assertEqual(a["coverage"]["players"]["eligible"], 9)

    def test_requires_explicit_roles_and_no_hidden_identity_or_rank_substitute(self):
        result = self.train_pregame()
        model.save(self.db, "pregame", result, now=123)
        unknown_roles = players()
        unknown_roles[0].pop("position")
        unknown_roles[0].update(rank="CHALLENGER", mastery=999999, riot_id="hidden#id")
        unavailable = model.pregame_prediction(self.db, unknown_roles, "16.1")
        self.assertFalse(unavailable["ready"])
        self.assertIn("roles", unavailable["reason"])
        plain = model.pregame_prediction(self.db, players(), "16.1")
        embellished = [{**p, "rank": "CHALLENGER", "mastery": 999999, "riot_id": "hidden#id"} for p in players()]
        same = model.pregame_prediction(self.db, embellished, "16.1")
        self.assertEqual(plain["blue"], same["blue"])
        self.assertEqual(same["coverage"]["players"]["identified"], 0)
        self.assertEqual(set(same["features"]["excluded"]), {"rank", "mastery", "hidden_identities"})
        riot = [{"teamId": p["team_id"], "championId": p["champion_id"], "teamPosition": p["position"]} for p in players()]
        self.assertEqual(plain["blue"], model.pregame_prediction(self.db, riot, "16.1")["blue"])

    def test_cutoff_patch_and_incomplete_draft_are_unavailable_not_fabricated(self):
        result = self.train_pregame()
        model.save(self.db, "pregame", result, now=123)
        for cutoff in (START, result[0]["training_data_end"], result[0]["training_data_end"] + 1,
                       result[0]["validation_data_end"], math.nan, -1):
            out = model.pregame_prediction(self.db, players(), "16.1", start_cutoff=cutoff)
            self.assertFalse(out["ready"])
            self.assertIsNone(out["blue"])
        self.assertFalse(model.pregame_prediction(self.db, players(), "99.99")["ready"])
        self.assertFalse(model.pregame_prediction(self.db, players()[:9], "16.1")["ready"])
        duplicate = players()
        duplicate[1]["position"] = duplicate[0]["position"]
        self.assertFalse(model.pregame_prediction(self.db, duplicate, "16.1")["ready"])

    def test_current_database_rank_and_mastery_never_change_odds(self):
        with mock.patch.object(model, "PLAYER_MIN_GAMES", 5):
            result = self.train_pregame(known=True)
            model.save(self.db, "pregame", result, now=123)
            first = model.pregame_prediction(self.db, players(known=True), "16.1")
            for i in range(10):
                self.db.execute("INSERT OR REPLACE INTO mastery VALUES (?, ?, ?, ?, ?)",
                                (f"known-{i}", 1 if i < 5 else 2, 99, 9999999, 123))
                self.db.execute("INSERT OR REPLACE INTO rank_history VALUES (?, ?, ?, ?, ?, ?, ?)",
                                (f"known-{i}", 123, "CHALLENGER", "I", 9999, 999, 0))
            self.db.commit()
            second = model.pregame_prediction(self.db, players(known=True), "16.1")
        self.assertEqual(first["blue"], second["blue"])
        self.assertEqual(first["features"]["values"], second["features"]["values"])

    def test_prediction_preserves_caller_transaction(self):
        model.save(self.db, "pregame", self.train_pregame(), now=123)
        self.db.execute("BEGIN")
        out = model.pregame_prediction(self.db, players(), "16.1")
        self.assertTrue(out["ready"])
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()

    def test_player_histories_cannot_include_unresolved_or_nontrain_matches(self):
        with mock.patch.object(model, "PLAYER_MIN_GAMES", 5):
            result = self.train_pregame(known=True)
            model.save(self.db, "pregame", result, now=123)
            cutoff = NOW * 1000
            initial = model.pregame_prediction(self.db, players(known=True), "16.1", start_cutoff=cutoff)
            # New cached results before/at this target start, but outside the frozen TRAIN manifest.
            put_match(self.db, "extra", True, result[0]["training_data_end"] - STEP,
                      champions=[1] * 5 + [2] * 5, known_players=True)
            put_match(self.db, "target", True, cutoff, champions=[1] * 5 + [2] * 5, known_players=True)
            self.db.commit()
            repeated = model.pregame_prediction(self.db, players(known=True), "16.1", start_cutoff=cutoff)
        self.assertEqual(initial["features"], repeated["features"])
        self.assertEqual(initial["blue"], repeated["blue"])

    def test_failed_baseline_validation_is_unavailable_to_existing_callers(self):
        fill(self.db, reverse_holdout=True)
        result = self.trained(model.train_pregame)
        self.assertFalse(result[1]["ready"])
        self.assertIn("baseline", result[1]["reason"])
        model.save(self.db, "pregame", result, now=123)
        params, report, _ = model.load(self.db, "pregame")
        self.assertIsNone(params)
        assert report is not None
        self.assertEqual(report["status"], "unavailable")
        self.assertFalse(model.scorecards(self.db)["pregame"]["ready"])
        self.assertFalse(model.pregame_prediction(self.db, players(), "16.1")["ready"])


class CacheTests(FixtureTests):
    def test_memory_databases_are_isolated_and_save_invalidates_same_timestamp(self):
        result = self.train_pregame()
        other = test_data.fixture_db()
        self.addCleanup(other.close)
        model.save(self.db, "pregame", result, now=123)
        self.assertIsNotNone(model.load(self.db, "pregame")[0])
        self.assertEqual(model.load(other, "pregame"), (None, None, None))
        model.save(other, "pregame", None, now=456)
        self.assertEqual(model.load(other, "pregame")[2], 456)
        self.assertEqual(model.load(self.db, "pregame")[2], 123)
        model.save(self.db, "pregame", None, now=123)
        self.assertIsNone(model.load(self.db, "pregame")[0])
        model.save(self.db, "pregame", None, now=0)
        self.assertEqual(model.load(self.db, "pregame")[2], 0)

    def test_file_databases_share_only_their_own_cache_and_it_is_bounded(self):
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        a = test_data.fixture_db(str(Path(directory) / "a.sqlite"))
        b = test_data.fixture_db(str(Path(directory) / "b.sqlite"))
        a_again = test_data.fixture_db(str(Path(directory) / "a.sqlite"))
        for db in (a, b, a_again):
            self.addCleanup(db.close)
        model.save(a, "ingame", None, now=111)
        model.save(b, "ingame", None, now=222)
        self.assertEqual(model.load(a, "ingame")[2], 111)
        self.assertEqual(model.load(a_again, "ingame")[2], 111)
        self.assertEqual(model.load(b, "ingame")[2], 222)
        model.save(a_again, "ingame", None, now=333)
        self.assertEqual(model.load(a, "ingame")[2], 333)
        for _ in range(model.MAX_CACHED_MODELS + 3):
            fixture = test_data.fixture_db()
            self.addCleanup(fixture.close)
            model.load(fixture, "pregame")
        self.assertLessEqual(len(model._loaded), model.MAX_CACHED_MODELS)

    def test_legacy_leaky_models_are_not_ready_until_retrained(self):
        self.db.execute("INSERT INTO models VALUES (?, ?, ?, ?)",
                        ("ingame", 123, json.dumps({"weights": [0, 1], "features": ["gold"]}), json.dumps({"games": 200})))
        params, report, trained_at = model.load(self.db, "ingame")
        self.assertIsNone(params)
        self.assertEqual(trained_at, 123)
        assert report is not None
        self.assertIn("retraining", report["reason"])

    def test_corrupt_claimed_ready_model_is_unavailable(self):
        result = self.train_pregame()
        for weights in ([0, math.nan, 1], [0, 1], [1, 1, 1]):
            params = {**result[0], "weights": weights}
            self.db.execute("INSERT OR REPLACE INTO models VALUES (?, ?, ?, ?)",
                            ("pregame", 123, json.dumps(params), json.dumps(result[1])))
            loaded, report, _ = model.load(self.db, "pregame", ttl=0)
            self.assertIsNone(loaded)
            assert report is not None
            self.assertIn("Invalid stored model", report["reason"])

    def test_nonfinite_persistence_is_rejected(self):
        result = self.train_pregame()
        bad = copy.deepcopy(result)
        bad[0]["weights"][1] = math.nan
        with self.assertRaises(ValueError):
            model.save(self.db, "pregame", bad)
        self.assertEqual(model.load(self.db, "pregame"), (None, None, None))


class SnapshotFitTests(FixtureTests):
    def test_owned_snapshots_end_before_fitting_with_only_bounded_inputs_retained(self):
        fill(self.db, known_players=True)
        original_fit = model.fit
        original_rows = model._pregame_rows
        reads = []

        def check_read(sql, parameters):
            if sql.lstrip().upper().startswith("SELECT"):
                self.assertTrue(self.db.in_transaction, "Training reads must share an extraction snapshot")
                reads.append(sql)

        def checked_fit(*args, **kwargs):
            self.assertFalse(self.db.in_transaction, "Newton fitting must not pin the SQLite WAL snapshot")
            return original_fit(*args, **kwargs)

        def checked_pregame_rows(games):
            self.assertFalse(self.db.in_transaction, "Pure pregame feature aggregation needs no DB snapshot")
            self.assertLessEqual(len(games), model.MAX_GAMES)
            return original_rows(games)

        self.db.before_execute = check_read
        try:
            with (mock.patch.object(model, "fit", side_effect=checked_fit) as fits,
                  mock.patch.object(model, "_pregame_rows", side_effect=checked_pregame_rows)):
                ingame = self.trained(model.train_ingame, cap=80)
                pregame = self.trained(model.train_pregame)
            self.assertGreaterEqual(fits.call_count, 2)
            self.assertLessEqual(ingame[1]["train_samples"], 80)
            self.assertEqual(pregame[1]["train_samples"], 64)
        finally:
            self.db.before_execute = None
        self.assertTrue(reads)
        self.assertFalse(self.db.in_transaction)

    def test_caller_owned_training_snapshot_is_not_rolled_back(self):
        fill(self.db)
        self.db.execute("BEGIN")
        before = self.db.rollback_count
        self.trained(model.train_ingame)
        self.trained(model.train_pregame)
        self.assertTrue(self.db.in_transaction)
        self.assertEqual(self.db.rollback_count, before)
        self.db.rollback()


class TrainingJobTests(FixtureTests):
    def setUp(self):
        super().setUp()
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.path = self.directory / "training-fixture.sqlite"
        self.nice = self.stack.enter_context(mock.patch.object(model.os, "nice", create=True))
        with closing(test_data.fixture_db(str(self.path))) as db:
            db.executemany("INSERT INTO models VALUES (?, ?, ?, ?)",
                           [("ingame", 10, "null", '{"fixture": "old ingame"}'),
                            ("pregame", 20, "null", '{"fixture": "old pregame"}')])
            db.commit()
        self.original = self.rows()

    def rows(self):
        with closing(test_data.fixture_db(str(self.path))) as db:
            return {row[0]: tuple(row) for row in db.execute("SELECT * FROM models")}

    def job(self):
        with mock.patch.object(model, "print", create=True):
            return model.train_all(self.path)

    def test_training_exception_keeps_failed_artifact_and_still_trains_other_model(self):
        with (mock.patch.object(model, "train_ingame", side_effect=RuntimeError("fixture fit failure")),
              mock.patch.object(model, "train_pregame", return_value=None) as other,
              self.assertLogs(model.log, level="ERROR") as logs):
            status = self.job()
        self.assertEqual(status, 1)
        other.assert_called_once()
        self.assertIn("ingame: training/save failed", "\n".join(logs.output))
        self.assertIn("fixture fit failure", "\n".join(logs.output))
        self.assertEqual(self.rows()["ingame"], self.original["ingame"])
        self.assertNotEqual(self.rows()["pregame"], self.original["pregame"])
        self.nice.assert_called_once_with(10)

    def test_later_training_failure_rolls_back_without_corrupting_earlier_success(self):
        def failed_pregame(db):
            db.execute("UPDATE models SET report = 'uncommitted corruption'")
            raise RuntimeError("fixture second model failure")

        with (mock.patch.object(model, "train_ingame", return_value=None),
              mock.patch.object(model, "train_pregame", side_effect=failed_pregame),
              self.assertLogs(model.log, level="ERROR")):
            self.assertEqual(self.job(), 1)
        rows = self.rows()
        self.assertNotEqual(rows["ingame"], self.original["ingame"])
        self.assertIn("reason", json.loads(rows["ingame"][3]))
        self.assertEqual(rows["pregame"], self.original["pregame"])

    def test_save_failure_rolls_back_partial_writes_and_continues(self):
        original_save = model.save

        def failed_save(db, name, result):
            if name == "ingame":
                db.execute("UPDATE models SET report = 'uncommitted corruption'")
                raise OSError("fixture persistence failure")
            original_save(db, name, result)

        with (mock.patch.object(model, "train_ingame", return_value=None),
              mock.patch.object(model, "train_pregame", return_value=None),
              mock.patch.object(model, "save", side_effect=failed_save),
              self.assertLogs(model.log, level="ERROR") as logs):
            self.assertEqual(self.job(), 1)
        self.assertIn("fixture persistence failure", "\n".join(logs.output))
        rows = self.rows()
        self.assertEqual(rows["ingame"], self.original["ingame"])
        self.assertNotEqual(rows["pregame"], self.original["pregame"])

    def test_connection_path_and_small_memory_settings_do_not_mutate_store_default(self):
        original_path = store.DB_PATH
        with closing(model._training_connect(self.path)) as db:
            # resolve(): on macOS the temp dir under /var is reported by SQLite as /private/var
            self.assertEqual(Path(db.execute("PRAGMA database_list").fetchone()[2]).resolve(), self.path.resolve())
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(db.execute("PRAGMA cache_size").fetchone()[0], -2048)
            self.assertEqual(db.execute("PRAGMA temp_store").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA mmap_size").fetchone()[0], 0)
        self.assertEqual(store.DB_PATH, original_path)
        with mock.patch.object(store, "connect", return_value=self.db) as connect:
            self.assertIs(model._training_connect(), self.db)
        connect.assert_called_once_with()

    def test_database_open_failure_is_logged_and_returns_failure(self):
        target = self.directory / "missing-parent" / "cache.sqlite"
        with self.assertLogs(model.log, level="ERROR") as logs:
            self.assertEqual(model.train_all(target), 1)
        self.assertIn("failed to open or use its database", "\n".join(logs.output))
        self.assertEqual(self.rows(), self.original)

    def test_priority_failure_is_warned_without_discarding_a_successful_job(self):
        self.nice.side_effect = PermissionError("fixture nice denial")
        with (mock.patch.object(model, "train_ingame", return_value=None),
              mock.patch.object(model, "train_pregame", return_value=None),
              self.assertLogs(model.log, level="WARNING") as logs):
            self.assertEqual(self.job(), 0)
        self.assertIn("Could not lower model training process priority", "\n".join(logs.output))

    def test_cli_parses_optional_db_and_returns_job_exit_status(self):
        with mock.patch.object(model, "train_all", return_value=1) as train:
            self.assertEqual(model.main(["train", "--db", str(self.path)]), 1)
            train.assert_called_once_with(self.path)
        with mock.patch.object(model, "train_all", return_value=0) as train:
            self.assertEqual(model.main(["train"]), 0)
            train.assert_called_once_with(None)
        with (mock.patch.object(model, "train_all") as train,
              mock.patch.object(sys, "stderr", io.StringIO()), self.assertRaises(SystemExit) as error):
            model.main(["train", "--unknown"])
        self.assertEqual(error.exception.code, 2)
        train.assert_not_called()

    def test_cli_entrypoint_uses_only_fixture_override_and_propagates_failure_exit(self):
        # Protect the live DB even if CLI path handling regresses: the subprocess's
        # default points to a separate temporary decoy, which must never be opened.
        decoy = self.directory / "forbidden-default.sqlite"
        script = """import runpy, sys
from pathlib import Path
import store
default, program, target = sys.argv[1:]
store.DB_PATH = Path(default)
sys.argv = [program, 'train', '--db', target]
runpy.run_path(program, run_name='__main__')
"""
        program = str(Path(model.__file__).resolve())

        def run(target):
            return subprocess.run([sys.executable, "-c", script, str(decoy), program, str(target)],
                                  cwd=Path(program).parent, capture_output=True, text=True, timeout=30, check=False)

        success = run(self.path)
        self.assertEqual(success.returncode, 0, success.stderr)
        self.assertIn("ingame: not enough eligible games", success.stdout)
        self.assertIn("pregame: not enough eligible games", success.stdout)
        saved = self.rows()
        self.assertNotEqual(saved, self.original)
        failure = run(self.directory / "missing-parent" / "cache.sqlite")
        self.assertEqual(failure.returncode, 1)
        self.assertIn("failed to open or use its database", failure.stderr)
        self.assertEqual(self.rows(), saved)
        self.assertFalse(decoy.exists())


if __name__ == "__main__":
    unittest.main()
