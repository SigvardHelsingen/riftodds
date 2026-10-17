"""Fixture-only match tracking, review context and real-router security tests.

No production DB/cache/.env/verification file, network, sampler or model work.
Run: .venv/bin/python -m unittest discover -s tests -p test_training_matches.py -v
"""
import asyncio

import importlib
import json
import os
import socket
import sqlite3
import tempfile
import threading
import unittest
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

import auth
import config
import store
import training
import training_api
import training_matches as matches
from test_training import data_for

NOW = 2_000_000
FILTERS = {"revision": 1, "role": "MIDDLE", "champion_id": 103, "queue_id": 420, "patch": "16.1"}


def digest(puuids=None, teams=None):
    puuids = puuids or ["own", *[f"fixture-{i}" for i in range(2, 11)]]
    teams = teams or [100] * 5 + [200] * 5
    times = [0, 300, 600, 660, 720, 900, 1200, 1800]
    gold = [[500 + t * 5 + (100 if i == 0 else 0) for i in range(10)] for t in times]
    return {"v": 2, "map_id": 11, "pids": list(range(1, 11)), "puuids": puuids, "teams": teams,
            "ts": times, "valid": [True] * len(times), "gold": gold,
            "xp": [[t * 2] * 10 for t in times], "cs": [[int(t / 10)] * 10 for t in times],
            "pos": [[None] * 20 for _ in times], "kills": [[300, 6, 1, None, None, []]],
            "monsters": [], "buildings": [], "plates": [], "wards": [], "end": 1800, "winner": 100}


