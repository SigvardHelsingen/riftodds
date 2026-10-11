import asyncio
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack, closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx

import config
import test_data

# Import definitions without loading the real env file or starting the lifespan.
with patch.object(config, "load_env"), patch.dict(os.environ, {
    "SAMPLER": "0", "SESSION_COOKIE_SECURE": "auto",
    "SEASON_START": "2026-01-08", "TIMELINE_LIMIT": "100",
}):
    import main


class TrackedConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.closed = False
        self.closed_in_transaction = None
        self.trace = []
        self.set_trace_callback(self.trace.append)

    def close(self):
        if not self.closed:
            self.closed_in_transaction = self.in_transaction
            super().close()
            self.closed = True


def fixture_db(path):
    db = sqlite3.connect(path, factory=TrackedConnection)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS matches (
            match_id TEXT PRIMARY KEY, patch TEXT, queue_id INTEGER, remake INTEGER
        );
        CREATE TABLE IF NOT EXISTS timelines (match_id TEXT PRIMARY KEY);
    """)
    return db


class BackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(main.state, {"sampler": {"status": "off"}, "live": {}, "last_activity": 0}, clear=True))
        self.user_for = self.stack.enter_context(patch.object(main.auth, "user_for", return_value="alice"))
        self.stack.enter_context(patch.object(main.auth, "connect", side_effect=AssertionError("Real auth DB access forbidden")))
        self.store_connect = self.stack.enter_context(patch.object(main.store, "connect", side_effect=AssertionError("Real cache DB access forbidden")))
        self.transport = httpx.ASGITransport(app=main.app, client=("192.0.2.10", 12345))
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test", cookies={main.auth.COOKIE: "dummy-session"})

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_session_lookup_runs_off_event_loop(self):
        threads = []

        def lookup(token):
            threads.append(threading.get_ident())
            return "alice"

        self.user_for.side_effect = lookup
        with patch.object(main, "linked_account", return_value=None):
            response = await self.client.get("/api/me")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["username"], "alice")
        self.assertTrue(threads)
        self.assertNotEqual(threads[0], threading.get_ident())
        self.user_for.assert_called_once_with("dummy-session")

    async def test_index_versions_assets_and_is_revalidated(self):
        response = await self.client.get("/")
        self.assertEqual(response.headers["cache-control"], "no-cache")
        self.assertRegex(response.text, r'src="/static/app\.js\?v=[0-9a-f]{12}"')
        self.assertRegex(response.text, r'href="/static/style\.css\?v=[0-9a-f]{12}"')

    async def test_missing_session_still_returns_401(self):
        self.user_for.return_value = None
        response = await self.client.get("/api/meta")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"detail": "Not logged in"})

    async def test_sample_rejects_invalid_platform_before_outbound_calls(self):
        riot = SimpleNamespace(tier_players=AsyncMock())
        main.state["riot"] = riot
        for platform in ("attacker.invalid/", "euw1@attacker.invalid/", "unknown", "EUW1"):
            with self.subTest(platform=platform):
                response = await self.client.post("/api/sample", params={"platform": platform, "tier": "GOLD"})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["detail"], "Unknown platform")
        riot.tier_players.assert_not_awaited()

    async def test_sample_accepts_known_platform(self):
        riot = SimpleNamespace(tier_players=AsyncMock(return_value=[]), match_ids=AsyncMock())
        main.state["riot"] = riot
        with patch.object(main, "fetch_matches", new_callable=AsyncMock, return_value=0):
            response = await self.client.post("/api/sample", params={"platform": "euw1", "tier": "gold", "division": "I"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["tier"], "GOLD")
        self.assertEqual(riot.tier_players.await_count, 2)
        riot.match_ids.assert_not_awaited()

    async def test_sample_partial_fetch_failure_returns_502_and_preserves_valid_results(self):
        def match(platform, mid):
            if mid == "BAD":
                raise main.RiotError(503, "simulated upstream outage")
            return {"metadata": {"matchId": mid}}

        riot = SimpleNamespace(
            tier_players=AsyncMock(return_value=["dummy-puuid"]),
            match_ids=AsyncMock(return_value=["GOOD", "BAD"]),
            match=AsyncMock(side_effect=match),
            timeline=AsyncMock(return_value=None),
        )
        main.state["riot"] = riot

        def has_match(db, mid):
            return db.execute("SELECT 1 FROM matches WHERE match_id = ?", (mid,)).fetchone() is not None

        def has_timeline(db, mid):
            return db.execute("SELECT 1 FROM timelines WHERE match_id = ?", (mid,)).fetchone() is not None

        def save_match(db, platform, raw):
            db.execute("INSERT INTO matches VALUES (?, '26.20', 420, 0)", (raw["metadata"]["matchId"],))

        def save_timeline(db, mid, raw):
            db.execute("INSERT INTO timelines VALUES (?)", (mid,))

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.sqlite"
            with closing(fixture_db(path)) as db:
                self.store_connect.side_effect = None
                self.store_connect.return_value = db
                with patch.object(main.store, "has_match", side_effect=has_match), patch.object(main.store, "has_timeline", side_effect=has_timeline), patch.object(main.store, "save_match", side_effect=save_match), patch.object(main.store, "save_timeline", side_effect=save_timeline), patch.object(main.store, "tag_tier"):
                    response = await self.client.post("/api/sample", params={"platform": "euw1", "tier": "GOLD", "division": "I", "players": 1})
                self.assertEqual(response.status_code, 502)
                detail = response.json()["detail"]
                self.assertIn("cached", detail)
                self.assertIn("retry", detail)
                self.assertIn("BAD", detail)
                self.assertTrue(db.closed)
                self.assertFalse(db.closed_in_transaction)
            with closing(sqlite3.connect(path)) as check:
                self.assertEqual(check.execute("SELECT match_id FROM matches").fetchall(), [("GOOD",)])
                self.assertEqual(check.execute("SELECT match_id FROM timelines").fetchall(), [("GOOD",)])

    async def test_fetch_matches_closes_connection_on_success(self):
        db, cached = Mock(), {"old"}
        self.store_connect.side_effect = None
        self.store_connect.return_value = db

        async def fetch(riot, connection, platform, ids, tier):
            self.assertIs(connection, db)
            cached.update(ids)

        with patch.object(main.store, "has_match", side_effect=lambda db, mid: mid in cached), patch.object(main.history, "fetch_chunk", side_effect=fetch):
            fetched = await main.fetch_matches(object(), "euw1", ["old", "new"], "GOLD", chunk=1)
        self.assertEqual(fetched, 1)
        db.close.assert_called_once_with()

    async def test_fetch_matches_closes_connection_on_cancellation(self):
        db = Mock()
        self.store_connect.side_effect = None
        self.store_connect.return_value = db
        with patch.object(main.store, "has_match", return_value=False), patch.object(main.history, "fetch_chunk", new_callable=AsyncMock, side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await main.fetch_matches(object(), "euw1", ["dummy"], "GOLD")
        db.close.assert_called_once_with()

    async def test_fetch_matches_closes_connection_on_cache_read_errors(self):
        for results in ([RuntimeError("read failed")], [False, RuntimeError("read failed")]):
            with self.subTest(results=results):
                db = Mock()
                self.store_connect.side_effect = None
                self.store_connect.return_value = db
                with patch.object(main.store, "has_match", side_effect=results), patch.object(main.history, "fetch_chunk", new_callable=AsyncMock):
                    with self.assertRaisesRegex(RuntimeError, "read failed"):
                        await main.fetch_matches(object(), "euw1", ["dummy"], "GOLD")
                db.close.assert_called_once_with()

    async def test_credential_lengths_are_validated_before_authentication(self):
        valid = {"username": "alice", "password": "valid-password"}
        cases = [{**valid, "username": ""}, {**valid, "username": "a" * (main.auth.MAX_USERNAME_LENGTH + 1)},
                 {**valid, "password": "short"}, {**valid, "password": "p" * (main.auth.MAX_PASSWORD_LENGTH + 1)}]
        with patch.object(main.auth, "login") as login:
            for body in cases:
                response = await self.client.post("/api/login", json=body)
                self.assertEqual(response.status_code, 422)
        login.assert_not_called()

    async def test_cookie_setting_and_client_identity(self):
        for setting, scheme, secure in (("auto", "http", False), ("auto", "https", True),
                                         ("1", "http", True), ("0", "https", False)):
            with self.subTest(setting=setting, scheme=scheme):
                with patch.object(main, "SESSION_COOKIE_SECURE", setting), patch.object(main.auth, "login", return_value="dummy-token") as login:
                    async with httpx.AsyncClient(transport=self.transport, base_url=f"{scheme}://test") as client:
                        response = await client.post("/api/login", json={"username": " alice ", "password": "valid-password"}, headers={"X-Forwarded-For": "attacker.invalid"})
                self.assertEqual(response.status_code, 200)
                cookie = response.headers["set-cookie"].lower()
                self.assertEqual("; secure" in cookie, secure)
                self.assertIn("httponly", cookie)
                self.assertIn("samesite=lax", cookie)
                login.assert_called_once_with("alice", "valid-password", client="192.0.2.10")

    async def test_riot_key_errors_are_not_session_401_or_403(self):
        self.store_connect.side_effect = None
        self.store_connect.return_value = object()
        with patch.object(main.store, "find_player", return_value=None):
            for status in (401, 403):
                main.state["riot"] = SimpleNamespace(account=AsyncMock(side_effect=main.RiotError(status, "rejected")))
                response = await self.client.get("/api/player", params={"platform": "euw1", "riot_id": "Test#EUW"})
                self.assertEqual(response.status_code, 502)
                self.assertIn("Riot API key rejected", response.json()["detail"])
        self.assertEqual(main.riot_errors(main.RiotError(404, "missing")).status_code, 404)

    async def test_pick_alpha_must_be_finite_and_nonnegative(self):
        with patch.object(main.stats, "pick_probabilities", return_value={"ok": True}) as pick, patch.object(main.stats, "player_games", return_value=[]), patch.object(main.history, "resolve", return_value={}), patch.object(main.history, "window", return_value=[]):
            for alpha in ("-1", "nan", "inf", "-inf"):
                response = await self.client.get("/api/pick", params={"puuid": "dummy", "role": "TOP", "alpha": alpha})
                self.assertEqual(response.status_code, 422)
            pick.assert_not_called()
            self.store_connect.assert_not_called()
            self.store_connect.side_effect = None
            self.store_connect.return_value = object()
            response = await self.client.get("/api/pick", params={"puuid": "dummy", "role": "TOP", "alpha": "0"})
            self.assertEqual(response.status_code, 200)
            pick.assert_called_once_with([], "TOP", None, 0.0)

    async def check_key_rotation(self, status=None):
        db = Mock()
        self.store_connect.side_effect = None
        self.store_connect.return_value = db
        link = {"username": "alice", "platform": "euw1", "game_name": "Test", "tag_line": "EUW", "puuid": "old-puuid"}
        riot = SimpleNamespace(account_by_puuid=AsyncMock(side_effect=main.RiotError(400, "old key")), account=AsyncMock())
        account = {"gameName": "Test", "tagLine": "EUW", "puuid": "new-puuid"}
        if status is None:
            riot.account.return_value = account
        else:
            riot.account.side_effect = main.RiotError(status, "simulated failure")
        with patch.object(main.store, "oldest_participant", return_value=("euw1", "old-puuid")), patch.object(main.store, "archive", return_value="fake-archive"), patch.object(main.auth, "all_accounts", return_value=[link]), patch.object(main.auth, "clear_account") as clear, patch.object(main.auth, "set_account") as save, self.assertLogs("sampler", level="WARNING"):
            await main.ensure_cache_matches_key(riot)
        db.close.assert_called_once_with()
        return clear, save

    async def test_key_rotation_preserves_links_on_transient_errors(self):
        for status in (401, 403, 429, 503):
            with self.subTest(status=status):
                clear, save = await self.check_key_rotation(status)
                clear.assert_not_called()
                save.assert_not_called()

    async def test_key_rotation_clears_only_not_found_links(self):
        clear, save = await self.check_key_rotation(404)
        clear.assert_called_once_with("alice")
        save.assert_not_called()

    async def test_key_rotation_updates_successfully_resolved_links(self):
        clear, save = await self.check_key_rotation()
        clear.assert_not_called()
        save.assert_called_once_with("alice", "euw1", "Test", "EUW", "new-puuid")

    async def test_startup_failures_close_riot_client(self):
        for stage in ("champions", "spells", "cache", "backfill"):
            with self.subTest(stage=stage), ExitStack() as patches:
                riot = SimpleNamespace(http=SimpleNamespace(aclose=AsyncMock()))
                patches.enter_context(patch.object(main, "Riot", return_value=riot))
                champions = patches.enter_context(patch.object(main, "load_champions", new_callable=AsyncMock, return_value=("26.20.1", {})))
                spells = patches.enter_context(patch.object(main, "load_spells", new_callable=AsyncMock, return_value={}))
                cache = patches.enter_context(patch.object(main, "ensure_cache_matches_key", new_callable=AsyncMock))
                backfill = patches.enter_context(patch.object(main.store, "backfill_bans"))
                self.store_connect.side_effect = None
                self.store_connect.return_value = Mock()
                {"champions": champions, "spells": spells, "cache": cache, "backfill": backfill}[stage].side_effect = RuntimeError(stage)
                with self.assertRaisesRegex(RuntimeError, stage):
                    async with main.lifespan(main.app):
                        self.fail("Startup should not succeed")
                riot.http.aclose.assert_awaited_once_with()

    async def test_shutdown_cancels_background_work_and_closes_client(self):
        stopped = asyncio.Event()

        async def refresh():
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        riot = SimpleNamespace(http=SimpleNamespace(aclose=AsyncMock()))
        self.store_connect.side_effect = None
        self.store_connect.return_value = Mock()
        with patch.object(main, "Riot", return_value=riot), patch.object(main, "load_champions", new_callable=AsyncMock, return_value=("26.20.1", {})), patch.object(main, "load_spells", new_callable=AsyncMock, return_value={}), patch.object(main, "ensure_cache_matches_key", new_callable=AsyncMock), patch.object(main.store, "backfill_bans"), patch.object(main, "refresh_ddragon", side_effect=refresh), patch.dict(main.SAMPLER, {"enabled": False}):
            async with main.lifespan(main.app):
                await asyncio.sleep(0)
            self.assertTrue(stopped.is_set())
        riot.http.aclose.assert_awaited_once_with()


class SnapshotBoundaryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "snapshot.sqlite"
        self.writer = fixture_db(path)
        self.addCleanup(self.writer.close)
        self.add_match("first")
        self.db = fixture_db(path)
        self.addCleanup(self.db.close)
        self.db.trace.clear()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(main.store, "connect", return_value=self.db))
        self.stack.enter_context(patch.dict(main.state, {"ddragon": "26.20.1", "sampler": {"status": "off"}}))
        self.rng = {"key": "20", "label": "Last 20 games", "count": 20, "since": None}

    def add_match(self, mid):
        self.writer.execute("INSERT INTO matches VALUES (?, '26.20', 420, 0)", (mid,))
        self.writer.commit()

    def count(self, db):
        self.assertIs(db, self.db)
        self.assertTrue(db.in_transaction)
        return db.execute("SELECT COUNT(*) FROM matches").fetchone()[0]

    def assert_snapshot_closed(self):
        self.assertTrue(self.db.closed)
        self.assertFalse(self.db.closed_in_transaction)
        self.assertEqual(self.db.trace.count("BEGIN"), 1)
        self.assertEqual(self.db.trace.count("ROLLBACK"), 1)
        self.assertNotIn("COMMIT", self.db.trace)

    def test_patch_response_uses_one_snapshot_across_concurrent_commit(self):
        updated = False

        def latest(db, before=None):
            nonlocal updated
            self.count(db)
            if not updated:
                self.add_match("second")
                updated = True
            return "26.20"

        def overview(db, shown, tier):
            with main.store.read_snapshot(db):
                return {"patch": shown, "matches": self.count(db), "tiers": []}

        def leads(db, shown, tier):
            with main.store.read_snapshot(db):
                return {"games": self.count(db)}

        with patch.object(main.stats, "latest_patch", side_effect=latest), patch.object(main.stats, "patch_overview", side_effect=overview), patch.object(main.stats, "patch_lead_curve", side_effect=leads):
            result = main.patch()
        self.assertEqual(result["current_patch_games"], 1)
        self.assertEqual(result["matches"], 1)
        self.assertEqual(result["leads"]["games"], 1)
        self.assertEqual(self.writer.execute("SELECT COUNT(*) FROM matches").fetchone()[0], 2)
        self.assert_snapshot_closed()

    def prepare_analysis(self, concurrent_write=False):
        def player(db, puuid):
            count = self.count(db)
            if concurrent_write:
                self.add_match("second")
            return {"game_name": "Test", "tag_line": "EUW", "platform": "euw1", "tier": "GOLD",
                    "division": "I", "lp": 10, "wins": 1, "losses": 0, "level": count, "profile_icon": None}

        def games(db, puuid, queue):
            return [{"game_start": 1000 + i} for i in range(self.count(db))]

        def attach(db, games, puuid):
            self.count(db)
            return games

        def composite(db, *args):
            with main.store.read_snapshot(db):
                return {"count": self.count(db)}

        for target, name, effect in ((main.store, "get_player", player), (main.stats, "player_games", games),
                                     (main.stats, "attach_gold", attach), (main.stats, "champions_vs_rank", composite),
                                     (main.stats, "player_leads", composite), (main.stats, "mastery", composite)):
            self.stack.enter_context(patch.object(target, name, side_effect=effect))
        self.stack.enter_context(patch.object(main.stats, "overview", side_effect=lambda games, tz: {"count": len(games)}))
        self.stack.enter_context(patch.object(main.history, "status", return_value=None))

    def test_analysis_response_uses_one_snapshot_across_concurrent_commit(self):
        self.prepare_analysis(concurrent_write=True)
        result = main.analysis("dummy-puuid", self.rng, 0)
        self.assertEqual(result["profile"]["level"], 1)
        self.assertEqual(result["games_analyzed"], 1)
        for key in ("overview", "vs_rank", "leads", "mastery"):
            self.assertEqual(result[key]["count"], 1)
        self.assertEqual(self.writer.execute("SELECT COUNT(*) FROM matches").fetchone()[0], 2)
        self.assert_snapshot_closed()

    def test_patch_read_failure_rolls_back_snapshot_and_closes_connection(self):
        with patch.object(main.stats, "latest_patch", return_value="26.20"), patch.object(main.stats, "patch_overview", return_value={"matches": 1}), patch.object(main.stats, "patch_lead_curve", side_effect=RuntimeError("lead read failed")):
            with self.assertRaisesRegex(RuntimeError, "lead read failed"):
                main.patch()
        self.assert_snapshot_closed()

    def test_analysis_read_failure_rolls_back_snapshot_and_closes_connection(self):
        self.prepare_analysis()
        with patch.object(main.stats, "mastery", side_effect=RuntimeError("mastery read failed")):
            with self.assertRaisesRegex(RuntimeError, "mastery read failed"):
                main.analysis("dummy-puuid", self.rng, 0)
        self.assert_snapshot_closed()

    def test_unknown_player_rolls_back_snapshot_and_closes_connection(self):
        with patch.object(main.store, "get_player", return_value=None):
            with self.assertRaises(main.HTTPException) as error:
                main.analysis("unknown", self.rng, 0)
        self.assertEqual(error.exception.status_code, 404)
        self.assert_snapshot_closed()


class PatchFallbackTests(unittest.TestCase):
    """Right after a patch drops, the landing page keeps the previous patch until the new one has enough games."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "cache.sqlite"
        with closing(test_data.fixture_db(self.path)) as db:
            for i in range(main.MIN_PATCH_GAMES + 10):
                db.execute("INSERT INTO matches VALUES (?, 'X', 420, ?, 1800, '16.19', 0, NULL)", (f"OLD_{i}", i))
            db.commit()
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(main.store, "connect", side_effect=lambda: test_data.fixture_db(self.path)))
        stack.enter_context(patch.dict(main.state, {"ddragon": "16.20.1", "sampler": {"status": "off"}}))
        stack.enter_context(patch.object(main.stats, "patch_overview", side_effect=lambda db, shown, tier: {"patch": shown, "matches": 0, "tiers": []}))

    def add_new_patch_games(self, n):
        with closing(test_data.fixture_db(self.path)) as db:
            db.executemany("INSERT INTO matches VALUES (?, 'X', 420, 9999, 1800, '16.20', 0, NULL)",
                           [(f"NEW_{i}",) for i in range(n)])
            db.commit()

    def test_previous_patch_shown_while_new_patch_has_few_games(self):
        self.add_new_patch_games(5)
        result = main.patch()
        self.assertEqual((result["patch"], result["current_patch"], result["current_patch_games"]), ("16.19", "16.20", 5))

    def test_new_patch_shown_once_it_has_enough_games(self):
        self.add_new_patch_games(main.MIN_PATCH_GAMES)
        self.assertEqual(main.patch()["patch"], "16.20")


