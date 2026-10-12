"""History memory limits with tiny decoded payloads and an isolated SQLite cache."""
import asyncio
import os
import sqlite3
import tempfile
import time
import unittest
import weakref
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

with patch.dict(os.environ, {"SEASON_START": "2026-01-08", "TIMELINE_LIMIT": "100"}):
    import history
import store


class Payload(dict):
    """Weak-referenceable response, so tests can detect retained decoded objects."""


class TrackedConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.closed = False
        self.commits = 0
        self.rollbacks = 0

    def commit(self):
        super().commit()
        self.commits += 1

    def rollback(self):
        super().rollback()
        self.rollbacks += 1

    def close(self):
        if not self.closed:
            super().close()
            self.closed = True


class FixtureRiot:
    def __init__(self, ids, before_fetch=None, on_payload=None):
        self.ids = list(ids)
        self.before_fetch = before_fetch
        self.on_payload = on_payload
        self.failures = {}
        self.calls = []
        self.payloads = []

    async def _fetch(self, kind, mid):
        self.calls.append((kind, mid))
        if self.before_fetch:
            await self.before_fetch(kind, mid)
        if (kind, mid) in self.failures:
            result = self.failures[kind, mid]
            if isinstance(result, BaseException):
                raise result
            return result
        result = Payload(metadata={"matchId": mid}) if kind == "match" else Payload(info={"frames": []})
        self.payloads.append(weakref.ref(result))
        if self.on_payload:
            self.on_payload(result)
        return result

    async def match(self, platform, mid):
        return await self._fetch("match", mid)

    async def timeline(self, platform, mid):
        return await self._fetch("timeline", mid)

    async def match_ids(self, platform, puuid, queue, count, start=0, start_time=None):
        return self.ids[start:start + count]

    def background(self, share):
        return self


class MemoryHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.path = Path(directory) / "history-fixture.sqlite"
        self.connections = []
        self.addCleanup(self.close_connections)
        self.tasks = []
        self.now = time.time()
        self.stack.enter_context(patch.object(history, "time", SimpleNamespace(time=lambda: self.now)))
        self.stack.enter_context(patch.object(history, "jobs", {}))
        self.stack.enter_context(patch.object(history, "_incidental", None))
        self.stack.enter_context(patch.object(history, "_fetch_slots", None))
        self.stack.enter_context(patch.object(history.log, "exception"))
        self.connect = self.stack.enter_context(patch.object(store, "connect", side_effect=self.new_db))
        # Regular functions, not Mock side effects: mocks would themselves retain payload arguments.
        self.stack.enter_context(patch.object(store, "save_match", new=self.save_match))
        self.stack.enter_context(patch.object(store, "save_timeline", new=self.save_timeline))
        self.db = self.new_db()

    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await asyncio.sleep(0)  # let job-finalization callbacks run before restoring the globals

    def new_db(self):
        db = sqlite3.connect(self.path, factory=TrackedConnection)
        self.connections.append(db)
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS matches (match_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS timelines (match_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS match_tier (match_id TEXT, tier TEXT, PRIMARY KEY (match_id, tier));
        """)
        return db

    def close_connections(self):
        for db in self.connections:
            db.close()

    @staticmethod
    def save_match(db, platform, result):
        db.execute("INSERT OR REPLACE INTO matches VALUES (?)", (result["metadata"]["matchId"],))

    @staticmethod
    def save_timeline(db, mid, result):
        db.execute("INSERT OR IGNORE INTO timelines VALUES (?)", (mid,))

    def launch(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.append(task)
        return task

    def assert_no_transactions(self):
        for db in self.connections:
            if not db.closed:
                self.assertFalse(db.in_transaction, "A transaction crossed a network/slot await")

    def cached_ids(self):
        return {r[0] for r in self.db.execute("SELECT match_id FROM matches")}

    def finished_job(self, finished=None, seen=None, phase="done"):
        finished = self.now if finished is None else finished
        future = asyncio.get_running_loop().create_future()
        future.set_result(None)
        ready = asyncio.Event()
        ready.set()
        return {"range": "last4", "phase": phase, "total": 4, "done": 4, "running": False,
                "error": None, "finished": finished, "seen": finished if seen is None else seen,
                "incidental": True, "task": future, "matches_ready": ready}

    async def test_downloads_use_four_ids_and_release_payloads_before_the_next_batch(self):
        self.assertEqual(history.FETCH_BATCH, 4)
        ids = [f"M{i}" for i in range(11)]
        client = None

        async def before_fetch(kind, mid):
            self.assert_no_transactions()
            index = int(mid[1:])
            earlier_batches = index // history.FETCH_BATCH
            if index % history.FETCH_BATCH == 0 and earlier_batches:
                self.assertEqual(self.db.commits, earlier_batches)
                previous_payloads = client.payloads[:earlier_batches * history.FETCH_BATCH * 2]
                self.assertTrue(all(ref() is None for ref in previous_payloads))
                self.assertTrue(set(ids[:earlier_batches * history.FETCH_BATCH]) <= self.cached_ids())

        client = FixtureRiot(ids, before_fetch=before_fetch)
        await history.fetch_chunk(client, self.db, "fixture", ids, "GOLD")
        await asyncio.sleep(0)  # also release the final gather's completed task references
        self.assertEqual(self.db.commits, 3)
        self.assertEqual(self.cached_ids(), set(ids))
        self.assertEqual(len(client.calls), 22)
        self.assertTrue(all(ref() is None for ref in client.payloads))
        self.assert_no_transactions()
        self.assertFalse(self.db.closed)  # the connection remains owned by the caller

    async def test_global_gate_limits_all_callers_to_two_decoded_batches(self):
        self.assertEqual(history.FETCH_BATCHES, 2)
        gate, saturated = asyncio.Event(), asyncio.Event()
        active = peak_requests = peak_payloads = 0
        payloads, clients, tasks = [], [], []
        initial_requests = []
        limit = history.FETCH_BATCH * history.FETCH_BATCHES * 2  # match + timeline per ID

        async def before_fetch(kind, mid):
            nonlocal active, peak_requests
            self.assert_no_transactions()
            active += 1
            initial_requests.append(mid.split("-", 1)[0])
            peak_requests = max(peak_requests, active)
            if active == limit:
                saturated.set()
            try:
                await gate.wait()
            finally:
                active -= 1

        def on_payload(result):
            nonlocal peak_payloads
            payloads.append(weakref.ref(result))
            peak_payloads = max(peak_payloads, sum(ref() is not None for ref in payloads))

        for name in ("history1", "history2", "sampler", "manual1", "manual2", "liveform"):
            ids = [f"{name}-{i}" for i in range(9)]
            client = FixtureRiot(ids, before_fetch=before_fetch, on_payload=on_payload)
            clients.append(client)
            tasks.append(self.launch(history.fetch_chunk(client, self.new_db(), "fixture", ids, "GOLD")))
        await asyncio.wait_for(saturated.wait(), 2)
        await asyncio.sleep(0)
        self.assertEqual(active, limit)
        self.assertEqual(len(set(initial_requests)), 2)
        self.assert_no_transactions()
        gate.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 2)
        await asyncio.sleep(0)
        self.assertLessEqual(peak_requests, limit)
        self.assertLessEqual(peak_payloads, limit)
        self.assertTrue(all(ref() is None for ref in payloads))
        self.assertEqual(len(self.cached_ids()), 54)
        self.assertEqual(history._fetch_slots._value, 2)
        self.assert_no_transactions()

    async def test_partial_failures_and_completed_count_cover_all_batches(self):
        ids = [f"M{i}" for i in range(12)]
        self.db.execute("INSERT INTO matches VALUES ('M0')")
        self.db.execute("INSERT INTO timelines VALUES ('M0')")
        self.db.commit()
        self.db.commits = 0

        async def before_fetch(kind, mid):
            self.assert_no_transactions()

        client = FixtureRiot(ids, before_fetch=before_fetch)
        client.failures = {("match", "M1"): RuntimeError("upstream failed"),
                           ("match", "M5"): {"metadata": {"matchId": "WRONG"}},
                           ("timeline", "M8"): [], ("timeline", "M10"): None}
        with self.assertRaises(history.FetchChunkError) as caught:
            await history.fetch_chunk(client, self.db, "fixture", ids, "GOLD")
        self.assertEqual(caught.exception.completed, 9)
        self.assertEqual(len(caught.exception.errors), 3)
        for label in ("match M1", "match M5", "timeline M8"):
            self.assertIn(label, str(caught.exception))
        self.assertEqual(self.db.commits, 3)
        self.assertEqual(self.cached_ids(), set(ids) - {"M1", "M5"})
        self.assertTrue(store.has_timeline(self.db, "M10"))  # unavailable timelines still get a marker
        self.assertFalse(store.has_timeline(self.db, "M8"))
        self.assertNotIn(("match", "M0"), client.calls)
        self.assertNotIn(("timeline", "M0"), client.calls)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM match_tier").fetchone()[0], 10)
        self.assert_no_transactions()

    async def test_bad_item_rolls_back_only_its_savepoint_and_keeps_other_batches(self):
        ids = [f"M{i}" for i in range(9)]
        client = FixtureRiot(ids)

        def save(db, platform, result):
            self.save_match(db, platform, result)
            if result["metadata"]["matchId"] == "M6":
                raise ValueError("malformed match")

        with patch.object(store, "save_match", new=save), self.assertRaises(history.FetchChunkError) as caught:
            await history.fetch_chunk(client, self.db, "fixture", ids, "GOLD", timelines=False)
        self.assertEqual(caught.exception.completed, 8)
        self.assertEqual(self.cached_ids(), set(ids) - {"M6"})
        self.assertEqual(self.db.commits, 3)
        self.assert_no_transactions()

    async def test_later_batch_write_failure_rolls_back_that_batch_not_earlier_commits(self):
        ids = [f"M{i}" for i in range(9)]
        client = FixtureRiot(ids)

        def tag(db, mid, tier):
            db.execute("INSERT OR IGNORE INTO match_tier VALUES (?, ?)", (mid, tier))
            if mid == "M6":
                raise sqlite3.OperationalError("tag failed")

        with patch.object(store, "tag_tier", new=tag), self.assertRaisesRegex(sqlite3.OperationalError, "tag failed"):
            await history.fetch_chunk(client, self.db, "fixture", ids, "GOLD", timelines=False)
        self.assertEqual(self.cached_ids(), set(ids[:4]))
        self.assertEqual(self.db.commits, 1)
        self.assert_no_transactions()
        self.assertFalse(self.db.closed)
        self.assertEqual(history._fetch_slots._value, 2)

    async def test_cancellation_during_later_download_preserves_committed_batches(self):
        ids = [f"M{i}" for i in range(9)]
        started = asyncio.Event()

        async def before_fetch(kind, mid):
            self.assert_no_transactions()
            if int(mid[1:]) >= 4:
                started.set()
                await asyncio.Event().wait()

        client = FixtureRiot(ids, before_fetch=before_fetch)
        task = self.launch(history.fetch_chunk(client, self.db, "fixture", ids, "GOLD", timelines=False))
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.cached_ids(), set(ids[:4]))
        self.assertEqual(self.db.commits, 1)
        self.assert_no_transactions()
        self.assertFalse(self.db.closed)
        self.assertEqual(history._fetch_slots._value, 2)
        await history.fetch_chunk(FixtureRiot(["retry"]), self.db, "fixture", ["retry"], None, timelines=False)
        self.assertTrue(store.has_match(self.db, "retry"))

    async def test_cancellation_during_save_rolls_back_current_pending_batch(self):
        ids = [f"M{i}" for i in range(9)]

        def save(db, platform, result):
            self.save_match(db, platform, result)
            if result["metadata"]["matchId"] == "M5":
                raise asyncio.CancelledError()

        with patch.object(store, "save_match", new=save), self.assertRaises(asyncio.CancelledError):
            await history.fetch_chunk(FixtureRiot(ids), self.db, "fixture", ids, "GOLD", timelines=False)
        self.assertEqual(self.cached_ids(), set(ids[:4]))
        self.assertEqual(self.db.commits, 1)
        self.assertGreater(self.db.rollbacks, 0)
        self.assert_no_transactions()
        self.assertEqual(history._fetch_slots._value, 2)

    async def test_pending_caller_work_is_rejected_and_preserved_before_slot_wait(self):
        history._fetch_slots = asyncio.Semaphore(0)
        client = FixtureRiot(["M0"])
        self.db.execute("INSERT INTO matches VALUES ('pending')")
        with self.assertRaisesRegex(ValueError, "^commit pending work before fetching matches$"):
            await asyncio.wait_for(history.fetch_chunk(client, self.db, "fixture", client.ids, None,
                                                       timelines=False), 2)
        self.assertTrue(self.db.in_transaction)
        self.assertTrue(store.has_match(self.db, "pending"))
        self.assertEqual((self.db.commits, self.db.rollbacks), (0, 0))
        self.assertEqual(client.calls, [])
        self.assertEqual(history._fetch_slots._value, 0)
        self.assertFalse(self.db.closed)
        self.db.commit()  # the caller can still commit its original work
        self.assertTrue(store.has_match(self.db, "pending"))

    async def test_slot_wait_cancellation_with_clean_db_does_not_download_or_release_unacquired_slot(self):
        history._fetch_slots = asyncio.Semaphore(0)
        client = FixtureRiot(["M0"])
        task = self.launch(history.fetch_chunk(client, self.db, "fixture", client.ids, None, timelines=False))
        await asyncio.sleep(0)
        self.assert_no_transactions()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(client.calls, [])
        self.assertEqual(history._fetch_slots._value, 0)  # no unacquired slot was released
        self.assertFalse(self.db.closed)
        self.assert_no_transactions()

    async def test_cached_ids_are_still_tagged_without_downloads(self):
        ids = [f"M{i}" for i in range(9)]
        self.db.executemany("INSERT INTO matches VALUES (?)", [(mid,) for mid in ids])
        self.db.executemany("INSERT INTO timelines VALUES (?)", [(mid,) for mid in ids])
        self.db.commit()
        self.db.commits = 0
        client = FixtureRiot(ids)
        await history.fetch_chunk(client, self.db, "fixture", ids, "GOLD")
        self.assertEqual(client.calls, [])
        self.assertEqual(self.db.commits, 3)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM match_tier").fetchone()[0], 9)
        self.assert_no_transactions()

    async def test_failed_job_progress_includes_valid_results_from_every_small_batch(self):
        ids = [f"M{i}" for i in range(9)]
        client = FixtureRiot(ids)
        client.failures = {("match", "M1"): RuntimeError("first batch failed"),
                           ("match", "M6"): RuntimeError("second batch failed")}
        task = history.start(client, "fixture", "player", "GOLD", history.last_n(9), timelines=False)
        self.tasks.append(task)
        await task
        result = history.status("player")
        self.assertEqual(set(result), {"range", "phase", "total", "done", "running", "error"})
        self.assertEqual((result["phase"], result["total"], result["done"], result["running"]), ("matches", 9, 7, False))
        self.assertIn("M1", result["error"])
        self.assertIn("M6", result["error"])
        self.assertEqual(self.cached_ids(), set(ids) - {"M1", "M6"})
        self.assertTrue(self.connections[-1].closed)
        self.assertTrue(history.jobs["player"]["matches_ready"].is_set())

    async def test_phase_retains_twenty_id_progress_steps(self):
        self.assertEqual(history.CHUNK, 20)
        j = self.finished_job()
        j.update(running=True, incidental=False, seen=self.now)
        steps = []

        async def step(ids):
            steps.append((list(ids), j["done"]))

        self.assertTrue(await history._phase(j, "matches", list(range(45)), step))
        self.assertEqual([len(ids) for ids, _ in steps], [20, 20, 5])
        self.assertEqual([done for _, done in steps], [0, 20, 40])
        self.assertEqual((j["total"], j["done"]), (45, 45))

    async def test_completed_jobs_expire_only_after_cooldown_and_idle_age(self):
        history.jobs.update({
            "expired": self.finished_job(self.now - history.RESYNC_AFTER),
            "recent": self.finished_job(self.now - history.RESYNC_AFTER + 1),
            "watched": self.finished_job(self.now - 2 * history.RESYNC_AFTER, seen=self.now - 1),
        })
        held = history.jobs["expired"]
        self.assertIsNone(history.status("expired"))
        self.assertIn("recent", history.jobs)
        self.assertIn("watched", history.jobs)
        self.assertEqual(held["phase"], "done")  # eviction does not clear held job dictionaries
        self.assertTrue(held["matches_ready"].is_set())
        self.now += 1
        history._prune_jobs()
        self.assertNotIn("recent", history.jobs)
        self.assertIn("watched", history.jobs)

    async def test_polling_completed_jobs_refreshes_their_idle_retention(self):
        history.jobs["watched"] = self.finished_job(self.now - 2 * history.RESYNC_AFTER, seen=self.now - 1)
        history.touch("watched")
        self.now += history.RESYNC_AFTER - 1
        self.assertIsNotNone(history.status("watched"))
        self.now += 1
        self.assertIsNone(history.status("watched"))

    async def test_finished_cap_never_evicts_or_cancels_active_work(self):
        self.assertEqual(history.FINISHED_MAX, 128)
        active = {}
        for i in range(150):
            j = self.finished_job(self.now - 10000)
            j.update(running=True, phase="matches", task=SimpleNamespace(cancel=Mock()))
            active[f"active-{i}"] = j
        history.jobs.update(active)
        for i in range(150):
            history.jobs[f"finished-{i}"] = self.finished_job(self.now - 200 + i)
        held = history.jobs["finished-0"]
        history._prune_jobs()
        self.assertEqual(sum(not j["running"] for j in history.jobs.values()), 128)
        self.assertEqual({key for key in history.jobs if key.startswith("finished-")},
                         {f"finished-{i}" for i in range(22, 150)})
        for key, j in active.items():
            self.assertIs(history.jobs[key], j)
            j["task"].cancel.assert_not_called()
        self.assertEqual(held["phase"], "done")
        self.assertTrue(history.any_running())

    async def test_finish_enforces_cap_without_changing_current_job_progress(self):
        for i in range(history.FINISHED_MAX):
            history.jobs[str(i)] = self.finished_job(self.now - 1)
        current = self.finished_job()
        current.update(running=True, finished=0, done=3, phase="cancelled")
        current["matches_ready"].clear()
        history.jobs["current"] = current
        history._finish(current)
        self.assertEqual(len(history.jobs), history.FINISHED_MAX)
        self.assertIs(history.jobs["current"], current)
        self.assertNotIn("0", history.jobs)
        self.assertFalse(current["running"])
        self.assertEqual((current["phase"], current["done"], current["finished"]), ("cancelled", 3, self.now))
        self.assertTrue(current["matches_ready"].is_set())

    async def test_incidental_success_cooldown_and_failed_job_retry_are_preserved(self):
        finished = self.finished_job()
        history.jobs["player"] = finished
        client = FixtureRiot([])
        reused = history.start(client, "fixture", "player", "GOLD", history.last_n(4), replace=False, timelines=False)
        self.assertIs(reused, finished["task"])
        self.connect.assert_not_called()
        finished["error"] = "previous failure"
        retry = history.start(client, "fixture", "player", "GOLD", history.last_n(4), replace=False, timelines=False)
        self.tasks.append(retry)
        self.assertIsNot(retry, reused)
        await retry
        self.assertEqual(history.status("player")["phase"], "done")
        self.assertTrue(self.connections[-1].closed)

    async def test_more_than_128_real_active_jobs_are_retained_until_they_finish(self):
        release = asyncio.Event()

        async def hold(riot, platform, puuid, tier, rng, j, timelines, queued=False):
            try:
                await release.wait()
                j["phase"] = "done"
            finally:
                history._finish(j)

        with patch.object(history, "_run", new=hold):
            tasks = [history.start(FixtureRiot([]), "fixture", f"player-{i}", "GOLD", history.last_n(1))
                     for i in range(140)]
            self.tasks.extend(tasks)
            await asyncio.sleep(0)
            history._prune_jobs()
            self.assertEqual(len(history.jobs), 140)
            self.assertTrue(all(j["running"] for j in history.jobs.values()))
            self.assertFalse(any(task.cancelled() for task in tasks))
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 2)
        self.assertEqual(len(history.jobs), 128)
        self.assertFalse(history.any_running())
        self.connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