class MatchFixture(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.members, self.cache = self.directory / "members.sqlite", self.directory / "cache.sqlite"
        self.stack.enter_context(patch.object(auth, "DB_PATH", self.members))
        self.stack.enter_context(patch.object(store, "DB_PATH", self.cache))
        real_connect = sqlite3.connect
        self.connections = []

        def fixture_only(database, *args, **kwargs):
            text = str(database)
            if text.startswith("file:"):
                parsed = urlsplit(text)
                self.assertEqual(Path(unquote(parsed.path)), self.cache, "Non-fixture cache access")
                self.assertEqual(parse_qs(parsed.query), {"mode": ["ro"]})
                self.assertTrue(kwargs.get("uri"))
            else:
                self.assertIn(Path(database), (self.members, self.cache), "Non-fixture database access")
            self.connections.append(text)
            return real_connect(database, *args, **kwargs)

        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=fixture_only))
        self.stack.enter_context(patch.object(store, "connect", side_effect=AssertionError("Migrating cache connection")))
        self.stack.enter_context(patch.object(store, "init", side_effect=AssertionError("Cache migration")))
        self.stack.enter_context(patch.object(socket.socket, "connect", side_effect=AssertionError("Network")))
        self.stack.enter_context(patch.object(config, "load_env", side_effect=AssertionError("Environment file access")))
        self.clock = self.stack.enter_context(patch.object(matches.time, "time", return_value=NOW))
        with closing(auth.connect()) as db:
            db.executemany("INSERT INTO users(username,password_hash,created) VALUES (?,'fixture-only',0)",
                           [("alice",), ("bob",)])
            db.executemany("INSERT INTO sessions VALUES (?,?,?)",
                           [(auth._token_hash(f"{u}-token"), u, 10 ** 12) for u in ("alice", "bob")])
            db.commit()
        with closing(sqlite3.connect(self.cache)) as db:
            db.executescript(store.SCHEMA)
        auth.set_account("alice", "euw1", "Fixture", "TEST", "own")
        self.plan = training.create_entry("alice", "plans", data_for("plans"))
        app = FastAPI()

        @app.middleware("http")
        async def identity(request: Request, call_next):
            request.state.user = auth.user_for(request.cookies.get(auth.COOKIE))
            return await call_next(request)

        app.include_router(training_api.router)
        self.client = self.stack.enter_context(TestClient(app))
        self.user("alice")

    def user(self, username):
        self.client.cookies.clear()
        if username:
            self.client.cookies.set(auth.COOKIE, f"{username}-token")

    def call(self, method, path, status=200, **kwargs):
        response = self.client.request(method, "/api/training" + path, **kwargs)
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.headers.get("cache-control"), "no-store, private")
        self.assertEqual(response.headers.get("vary"), "Cookie")
        return response.json()

    @property
    def path(self):
        return f"/plans/{self.plan['id']}/matches"

    def start(self, **overrides):
        return self.call("POST", self.path, json={**FILTERS, **overrides})

    def seed(self, mid="EUW1_base", start=None, duration=1800, patch_name="16.1", queue=420, role="MIDDLE",
             champion=103, puuid="own", team=100, deaths: int | None = 2, cs10: float | None = 0,
             dg: bool | dict = True, map_id: int | None = 11, remake=0, raw=None):
        start = (NOW - 4000) * 1000 if start is None else start
        roles = ["MIDDLE", "TOP", "JUNGLE", "BOTTOM", "UTILITY"] * 2
        roles[0] = role
        teams = [team] * 5 + [300 - team] * 5
        people = [puuid, *[f"fixture-{i}" for i in range(2, 11)]]
        info = {"mapId": map_id, "queueId": queue, "gameMode": "CLASSIC"}
        raw = raw if raw is not None else zlib.compress(json.dumps({"info": info}).encode())
        with closing(sqlite3.connect(self.cache)) as db:
            db.execute("INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?,?)",
                       (mid, "euw1", queue, start, duration, patch_name, remake, raw))
            for i, person in enumerate(people):
                db.execute("INSERT OR REPLACE INTO participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (mid, person, teams[i], champion if i == 0 else 1, roles[i], 1, 1,
                            deaths if i == 0 else 1, 1, 100, 10000, 10000, 1, None))
            db.execute("INSERT OR REPLACE INTO perf(match_id,puuid,cs10,jungle_cs10) VALUES (?,?,?,?)",
                       (mid, puuid, cs10, 23))
            if dg:
                value = digest(people, teams) if dg is True else dg
                db.execute("INSERT OR REPLACE INTO timeline_digest VALUES (?,?)",
                           (mid, zlib.compress(json.dumps(value).encode())))
            db.commit()
        return mid

    def assert_error(self, status, function, *args):
        with self.assertRaises(training.Error) as raised:
            function(*args)
        self.assertEqual(raised.exception.status, status)

    def test_import_workspace_and_all_old_crud_never_open_cache(self):
        self.connections.clear()
        with patch.object(auth, "connect", side_effect=AssertionError("Import opened members")), \
                patch.object(sqlite3, "connect", side_effect=AssertionError("Import opened cache")):
            importlib.reload(matches)
        with patch.object(matches, "_cached", side_effect=AssertionError("Old endpoint read cache")):
            self.call("GET", "")
            self.call("GET", "/export")
            for kind in training.KINDS:
                entry = self.call("POST", f"/entries/{kind}", json={"data": data_for(kind)})["entry"]
                self.call("GET", f"/entries/{kind}")
                entry = self.call("PUT", f"/entries/{kind}/{entry['id']}",
                                  json={"data": entry["data"], "revision": 1})["entry"]
                self.call("DELETE", f"/entries/{kind}/{entry['id']}?revision={entry['revision']}")
        self.assertTrue(all("file:" not in c and c != str(self.cache) for c in self.connections))

    def test_options_own_account_map_queue_remake_and_completed_only(self):
        self.seed()
        self.seed("EUW1_custom", queue=0, champion=999, patch_name="secret")
        self.seed("EUW1_aram", queue=450, map_id=12, champion=999)
        self.seed("EUW1_unknown_map", map_id=None, champion=998)
        self.seed("EUW1_wrong_map", map_id=12, champion=997)
        self.seed("EUW1_other", puuid="foreign", champion=996, patch_name="foreign")
        self.seed("EUW1_remake", remake=1, champion=995)
        self.seed("EUW1_live", start=(NOW - 100) * 1000, champion=994)
        self.seed("EUW1_quick", queue=490, champion=104, patch_name="16.2")
        result = self.call("GET", "/matches/options")
        self.assertEqual(result["account"], {"game_name": "Fixture", "tag_line": "TEST", "platform": "euw1"})
        self.assertEqual(result["champions"], [{"id": 103, "name": "Champion 103"}, {"id": 104, "name": "Champion 104"}])
        self.assertEqual(result["patches"], ["16.2", "16.1"])
        self.assertEqual({q["id"] for q in result["queues"]}, {420, 440, 400, 490})
        self.assertEqual(len(result["roles"]), 5)
        self.assertNotIn("puuid", json.dumps(result))
        self.user("bob")
        self.assertFalse(self.call("GET", "/matches/options")["available"])

    def test_read_only_cache_pragmas_and_no_mutations(self):
        def check(db):
            self.assertEqual(db.execute("PRAGMA query_only").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA cache_size").fetchone()[0], -1024)
            self.assertEqual(db.execute("PRAGMA mmap_size").fetchone()[0], 0)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("CREATE TABLE forbidden (id INTEGER)")
            return True
        self.assertTrue(matches._cached(check, False))
        self.seed()
        before = self.cache.read_bytes()
        self.start()
        self.call("GET", self.path)
        self.call("GET", "/review-queue")
        self.call("GET", "/review-context/EUW1_base")
        self.assertEqual(self.cache.read_bytes(), before)

    def test_absent_cache_does_not_create_files_and_stop_still_works(self):
        self.seed()
        started = self.start()
        self.cache.unlink()
        before = set(self.directory.iterdir())
        for path in ("/matches/options", self.path, "/review-queue", f"/review-queue?plan_id={self.plan['id']}"):
            result = self.call("GET", path)
            self.assertFalse(result["available"])
            self.assertIn("unavailable", result["reason"])
        self.call("GET", "/review-context/EUW1_base", 404)
        self.call("POST", self.path, 503, json={**FILTERS, "revision": 2})
        stopped = self.call("DELETE", self.path + "?revision=2")
        self.assertEqual(stopped["entry"]["revision"], started["entry"]["revision"] + 1)
        self.assertEqual(set(self.directory.iterdir()), before)
        self.assertFalse(self.cache.exists())

    def test_unlinked_changed_account_suppresses_cache_without_erasing_links_notes(self):
        self.seed()
        self.start()
        review = training.create_entry("alice", "reviews", data_for("reviews"))
        for action in (lambda: auth.set_account("alice", "euw1", "Changed", "T", "changed"),
                       lambda: auth.clear_account("alice")):
            action()
            with patch.object(matches, "_cached", side_effect=AssertionError("Mismatched account read cache")):
                progress = self.call("GET", self.path)
                self.assertFalse(progress["available"])
                self.assertEqual(progress["baseline"]["rows"], [])
                self.assertFalse(self.call("GET", f"/review-queue?plan_id={self.plan['id']}")["available"])
            self.call("GET", "/review-context/EUW1_base", 404)
            self.assertEqual(training.list_entries("alice", "reviews")["entries"], [review])
            self.assertEqual(len(training.export_member("alice")["tracking"]), 1)
        auth.set_account("alice", "euw1", "Fixture", "TEST", "own")
        self.assertTrue(self.call("GET", self.path)["available"])

    def test_frozen_baseline_first_follow_window_all_filters_and_temporal_boundaries(self):
        old = self.seed("EUW1_old", start=(NOW - 6000) * 1000)
        newest = self.seed("EUW1_newest", start=(NOW - 3000) * 1000)
        # End exactly at tracking start is not a completed-before-start baseline.
        self.seed("EUW1_end_boundary", start=(NOW - 1800) * 1000)
        result = self.start()
        self.assertEqual([r["match_id"] for r in result["baseline"]["rows"]], [newest, old])
        self.assertEqual(result["entry"]["revision"], 2)
        cases: list[tuple[str, dict[str, Any]]] = [
            ("wrong_role", {"role": "TOP"}), ("wrong_champion", {"champion": 104}),
            ("wrong_patch", {"patch_name": "16.2"}), ("wrong_queue", {"queue": 440}),
            ("wrong_map", {"map_id": 12}), ("remake", {"remake": 1})]
        for mid, kwargs in cases:
            self.seed(mid, start=(NOW + 1) * 1000, **kwargs)
        self.seed("boundary", start=NOW * 1000)
        self.seed("first", start=NOW * 1000 + 1, deaths=0)
        self.seed("second", start=(NOW + 2) * 1000, dg=False)
        self.seed("third", start=(NOW + 3) * 1000)
        self.seed("in_progress", start=(NOW + 9900) * 1000)
        self.clock.return_value = NOW + 10000
        result = self.call("GET", self.path)
        self.assertEqual([r["match_id"] for r in result["practice"]["rows"]], ["first", "second"])
        self.assertEqual(result["practice"]["games"], 2)
        self.assertEqual([r["match_id"] for r in result["baseline"]["rows"]], [newest, old])
        # Plan edits cannot silently change any captured filter/window.
        changed = dict(result["entry"]["data"]) if "entry" in result else dict(self.plan["data"])
        changed.update(games=1, role="TOP", champion="Other")
        training.update_entry("alice", "plans", self.plan["id"], changed, 2)
        frozen = self.call("GET", self.path)
        self.assertEqual(frozen["tracking"]["games"], 2)
        self.assertEqual(frozen["tracking"]["role"], "MIDDLE")
        # Missing baseline IDs are never replaced, even with another eligible cached match.
        with closing(sqlite3.connect(self.cache)) as db:
            db.execute("DELETE FROM matches WHERE match_id=?", (newest,))
            db.commit()
        self.seed("replacement", start=(NOW - 2000) * 1000)
        frozen = self.call("GET", self.path)
        self.assertEqual(frozen["baseline"]["games"], 2)
        self.assertEqual(frozen["baseline"]["rows"][0]["match_id"], newest)
        self.assertTrue(frozen["baseline"]["rows"][0]["missing"])
        self.assertIsNone(frozen["baseline"]["rows"][0]["values"]["deaths"])
        self.call("POST", self.path, 409, json={**FILTERS, "revision": 2})
        restarted = self.start(revision=3)
        self.assertEqual(restarted["tracking"]["games"], 1)
        self.assertEqual(restarted["entry"]["revision"], 4)
        self.call("DELETE", self.path + "?revision=3", 409)
        self.assertEqual(self.call("DELETE", self.path + "?revision=4")["entry"]["revision"], 5)
        self.assertIsNone(self.call("GET", self.path)["tracking"])

    def test_metric_counts_zeros_missing_partial_legacy_and_role_applicability(self):
        dg = digest()
        dg["kills"] = [[0, 6, 1, None, None, []], [599.999, 6, 1, None, None, []],
                       [600, 6, 1, None, None, []], [400, 1, 6, None, None, []]]
        dg["gold"][2][0], dg["gold"][2][5] = 3500, 3000
        self.seed("zero", deaths=0, cs10=0, dg=dg)
        self.seed("missing", start=(NOW - 3000) * 1000, deaths=None, cs10=None, dg={"v": 1})
        result = self.start()
        metrics = {m["key"]: m for m in result["metrics"]}
        self.assertEqual(metrics["deaths"]["baseline"], {"mean": 0, "n": 1})
        self.assertEqual(metrics["cs10"]["baseline"], {"mean": 0, "n": 1})
        self.assertEqual(metrics["early_deaths"]["baseline"], {"mean": 2, "n": 1})
        self.assertEqual(metrics["lane_gold10"]["baseline"], {"mean": 500, "n": 1})
        self.assertEqual(metrics["cs10"]["practice"], {"mean": None, "n": 0})
        self.assertIsNone(metrics["cs10"]["difference"])
        self.assertEqual(result["baseline"]["games"], 2)
        self.seed("support", role="UTILITY")
        result = self.start(revision=2, role="UTILITY")
        self.assertEqual({m["key"] for m in result["metrics"]}, {"deaths", "early_deaths"})
        self.assertIsNone(result["baseline"]["rows"][0]["values"]["cs10"])
        self.seed("jungle", role="JUNGLE")
        result = self.start(revision=3, role="JUNGLE")
        cs = next(m for m in result["metrics"] if m["key"] == "cs10")
        self.assertIn("Jungle", cs["label"])
        self.assertEqual(cs["baseline"], {"mean": 23, "n": 1})
        self.assertNotIn("lane_gold10", {m["key"] for m in result["metrics"]})

    def test_partial_digest_known_death_is_a_review_fact_not_a_complete_interval_count(self):
        complete = digest()
        complete["kills"] = []
        self.seed("complete", dg=complete)
        partial = digest()
        for key in ("ts", "valid", "gold", "xp", "cs", "pos"):
            partial[key] = partial[key][:2]
        partial["kills"] = [[250, 6, 1, None, None, []]]
        partial["end"] = 300
        self.seed("partial", dg=partial)
        result = self.start()
        values = {r["match_id"]: r["values"] for r in result["baseline"]["rows"]}
        self.assertIsNone(values["partial"]["early_deaths"])
        self.assertEqual(values["complete"]["early_deaths"], 0)
        metric = next(m for m in result["metrics"] if m["key"] == "early_deaths")
        self.assertEqual(metric["baseline"], {"mean": 0, "n": 1})
        self.assertEqual(result["baseline"]["games"], 2)
        context = self.call("GET", "/review-context/partial")
        self.assertTrue(context["available"])
        self.assertEqual([(p["kind"], p["seconds"]) for p in context["prompts"]], [("early_death", 250)])
        queue = self.call("GET", "/review-queue")
        self.assertEqual(queue["timelines_available"], 2)
        self.assertEqual(queue["missing_timelines"], 0)
        self.assertEqual({p["match_id"] for p in queue["prompts"]}, {"partial"})
        self.seed("partial_practice", start=(NOW + 1) * 1000, dg=partial)
        self.clock.return_value = NOW + 5000
        progress = self.call("GET", self.path)
        self.assertEqual(progress["practice"]["games"], 1)
        self.assertIsNone(progress["practice"]["rows"][0]["values"]["early_deaths"])
        metric = next(m for m in progress["metrics"] if m["key"] == "early_deaths")
        self.assertEqual(metric["practice"], {"mean": None, "n": 0})
        self.assertIsNone(metric["difference"])

    def test_early_death_coverage_uses_actual_frames_and_exact_short_match_cutoff(self):
        self.seed()
        self.start()
        cases = [(1800, 300, 1800, None), (1800, 1200, 300, None),
                 (1800, 599.999, 599.999, None), (1800, 600, 600, 1), (450, 449.999, 449.999, None),
                 (450, 450, 450, 1), (300, 300, 300, 1), (1800, None, 1800, None)]
        for duration, last_frame, end, expected in cases:
            with self.subTest(duration=duration, last_frame=last_frame):
                dg = digest()
                for key in ("ts", "valid", "gold", "xp", "cs", "pos"):
                    dg[key] = dg[key][:2]
                dg["ts"] = [0, last_frame]
                dg["valid"] = [True, last_frame is not None]
                dg["end"] = end
                dg["kills"] = [[250, 6, 1, None, None, []], [min(600, duration), 6, 1, None, None, []]]
                self.seed(duration=duration, dg=dg)
                progress = self.call("GET", self.path)
                self.assertEqual(progress["baseline"]["rows"][0]["values"]["early_deaths"], expected)
                metric = next(m for m in progress["metrics"] if m["key"] == "early_deaths")
                self.assertEqual(metric["baseline"]["n"], int(expected is not None))

    def test_huge_finite_cached_cs_does_not_overflow_means_or_json(self):
        self.seed("huge_a", cs10=1.7e308)
        self.seed("huge_b", start=(NOW - 3000) * 1000, cs10=1.7e308)
        result = self.start()
        for row in result["baseline"]["rows"]:
            self.assertIsNone(row["values"]["cs10"])
        metric = next(m for m in result["metrics"] if m["key"] == "cs10")
        self.assertEqual(metric["baseline"], {"mean": None, "n": 0})
        self.seed("practice_zero", start=(NOW + 1) * 1000, cs10=0)
        self.seed("practice_huge", start=(NOW + 2) * 1000, cs10=1.7e308)
        self.clock.return_value = NOW + 5000
        progress = self.call("GET", self.path)
        metric = next(m for m in progress["metrics"] if m["key"] == "cs10")
        self.assertEqual(metric["practice"], {"mean": 0, "n": 1})
        self.assertIsNone(metric["difference"])
        for payload in (result, progress):
            encoded = json.dumps(payload, allow_nan=False)
            self.assertNotIn("Infinity", encoded)
            self.assertNotIn("NaN", encoded)

    def test_cached_counter_bounds_keep_valid_values_and_finite_means(self):
        limit = matches.MAX_CACHED_COUNTER
        for value in (-1, limit + 1, 1.7e308, float("inf"), float("nan"), True):
            self.assertIsNone(matches._counter(value))
        self.assertEqual(matches._counter(0), 0)
        self.assertEqual(matches._counter(limit), limit)
        self.seed("bound_a", cs10=limit)
        self.seed("bound_b", cs10=limit)
        result = self.start()
        metric = next(m for m in result["metrics"] if m["key"] == "cs10")
        self.assertEqual(metric["baseline"], {"mean": limit, "n": 2})
        self.assertIn("15 seconds", result["note"])
        self.assertIn("approximate", result["note"])
        json.dumps(result, allow_nan=False)

    def test_lane_pairing_requires_unique_roles_explicit_teams_and_valid_frame(self):
        self.seed()
        self.start()
        for alteration in ("duplicate", "invalid_frame", "no_near_frame", "bad_team"):
            with self.subTest(alteration=alteration):
                self.seed()
                dg = digest()
                with closing(sqlite3.connect(self.cache)) as db:
                    if alteration == "duplicate":
                        db.execute("UPDATE participants SET position='MIDDLE' WHERE puuid='fixture-7'")
                    elif alteration == "invalid_frame":
                        dg["valid"][2] = False
                    elif alteration == "no_near_frame":
                        dg["ts"][2] = 580
                    elif alteration == "bad_team":
                        dg["teams"][5] = None
                    db.execute("UPDATE timeline_digest SET data=?", (zlib.compress(json.dumps(dg).encode()),))
                    db.commit()
                row = self.call("GET", self.path)["baseline"]["rows"][0]
                self.assertIsNone(row["values"]["lane_gold10"])

    def test_empty_valid_filter_combinations_any_champion_and_invalid_metadata(self):
        self.seed()
        result = self.start(role="TOP", champion_id=None, queue_id=440)
        self.assertTrue(result["available"])
        self.assertEqual(result["baseline"]["games"], 0)
        self.assertEqual(result["practice"]["games"], 0)
        self.assertIsNone(result["tracking"]["champion_id"])
        for fields in ({"patch": "unknown"}, {"champion_id": 999}):
            self.call("POST", self.path, 422, json={**FILTERS, "revision": 2, **fields})
        self.assertEqual(self.call("GET", self.path)["tracking"], result["tracking"])

    def test_revision_race_restart_stop_and_plan_access_are_transactional(self):
        self.seed()
        barrier = threading.Barrier(2)

        def attempt():
            barrier.wait(timeout=5)
            try:
                return matches.start("alice", self.plan["id"], FILTERS)["entry"]["revision"]
            except training.Error as error:
                return error.status

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: attempt(), range(2)))
        self.assertEqual(sorted(results), [2, 409])
        self.user("bob")
        for plan_id in (self.plan["id"], "unknown"):
            self.call("GET", f"/plans/{plan_id}/matches", 404)
            self.call("POST", f"/plans/{plan_id}/matches", 404, json=FILTERS)
            self.call("DELETE", f"/plans/{plan_id}/matches?revision=1", 404)
            self.call("GET", f"/review-queue?plan_id={plan_id}", 404)

    def test_exports_deletion_and_member_erasure_with_foreign_keys_off(self):
        self.seed()
        result = self.start()
        exported = training.export_member("alice")
        self.assertEqual(exported["tracking"][0]["puuid"], "own")
        self.assertEqual(exported["tracking"][0]["baseline_ids"], ["EUW1_base"])
        self.assertEqual(training.export_member("bob").get("tracking", []), [])
        self.assertNotIn("tracking", result["entry"]["data"])
        training.delete_entry("alice", "plans", self.plan["id"], 2)
        with closing(training.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_plan_links").fetchone()[0], 0)
        self.plan = training.create_entry("alice", "plans", data_for("plans"))
        self.start()
        with closing(auth.connect()) as db:
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 0)
            db.execute("BEGIN IMMEDIATE")
            training.erase_member(db, "alice")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_plan_links").fetchone()[0], 0)
            db.rollback()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_plan_links").fetchone()[0], 1)
            db.execute("BEGIN IMMEDIATE")
            training.erase_member(db, "alice")
            db.execute("DELETE FROM users WHERE username='alice'")
            db.commit()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_plan_links").fetchone()[0], 0)

    def test_legacy_reviews_keep_video_basis_without_rewriting_old_rows(self):
        review = training.create_entry("alice", "reviews", data_for("reviews"))
        self.assertEqual(review["data"]["time_basis"], "video")
        old = data_for("reviews")
        with closing(training.connect()) as db:
            db.execute("UPDATE training_entries SET data=? WHERE id=?", (json.dumps(old), review["id"]))
            db.commit()
        self.assertEqual(training.list_entries("alice", "reviews")["entries"][0]["data"]["time_basis"], "video")
        with closing(training.connect()) as db:
            self.assertEqual(json.loads(db.execute("SELECT data FROM training_entries WHERE id=?", (review["id"],)).fetchone()[0]), old)
        old["time_basis"] = "match"
        self.assertEqual(training.update_entry("alice", "reviews", review["id"], old, 1)["data"]["time_basis"], "match")
        old["time_basis"] = "auto"
        self.assert_error(422, training.update_entry, "alice", "reviews", review["id"], old, 2)

    def test_review_prompts_events_are_observational_bounded_and_private(self):
        dg = digest()
        dg["kills"] = [[250, 6, 1, 1200, 5000, []], [500, 6, 1, 1300, 4000, []]]
        dg["monsters"] = [[310, 200, "DRAGON", "FIRE_DRAGON"]]
        dg["gold"][2] = [4000] * 5 + [3500] * 5
        dg["gold"][3] = [4000] * 5 + [4100] * 5
        self.seed(dg=dg)
        context = self.call("GET", "/review-context/EUW1_base")
        self.assertTrue(context["available"])
        self.assertLessEqual(len(context["prompts"]), 3)
        kinds = {p["kind"] for p in context["prompts"]}
        self.assertEqual(kinds, {"death_before_objective", "early_death", "gold_swing"})
        self.assertEqual(len(context["prompts"]), len({p["id"] for p in context["prompts"]}))
        self.assertLessEqual(len(context["events"]), 80)
        for event in context["events"]:
            self.assertEqual(set(event), {"seconds", "kind", "label", "side"})
            self.assertLess(event["seconds"], 1800)
        public = json.dumps(context)
        for forbidden in ("fixture-", "puuid", "victim", "killer", "position", '"x"', '"y"', "chance", "odds"):
            self.assertNotIn(forbidden, public)
        self.seed("other", start=(NOW - 5000) * 1000, dg=dg)
        self.seed("third", start=(NOW - 6000) * 1000, dg=dg)
        self.seed("no_timeline", start=(NOW - 7000) * 1000, dg=False)
        queue = self.call("GET", "/review-queue")
        self.assertEqual(queue["games_considered"], 4)
        self.assertEqual(queue["timelines_available"], 3)
        self.assertEqual(queue["missing_timelines"], 1)
        self.assertEqual(len(queue["prompts"]), 6)

    def test_review_gold_lead_prompt_and_invalid_or_terminal_frames_not_used(self):
        dg = digest()
        dg["kills"] = []
        dg["gold"][1] = [3000] * 5 + [2700] * 5  # +1500 early lead
        dg["gold"][5] = [5000] * 5 + [5000] * 5  # lost after >180 seconds
        dg["gold"][2] = [3500] * 5 + [3300] * 5
        dg["gold"][3] = [3600] * 5 + [3400] * 5
        dg["gold"][4] = [3700] * 5 + [3500] * 5
        dg["gold"][-1] = [6000] * 5 + [10000] * 5  # terminal: never a gold-loss prompt
        self.seed(dg=dg)
        context = self.call("GET", "/review-context/EUW1_base")
        self.assertIn("lead_lost", {p["kind"] for p in context["prompts"]})
        self.assertNotIn("gold_swing", {p["kind"] for p in context["prompts"]})
        dg["valid"] = [False] * len(dg["ts"])
        self.seed(dg=dg)
        self.assertEqual(self.call("GET", "/review-context/EUW1_base")["prompts"], [])

    def test_plan_scoped_queue_only_follow_games_missing_digests_counted(self):
        self.seed()
        self.assertFalse(self.call("GET", f"/review-queue?plan_id={self.plan['id']}")["available"])
        self.start()
        self.seed("follow", start=(NOW + 1) * 1000, dg=False)
        self.seed("wrong_role", start=(NOW + 2) * 1000, role="TOP")
        self.seed("follow2", start=(NOW + 3) * 1000)
        self.seed("outside_window", start=(NOW + 4) * 1000)
        self.clock.return_value = NOW + 10000
        queue = self.call("GET", f"/review-queue?plan_id={self.plan['id']}")
        self.assertEqual(queue["games_considered"], 2)
        self.assertEqual(queue["timelines_available"], 1)
        self.assertEqual(queue["missing_timelines"], 1)
        self.assertEqual({p["match_id"] for p in queue["prompts"]}, {"follow2"})
        self.assertEqual(queue["scope"]["role"], "MIDDLE")

    def test_context_unknown_foreign_custom_and_unlinked_are_identical_404(self):
        self.seed("foreign", puuid="foreign")
        self.seed("custom", queue=0)
        self.seed("unknown_map", map_id=None)
        self.seed("not_completed", start=(NOW - 1) * 1000)
        bodies = [self.call("GET", f"/review-context/{mid}", 404)
                  for mid in ("unknown", "foreign", "custom", "unknown_map", "not_completed")]
        self.assertEqual(bodies, [bodies[0]] * len(bodies))
        self.seed(dg=False)
        context = self.call("GET", "/review-context/EUW1_base")
        self.assertFalse(context["available"])
        self.assertEqual(context["events"], [])
        self.assertEqual(context["prompts"], [])
        auth.clear_account("alice")
        self.assertEqual(self.call("GET", "/review-context/EUW1_base", 404), bodies[0])

    def test_partial_legacy_tables_and_bounded_decompression_do_not_upgrade_cache(self):
        self.seed(dg={"v": 1})
        self.seed("raw_bomb", raw=zlib.compress(b"x" * (matches.MAX_RAW_BYTES + 1)), champion=999)
        self.start()
        with closing(sqlite3.connect(self.cache)) as db:
            db.execute("DROP TABLE perf")
            db.execute("DROP TABLE timeline_digest")
            db.commit()
        before = self.cache.read_bytes()
        result = self.call("GET", self.path)
        self.assertIsNone(result["baseline"]["rows"][0]["values"]["early_deaths"])
        self.assertEqual(result["baseline"]["rows"][0]["values"]["deaths"], 2)
        self.assertIsNone(result["baseline"]["rows"][0]["values"]["cs10"])
        self.assertFalse(self.call("GET", "/review-context/EUW1_base")["available"])
        self.assertEqual(self.cache.read_bytes(), before)
        self.assertNotIn(999, {c["id"] for c in self.call("GET", "/matches/options")["champions"]})

    def test_bounded_candidates_explicit_truncation_and_review_ten_game_limit(self):
        self.seed()
        with closing(sqlite3.connect(self.cache)) as db:
            base = db.execute("SELECT * FROM matches WHERE match_id='EUW1_base'").fetchone()
            person = db.execute("SELECT * FROM participants WHERE match_id='EUW1_base' AND puuid='own'").fetchone()
            for i in range(205):
                mid = f"bounded-{i:03}"
                db.execute("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)", (mid, *base[1:3], base[3] - i * 1000, *base[4:]))
                db.execute("INSERT INTO participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (mid, *person[1:]))
            db.commit()
        with patch.object(matches, "_raw_info", wraps=matches._raw_info) as reads:
            result = self.call("GET", "/matches/options")
            self.assertEqual(reads.call_count, 200)
        self.assertTrue(result["truncated"])
        queue = self.call("GET", "/review-queue")
        self.assertEqual(queue["games_considered"], 10)
        self.assertTrue(queue["truncated"])
        self.assertEqual(queue["timelines_available"] + queue["missing_timelines"], 10)

    def test_subsecond_opt_in_freezes_same_second_baseline_and_excludes_earlier_starts(self):
        started = NOW + 0.80025
        older = self.seed()
        baseline = self.seed("baseline_same_second", start=(NOW - 1800) * 1000 + 500)
        self.seed("practice_before_start", start=NOW * 1000 + 500)
        self.seed("practice_before_start_same_ms", start=NOW * 1000 + 800)
        self.seed("practice_after_start", start=NOW * 1000 + 801)
        self.clock.return_value = started
        result = self.start()
        self.assertEqual(result["tracking"]["started"], started)
        self.assertEqual(result["entry"]["updated"], NOW)
        self.assertIsInstance(result["entry"]["updated"], int)
        self.assertEqual([r["match_id"] for r in result["baseline"]["rows"]], [baseline, older])
        self.assertEqual(result["practice"]["games"], 0)
        with closing(training.connect()) as db:
            stored = db.execute("SELECT started,typeof(started) FROM training_plan_links WHERE plan_id=?",
                                (self.plan["id"],)).fetchone()
            self.assertEqual(tuple(stored), (started, "real"))
        self.assertEqual(training.export_member("alice")["tracking"][0]["started"], started)
        self.clock.return_value = NOW + 5000.123456
        progress = self.call("GET", self.path)
        self.assertEqual(progress["tracking"]["started"], started)
        self.assertEqual([r["match_id"] for r in progress["baseline"]["rows"]], [baseline, older])
        self.assertEqual([r["match_id"] for r in progress["practice"]["rows"]], ["practice_after_start"])
        queue = self.call("GET", f"/review-queue?plan_id={self.plan['id']}")
        self.assertEqual(queue["games_considered"], 1)
        self.assertEqual({p["match_id"] for p in queue["prompts"]}, {"practice_after_start"})
        restarted = self.start(revision=2)
        self.assertEqual(restarted["tracking"]["started"], self.clock.return_value)
        self.assertEqual(restarted["entry"]["updated"], NOW + 5000)
        self.assertEqual(restarted["practice"]["games"], 0)

    def test_follow_requires_completion_but_includes_exact_completion_time(self):
        self.seed()
        self.start()
        self.seed("follow", start=(NOW + 1) * 1000)
        self.clock.return_value = NOW + 1800.999
        self.assertEqual(self.call("GET", self.path)["practice"]["games"], 0)
        self.clock.return_value = NOW + 1801
        self.assertEqual(self.call("GET", self.path)["practice"]["games"], 1)

    def test_maximum_twenty_game_windows_and_sequential_digest_budget(self):
        training.update_entry("alice", "plans", self.plan["id"], {**self.plan["data"], "games": 20}, 1)
        for i in range(25):
            self.seed(f"before-{i}", start=(NOW - 3000 - i) * 1000, dg=False)
        result = self.start(revision=2)
        self.assertEqual(result["baseline"]["games"], 20)
        for i in range(25):
            self.seed(f"after-{i}", start=(NOW + 1 + i) * 1000, dg=False)
        self.clock.return_value = NOW + 5000
        with patch.object(store, "digest", wraps=store.digest) as reads:
            progress = self.call("GET", self.path)
            self.assertEqual(reads.call_count, 40)
        self.assertEqual(progress["practice"]["games"], 20)
        self.assertEqual([r["match_id"] for r in progress["practice"]["rows"]], [f"after-{i}" for i in range(20)])
        self.assertEqual(next(m for m in progress["metrics"] if m["key"] == "cs10")["baseline"]["n"], 20)
        with patch.object(store, "digest", wraps=store.digest) as reads:
            queue = self.call("GET", f"/review-queue?plan_id={self.plan['id']}")
            self.assertEqual(reads.call_count, 20)
        self.assertEqual(queue["missing_timelines"], 20)

    def test_default_queue_filters_solo_before_bounding_candidates(self):
        self.seed()
        with closing(sqlite3.connect(self.cache)) as db:
            base = db.execute("SELECT * FROM matches WHERE match_id='EUW1_base'").fetchone()
            person = db.execute("SELECT * FROM participants WHERE match_id='EUW1_base' AND puuid='own'").fetchone()
            for i in range(205):
                mid = f"normal-{i}"
                raw = zlib.compress(json.dumps({"info": {"mapId": 11, "queueId": 400}}).encode())
                db.execute("INSERT INTO matches VALUES (?,?,?,?,?,?,?,?)",
                           (mid, "euw1", 400, base[3] + i + 1, *base[4:7], raw))
                db.execute("INSERT INTO participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (mid, *person[1:]))
            db.commit()
        result = self.call("GET", "/review-queue")
        self.assertEqual(result["games_considered"], 1)
        self.assertEqual({p["match_id"] for p in result["prompts"]}, {"EUW1_base"})

    def test_digest_bomb_corruption_and_unconfirmed_team_remain_missing(self):
        self.seed()
        self.start()
        invalid_payloads = [b"not-zlib", zlib.compress(b"x" * (256 * 1024 + 1)),
                            zlib.compress(json.dumps({"v": 1}).encode())]
        unknown_team = digest()
        unknown_team["teams"][0] = None
        invalid_payloads.append(zlib.compress(json.dumps(unknown_team).encode()))
        for payload in invalid_payloads:
            with closing(sqlite3.connect(self.cache)) as db:
                db.execute("UPDATE timeline_digest SET data=?", (payload,))
                db.commit()
            result = self.call("GET", self.path)
            self.assertIsNone(result["baseline"]["rows"][0]["values"]["early_deaths"])
            self.assertFalse(self.call("GET", "/review-context/EUW1_base")["available"])

    def test_archived_tracking_remains_readable_and_red_team_mapping_is_explicit(self):
        dg = digest(teams=[200] * 5 + [100] * 5)
        dg["monsters"] = [[350, 100, "DRAGON", "FIRE_DRAGON"]]
        self.seed(team=200, dg=dg)
        self.start()
        training.create_entry("alice", "plans", data_for("plans", title="A new active plan"))
        progress = self.call("GET", self.path)
        self.assertTrue(progress["available"])
        self.assertEqual(progress["baseline"]["games"], 1)
        context = self.call("GET", "/review-context/EUW1_base")
        self.assertIn("death_before_objective", {p["kind"] for p in context["prompts"]})
        objective = next(e for e in context["events"] if e["kind"] == "monster")
        self.assertEqual(objective["side"], "them")
        self.call("DELETE", self.path + "?revision=2", 409)
        self.assertEqual(self.call("DELETE", self.path + "?revision=3")["entry"]["data"]["status"], "archived")

    def test_new_routes_strict_queries_bodies_origin_and_auth_before_cache(self):
        self.seed()
        bad_queries = [("GET", "/matches/options?puuid=foreign"), ("GET", self.path + "?revision=1"),
                       ("GET", "/review-queue?plan_id=x&plan_id=y"), ("GET", "/review-queue?plan_id="),
                       ("GET", "/review-context/EUW1_base?owner=bob"),
                       ("DELETE", self.path + "?revision=1&revision=1"),
                       ("DELETE", self.path + "?revision=1.0"), ("DELETE", self.path)]
        with patch.object(matches, "_cached", side_effect=AssertionError("Invalid request read cache")):
            for method, path in bad_queries:
                self.call(method, path, 422)
            for field, values in {"revision": [True, 0, "1", 1.0], "role": ["", "MID", None],
                                  "queue_id": [420.0, "420", True, 450, 480],
                                  "champion_id": [True, 0, "103", 103.0], "patch": ["", " ", 16.1]}.items():
                for value in values:
                    self.call("POST", self.path, 422, json={**FILTERS, field: value})
            for extra in ({"puuid": "foreign"}, {"owner": "bob"}, {"started": 0}, {"games": 20}, {"tracking_revision": 1}):
                self.call("POST", self.path, 422, json={**FILTERS, **extra})
            self.call("POST", self.path, 422, content=json.dumps(FILTERS)[:-1] + ',"revision":1}',
                      headers={"Content-Type": "application/json"})
            self.call("POST", self.path, 422, content='{"revision":NaN}', headers={"Content-Type": "application/json"})
            self.call("POST", self.path, 415, content=json.dumps(FILTERS))
            self.call("POST", self.path, 413, content=b" " * (training_api.MAX_REQUEST_BYTES + 1),
                      headers={"Content-Type": "application/json"})
            for headers in ({"Origin": "https://evil.example"}, {"Referer": "https://evil.example/page"},
                            {"Origin": "http://testserver", "Sec-Fetch-Site": "same-site"}):
                self.call("POST", self.path, 403, json=FILTERS, headers=headers)
                self.call("DELETE", self.path + "?revision=1", 403, headers=headers)
            self.user(None)
            for method, path, kwargs in (("GET", "/matches/options", {}), ("GET", self.path, {}),
                                         ("POST", self.path, {"json": FILTERS}),
                                         ("DELETE", self.path + "?revision=1", {}),
                                         ("GET", "/review-queue", {}), ("GET", "/review-context/EUW1_base", {})):
                self.call(method, path, 401, **kwargs)

    def test_new_endpoints_inside_real_app_without_lifespan_network_or_env(self):
        self.seed()
        # main's import calls load_env; suppress it rather than reading any real file.
        with patch.object(config, "load_env"), patch.dict(os.environ, {"SAMPLER": "0", "SESSION_COOKIE_SECURE": "auto"}):
            import main
        with patch.object(main, "track"), patch.dict(main._seen, {}, clear=True):
            async def exercise():
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://fixture") as client:
                    client.cookies.set(auth.COOKIE, "alice-token")
                    for path in ("/matches/options", "/review-queue", "/review-context/EUW1_base", self.path):
                        response = await client.get("/api/training" + path)
                        self.assertEqual(response.status_code, 200, response.text)
                        self.assertEqual(response.headers["cache-control"], "no-store, private")
                    response = await client.post("/api/training" + self.path, json=FILTERS, headers={"Origin": "http://fixture"})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["entry"]["revision"], 2)
                    response = await client.delete("/api/training" + self.path + "?revision=2", headers={"Origin": "http://fixture"})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["entry"]["revision"], 3)
                    client.cookies.clear()
                    self.assertEqual((await client.get("/api/training/review-queue")).status_code, 401)
            asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