class MatchHistoryTests(unittest.IsolatedAsyncioTestCase):
    PUUID = "fixture-player"

    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "cache.sqlite"
        with closing(test_data.fixture_db(self.path)) as db:
            for i in range(25):  # ranked solo, one every two hours
                match = test_data.match_fixture(f"SOLO_{i:02}", self.PUUID)
                match["info"]["gameStartTimestamp"] = 1_000_000 + i * 7_200_000
                main.store.save_match(db, "euw1", match)
            main.store.save_player(db, self.PUUID, "Fixture", "EUW", "euw1", {})
            db.commit()
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(main.store, "connect", side_effect=lambda: test_data.fixture_db(self.path)))
        self.stack.enter_context(patch.object(main.auth, "user_for", return_value="alice"))
        self.riot = SimpleNamespace(match_ids=AsyncMock(), match=AsyncMock())
        self.stack.enter_context(patch.dict(main.state, {"riot": self.riot, "live": {}, "last_activity": 0}))
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test",
                                        cookies={main.auth.COOKIE: "dummy-session"})
        self.addAsyncCleanup(self.client.aclose)

    async def matches(self, **params):
        response = await self.client.get(f"/api/player/{self.PUUID}/matches", params={"range": "50", **params})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    @staticmethod
    def arena_fixture(mid, puuid):
        match = test_data.match_fixture(mid, puuid)
        match["info"].update(queueId=1710, gameMode="CHERRY", mapId=30, teams=[])
        for i, p in enumerate(match["info"]["participants"]):
            p.update(playerSubteamId=i // 2 + 1, placement=i // 2 + 1, teamPosition="", kills=i)
        return match

    async def test_ranked_solo_pages_follow_the_synced_range(self):
        first = await self.matches(limit=20)
        self.assertEqual((first["total"], first["next"], len(first["rows"])), (25, 20, 20))
        self.assertEqual(first["rows"][0]["match_id"], "SOLO_24")  # newest first
        row = first["rows"][0]
        self.assertEqual((row["queue"], row["opp_champ"], row["kill_participation"]), ("Ranked Solo", 6, 5 / 10))
        second = await self.matches(offset=20, limit=20)
        self.assertEqual((second["next"], [r["match_id"] for r in second["rows"]]),
                         (None, [f"SOLO_{i:02}" for i in range(4, -1, -1)]))
        self.riot.match_ids.assert_not_called()

    async def test_more_than_a_hundred_rows_are_paged_not_rejected(self):
        self.assertEqual((await self.client.get(f"/api/player/{self.PUUID}/matches", params={"limit": 120})).status_code, 422)
        self.assertEqual((await self.matches(offset=120, limit=20))["rows"], [])

    async def test_other_queues_list_from_riot_and_fetch_only_uncached_matches(self):
        self.riot.match_ids.return_value = ["ARENA_1", "SOLO_24"]
        self.riot.match.side_effect = lambda platform, mid: self.arena_fixture(mid, self.PUUID)
        page = await self.matches(queue="all", limit=2, offset=0)
        self.riot.match_ids.assert_awaited_once_with("euw1", self.PUUID, None, 2, start=0)
        self.riot.match.assert_awaited_once_with("euw1", "ARENA_1")  # SOLO_24 was cached
        self.assertEqual(page["next"], 2)
        arena, solo = page["rows"]
        self.assertEqual((arena["queue"], arena["placement"], solo["queue"]), ("Arena", 1, "Ranked Solo"))
        self.assertEqual(arena["kill_participation"], (0 + 3) / (0 + 1))  # KP within the duo, not all 16 players
        self.assertIsNone(arena["opp_champ"])

        self.riot.match_ids.reset_mock()
        self.riot.match_ids.return_value = []
        self.assertEqual((await self.matches(queue="1710", offset=2))["next"], None)
        self.riot.match_ids.assert_awaited_once_with("euw1", self.PUUID, 1710, 20, start=2)

    async def test_current_modes_are_filters_and_retired_arena_is_not(self):
        self.riot.match_ids.return_value = []
        await self.matches(queue="2400")
        self.riot.match_ids.assert_awaited_once_with("euw1", self.PUUID, 2400, 20, start=0)
        for retired in ("1700", "490"):
            response = await self.client.get(f"/api/player/{self.PUUID}/matches", params={"queue": retired})
            self.assertEqual(response.status_code, 400, retired)

    async def test_unknown_queue_is_rejected(self):
        response = await self.client.get(f"/api/player/{self.PUUID}/matches", params={"queue": "999"})
        self.assertEqual(response.status_code, 400)

    async def test_arena_scoreboard_lists_each_duo_by_placement(self):
        with closing(test_data.fixture_db(self.path)) as db:
            main.store.save_match(db, "euw1", self.arena_fixture("ARENA_2", self.PUUID))
            db.commit()
        detail = (await self.client.get("/api/match/ARENA_2")).json()
        self.assertEqual([t["placement"] for t in detail["teams"]], [1, 2, 3, 4, 5])
        self.assertEqual([len(t["players"]) for t in detail["teams"]], [2] * 5)
        self.assertEqual((detail["queue"], detail["teams"][0]["dragons"]), ("Arena", None))
        rift = (await self.client.get("/api/match/SOLO_00")).json()
        self.assertEqual([(t["team_id"], t["win"], t["kills"]) for t in rift["teams"]], [(100, True, 10), (200, False, 10)])


class ConfigTests(unittest.TestCase):
    def test_env_loader_preserves_process_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            env = Path(directory) / "test.env"
            env.write_text('# ignored\nRIOT_API_KEY="file-dummy"\nSEASON_START=2026-02-01\nTIMELINE_LIMIT=7\n')
            with patch.dict(os.environ, {"RIOT_API_KEY": "process-dummy"}, clear=True):
                config.load_env(env)
                self.assertEqual(os.environ["RIOT_API_KEY"], "process-dummy")
                self.assertEqual(os.environ["SEASON_START"], "2026-02-01")
                self.assertEqual(os.environ["TIMELINE_LIMIT"], "7")

    def test_bootstrap_loads_env_before_history_settings(self):
        script = """
import sys
from unittest.mock import patch
import config
original_load = config.load_env
config.load_env = lambda: original_load(sys.argv[1])
with patch('sqlite3.connect', side_effect=AssertionError('Database access forbidden')), patch('httpx.AsyncClient', side_effect=AssertionError('Network client forbidden')):
    import main
    import history
assert history.SEASON_START == '2026-02-01', history.SEASON_START
assert history.TIMELINE_LIMIT == 7, history.TIMELINE_LIMIT
"""
        with tempfile.TemporaryDirectory() as directory:
            env = Path(directory) / "test.env"
            env.write_text("SEASON_START=2026-02-01\nTIMELINE_LIMIT=7\nSAMPLER=0\n")
            result = subprocess.run([sys.executable, "-B", "-c", script, str(env)], cwd=Path(__file__).resolve().parents[1], env={"PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
