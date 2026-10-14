"""Fixture-only tests: never open the project's cache.db or call Riot."""
import copy
import json
import math
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import insights
import perf
import store


class TrackingConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.queries: list[tuple[str, bool]] = []
        self.recording = False

    def execute(self, sql, parameters=()):
        if self.recording:
            self.queries.append((sql, self.in_transaction))
        return super().execute(sql, parameters)


def fixture_db(path: str | Path = ":memory:"):
    db = sqlite3.connect(path, factory=TrackingConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    store.init(db)
    db.queries = []
    db.recording = True
    return db


def game(db, mid, who="peer", champ=1, opponent=9, role="TOP", win=1,
         tier="GOLD", patch_name="16.1", queue=420, remake=0, start=1,
         metrics=None, gold=(100, 200), extra_tags=(), missing_perf=False):
    """One unambiguous pair; blank perf is distinct from no perf row."""
    db.execute("INSERT INTO matches (match_id, queue_id, game_start, patch, remake) VALUES (?, ?, ?, ?, ?)",
               (mid, queue, start, patch_name, remake))
    people = [(who, 100, champ, win), (f"{mid}-opponent", 200, opponent, 1 - win)]
    for puuid, team, champion, won in people:
        db.execute("INSERT INTO participants (match_id, puuid, team_id, champion_id, position, win) VALUES (?, ?, ?, ?, ?, ?)",
                   (mid, puuid, team, champion, role, won))
    for tag in (tier, *extra_tags):
        if tag:
            db.execute("INSERT OR IGNORE INTO match_tier VALUES (?, ?)", (mid, tag))
    if not missing_perf:
        metrics = metrics or {}
        columns = ", ".join(perf.COLUMNS)
        marks = ", ".join("?" for _ in perf.COLUMNS)
        db.execute(f"INSERT INTO perf (match_id, puuid, {columns}) VALUES (?, ?, {marks})",
                   (mid, who, *(metrics.get(k) for k in perf.COLUMNS)))
    if gold is not None:
        for minute, difference in zip((10, 15), gold):
            if difference is not None:
                db.executemany("INSERT INTO frames (match_id, puuid, minute, gold) VALUES (?, ?, ?, ?)",
                               [(mid, who, minute, 5000 + difference), (mid, people[1][0], minute, 5000)])
    return {"match_id": mid}


class InsightTests(unittest.TestCase):
    def setUp(self):
        self.db = fixture_db()
        self.addCleanup(self.db.close)
        # Any accidental connection to production must fail, even though these
        # functions are normally passed a connection rather than opening one.
        guard = patch.object(store, "connect", side_effect=AssertionError("Real cache access"))
        guard.start()
        self.addCleanup(guard.stop)

    def peers(self, n=20, tier="GOLD", role="TOP", **kwargs):
        return [game(self.db, f"{tier}-{role}-{i}", tier=tier, role=role, **kwargs) for i in range(n)]

    def own(self, n=20, role="TOP", **kwargs):
        return [game(self.db, f"own-{role}-{i}", who="me", role=role, start=i, **kwargs) for i in range(n)]

    def draft(self, games=(), **kwargs):
        self.db.commit()
        return insights.draft(self.db, games, "me", kwargs.pop("tier", "GOLD"),
                              kwargs.pop("patch_name", "16.1"), kwargs.pop("role", "TOP"), **kwargs)

    def coaching(self, games, tier="GOLD", patch_name: str | None = "16.1"):
        self.db.commit()
        return insights.coaching(self.db, games, "me", tier, patch_name)

    def metric(self, result, key, role="TOP"):
        selected = next(r for r in result["roles"] if r["role"] == role)
        return next(m for m in selected["metrics"] if m["key"] == key)

    def test_draft_wr_intervals_gold_and_own_pool(self):
        self.peers(20, metrics={"cs_min": 6}, extra_tags=("PLATINUM", "SILVER"))
        own = self.own(3, gold=(300, None))
        result = self.draft(own + own, opponent=9)
        row = result["matchups"][0]
        self.assertEqual((row["champion_id"], row["opponent_id"], row["games"], row["wins"]), (1, 9, 20, 20))
        self.assertEqual(row["wr"], 1)
        self.assertLess(row["lo"], row["hi"])
        self.assertLess(row["hi"], 1)
        self.assertEqual(row["gold10"], {"mean": 100, "games": 20})
        self.assertEqual(row["gold15"], {"mean": 200, "games": 20})
        self.assertEqual(row["you"]["games"], 3)
        self.assertEqual(row["you"]["gold10"], {"mean": 300, "games": 3})
        self.assertEqual(row["you"]["gold15"], {"mean": None, "games": 0})
        self.assertEqual(result["counters"][0]["pool_games"], 3)
        self.assertIn("not proof", result["counters"][0]["reason"])
        self.assertIn("proxy", insights.__doc__ or "")
        json.dumps(result, allow_nan=False)

    def test_draft_shrinkage_ranked_pool_and_minimums(self):
        self.peers(1, champ=1)
        for i in range(100):
            game(self.db, f"established-{i}", champ=2, win=int(i < 70))
        for i in range(insights.MIN_MATCHUP_GAMES):
            game(self.db, f"outside-pool-{i}", champ=3, win=1)
        own = self.own(3, champ=1) + [game(self.db, f"own-second-{i}", who="me", champ=2) for i in range(3)]
        result = self.draft(own, opponent=9)
        rows = {r["champion_id"]: r for r in result["matchups"]}
        self.assertGreater(rows[2]["score"], rows[1]["score"])
        self.assertGreater(rows[1]["hi"] - rows[1]["lo"], rows[2]["hi"] - rows[2]["lo"])
        self.assertEqual([r["champion_id"] for r in result["counters"]], [2])
        self.assertEqual(self.draft(own)["counters"], [])
        self.assertEqual(self.draft(own[:2], opponent=9)["counters"], [])

    def test_draft_range_patch_role_queue_remake_and_missing_gold(self):
        self.peers(3, gold=(None, 100))
        own = self.own(3, gold=None)
        outside = game(self.db, "outside-range", who="me", champ=4)
        wrong = [game(self.db, "other-patch", who="me", patch_name="16.2"),
                 game(self.db, "flex", who="me", queue=440),
                 game(self.db, "remake", who="me", remake=1),
                 game(self.db, "other-role", who="me", role="MIDDLE")]
        game(self.db, "wrong-peer-patch", patch_name="16.2", champ=5)
        game(self.db, "wrong-peer-tier", tier="SILVER", champ=6)
        game(self.db, "wrong-peer-queue", queue=440, champ=7)
        game(self.db, "wrong-peer-remake", remake=1, champ=8)
        result = self.draft(own + wrong + [{"match_id": "not-cached"}], opponent=9)
        self.assertEqual([r["champion_id"] for r in result["matchups"]], [1])
        self.assertEqual(result["matchups"][0]["you"]["games"], 3)
        self.assertEqual(result["matchups"][0]["gold10"], {"mean": None, "games": 0})
        self.assertEqual(result["matchups"][0]["gold15"], {"mean": 100, "games": 3})
        self.assertNotIn(outside, own)
        self.assertEqual(self.draft(own, tier="DIAMOND", opponent=9)["counters"], [])

    def test_draft_gold_orientation_and_ambiguous_lane_no_multiplication(self):
        game(self.db, "valid", gold=(100, -200))
        game(self.db, "ambiguous")
        self.db.execute("INSERT INTO participants (match_id, puuid, team_id, champion_id, position, win) VALUES ('ambiguous', 'extra', 200, 8, 'TOP', 0)")
        result = self.draft()
        rows = {(r["champion_id"], r["opponent_id"]): r for r in result["matchups"]}
        self.assertEqual(rows[1, 9]["games"], 1)
        self.assertEqual(rows[9, 1]["games"], 1)
        # Gold samples below the floor are disclosed but not presented as means.
        self.assertEqual(rows[1, 9]["gold15"], {"mean": None, "games": 1})
        for i in range(2):
            game(self.db, f"valid-{i}", gold=(100, -200))
        result = self.draft()
        rows = {(r["champion_id"], r["opponent_id"]): r for r in result["matchups"]}
        self.assertEqual(rows[1, 9]["gold15"]["mean"], -200)
        self.assertEqual(rows[9, 1]["gold15"]["mean"], 200)

    def test_coaching_excludes_entire_player_matches_even_outside_range(self):
        self.peers(metrics={"cs_min": 6, "deaths": 3}, extra_tags=("PLATINUM",))
        own = self.own(5, metrics={"cs_min": 4, "deaths": 5})
        game(self.db, "player-outside-range", who="me", metrics={"cs_min": 100}, extra_tags=("PLATINUM",))
        # Teammates in a player's match must not leak into peer baselines.
        self.db.execute("INSERT INTO participants (match_id, puuid, team_id, champion_id, position, win) VALUES ('player-outside-range', 'teammate', 100, 3, 'TOP', 1)")
        self.db.execute("INSERT INTO perf (match_id, puuid, cs_min) VALUES ('player-outside-range', 'teammate', 100)")
        result = self.coaching(own + own)
        cs = self.metric(result, "cs_min")
        self.assertEqual((cs["games"], cs["baseline_games"], cs["next_games"]), (5, 20, 20))
        self.assertEqual((cs["you"], cs["current"], cs["next"]), (4, 6, 6))
        self.assertEqual(cs["percentile"], 0)
        self.assertEqual(result["next_tier"], "PLATINUM")
        sql = "\n".join(q for q, _ in self.db.queries)
        self.assertIn("EXISTS (SELECT 1 FROM match_tier", sql)
        self.assertIn("NOT EXISTS (SELECT 1 FROM participants me", sql)
        self.assertIn("not verified", result["roles"][0]["takeaway"])

    def test_per_metric_missing_data_and_sample_floors(self):
        self.peers(19, metrics={"cs_min": 6, "kp": 0.5})
        game(self.db, "one-more", metrics={"cs_min": 6, "kp": None})
        own = self.own(4, metrics={"cs_min": 4, "kp": 0.2})
        own += [game(self.db, "missing-own", who="me", missing_perf=True)]
        result = self.coaching(own)
        self.assertEqual(result["roles"][0]["games"], 5)
        cs, kp, vision = (self.metric(result, k) for k in ("cs_min", "kp", "vision_min"))
        self.assertEqual((cs["games"], cs["current"], cs["percentile"]), (4, 6, None))
        self.assertEqual((kp["games"], kp["baseline_games"], kp["current"]), (4, 19, None))
        self.assertEqual((vision["you"], vision["games"], vision["baseline_games"]), (None, 0, 0))
        self.assertIsNone(vision["recent"]["value"])
        self.assertEqual(result["roles"][0]["focus"], [])
        self.assertIsNone(next(a for a in result["roles"][0]["fingerprint"] if a["key"] == "vision")["percentile"])
        json.dumps(result, allow_nan=False)

    def test_percentile_ties_direction_fingerprint_and_goals(self):
        self.peers(metrics={"cs_min": 6, "deaths": 3, "kp": 0.6, "vision_min": 2, "gold_min": 500})
        self.peers(tier="PLATINUM", metrics={"cs_min": 7, "deaths": 2, "kp": 0.7, "vision_min": 3, "gold_min": 600})
        own = self.own(5, metrics={"cs_min": 6, "deaths": 6, "kp": 0.3, "vision_min": 1, "gold_min": 300})
        result = self.coaching(own)
        self.assertEqual(self.metric(result, "cs_min")["percentile"], 50)
        self.assertEqual(self.metric(result, "deaths")["percentile"], 0)
        focus = result["roles"][0]["focus"]
        self.assertEqual(len(focus), 3)
        self.assertNotIn("gold_min", [m["key"] for m in focus])
        for entry in focus:
            self.assertGreater((entry["target"] - entry["you"]) * entry["better"], 0)
            self.assertEqual(entry["target_tier"], "PLATINUM")
            self.assertTrue(entry["advice"])
        deaths = next(m for m in focus if m["key"] == "deaths")
        self.assertIn("not always better", deaths["advice"])
        safety = next(a for a in result["roles"][0]["fingerprint"] if a["key"] == "safety")
        self.assertIn("context", safety["label"])
        self.assertEqual(safety["percentile"], 0)

    def test_coaching_recent_older_range_and_nonfinite_values(self):
        own = []
        for i in range(25):
            own.append(game(self.db, f"history-{i}", who="me", start=i,
                            metrics={"cs_min": 4 if i < 15 else 6, "kp": math.inf if i >= 15 else 0.5}))
        excluded = own[:5]
        selected = own[5:]
        snapshot = copy.deepcopy(selected)
        result = self.coaching(selected[::-1] + selected)
        cs = self.metric(result, "cs_min")
        self.assertEqual(cs["games"], 20)
        self.assertEqual(cs["previous"], {"value": 4, "games": 10})
        self.assertEqual(cs["recent"], {"value": 6, "games": 10})
        kp = self.metric(result, "kp")
        self.assertEqual(kp["recent"], {"value": None, "games": 0})
        self.assertEqual(kp["games"], 10)
        self.assertEqual(selected, snapshot)
        self.assertNotIn(excluded[0], selected)
        json.dumps(result, allow_nan=False)

    def test_roles_patch_and_next_tier_missing_data_are_not_blended(self):
        self.peers(role="TOP", metrics={"cs_min": 6})
        self.peers(role="MIDDLE", metrics={"cs_min": 8})
        self.peers(tier="PLATINUM", patch_name="16.2", metrics={"cs_min": 9})
        own = self.own(5, metrics={"cs_min": 4}) + self.own(5, role="MIDDLE", metrics={"cs_min": 7})
        wrong = [game(self.db, "wrong-own-patch", who="me", patch_name="16.2", metrics={"cs_min": 90}),
                 game(self.db, "wrong-own-queue", who="me", queue=440),
                 game(self.db, "own-remake", who="me", remake=1)]
        result = self.coaching(own + wrong)
        self.assertEqual([r["games"] for r in result["roles"]], [5, 5])
        self.assertEqual(self.metric(result, "cs_min")["current"], 6)
        self.assertEqual(self.metric(result, "cs_min", "MIDDLE")["current"], 8)
        self.assertEqual(self.metric(result, "cs_min")["next_games"], 0)
        self.assertIsNone(self.metric(result, "cs_min")["next"])
        self.assertIsNone(self.coaching(own, "CHALLENGER")["next_tier"])
        unranked = self.coaching(own, "UNRANKED")
        self.assertIsNone(unranked["next_tier"])
        self.assertIsNone(self.metric(unranked, "cs_min")["current"])

    def test_empty_and_invalid_inputs(self):
        self.assertEqual(self.draft()["matchups"], [])
        self.assertEqual(self.coaching([])["roles"], [])
        self.assertEqual(self.coaching([], patch_name=None)["roles"], [])
        with self.assertRaises(ValueError):
            self.draft(role="SUPPORT")
        with self.assertRaises(ValueError):
            self.draft(opponent=True)
        with self.assertRaises(ValueError):
            self.draft(tier="FAKE")

    def test_snapshot_owned_and_caller_transaction_preserved(self):
        own = self.own(5, metrics={"cs_min": 4})
        self.db.commit()
        self.db.queries.clear()
        insights.coaching(self.db, own, "me", "GOLD", "16.1")
        reads = [(sql, active) for sql, active in self.db.queries if sql.lstrip().startswith("SELECT")]
        self.assertTrue(reads)
        self.assertTrue(all(active for _, active in reads))
        self.assertFalse(self.db.in_transaction)
        self.db.execute("BEGIN")
        game(self.db, "uncommitted", who="me")
        insights.draft(self.db, own, "me", "GOLD", "16.1", "TOP", 9)
        self.assertTrue(self.db.in_transaction)
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM matches WHERE match_id = 'uncommitted'").fetchone())
        self.db.rollback()

    def test_snapshot_does_not_mix_concurrent_peer_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.db"
            db, writer = fixture_db(path), fixture_db(path)
            try:
                selected = [game(db, f"me-{i}", who="me", metrics={"cs_min": 4}) for i in range(5)]
                for i in range(20):
                    game(db, f"baseline-{i}", metrics={"cs_min": 6}, extra_tags=("PLATINUM",))
                db.commit()
                original = insights._baseline
                writes = []

                def write_after_first(*args):
                    result = original(*args)
                    if not writes:
                        writer.execute("UPDATE perf SET cs_min = 100 WHERE puuid = 'peer'")
                        writer.commit()
                        writes.append(True)
                    return result

                with patch.object(insights, "_baseline", side_effect=write_after_first):
                    result = insights.coaching(db, selected, "me", "GOLD", "16.1")
                cs = self.metric(result, "cs_min")
                self.assertEqual((cs["current"], cs["next"]), (6, 6))
                later = insights.coaching(db, selected, "me", "GOLD", "16.1")
                self.assertEqual(self.metric(later, "cs_min")["current"], 100)
            finally:
                writer.close()
                db.close()

    def test_own_matchup_is_visible_when_peer_population_is_missing(self):
        own = self.own(3)
        row = self.draft(own, tier="DIAMOND", opponent=9)["matchups"][0]
        self.assertEqual(row["games"], 0)
        self.assertIsNone(row["wr"])
        self.assertIsNone(row["score"])
        self.assertEqual(row["you"]["games"], 3)

    def test_draft_chunking_counter_order_cap_and_input_immutability(self):
        selected = []
        for champion in range(1, 7):
            for i in range(insights.MIN_MATCHUP_GAMES):
                game(self.db, f"pool-peer-{champion}-{i}", champ=champion)
            for i in range(insights.MIN_POOL_GAMES):
                selected.append(game(self.db, f"pool-own-{champion}-{i}", who="me", champ=champion))
        original = copy.deepcopy(selected)
        with patch.object(insights, "SQL_CHUNK", 2):
            result = self.draft(selected + selected, opponent=9)
        self.assertEqual([r["champion_id"] for r in result["counters"]], [1, 2, 3, 4, 5])
        self.assertEqual(len(result["counters"]), insights.MAX_COUNTERS)
        self.assertTrue(all(r["you"]["games"] == 3 for r in result["matchups"]))
        self.assertEqual(selected, original)

    def test_invalid_and_one_sided_gold_frames_are_not_samples(self):
        self.peers(3)
        self.db.execute("UPDATE frames SET gold = ? WHERE puuid = 'peer' AND minute = 10", (math.inf,))
        self.db.execute("DELETE FROM frames WHERE puuid = 'peer' AND minute = 15 AND match_id = 'GOLD-TOP-0'")
        row = next(r for r in self.draft(opponent=9)["matchups"] if r["champion_id"] == 1)
        self.assertEqual(row["gold10"], {"mean": None, "games": 0})
        self.assertEqual(row["gold15"], {"mean": None, "games": 2})

    def test_progress_windows_do_not_pull_older_values_to_fill_missing_samples(self):
        selected = self.own(12, metrics={"cs_min": 4})
        result = self.coaching(selected)
        cs = self.metric(result, "cs_min")
        self.assertEqual(cs["recent"], {"value": 4, "games": 10})
        self.assertEqual(cs["previous"], {"value": None, "games": 2})
        self.assertEqual(self.metric(self.coaching(selected[-2:]), "cs_min")["recent"], {"value": None, "games": 2})

    def test_focus_family_diversity_and_worse_next_mean_do_not_reverse_target(self):
        self.peers(metrics={"cs_min": 6, "cs10": 80, "deaths": 3, "kp": 0.6})
        self.peers(tier="PLATINUM", metrics={"cs_min": 5, "cs10": 60, "deaths": 7, "kp": 0.5})
        selected = self.own(5, metrics={"cs_min": 4, "cs10": 40, "deaths": 6, "kp": 0.3})
        focus = self.coaching(selected)["roles"][0]["focus"]
        self.assertEqual(len(focus), 3)
        self.assertEqual(len({m["key"] for m in focus} & {"cs_min", "cs10"}), 1)
        deaths = next(m for m in focus if m["key"] == "deaths")
        self.assertEqual(deaths["target_tier"], "GOLD")
        self.assertEqual(deaths["target"], 4.5)

    def test_all_roles_expose_only_applicable_metrics_and_no_goal_without_gap(self):
        selected = []
        for role in perf.ROLES:
            self.peers(role=role, metrics={"cs_min": 6, "deaths": 3, "cc_min": 1})
            selected.extend(self.own(5, role=role, metrics={"cs_min": 8, "deaths": 1, "cc_min": 2}))
        result = self.coaching(selected)
        self.assertEqual([r["role"] for r in result["roles"]], list(perf.ROLES))
        for entry in result["roles"]:
            self.assertEqual([m["key"] for m in entry["metrics"]], perf.role_metrics(entry["role"]))
            self.assertEqual(entry["focus"], [])
        self.assertEqual(set(insights.ADVICE), {k for k, m in perf.METRICS.items() if m[3]})


class ForecastTests(unittest.TestCase):
    def rank(self, at, lp, games, tier="GOLD", division="I", wins=None, losses=0):
        return {"at": at, "tier": tier, "division": division, "lp": lp,
                "wins": games if wins is None else wins, "losses": losses}

    def forecast(self, rows, **profile):
        current = {**rows[-1], **profile}
        return insights.rank_forecast(rows, current)

    def test_positive_observed_pace_and_uncertainty(self):
        rows = [self.rank(1, 20, 10), self.rank(2, 40, 15), self.rank(3, 70, 20)]
        snapshot = copy.deepcopy(rows)
        result = self.forecast(rows)
        self.assertTrue(result["available"])
        self.assertEqual(result["lp_per_game"], 5)
        self.assertEqual((result["observations"], result["games"], result["net_lp"]), (3, 10, 50))
        self.assertEqual(result["target"], {"tier": "PLATINUM", "division": "IV", "lp": 0})
        self.assertEqual(result["next_lp"], 30)
        self.assertEqual(result["estimated_games"], 6)
        self.assertEqual(result["uncertainty"], {"lp_per_game_lo": 4, "lp_per_game_hi": 6,
                                               "estimated_games_lo": 5, "estimated_games_hi": 8})
        self.assertIn("not a promise", result["note"])
        self.assertEqual(rows, snapshot)
        self.assertNotIn("mmr", result)
        self.assertIn(result["reason"], insights.FORECAST_REASONS)
        json.dumps(result, allow_nan=False)

    def test_insufficient_negative_and_flat_are_distinct(self):
        cases = [([self.rank(1, 20, 10)], "insufficient_observations"),
                 ([self.rank(1, 20, 10), self.rank(2, 40, 11), self.rank(3, 50, 12)], "insufficient_games"),
                 ([self.rank(1, 80, 10), self.rank(2, 60, 15), self.rank(3, 30, 20)], "negative_pace"),
                 ([self.rank(1, 20, 10), self.rank(2, 20, 15), self.rank(3, 20, 20)], "zero_pace")]
        for rows, reason in cases:
            with self.subTest(reason=reason):
                result = self.forecast(rows)
                self.assertFalse(result["available"])
                self.assertEqual(result["reason"], reason)
                self.assertNotIn("estimated_games", result)
        self.assertEqual(insights.rank_forecast([], {"tier": "UNRANKED"})["reason"], "unranked")

    def test_crossing_divisions_and_tiers_uses_displayed_lp_distance(self):
        rows = [self.rank(1, 90, 10, division="II"), self.rank(2, 20, 15),
                self.rank(3, 5, 20, tier="PLATINUM", division="IV")]
        result = self.forecast(rows)
        self.assertEqual(result["net_lp"], 115)
        self.assertEqual(result["target"]["tier"], "EMERALD")
        self.assertEqual(result["next_lp"], 395)

    def test_resets_and_lp_changes_without_games_start_new_segment(self):
        rows = [self.rank(1, 20, 100), self.rank(2, 40, 110), self.rank(3, 10, 0),
                self.rank(4, 20, 5), self.rank(5, 30, 10)]
        result = self.forecast(rows)
        self.assertEqual((result["games"], result["net_lp"], result["observations"]), (10, 20, 3))
        self.assertIn("reset", result["note"])
        correction = rows[:2] + [self.rank(3, 10, 110)]
        result = self.forecast(correction)
        self.assertEqual(result["reason"], "insufficient_observations")
        self.assertEqual(result["observations"], 1)
        # Even if the total counter grows, a reset in one counter must not bridge.
        individual = [self.rank(1, 20, 0, wins=10, losses=10), self.rank(2, 40, 0, wins=9, losses=20)]
        self.assertEqual(self.forecast(individual)["observations"], 1)

    def test_dedup_sort_stale_and_invalid_history(self):
        rows = [self.rank(1, 20, 10), self.rank(2, 40, 15), self.rank(3, 60, 20)]
        repeated = [*rows, dict(rows[0]), {**rows[-1], "at": 4}]
        result = insights.rank_forecast(repeated[::-1], rows[-1])
        self.assertEqual(result["observations"], 3)
        self.assertTrue(result["available"])
        self.assertEqual(self.forecast(rows, lp=70)["reason"], "stale_history")
        conflicting = [*rows, {**rows[0], "lp": 30}]
        self.assertEqual(self.forecast(conflicting)["reason"], "invalid_history")
        invalid = [*rows, {**rows[-1], "at": 4, "lp": math.nan}]
        self.assertEqual(insights.rank_forecast(invalid, rows[-1])["reason"], "invalid_history")
        self.assertEqual(self.forecast(rows, lp=100)["reason"], "invalid_profile")

    def test_negative_interval_positive_total_has_open_ended_uncertainty(self):
        rows = [self.rank(1, 30, 0), self.rank(2, 20, 5), self.rank(3, 60, 10)]
        result = self.forecast(rows)
        self.assertTrue(result["available"])
        self.assertEqual(result["lp_per_game"], 3)
        self.assertEqual(result["uncertainty"]["lp_per_game_lo"], -2)
        self.assertIsNone(result["uncertainty"]["estimated_games_hi"])
        self.assertIn("no finite", result["note"])

    def test_apex_rank_labels_do_not_add_400_lp_or_invent_cutoffs(self):
        rows = [self.rank(1, 300, 10, tier="MASTER"), self.rank(2, 320, 15, tier="GRANDMASTER"),
                self.rank(3, 330, 20, tier="CHALLENGER")]
        result = self.forecast(rows)
        self.assertEqual(result["net_lp"], 30)
        self.assertEqual(result["reason"], "dynamic_apex_target")
        self.assertIsNone(result["target"])
        self.assertNotIn("estimated_games", result)

    def test_profile_analysis_and_riot_field_names_and_bounded_window(self):
        rows = [self.rank(i, i, i * 5) for i in range(30)]
        profile = {"tier": "GOLD", "division": "I", "lp": 29, "season_wins": 145, "season_losses": 0}
        result = insights.rank_forecast(rows, profile)
        self.assertEqual(result["observations"], insights.MAX_RANK_OBSERVATIONS)
        self.assertEqual(result["games"], 95)
        raw_riot = {"tier": "GOLD", "rank": "I", "leaguePoints": 29, "wins": 145, "losses": 0}
        self.assertEqual(insights.rank_forecast(rows, raw_riot), result)


if __name__ == "__main__":
    unittest.main()
