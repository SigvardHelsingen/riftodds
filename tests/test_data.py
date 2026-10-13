import asyncio
import copy
import math
import sqlite3
import tempfile
import tracemalloc
import unittest
from collections.abc import Callable, Sequence
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import history
import stats
import store

ROOT = Path(__file__).resolve().parents[1]


class FixtureConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.closed = False
        self.rollback_count = 0
        self.queries = []
        self.before_execute: Callable[[str, Sequence[object]], None] | None = None

    def execute(self, sql, parameters=()):
        self.queries.append((sql, tuple(parameters)))
        if self.before_execute is not None:
            self.before_execute(sql, parameters)
        return super().execute(sql, parameters)

    def rollback(self):
        self.rollback_count += 1
        return super().rollback()

    def close(self):
        self.closed = True
        return super().close()


def fixture_db(path=":memory:"):
    db = sqlite3.connect(path, timeout=0.1, factory=FixtureConnection)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    store.init(db)  # the same tables and migrations as production
    return db


def match_fixture(mid, puuid="fixture-player"):
    participants = []
    for i in range(10):
        participants.append({
            "puuid": puuid if i == 0 else f"{mid}-player-{i}",
            "teamId": 100 if i < 5 else 200,
            "championId": i + 1,
            "teamPosition": stats.ROLES[i % 5],
            "win": i < 5,
            "kills": 2, "deaths": 1, "assists": 3,
            "totalMinionsKilled": 100, "neutralMinionsKilled": 10,
            "goldEarned": 10000, "totalDamageDealtToChampions": 12000,
            "visionScore": 20,
        })
    teams = [{
        "teamId": team, "win": team == 100,
        "objectives": {name: {"first": team == 100}
                       for name in ("champion", "tower", "dragon", "riftHerald")},
        "bans": [{"championId": 100 + team, "pickTurn": 1}],
    } for team in (100, 200)]
    return {
        "metadata": {"matchId": mid},
        "info": {"queueId": 420, "gameStartTimestamp": 1000000, "gameDuration": 1800,
                 "gameVersion": "16.1.1", "participants": participants, "teams": teams},
    }


def timeline_fixture(match):
    people = match["info"]["participants"]
    return {
        "metadata": {"participants": [p["puuid"] for p in people]},
        "info": {
            "participants": [{"participantId": i + 1, "puuid": p["puuid"]}
                             for i, p in enumerate(people)],
            "frames": [{"participantFrames": {
                str(i + 1): {"totalGold": 7000 if i < 5 else 6000, "xp": 1000,
                             "minionsKilled": 80, "jungleMinionsKilled": 20}
                for i in range(10)
            }} for _ in range(16)],
        },
    }


def save_fixture(db, mid, puuid="fixture-player", timeline=True):
    match = match_fixture(mid, puuid)
    store.save_match(db, "FIXTURE", match)
    store.tag_tier(db, mid, "GOLD")
    if timeline:
        store.save_timeline(db, mid, timeline_fixture(match))


class FakeClient:
    def __init__(self, matches=None, timelines=None, ids=None, listing_error=None):
        self.matches = matches or {}
        self.timelines = timelines or {}
        self.ids = list(self.matches) if ids is None else ids
        self.listing_error = listing_error
        self.calls = []

    async def match_ids(self, platform, puuid, queue, count, start=0, start_time=None):
        self.calls.append(("ids", puuid))
        if self.listing_error is not None:
            raise self.listing_error
        return self.ids[start:start + count]

    async def match(self, platform, mid):
        self.calls.append(("match", mid))
        result = self.matches[mid]
        if isinstance(result, BaseException):
            raise result
        return copy.deepcopy(result)

    async def timeline(self, platform, mid):
        self.calls.append(("timeline", mid))
        result = self.timelines.get(mid)
        if isinstance(result, BaseException):
            raise result
        return copy.deepcopy(result)

    def background(self, share):
        return self


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.db = fixture_db()
        self.addCleanup(self.db.close)



class PickTests(unittest.TestCase):
    def setUp(self):
        self.games = [
            {"position": "TOP", "champion_id": champ, "opp_champ": opponent, "win": win}
            for champ, opponent, win in ((1, 2, 1), (1, 2, 0), (3, 4, 1))
        ]

    def test_zero_smoothing_unseen_matchup_uses_role_prior(self):
        result = stats.pick_probabilities(self.games, "TOP", opp=99, alpha=0)
        self.assertEqual(result["games_vs_opp"], 0)
        self.assertAlmostEqual(sum(row["p_vs"] for row in result["rows"]), 1)
        for row in result["rows"]:
            self.assertEqual(row["p_vs"], row["p_role"])
            self.assertEqual(row["games_vs"], 0)
            self.assertEqual(row["wr_vs"]["games"], 0)

    def test_zero_smoothing_observed_matchup_uses_observations(self):
        rows = stats.pick_probabilities(self.games, "TOP", opp=2, alpha=0)["rows"]
        self.assertEqual({r["champion_id"]: r["p_vs"] for r in rows}, {1: 1, 3: 0})

    def test_positive_smoothing_is_unchanged(self):
        result = stats.pick_probabilities(self.games, "TOP", opp=2, alpha=5)
        for row in result["rows"]:
            self.assertAlmostEqual(row["p_vs"], (row["games_vs"] + 5 * row["p_role"]) / 7)

    def test_invalid_alpha_rejected_even_without_games(self):
        for alpha in (-1, float("nan"), float("inf"), float("-inf")):
            for games in (self.games, []):
                with (
                    self.subTest(alpha=alpha, empty=not games),
                    self.assertRaisesRegex(ValueError, "finite and nonnegative"),
                ):
                    stats.pick_probabilities(games, "TOP", alpha=alpha)


def binomial_sf(x, a, b):
    """Reference P(X > x) for X ~ Beta(a, b), integer a, b: P(Binomial(a + b - 1, x) <= a - 1)."""
    n = a + b - 1
    return sum(math.exp(math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
                        + k * math.log(x) + (n - k) * math.log1p(-x)) for k in range(a))


