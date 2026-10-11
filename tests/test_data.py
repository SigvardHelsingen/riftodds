import asyncio
import copy
import sqlite3
import tempfile
import unittest
from collections.abc import Callable, Sequence
from pathlib import Path
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
    db.executescript(store.SCHEMA)
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
        self.memo_patch = mock.patch.object(stats, "_memo", {})
        self.memo_patch.start()
        self.addCleanup(self.memo_patch.stop)


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

    def test_player_leads_does_not_memoize_uncommitted_rows(self):
        save_fixture(self.db, "FIXTURE_PENDING")
        result = stats.player_leads(self.db, [], "fixture-observer", "GOLD")
        self.assertEqual(result["rank_games"], 1)
        self.assertEqual(stats._memo, {})
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
        patch = mock.patch.object(stats, "_memo", {})
        patch.start()
        self.addCleanup(patch.stop)
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
        self.assertEqual(result["rank_games"], 1)
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
        self.db.execute("INSERT INTO match_tier VALUES (?,?)", ("FIXTURE_PENDING", "GOLD"))
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
