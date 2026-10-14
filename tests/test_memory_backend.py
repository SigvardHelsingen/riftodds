"""Bounded process-local caches and SQLite ownership; never use production DBs or Riot."""
import asyncio
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack, closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import config

with patch.object(config, "load_env"), patch.dict(os.environ, {
    "SAMPLER": "0", "SESSION_COOKIE_SECURE": "auto", "SEASON_START": "2026-01-08",
}):
    import main


class TrackedConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.closed = False
        self.closed_in_transaction = None
        self.owner_thread = threading.get_ident()

    def close(self):
        if not self.closed:
            self.closed_in_transaction = self.in_transaction
            super().close()
            self.closed = True


class MemoryBackendTests(unittest.IsolatedAsyncioTestCase):
    PUUID = "fixture-player"

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.path = Path(directory) / "memory-fixture.sqlite"
        self.connections = []
        self.addCleanup(self.close_connections)
        self.now = time.time()
        self.stack.enter_context(patch.object(main, "time", SimpleNamespace(time=lambda: self.now)))
        self.stack.enter_context(patch.dict(main.state, {
            "sampler": {"status": "off"}, "live": {}, "last_activity": 0,
            "ddragon": "26.20.1", "champions": {}, "spells": {},
        }, clear=True))
        self.stack.enter_context(patch.object(main, "_seen", {}))
        self.store_connect = self.stack.enter_context(patch.object(main.store, "connect", side_effect=self.connect))
        self.stack.enter_context(patch.object(main.auth, "connect", side_effect=AssertionError("Real auth DB forbidden")))
        self.stack.enter_context(patch.object(main, "Riot", side_effect=AssertionError("Real Riot client forbidden")))
        for loader in ("load_champions", "load_spells", "load_items", "load_runes"):
            self.stack.enter_context(patch.object(main, loader, new_callable=AsyncMock,
                                                 side_effect=AssertionError("Real Data Dragon request forbidden")))
        self.stack.enter_context(patch.object(main.auth, "user_for", return_value="alice"))
        self.seen = self.stack.enter_context(patch.object(main.auth, "seen"))
        self.stack.enter_context(patch.object(main.auth, "record"))
        self.get_account = self.stack.enter_context(patch.object(main.auth, "get_account", return_value=None))
        self.set_account = self.stack.enter_context(patch.object(main.auth, "set_account"))
        self.start = self.stack.enter_context(patch.object(main.history, "start"))
        self.wait = self.stack.enter_context(patch.object(main.history, "wait_for_matches", new_callable=AsyncMock))
        self.stack.enter_context(patch.object(main.history, "status", return_value=None))
        self.analysis = self.stack.enter_context(patch.object(main, "analysis", return_value={"puuid": self.PUUID}))
        self.request = SimpleNamespace(state=SimpleNamespace(user="alice"), cookies={},
                                       url=SimpleNamespace(path="/api/sync/fixture-player"))
        self.solo = {"queueType": "RANKED_SOLO_5x5", "tier": "GOLD", "rank": "II",
                     "leaguePoints": 50, "wins": 12, "losses": 10}
        self.game = {"gameId": 1, "gameQueueConfigId": 420, "gameStartTime": 123456,
                     "participants": [{"puuid": self.PUUID, "teamId": 100, "championId": 1,
                                       "riotId": "Fixture#EUW"}], "bannedChampions": []}
        self.masteries = [{"championId": 1, "championLevel": 7, "championPoints": 12345, "lastPlayTime": 100}]
        self.riot = SimpleNamespace(
            account=AsyncMock(side_effect=self.outbound({"puuid": self.PUUID, "gameName": "Fixture", "tagLine": "EUW"})),
            league_entries=AsyncMock(side_effect=self.outbound([self.solo])),
            active_game=AsyncMock(side_effect=self.outbound(self.game)),
            summoner=AsyncMock(side_effect=self.outbound({"profileIconId": 1, "summonerLevel": 100})),
            mastery=AsyncMock(side_effect=self.outbound(self.masteries)),
            tier_players=AsyncMock(side_effect=self.outbound([self.PUUID])),
            match_ids=AsyncMock(side_effect=self.outbound([])),
            account_by_puuid=AsyncMock(side_effect=self.outbound({})),
        )
        self.riot.background = Mock(return_value=self.riot)
        main.state["riot"] = self.riot
        with closing(self.connect()) as db:
            main.store.save_player(db, self.PUUID, "Fixture", "EUW", "euw1", {},
                                   {"profileIconId": 1, "summonerLevel": 100})
            db.commit()
        self.connections.clear()

    def connect(self):
        # Allow cleanup of a leaked worker-thread connection so a failed test remains isolated.
        db = sqlite3.connect(self.path, factory=TrackedConnection, check_same_thread=False)
        self.connections.append(db)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        main.store.init(db)
        return db

    def close_connections(self):
        for db in self.connections:
            db.close()

    def assert_connections_closed(self):
        for db in self.connections:
            self.assertTrue(db.closed, "SQLite connection leaked")

    def outbound(self, result):
        def answer(*args, **kwargs):
            self.assert_connections_closed()
            return result
        return answer

    def entry(self, extra=None):
        return {"at": self.now, "game": self.game, "extra": extra}

    async def lookup(self):
        return await main.player(self.request, "euw1", "Fixture#EUW", range_="20")

    async def test_live_cache_is_lru_bounded_and_keeps_held_entries_intact(self):
        self.assertEqual(main.LIVE_CACHE_MAX, 64)
        extra = {self.PUUID: ([self.solo], self.masteries)}
        held = self.entry(extra)
        for i in range(main.LIVE_CACHE_MAX):
            main._live_cached(str(i), held if i == 1 else self.entry())
            self.assertLessEqual(len(main.state["live"]), main.LIVE_CACHE_MAX)
        main._live_cached("0")  # watched players move to the newest position
        main._live_cached("new", self.entry())
        self.assertIn("0", main.state["live"])
        self.assertNotIn("1", main.state["live"])
        self.assertIs(held["game"], self.game)
        self.assertIs(held["extra"], extra)
        for i in range(100):
            main._live_cached(f"overflow-{i}", self.entry())
            self.assertLessEqual(len(main.state["live"]), 64)
        self.store_connect.assert_not_called()

    async def test_live_cache_expires_after_six_idle_hours_without_clearing_held_data(self):
        self.assertEqual(main.LIVE_CACHE_TTL, 6 * 3600)
        extra = {self.PUUID: ([self.solo], self.masteries)}
        held = main._live_cached(self.PUUID, self.entry(extra))
        # Old entries without an idle timestamp also expire (e.g. an already-running process).
        main.state["live"]["legacy"] = self.entry()
        self.now += main.LIVE_CACHE_TTL
        self.assertIsNone(main._live_cached(self.PUUID))
        self.assertEqual(main.state["live"], {})
        self.assertIs(held["extra"], extra)
        self.assertIs(held["game"], self.game)

    async def test_live_cache_idle_ttl_is_independent_of_spectator_refresh_time(self):
        held = main._live_cached(self.PUUID, self.entry({}))
        spectator_at = held["at"]
        self.now += main.LIVE_CACHE_TTL - 1
        self.assertIs(main._live_cached(self.PUUID), held)
        self.now += main.LIVE_CACHE_TTL - 1
        self.assertIs(main._live_cached(self.PUUID), held)
        self.assertEqual(held["at"], spectator_at)

    async def test_seen_is_bounded_and_does_not_evict_active_throttles(self):
        self.assertEqual(main.SEEN_MAX, 1024)
        for i in range(main.SEEN_MAX):
            self.assertTrue(main._seen_due(str(i), self.now))
        self.assertFalse(main._seen_due("overflow", self.now))
        self.assertEqual(len(main._seen), 1024)
        for _ in range(10):
            self.assertFalse(main._seen_due("0", self.now))
        self.now += main.SEEN_EVERY
        self.assertTrue(main._seen_due("overflow", self.now))
        self.assertEqual(main._seen, {"overflow": self.now})

    async def test_seen_middleware_throttles_concurrent_and_repeated_requests(self):
        response = object()
        call_next = AsyncMock(return_value=response)
        replies = await asyncio.gather(*(main.require_login(self.request, call_next) for _ in range(20)))
        self.assertTrue(all(reply is response for reply in replies))
        self.seen.assert_called_once_with("alice")
        self.now += main.SEEN_EVERY - 1
        await main.require_login(self.request, call_next)
        self.seen.assert_called_once_with("alice")
        self.now += 1
        await main.require_login(self.request, call_next)
        self.assertEqual(self.seen.call_count, 2)
        self.assertEqual(main.state["last_activity"], self.now)
        self.store_connect.assert_not_called()

    async def test_linked_account_closes_reads_and_prefers_cached_name(self):
        self.get_account.return_value = {"puuid": self.PUUID, "game_name": "Old", "tag_line": "OLD"}
        self.assertEqual(main.linked_account("alice"),
                         {"puuid": self.PUUID, "game_name": "Fixture", "tag_line": "EUW"})
        self.assertEqual(len(self.connections), 1)
        self.assert_connections_closed()
        with patch.object(main.store, "get_player", side_effect=sqlite3.OperationalError("read failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "read failed"):
                main.linked_account("alice")
        self.assert_connections_closed()

    async def test_link_account_closes_reads_before_auth_and_on_not_found(self):
        self.get_account.return_value = {"puuid": self.PUUID}
        self.set_account.side_effect = self.outbound(None)
        result = main.link_account(main.AccountLink(puuid=self.PUUID), self.request)
        self.assertEqual(result["game_name"], "Fixture")
        self.set_account.assert_called_once_with("alice", "euw1", "Fixture", "EUW", self.PUUID)
        self.assertEqual(len(self.connections), 2)
        self.assert_connections_closed()
        with self.assertRaises(main.HTTPException) as error:
            main.link_account(main.AccountLink(puuid="unknown"), self.request)
        self.assertEqual(error.exception.status_code, 404)
        self.assert_connections_closed()
        with patch.object(main.store, "get_player", side_effect=sqlite3.OperationalError("read failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "read failed"):
                main.link_account(main.AccountLink(puuid=self.PUUID), self.request)
        self.assert_connections_closed()

    async def test_player_closes_successful_reads_and_writes_before_awaits(self):
        self.wait.side_effect = self.outbound(None)
        self.analysis.side_effect = self.outbound({"puuid": self.PUUID})
        result = await self.lookup()
        self.assertEqual(result, {"puuid": self.PUUID, "live": {
            "queue": "Ranked Solo", "champion_id": 1, "started": 123456}})
        self.assertEqual(len(self.connections), 2)
        self.assert_connections_closed()
        self.assertTrue(all(db.closed_in_transaction is False for db in self.connections))
        self.riot.account.assert_not_awaited()  # cached profiles still skip account/summoner/mastery
        self.riot.summoner.assert_not_awaited()
        self.riot.mastery.assert_not_awaited()
        self.start.assert_called_once()

    async def test_player_profile_lookup_preserves_watched_games_extra(self):
        extra = {self.PUUID: ([self.solo], self.masteries)}
        main._live_cached(self.PUUID, self.entry(extra))
        await self.lookup()
        self.assertIs(main.state["live"][self.PUUID]["extra"], extra)
        self.assert_connections_closed()

    async def test_player_insertions_use_the_bounded_cache(self):
        for i in range(main.LIVE_CACHE_MAX):
            main._live_cached(str(i), self.entry())
        await self.lookup()
        self.assertEqual(len(main.state["live"]), main.LIVE_CACHE_MAX)
        self.assertIn(self.PUUID, main.state["live"])
        self.assertNotIn("0", main.state["live"])

    async def test_player_closes_connection_on_cached_read_failure(self):
        with patch.object(main.store, "find_player", side_effect=sqlite3.OperationalError("read failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "read failed"):
                await self.lookup()
        self.assertEqual(len(self.connections), 1)
        self.assert_connections_closed()
        self.riot.active_game.assert_not_awaited()

    async def test_player_has_no_open_connection_on_riot_error_or_cancellation(self):
        for failure in (main.RiotError(403, "rejected"), asyncio.CancelledError()):
            with self.subTest(failure=type(failure).__name__):
                self.riot.active_game.side_effect = failure
                with self.assertRaises(main.HTTPException if isinstance(failure, main.RiotError) else asyncio.CancelledError) as error:
                    await self.lookup()
                if isinstance(failure, main.RiotError):
                    self.assertEqual(error.exception.status_code, 502)
                self.assert_connections_closed()
        self.start.assert_not_called()

    async def test_player_write_failure_closes_and_rolls_back(self):
        with patch.object(main.store, "find_player", return_value=None), \
                patch.object(main.store, "save_mastery", side_effect=sqlite3.OperationalError("write failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "write failed"):
                await self.lookup()
        self.assertEqual(len(self.connections), 2)
        self.assert_connections_closed()
        with closing(self.connect()) as db:
            self.assertEqual(main.store.get_player(db, self.PUUID)["lp"], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM rank_history").fetchone()[0], 0)
        self.start.assert_not_called()

    async def test_live_closes_all_connections_and_builds_rows_in_worker(self):
        result = await main.live(self.PUUID, form=True)
        self.assertTrue(result["in_game"])
        row = result["players"][0]
        self.assertEqual((row["tier"], row["lp"], row["mastery_points"]), ("GOLD", 50, 12345))
        self.assertEqual(len(self.connections), 3)  # player read, rank write, row-building read
        self.assert_connections_closed()
        self.assertTrue(all(db.closed_in_transaction is False for db in self.connections))
        self.assertNotEqual(self.connections[-1].owner_thread, threading.get_ident())
        self.start.assert_called_once()
        self.assertFalse(self.start.call_args.kwargs["timelines"])

    async def test_live_reuses_ranks_and_mastery_for_a_game_watched_over_six_hours(self):
        await main.live(self.PUUID)
        extra = main.state["live"][self.PUUID]["extra"]
        for _ in range(7):
            self.now += 3600  # regularly watched, but spectator freshness expires every poll here
            result = await main.live(self.PUUID)
            self.assertTrue(result["in_game"])
            self.assertIs(main.state["live"][self.PUUID]["extra"], extra)
        self.assertEqual(self.riot.active_game.await_count, 8)
        self.riot.league_entries.assert_awaited_once_with("euw1", self.PUUID)
        self.riot.mastery.assert_awaited_once_with("euw1", self.PUUID)
        self.assert_connections_closed()

    async def test_live_refetches_extra_after_idle_expiry_or_a_different_game(self):
        await main.live(self.PUUID)
        self.now += main.LIVE_CACHE_TTL
        await main.live(self.PUUID)
        self.assertEqual(self.riot.mastery.await_count, 2)
        self.now += main.LIVE_TTL + 1
        self.riot.active_game.side_effect = self.outbound({**self.game, "gameId": 2})
        await main.live(self.PUUID)
        self.assertEqual(self.riot.mastery.await_count, 3)
        self.assertEqual(self.riot.league_entries.await_count, 3)
        self.assert_connections_closed()

    async def test_live_in_flight_entry_survives_eviction_while_awaiting_ranks(self):
        held = main._live_cached(self.PUUID, self.entry())

        async def leagues(*args):
            self.assert_connections_closed()
            for i in range(main.LIVE_CACHE_MAX):
                main._live_cached(str(i), self.entry())
            self.assertNotIn(self.PUUID, main.state["live"])
            return [self.solo]

        self.riot.league_entries.side_effect = leagues
        result = await main.live(self.PUUID)
        self.assertEqual(result["players"][0]["lp"], 50)
        self.assertEqual(held["extra"][self.PUUID][0], [self.solo])
        self.assertIs(held["game"], self.game)
        self.assert_connections_closed()

    async def test_live_closes_connection_on_not_found_no_game_and_read_failure(self):
        with self.assertRaises(main.HTTPException) as error:
            await main.live("unknown")
        self.assertEqual(error.exception.status_code, 404)
        self.assert_connections_closed()
        self.riot.active_game.side_effect = self.outbound(None)
        self.assertEqual(await main.live(self.PUUID), {"in_game": False})
        self.assert_connections_closed()
        with patch.object(main.store, "get_player", side_effect=sqlite3.OperationalError("read failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "read failed"):
                await main.live(self.PUUID)
        self.assert_connections_closed()

    async def test_live_has_no_open_connection_on_riot_error_or_cancellation(self):
        for failure in (main.RiotError(403, "rejected"), asyncio.CancelledError()):
            with self.subTest(failure=type(failure).__name__):
                self.riot.active_game.side_effect = failure
                with self.assertRaises(main.HTTPException if isinstance(failure, main.RiotError) else asyncio.CancelledError) as error:
                    await main.live(self.PUUID)
                if isinstance(failure, main.RiotError):
                    self.assertEqual(error.exception.status_code, 502)
                self.assert_connections_closed()

    async def test_live_closes_rank_writer_and_row_reader_on_failures(self):
        with patch.object(main.store, "save_rank", side_effect=sqlite3.OperationalError("rank failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "rank failed"):
                await main.live(self.PUUID)
        self.assertEqual(len(self.connections), 2)
        self.assert_connections_closed()
        with patch.object(main.stats, "player_games", side_effect=sqlite3.OperationalError("rows failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "rows failed"):
                await main.live(self.PUUID)
        self.assert_connections_closed()
        self.assertNotEqual(self.connections[-1].owner_thread, threading.get_ident())

    async def test_pick_stays_sync_and_closes_before_computing_probabilities(self):
        self.assertFalse(asyncio.iscoroutinefunction(main.pick))
        with patch.object(main.stats, "pick_probabilities", side_effect=self.outbound({"ok": True})) as probabilities:
            self.assertEqual(main.pick(self.PUUID, "MIDDLE", alpha=5.0, range_="20"), {"ok": True})
        probabilities.assert_called_once_with([], "MIDDLE", None, 5.0)
        self.assertEqual(len(self.connections), 1)
        self.assert_connections_closed()

    async def test_pick_closes_connection_on_read_or_probability_failure(self):
        for symbol in ("player_games", "pick_probabilities"):
            with self.subTest(symbol=symbol), \
                    patch.object(main.stats, symbol, side_effect=sqlite3.OperationalError("pick failed")):
                with self.assertRaisesRegex(sqlite3.OperationalError, "pick failed"):
                    main.pick(self.PUUID, "MIDDLE", alpha=5.0, range_="20")
                self.assert_connections_closed()

    async def test_sampler_closes_before_network_and_after_successful_round(self):
        fetch = AsyncMock(side_effect=self.outbound(0))
        with patch.object(main, "users_active", side_effect=[False, True]), \
                patch.object(main, "sampler_share", return_value=0.2), \
                patch.object(main, "fetch_matches", fetch), \
                patch.object(main.asyncio, "sleep", new_callable=AsyncMock, side_effect=asyncio.CancelledError()):
            with self.assertRaises(asyncio.CancelledError):
                await main.sampler()
        self.riot.tier_players.assert_awaited_once()
        self.riot.match_ids.assert_awaited_once()
        fetch.assert_awaited_once()
        self.assert_connections_closed()
        self.assertEqual(main.state["sampler"]["status"], "paused")

    async def test_sampler_closes_before_idle_sleep_and_timeline_backfill(self):
        def stop(*args, **kwargs):
            self.assert_connections_closed()
            raise asyncio.CancelledError()

        with patch.object(main, "users_active", return_value=False), \
                patch.object(main, "sampler_share", return_value=0.2), \
                patch.dict(main.SAMPLER, {"target": 0}), \
                patch.object(main.asyncio, "sleep", new_callable=AsyncMock, side_effect=stop) as sleep:
            with self.assertRaises(asyncio.CancelledError):
                await main.sampler()
            sleep.assert_awaited_once_with(600)
        self.assertEqual(main.state["sampler"]["status"], "idle")
        with closing(self.connect()) as db:
            db.execute("INSERT INTO matches (match_id, patch, queue_id, remake) VALUES ('M', '26.20', 420, 0)")
            db.commit()
        with patch.object(main, "users_active", return_value=False), \
                patch.object(main, "sampler_share", return_value=0.2), \
                patch.object(main, "fetch_matches", new_callable=AsyncMock, side_effect=stop) as fetch:
            with self.assertRaises(asyncio.CancelledError):
                await main.sampler()
            self.assertEqual(fetch.call_args.args[2], ["M"])
        self.assert_connections_closed()

    async def test_sampler_closes_on_read_failure_before_retry_sleep(self):
        def stop(*args):
            self.assert_connections_closed()
            raise asyncio.CancelledError()

        with patch.object(main, "users_active", return_value=False), \
                patch.object(main, "sampler_share", return_value=0.2), \
                patch.object(main, "current_patch", side_effect=sqlite3.OperationalError("read failed")), \
                patch.object(main.asyncio, "sleep", new_callable=AsyncMock, side_effect=stop), \
                self.assertLogs("sampler", "ERROR"):
            with self.assertRaises(asyncio.CancelledError):
                await main.sampler()
        self.assert_connections_closed()
        self.assertEqual(main.state["sampler"]["status"], "error")

    async def test_key_verification_closes_before_network_and_on_read_failure(self):
        with patch.object(main.store, "oldest_participant", return_value=("euw1", self.PUUID)):
            await main.ensure_cache_matches_key(self.riot)
        self.riot.account_by_puuid.assert_awaited_once_with("euw1", self.PUUID)
        self.assert_connections_closed()
        with patch.object(main.store, "oldest_participant", side_effect=sqlite3.OperationalError("read failed")):
            with self.assertRaisesRegex(sqlite3.OperationalError, "read failed"):
                await main.ensure_cache_matches_key(self.riot)
        self.assert_connections_closed()

    async def test_lifespan_closes_bans_connection_on_success_and_startup_failure(self):
        for fails in (False, True):
            with self.subTest(fails=fails), ExitStack() as patches:
                riot = SimpleNamespace(http=SimpleNamespace(aclose=AsyncMock()))
                patches.enter_context(patch.object(main, "Riot", return_value=riot))
                patches.enter_context(patch.object(main, "load_champions", new_callable=AsyncMock, return_value=("26.20.1", {})))
                patches.enter_context(patch.object(main, "load_spells", new_callable=AsyncMock, return_value={}))
                for name in ("load_build_data", "ensure_cache_matches_key", "refresh_ddragon", "backfill_derived", "track_ranks"):
                    patches.enter_context(patch.object(main, name, new_callable=AsyncMock))
                patches.enter_context(patch.dict(main.SAMPLER, {"enabled": False}))
                if fails:
                    patches.enter_context(patch.object(main.store, "backfill_bans", side_effect=sqlite3.OperationalError("bans failed")))
                    with self.assertRaisesRegex(sqlite3.OperationalError, "bans failed"):
                        async with main.lifespan(main.app):
                            self.fail("Startup should have failed")
                else:
                    async with main.lifespan(main.app):
                        self.assert_connections_closed()
                self.assert_connections_closed()
                riot.http.aclose.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