class ProbabilityTests(unittest.TestCase):
    def test_beta_tail_matches_binomial_identity(self):
        for a in (1, 2, 7, 30, 151, 401):
            for b in (1, 3, 40, 249, 600):
                for x in (0.001, 0.2, 0.5, 0.73, 0.999):
                    with self.subTest(a=a, b=b, x=x):
                        self.assertAlmostEqual(stats.beta_sf(x, a, b), binomial_sf(x, a, b), places=10)

    def test_quantile_inverts_the_tail(self):
        for a, b in ((1, 1), (2, 30), (6, 496), (151, 151), (5001, 4001)):
            for q in (0.05, 0.5, 0.95):
                with self.subTest(a=a, b=b, q=q):
                    self.assertAlmostEqual(1 - stats.beta_sf(stats.beta_quantile(q, a, b), a, b), q, places=9)

    def test_skewed_large_sample_interval_is_exact(self):
        # 5 wins in 500 games: a normal approximation put the lower bound at 0.40%; the exact one is 0.52%
        result = stats.winrate(5, 500)
        self.assertAlmostEqual(binomial_sf(result["lo"], 6, 496), 0.95, places=8)
        self.assertAlmostEqual(binomial_sf(result["hi"], 6, 496), 0.05, places=8)
        self.assertAlmostEqual(result["lo"], 0.00523, places=5)

    def test_probability_better_matches_exact_sum(self):
        def exact(a1, b1, a2, b2):
            log_b = lambda x, y: math.lgamma(x) + math.lgamma(y) - math.lgamma(x + y)
            return sum(math.exp(math.lgamma(b1 + i) - math.lgamma(i + 1) - math.lgamma(b1)
                                + log_b(a2 + i, b1 + b2) - log_b(a2, b2)) for i in range(a1))
        for case in ((4, 3, 51, 51), (13, 9, 5001, 4801), (61, 41, 30001, 29001), (11, 2, 9001, 9001)):
            with self.subTest(case=case):
                self.assertAlmostEqual(stats.prob_greater(*case), exact(*case), places=3)


class LocalTimeTests(unittest.TestCase):
    @staticmethod
    def game(utc):
        return {"game_start": int(utc.timestamp() * 1000), "duration": 1800, "win": 1, "position": "MIDDLE",
                "champion_id": 1, "first_blood": 0, "first_tower": 0, "first_dragon": 0, "deaths": 0,
                "lane_adv": None, "match_id": utc.isoformat()}

    def test_time_of_day_follows_daylight_saving_per_game(self):
        # 17:30 in Oslo both times: 16:30 UTC in winter (CET), 15:30 UTC in summer (CEST)
        games = [self.game(datetime(2026, 1, 20, 16, 30, tzinfo=timezone.utc)),
                 self.game(datetime(2026, 7, 20, 15, 30, tzinfo=timezone.utc))]
        buckets = {b["label"]: b["games"] for b in stats.overview(games, stats.local_zone("Europe/Oslo", -120))["time_of_day"]}
        self.assertEqual(buckets["Afternoon 12–18"], 2)
        # a summer offset alone would push the winter game to 18:30
        fixed = {b["label"]: b["games"] for b in stats.overview(games, stats.local_zone(None, -120))["time_of_day"]}
        self.assertEqual(fixed["Evening 18–24"], 1)

    def test_unknown_zone_falls_back_to_offset(self):
        self.assertEqual(stats.local_zone("Not/AZone", -60).utcoffset(None).total_seconds(), 3600)
        self.assertEqual(stats.local_zone("../etc/passwd", 0).utcoffset(None).total_seconds(), 0)


class PatchAndModeTests(unittest.TestCase):
    def setUp(self):
        self.db = fixture_db()
        self.addCleanup(self.db.close)

    def test_latest_patch_before(self):
        for mid, patch in (("A", "16.9"), ("B", "16.10"), ("C", "16.11")):
            self.db.execute("INSERT INTO matches VALUES (?, 'X', 420, 0, 0, ?, 0, NULL)", (mid, patch))
        self.assertEqual(stats.latest_patch(self.db), "16.11")
        self.assertEqual(stats.latest_patch(self.db, before="16.11"), "16.10")
        self.assertIsNone(stats.latest_patch(self.db, before="16.9"))

    def test_match_without_rift_objectives_is_saved(self):
        match = match_fixture("ARENA_1")
        match["info"].update(queueId=1710, teams=[])
        store.save_match(self.db, "FIXTURE", match)
        self.assertTrue(store.has_match(self.db, "ARENA_1"))
        match = match_fixture("NO_OBJECTIVES")
        for team in match["info"]["teams"]:
            del team["objectives"]
        store.save_match(self.db, "FIXTURE", match)
        self.assertEqual(self.db.execute("SELECT SUM(first_tower) FROM teams WHERE match_id = 'NO_OBJECTIVES'").fetchone()[0], 0)


class SeriesTests(unittest.TestCase):
    def test_chart_series_carries_team_kills_and_gold_leads(self):
        db = fixture_db()
        self.addCleanup(db.close)
        save_fixture(db, "SERIES_1")
        db.commit()
        games = stats.attach_gold(db, stats.player_games(db, "fixture-player"), "fixture-player")
        row = stats.game_series(games)[0]
        self.assertEqual(set(row), set(stats.SERIES_FIELDS))
        self.assertEqual((row["kills"], row["assists"], row["team_kills"], row["lane_diff15"], row["team_diff15"]),
                         (2, 3, 10, 1000, 5000))


FINISHED = {"completed": True, "boots": False}
ITEMS = {3031: FINISHED, 3072: FINISHED, 3036: FINISHED, 3046: FINISHED, 6672: FINISHED,
         3006: {"completed": False, "boots": True}, 3111: {"completed": False, "boots": True},
         1055: {"completed": False, "boots": False}, 3340: {"completed": False, "boots": False},
         3877: {"completed": False, "boots": False, "support": True}}


def build_match(mid, champion, items, win, subject="subject", patch="16.1", position="MIDDLE",
                keystone=8010, primary=8000, sub=8400, spells=(4, 12)):
    """A ranked solo match where only `subject` has a role: `champion` in `position`, with these final items."""
    match = match_fixture(mid, subject)
    info = match["info"]
    info["gameVersion"] = f"{patch}.1"
    for p in info["participants"]:
        p.update(teamPosition="", win=(p["teamId"] == 100) == win, championId=p["championId"] + 500)
    for t in info["teams"]:
        t["win"] = (t["teamId"] == 100) == win
    slots = (list(items) + [0] * 6)[:6]
    info["participants"][0].update(
        championId=champion, teamPosition=position, summoner1Id=spells[0], summoner2Id=spells[1], item6=3340,
        perks={"styles": [{"style": primary, "selections": [{"perk": keystone}]}, {"style": sub, "selections": []}]},
        **{f"item{i}": item for i, item in enumerate(slots)})
    return match


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.db = fixture_db()
        self.addCleanup(self.db.close)


    def add(self, mid, champion, items, win, **kwargs):
        store.save_match(self.db, "FIXTURE", build_match(mid, champion, items, win, subject=f"p-{mid}", **kwargs))

    def build(self, champion=901):
        return stats.champion_build(self.db, champion, "MIDDLE", "16.1", ITEMS)

    def test_save_match_flattens_final_items_runes_and_spells(self):
        self.add("B1", 901, [3031, 0, 1055, 3006], True, spells=(12, 4))
        row = self.db.execute("SELECT items, keystone, primary_style, sub_style, spells FROM builds WHERE puuid = 'p-B1'").fetchone()
        self.assertEqual(tuple(row), ("3031,1055,3006", 8010, 8000, 8400, "4,12"))  # empty slots and the trinket left out
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM builds WHERE match_id = 'B1'").fetchone()[0], 10)

    def test_backfill_restores_builds_in_batches(self):
        for mid in ("B1", "B2"):
            self.add(mid, 901, [3031], True)
        self.db.execute("DELETE FROM builds")
        self.db.commit()
        self.assertEqual(store.backfill_builds(self.db, limit=1), "B1")
        self.assertEqual(store.backfill_builds(self.db, "B1", limit=1), "B2")
        self.assertIsNone(store.backfill_builds(self.db, "B2"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM builds").fetchone()[0], 20)

    def test_core_ranks_by_shrunk_win_rate_and_lists_the_most_built_item_first(self):
        for i in range(12):
            self.add(f"A{i}", 901, [3072, 3031, 3036, 3006, 1055], i < 9)
        for i in range(8):
            self.add(f"C{i}", 901, [3046, 3031, 6672, 3111], i < 2, keystone=8005, spells=(4, 14))
        b = self.build()
        self.assertEqual((b["games"], b["wins"]), (20, 11))
        core = b["core"][0]
        self.assertEqual((core["items"][0], set(core["items"]), core["games"], core["wins"]), (3031, {3031, 3072, 3036}, 12, 9))
        self.assertEqual(set(b["core"][1]["items"]), {3031, 3046, 6672})
        self.assertEqual((b["boots"][0]["item"], b["runes"][0]["keystone"], b["spells"][0]["spells"]), (3006, 8010, [4, 12]))
        self.assertEqual((b["runes"][0]["primary"], b["runes"][0]["secondary"]), (8000, 8400))
        # also built: finished items outside the top core (no starters, boots or core items)
        self.assertEqual({o["item"] for o in b["situational"]}, {3046, 6672})
        self.assertAlmostEqual(b["core"][0]["share"], 12 / 20)

    def test_thin_options_only_show_when_nothing_else_qualifies(self):
        for i in range(10):
            self.add(f"P{i}", 901, [3031, 3072, 3036], i < 5)
        for i in range(4):
            self.add(f"Q{i}", 901, [3046, 6672, 3031], True)  # 4-0, under MIN_BUILD_GAMES
        self.assertEqual([set(c["items"]) for c in self.build()["core"]], [{3031, 3072, 3036}])
        for i in range(4):
            self.add(f"R{i}", 902, [3046, 6672, 3031], True)
        self.assertEqual([(set(c["items"]), c["games"]) for c in self.build(902)["core"]], [({3031, 3046, 6672}, 4)])

    def test_support_items_get_their_own_slot(self):
        for i in range(6):
            self.add(f"S{i}", 901, [3877, 3031, 3072, 3036, 3111], i < 4)
        b = self.build()
        self.assertEqual((b["support"][0]["item"], b["support"][0]["games"], b["support"][0]["wins"]), (3877, 6, 4))
        self.assertNotIn(3877, b["core"][0]["items"] + [o["item"] for o in b["situational"]])

    def test_unknown_champion_has_an_empty_build(self):
        b = self.build(999)
        self.assertEqual((b["games"], b["core"], b["boots"], b["runes"]), (0, [], [], []))


class SuggestedPickTests(BuildTests):
    def test_player_roles_need_a_real_share(self):
        games = [{"position": p} for p in ["MIDDLE"] * 7 + ["TOP"] * 2 + ["UTILITY", ""]]
        self.assertEqual(stats.player_roles(games), [("MIDDLE", 0.7), ("TOP", 0.2)])
        self.assertEqual(stats.player_roles(games, min_share=0.25), [("MIDDLE", 0.7)])
        self.assertEqual(stats.player_roles([]), [])

    def test_picks_rank_by_shrunk_win_rate_with_enough_games(self):
        for champion, games, wins in ((901, 50, 30), (902, 20, 12), (903, 14, 14), (904, 50, 20)):
            for i in range(games):
                self.add(f"{champion}-{i}", champion, [3031, 3072, 3036], i < wins)
        mine = [{"position": "MIDDLE", "champion_id": 902, "win": w} for w in (1, 1, 0)]
        res = stats.suggested_picks(self.db, mine, "GOLD", "16.1", ITEMS, per_role=2)
        self.assertIsNone(res["tier"])  # too few sampled Gold games: every tier
        [role] = res["roles"]
        self.assertEqual((role["role"], role["games"]), ("MIDDLE", 134))
        # 903 is 14-0 but under MIN_PICK_GAMES; 901 (30-20) edges 902 (12-8) once both are shrunk
        self.assertEqual([p["champion_id"] for p in role["picks"]], [901, 902])
        first, second = role["picks"]
        self.assertAlmostEqual(first["pick_share"], 50 / 134)
        self.assertEqual((first["you"]["games"], second["you"]["games"], second["you"]["wins"]), (0, 3, 2))
        self.assertEqual((first["build"]["games"], set(first["build"]["core"][0]["items"])), (50, {3031, 3072, 3036}))

    def test_picks_use_the_players_tier_once_it_has_enough_games(self):
        for i in range(20):
            self.add(f"G{i}", 901, [3031], i < 15)
            store.tag_tier(self.db, f"G{i}", "GOLD")
        for i in range(20):
            self.add(f"S{i}", 902, [3031], i < 18)
        mine = [{"position": "MIDDLE", "champion_id": 901, "win": 1}]
        with mock.patch.object(stats, "MIN_TIER_MATCHES", 10):
            res = stats.suggested_picks(self.db, mine, "GOLD", "16.1", ITEMS)
        self.assertEqual((res["tier"], [p["champion_id"] for p in res["roles"][0]["picks"]]), ("GOLD", [901]))

    def test_tier_population_needs_enough_tier_games_on_the_patch(self):
        for i in range(10):
            self.add(f"G{i}", 901, [3031], True)
            store.tag_tier(self.db, f"G{i}", "GOLD")
        with mock.patch.object(stats, "MIN_TIER_MATCHES", 10):
            self.assertEqual(stats.tier_population(self.db, "GOLD", "16.1"), "GOLD")
            self.assertIsNone(stats.tier_population(self.db, "SILVER", "16.1"))
            self.assertIsNone(stats.tier_population(self.db, "GOLD", "16.2"))
            self.assertIsNone(stats.tier_population(self.db, None, "16.1"))
        with mock.patch.object(stats, "MIN_TIER_MATCHES", 11):
            self.assertIsNone(stats.tier_population(self.db, "GOLD", "16.1"))


def league(tier="GOLD", division="II", lp=40, wins=10, losses=8):
    return {"queueType": "RANKED_SOLO_5x5", "tier": tier, "rank": division, "leaguePoints": lp, "wins": wins, "losses": losses}


class RankHistoryTests(unittest.TestCase):
    def setUp(self):
        self.db = fixture_db()
        self.addCleanup(self.db.close)

    def history(self, puuid="p1", since=0):
        return [(r["at"], r["tier"], r["division"], r["lp"]) for r in store.rank_history(self.db, puuid, since)]

    def test_only_changes_are_recorded_and_unranked_is_not(self):
        self.assertTrue(store.save_rank(self.db, "p1", league(lp=40), at=100))
        self.assertFalse(store.save_rank(self.db, "p1", league(lp=40), at=200))  # unchanged
        self.assertTrue(store.save_rank(self.db, "p1", league(lp=58, wins=11), at=300))
        self.assertFalse(store.save_rank(self.db, "p1", {}, at=400))
        self.assertEqual(self.history(), [(100, "GOLD", "II", 40), (300, "GOLD", "II", 58)])
        self.assertEqual(self.history(since=200), [(300, "GOLD", "II", 58)])

    def test_lookups_and_background_checks_both_record_and_stamp_the_check(self):
        store.save_player(self.db, "p1", "Name", "TAG", "euw1", league(lp=40))
        self.db.execute("UPDATE rank_history SET at = 100")  # the lookup was a while before the check
        looked_up = store.get_player(self.db, "p1")
        self.assertIsNotNone(looked_up["rank_checked"])
        store.update_rank(self.db, "p1", league(tier="PLATINUM", division="IV", lp=0, wins=11))
        player = store.get_player(self.db, "p1")
        self.assertEqual((player["tier"], player["division"], player["lp"], player["wins"]), ("PLATINUM", "IV", 0, 11))
        self.assertEqual(player["updated"], looked_up["updated"])  # a background check isn't a lookup
        self.assertEqual([r[1:] for r in self.history()][-2:], [("GOLD", "II", 40), ("PLATINUM", "IV", 0)])

    def test_tracked_players_are_linked_or_recently_looked_up(self):
        for puuid, updated in (("recent", 1000), ("stale", 10), ("linked", 10)):
            store.save_player(self.db, puuid, puuid, "TAG", "euw1", {})
            self.db.execute("UPDATE players SET updated = ? WHERE puuid = ?", (updated, puuid))
        self.assertEqual(sorted(r[0] for r in store.tracked_players(self.db, {"linked"}, since=500)), ["linked", "recent"])
        self.assertEqual([r[0] for r in store.tracked_players(self.db, set(), since=500)], ["recent"])


class StreamingStatsTests(unittest.TestCase):
    def test_lead_curve_consumes_one_pass_without_retaining_population_rows(self):
        rows = ((1000 if i % 2 else -1000, i % 2) for i in range(100_000))
        tracemalloc.start()
        try:
            curve = stats.lead_curve(rows)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(sum(b["games"] for b in curve), 100_000)
        self.assertEqual([(b["games"], b["wins"]) for b in curve],
                         [(0, 0), (50_000, 0), (0, 0), (50_000, 50_000), (0, 0)])
        self.assertLess(peak, 512 * 1024, "Population rows must not be materialized in Python")

    def test_builds_aggregate_a_cursor_instead_of_a_full_row_list(self):
        rows = (("3031,3072,3036,3006", 8010, 8000, 8400, "4,12", i % 2) for i in range(10_000))
        db = SimpleNamespace(in_transaction=True, execute=lambda sql, args: rows)
        tracemalloc.start()
        try:
            build = stats.champion_build(db, 901, "MIDDLE", "16.1", ITEMS)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual((build["games"], build["wins"]), (10_000, 5_000))
        self.assertEqual(build["core"][0]["games"], 10_000)
        self.assertLess(peak, 512 * 1024, "Build rows must not be materialized in Python")

    def test_database_cache_targets_small_ram_and_temporary_work_uses_disk(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(store, "DB_PATH", Path(directory) / "cache.db"):
            db = store.connect()
            try:
                self.assertEqual(db.execute("PRAGMA cache_size").fetchone()[0], -2048)
                self.assertEqual(db.execute("PRAGMA temp_store").fetchone()[0], 1)
                self.assertEqual(db.execute("PRAGMA mmap_size").fetchone()[0], 0)
            finally:
                db.close()

    def test_build_and_ban_backfills_never_fetchall_raw_blobs(self):
        db = fixture_db()
        self.addCleanup(db.close)
        for mid in ("B1", "B2", "B3"):
            store.save_match(db, "FIXTURE", build_match(mid, 901, [3031], True))
        db.execute("DELETE FROM builds")
        db.execute("DELETE FROM bans")
        db.commit()

        class Cursor:
            def __init__(self, inner):
                self.inner = inner

            def __iter__(self):
                return iter(self.inner)

            def fetchone(self):
                return self.inner.fetchone()

            def fetchall(self):
                raise AssertionError("Backfill must stream, not fetchall")

        class Connection:
            def execute(self, *args):
                return Cursor(db.execute(*args))

            def commit(self):
                db.commit()

        streamed = Connection()
        self.assertEqual(store.backfill_builds(streamed, limit=2), "B2")
        self.assertEqual(store.backfill_builds(streamed, after="B2", limit=2), "B3")
        store.backfill_bans(streamed)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM builds").fetchone()[0], 30)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM bans").fetchone()[0], 6)
        scan = next(sql for sql, _ in db.queries if "match_id > ?" in sql)
        self.assertNotIn("raw", scan, "The batch keeps IDs only; JSON is decoded one match at a time")


class SnapshotTests(MemoryTests):
    def test_owned_snapshot_is_explicit_and_released(self):
        with store.read_snapshot(self.db):
            self.assertTrue(self.db.in_transaction)
            self.db.execute("SELECT COUNT(*) FROM matches").fetchone()
        self.assertFalse(self.db.in_transaction)
        self.assertIn(("BEGIN", ()), self.db.queries)

    def test_nested_snapshot_does_not_end_outer_transaction(self):
        with store.read_snapshot(self.db):
            with store.read_snapshot(self.db):
                self.db.execute("SELECT COUNT(*) FROM matches").fetchone()
            self.assertTrue(self.db.in_transaction)
        self.assertFalse(self.db.in_transaction)
        self.assertEqual(sum(sql == "BEGIN" for sql, _ in self.db.queries), 1)

    def test_owned_snapshot_released_on_exception(self):
        with (
            self.assertRaisesRegex(RuntimeError, "fixture failure"),
            store.read_snapshot(self.db),
        ):
            raise RuntimeError("fixture failure")
        self.assertFalse(self.db.in_transaction)

    def test_composite_functions_preserve_caller_writes(self):
        save_fixture(self.db, "FIXTURE_PENDING")
        self.db.execute("INSERT INTO mastery VALUES (?,?,?,?,?)", ("fixture-player", 1, 3, 500, 1))
        games = stats.attach_gold(self.db, stats.player_games(self.db, "fixture-player"), "fixture-player")
        calls = (
            lambda: stats.patch_overview(self.db, "16.1"),
            lambda: stats.champions_vs_rank(self.db, games, "fixture-player", "GOLD"),
            lambda: stats.player_leads(self.db, games, "fixture-player", "GOLD"),
            lambda: stats.mastery(self.db, "fixture-player", games),
        )
        for call in calls:
            call()
            self.assertTrue(self.db.in_transaction)
        self.assertEqual(stats.mastery(self.db, "fixture-player", games)["total_points"], 500)
        self.db.rollback()
        self.assertFalse(store.has_match(self.db, "FIXTURE_PENDING"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM mastery").fetchone()[0], 0)

    def test_caller_transaction_is_preserved_on_statistics_exception(self):
        save_fixture(self.db, "FIXTURE_PENDING")
        with (
            mock.patch.object(stats, "winrate", side_effect=RuntimeError("fixture failure")),
            self.assertRaisesRegex(RuntimeError, "fixture failure"),
        ):
            stats.patch_overview(self.db, "16.1")
        self.assertTrue(self.db.in_transaction)
        self.assertTrue(store.has_match(self.db, "FIXTURE_PENDING"))
        self.db.rollback()
        self.assertFalse(store.has_match(self.db, "FIXTURE_PENDING"))

    def test_composite_snapshot_is_released_on_statistics_exception(self):
        save_fixture(self.db, "FIXTURE_1")
        self.db.commit()
        with (
            mock.patch.object(stats, "winrate", side_effect=RuntimeError("fixture failure")),
            self.assertRaisesRegex(RuntimeError, "fixture failure"),
        ):
            stats.patch_overview(self.db, "16.1")
        self.assertFalse(self.db.in_transaction)

    def test_player_leads_reflects_rollback_without_cached_rows(self):
        save_fixture(self.db, "FIXTURE_PENDING")
        result = stats.player_leads(self.db, [], "fixture-observer", "GOLD")
        self.assertEqual(result["rank_games"], 1)

        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertEqual(stats.player_leads(self.db, [], "fixture-observer", "GOLD")["rank_games"], 0)

    def test_connect_closes_connection_when_initialization_fails(self):
        db = mock.Mock()
        db.executescript.side_effect = sqlite3.OperationalError("fixture schema failure")
        with (
            mock.patch.object(store.sqlite3, "connect", return_value=db),
            self.assertRaisesRegex(sqlite3.OperationalError, "fixture schema failure"),
        ):
            store.connect()
        db.close.assert_called_once_with()


class ConcurrentSnapshotTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="data-test-", dir=ROOT)
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / "fixture.sqlite")
        self.writer = fixture_db(self.path)
        self.addCleanup(self.writer.close)
        save_fixture(self.writer, "FIXTURE_1")
        self.writer.commit()
        self.reader = fixture_db(self.path)
        self.addCleanup(self.reader.close)

        self.injected = False

    def inject_match_before(self, marker):
        def inject(sql, parameters):
            if marker in sql and not self.injected:
                self.injected = True
                save_fixture(self.writer, "FIXTURE_2")
                self.writer.commit()
        self.reader.before_execute = inject

    def test_patch_overview_does_not_mix_denominator_and_new_rows(self):
        self.inject_match_before("SELECT mt.tier, COUNT(*)")
        result = stats.patch_overview(self.reader, "16.1")
        self.assertTrue(self.injected)
        self.assertEqual(result["matches"], 1)
        self.assertEqual(result["blue_side"]["games"], 1)
        self.assertEqual(result["tiers"], [{"tier": "GOLD", "matches": 1}])
        for row in result["champions"]:
            self.assertLessEqual(row["pick_rate"], 1)
            self.assertLessEqual(row["ban_rate"], 1)
        self.assertFalse(self.reader.in_transaction)
        self.assertEqual(self.reader.execute("SELECT COUNT(*) FROM matches").fetchone()[0], 2)

    def test_champion_baseline_and_sample_count_share_snapshot(self):
        self.inject_match_before("SELECT COUNT(*) FROM match_tier")
        games = [{"champion_id": 1, "win": 1}]
        result = stats.champions_vs_rank(self.reader, games, "fixture-observer", "GOLD")
        self.assertTrue(self.injected)
        self.assertEqual(result["sample_matches"], 1)
        self.assertEqual(result["rows"][0]["baseline"]["games"], 1)
        self.assertFalse(self.reader.in_transaction)

    def test_player_leads_filters_own_matches_from_same_snapshot(self):
        def change_player(sql, parameters):
            if "SELECT match_id FROM participants WHERE puuid" in sql and not self.injected:
                self.injected = True
                self.writer.execute("UPDATE participants SET puuid=? WHERE match_id=? AND puuid=?",
                                    ("fixture-observer", "FIXTURE_1", "fixture-player"))
                self.writer.commit()
        self.reader.before_execute = change_player
        result = stats.player_leads(self.reader, [], "fixture-observer", "GOLD")
        self.assertTrue(self.injected)
        # Exclusion and gold now share one query: a commit before that query is visible to both.
        self.assertEqual(result["rank_games"], 0)
        self.assertFalse(self.reader.in_transaction)


class GoldTests(MemoryTests):
    def test_empty_games_do_not_query_database(self):
        self.db.queries.clear()
        games = []
        self.assertIs(stats.attach_gold(self.db, games, "fixture-player"), games)
        self.assertEqual(self.db.queries, [])

    def test_only_supplied_matches_are_read_and_gold_is_correct(self):
        save_fixture(self.db, "FIXTURE_SELECTED")
        save_fixture(self.db, "FIXTURE_OTHER")
        self.db.commit()
        games = [g for g in stats.player_games(self.db, "fixture-player")
                 if g["match_id"] == "FIXTURE_SELECTED"]
        fetched = []
        def record_frames(cursor, row):
            if [col[0] for col in cursor.description] == ["match_id", "puuid", "team_id", "position", "gold"]:
                fetched.append(row[0])
            return sqlite3.Row(cursor, row)
        self.db.row_factory = record_frames
        self.assertIs(stats.attach_gold(self.db, games, "fixture-player"), games)
        self.assertEqual(fetched, ["FIXTURE_SELECTED"] * 10)
        self.assertEqual(games[0]["team_diff15"], 5000)
        self.assertEqual(games[0]["lane_diff15"], 1000)
        self.assertFalse(self.db.in_transaction)

    def test_incomplete_frames_do_not_produce_a_gold_difference(self):
        save_fixture(self.db, "FIXTURE_INCOMPLETE")
        self.db.execute("DELETE FROM frames WHERE match_id=? AND puuid=? AND minute=15",
                        ("FIXTURE_INCOMPLETE", "FIXTURE_INCOMPLETE-player-9"))
        self.db.commit()
        games = stats.player_games(self.db, "fixture-player")
        stats.attach_gold(self.db, games, "fixture-player")
        self.assertIsNone(games[0]["team_diff15"])
        self.assertIsNone(games[0]["lane_diff15"])

    def test_large_ranges_are_batched_below_legacy_variable_limit(self):
        self.db.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 999)
        games = [{"match_id": f"FIXTURE_{i}", "team_id": 100, "position": "TOP"}
                 for i in range(1001)]
        self.db.queries.clear()
        stats.attach_gold(self.db, games, "fixture-player")
        queries = [(sql, params) for sql, params in self.db.queries if "FROM frames f" in sql]
        self.assertEqual(len(queries), 3)
        self.assertTrue(all(len(params) <= 501 for _, params in queries))
        self.assertTrue(all(g["team_diff15"] is None for g in games))
        self.assertFalse(self.db.in_transaction)


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.db = fixture_db()
        self.addCleanup(self.db.close)
        self.connect = mock.Mock(return_value=self.db)
        for patch in (
            mock.patch.object(store, "connect", self.connect),
            mock.patch.object(history, "jobs", {}),
            mock.patch.object(history, "_incidental", None),
            mock.patch.object(history.log, "exception"),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def job_status(self, puuid: str = "fixture-player"):
        result = history.status(puuid)
        assert result is not None, f"No sync status for {puuid}"
        return result

    async def test_fetch_failure_commits_successes_and_reports_failed_id(self):
        client = FakeClient({"FIXTURE_GOOD": match_fixture("FIXTURE_GOOD"),
                             "FIXTURE_BAD": RuntimeError("fixture upstream failure")})
        with self.assertRaises(history.FetchChunkError) as caught:
            await history.fetch_chunk(client, self.db, "FIXTURE", client.ids, "GOLD", timelines=False)
        self.assertEqual(caught.exception.completed, 1)
        self.assertIn("match FIXTURE_BAD", str(caught.exception))
        self.assertIn("fixture upstream failure", str(caught.exception))
        self.assertTrue(store.has_match(self.db, "FIXTURE_GOOD"))
        self.assertFalse(store.has_match(self.db, "FIXTURE_BAD"))
        self.assertEqual(self.db.execute("SELECT tier FROM match_tier").fetchone()[0], "GOLD")
        self.assertFalse(self.db.in_transaction)
        self.assertFalse(self.db.closed)

    async def test_timeline_failure_preserves_matches_and_other_timelines(self):
        good, bad = match_fixture("FIXTURE_GOOD"), match_fixture("FIXTURE_BAD")
        client = FakeClient({"FIXTURE_GOOD": good, "FIXTURE_BAD": bad},
                            {"FIXTURE_GOOD": timeline_fixture(good), "FIXTURE_BAD": RuntimeError("timeline failed")})
        with self.assertRaises(history.FetchChunkError) as caught:
            await history.fetch_chunk(client, self.db, "FIXTURE", client.ids, "GOLD")
        self.assertEqual(caught.exception.completed, 1)
        self.assertIn("timeline FIXTURE_BAD", str(caught.exception))
        self.assertTrue(all(store.has_match(self.db, mid) for mid in client.ids))
        self.assertTrue(store.has_timeline(self.db, "FIXTURE_GOOD"))
        self.assertFalse(store.has_timeline(self.db, "FIXTURE_BAD"))
        self.assertFalse(self.db.in_transaction)

    async def test_malformed_match_rolls_back_only_its_partial_rows(self):
        bad = match_fixture("FIXTURE_BAD")
        del bad["info"]["participants"][1]["goldEarned"]
        client = FakeClient({"FIXTURE_GOOD": match_fixture("FIXTURE_GOOD"), "FIXTURE_BAD": bad})
        with self.assertRaises(history.FetchChunkError) as caught:
            await history.fetch_chunk(client, self.db, "FIXTURE", client.ids, "GOLD", timelines=False)
        self.assertEqual(caught.exception.completed, 1)
        self.assertIn("FIXTURE_BAD", str(caught.exception))
        self.assertIn("goldEarned", str(caught.exception))
        self.assertTrue(store.has_match(self.db, "FIXTURE_GOOD"))
        self.assertFalse(store.has_match(self.db, "FIXTURE_BAD"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM participants WHERE match_id='FIXTURE_BAD'").fetchone()[0], 0)
        self.assertFalse(self.db.in_transaction)

    async def test_malformed_timeline_rolls_back_marker_and_partial_frames(self):
        match = match_fixture("FIXTURE_1")
        store.save_match(self.db, "FIXTURE", match)
        self.db.commit()
        timeline = timeline_fixture(match)
        del timeline["info"]["frames"][15]["participantFrames"]["2"]["totalGold"]
        client = FakeClient(timelines={"FIXTURE_1": timeline}, ids=["FIXTURE_1"])
        with self.assertRaises(history.FetchChunkError) as caught:
            await history.fetch_chunk(client, self.db, "FIXTURE", client.ids, "GOLD")
        self.assertEqual(caught.exception.completed, 0)
        self.assertFalse(store.has_timeline(self.db, "FIXTURE_1"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM frames").fetchone()[0], 0)
        self.assertFalse(self.db.in_transaction)

    async def test_wrong_match_id_and_nonobject_results_are_reported(self):
        client = FakeClient({"FIXTURE_WRONG": match_fixture("FIXTURE_UNREQUESTED"), "FIXTURE_LIST": []})
        with self.assertRaises(history.FetchChunkError) as caught:
            await history.fetch_chunk(client, self.db, "FIXTURE", client.ids, None, timelines=False)
        self.assertEqual(caught.exception.completed, 0)
        self.assertEqual(len(caught.exception.errors), 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM matches").fetchone()[0], 0)
        self.assertFalse(self.db.in_transaction)

    async def test_chunk_write_failure_rolls_back_without_closing_caller_connection(self):
        client = FakeClient({"FIXTURE_1": match_fixture("FIXTURE_1")})
        with (
            mock.patch.object(store, "tag_tier", side_effect=sqlite3.OperationalError("fixture write failure")),
            self.assertRaisesRegex(sqlite3.OperationalError, "fixture write failure"),
        ):
            await history.fetch_chunk(client, self.db, "FIXTURE", client.ids, "GOLD", timelines=False)
        self.assertFalse(store.has_match(self.db, "FIXTURE_1"))
        self.assertFalse(self.db.in_transaction)
        self.assertFalse(self.db.closed)
        self.db.execute("INSERT INTO match_tier VALUES (?,?)", ("FIXTURE_NEXT", "GOLD"))
        self.db.commit()

    async def test_chunk_cancellation_rolls_back_pending_transaction(self):
        started = asyncio.Event()
        async def wait_for_cancel(platform, mid):
            started.set()
            await asyncio.Event().wait()
        client = FakeClient(ids=["FIXTURE_1"])
        client.match = wait_for_cancel
        task = asyncio.create_task(history.fetch_chunk(client, self.db, "FIXTURE", client.ids, "GOLD", timelines=False))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.db.in_transaction)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM match_tier").fetchone()[0], 0)
        self.assertFalse(self.db.closed)

    async def test_failed_job_reports_partial_progress_and_closes_database(self):
        client = FakeClient({"FIXTURE_GOOD": match_fixture("FIXTURE_GOOD"), "FIXTURE_BAD": RuntimeError("fetch failed")})
        await history.start(client, "FIXTURE", "fixture-player", "GOLD", history.last_n(2), timelines=False)
        result = self.job_status()
        self.assertEqual((result["phase"], result["done"], result["total"]), ("matches", 1, 2))
        self.assertIn("FIXTURE_BAD", result["error"])
        self.assertFalse(result["running"])
        self.assertTrue(history.jobs["fixture-player"]["matches_ready"].is_set())
        self.assertTrue(self.db.closed)

    async def test_successful_job_closes_database(self):
        client = FakeClient({"FIXTURE_1": match_fixture("FIXTURE_1")})
        await history.start(client, "FIXTURE", "fixture-player", "GOLD", history.last_n(1), timelines=False)
        result = self.job_status()
        self.assertEqual((result["phase"], result["done"], result["total"]), ("done", 1, 1))
        self.assertIsNone(result["error"])
        self.assertFalse(result["running"])
        self.assertTrue(self.db.closed)

    async def test_run_write_failure_releases_lock_without_garbage_collection(self):
        directory = tempfile.TemporaryDirectory(prefix="data-test-", dir=ROOT)
        self.addCleanup(directory.cleanup)
        path = str(Path(directory.name) / "fixture.sqlite")
        db = fixture_db(path)
        self.addCleanup(db.close)
        save_fixture(db, "FIXTURE_1", timeline=False)
        db.commit()
        self.connect.return_value = db
        def failed_tag(db, mid, tier):
            db.execute("INSERT INTO mastery VALUES (?,?,?,?,?)", ("fixture-player", 1, 1, 1, 1))
            raise RuntimeError("fixture tag failure")
        with mock.patch.object(store, "tag_tier", side_effect=failed_tag):
            await history.start(FakeClient(ids=["FIXTURE_1"]), "FIXTURE", "fixture-player", "GOLD",
                                history.last_n(1), timelines=False)
        self.assertTrue(db.closed)
        self.assertGreater(db.rollback_count, 0)
        self.assertIn("fixture tag failure", self.job_status()["error"])
        observer = fixture_db(path)
        self.addCleanup(observer.close)
        self.assertEqual(observer.execute("SELECT COUNT(*) FROM mastery").fetchone()[0], 0)
        observer.execute("INSERT INTO match_tier VALUES (?,?)", ("FIXTURE_NEXT", "GOLD"))
        observer.commit()

    async def test_queued_cancellation_finalizes_job_without_connecting(self):
        history._incidental = asyncio.Semaphore(0)
        task = history.start(FakeClient(), "FIXTURE", "fixture-player", "GOLD", history.last_n(1),
                             replace=False, timelines=False)
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        job = history.jobs["fixture-player"]
        self.assertEqual(job["phase"], "cancelled")
        self.assertFalse(job["running"])
        self.assertTrue(job["matches_ready"].is_set())
        self.assertGreater(job["finished"], 0)
        self.assertFalse(history.any_running())
        self.connect.assert_not_called()
        self.assertEqual(history._incidental._value, 0)

    async def test_cancellation_before_first_run_finalizes_job(self):
        task = history.start(FakeClient(), "FIXTURE", "fixture-player", "GOLD", history.last_n(1),
                             replace=False, timelines=False)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        self.assertEqual(self.job_status()["phase"], "cancelled")
        self.assertFalse(history.any_running())
        self.assertTrue(history.jobs["fixture-player"]["matches_ready"].is_set())
        self.connect.assert_not_called()

    async def test_active_cancellation_closes_database_and_releases_slot(self):
        history._incidental = asyncio.Semaphore(1)
        started = asyncio.Event()
        async def wait_for_cancel(platform, mid):
            started.set()
            await asyncio.Event().wait()
        client = FakeClient(ids=["FIXTURE_1"])
        client.match = wait_for_cancel
        task = history.start(client, "FIXTURE", "fixture-player", "GOLD", history.last_n(1),
                             replace=False, timelines=False)
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.db.closed)
        self.assertFalse(history.any_running())
        self.assertEqual(self.job_status()["phase"], "cancelled")
        await asyncio.wait_for(history._incidental.acquire(), 1)
        history._incidental.release()

    async def test_incidental_failure_is_not_subject_to_success_cooldown(self):
        failed = history.start(FakeClient(listing_error=RuntimeError("listing failed")), "FIXTURE",
                               "fixture-player", "GOLD", history.last_n(1), replace=False, timelines=False)
        await failed
        self.assertIn("listing failed", self.job_status()["error"])
        retry = history.start(FakeClient(), "FIXTURE", "fixture-player", "GOLD", history.last_n(1),
                              replace=False, timelines=False)
        self.assertIsNot(retry, failed)
        await retry
        self.assertEqual(self.job_status()["phase"], "done")

    async def test_successful_incidental_job_observes_cooldown(self):
        client = FakeClient()
        first = history.start(client, "FIXTURE", "fixture-player", "GOLD", history.last_n(1),
                              replace=False, timelines=False)
        await first
        second = history.start(client, "FIXTURE", "fixture-player", "GOLD", history.last_n(1),
                               replace=False, timelines=False)
        self.assertIs(second, first)
        self.assertEqual(client.calls, [("ids", "fixture-player")])

    async def test_paused_job_is_closed_and_not_subject_to_success_cooldown(self):
        client = FakeClient({"FIXTURE_1": match_fixture("FIXTURE_1")})
        with mock.patch.object(history, "ORPHAN_AFTER", -1):
            paused = history.start(client, "FIXTURE", "fixture-player", "GOLD", history.last_n(1), timelines=False)
            await paused
        self.assertEqual(self.job_status()["phase"], "paused")
        self.assertTrue(self.db.closed)
        retry_db = fixture_db()
        self.addCleanup(retry_db.close)
        self.connect.return_value = retry_db
        retry = history.start(FakeClient(), "FIXTURE", "fixture-player", "GOLD", history.last_n(1),
                              replace=False, timelines=False)
        self.assertIsNot(retry, paused)
        await retry
        self.assertEqual(self.job_status()["phase"], "done")


if __name__ == "__main__":
    unittest.main()
