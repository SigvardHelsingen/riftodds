"""The training workspace inside the real app: routing, headers, privacy and member removal.

Fixture databases only; no lifespan (no sampler, model training or Data Dragon), no Riot calls
and no network. Run: .venv/bin/python -m unittest discover -s tests -p test_training_integration.py -v
"""
import io
import os
import sqlite3
import tempfile
import unittest
from contextlib import ExitStack, closing, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import httpx

import config

with patch.object(config, "load_env"), patch.dict(os.environ, {"SAMPLER": "0", "SESSION_COOKIE_SECURE": "auto"}):
    import main

import training
from test_training import data_for

ORIGIN = "http://fixture"
SECRET = "Private note: alice keeps tilting after losses"


class TrainingInApp(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.members = directory / "fixture-members.sqlite"
        self.cache = directory / "fixture-cache.sqlite"
        real_connect = sqlite3.connect

        def fixture_only(database, *args, **kwargs):
            self.assertIn(Path(database), (self.members, self.cache), "Unexpected database access")
            return real_connect(database, *args, **kwargs)

        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=fixture_only))
        self.stack.enter_context(patch.object(main.auth, "DB_PATH", self.members))
        self.stack.enter_context(patch.object(main.store, "DB_PATH", self.cache))
        self.stack.enter_context(patch.object(main, "track"))
        self.stack.enter_context(patch.dict(main._seen, {}, clear=True))
        forbidden = AssertionError("Real network is forbidden")
        self.stack.enter_context(patch.object(httpx.AsyncHTTPTransport, "handle_async_request", side_effect=forbidden))
        self.stack.enter_context(patch.object(httpx.HTTPTransport, "handle_request", side_effect=forbidden))
        with closing(main.auth.connect()) as db:
            db.executemany("INSERT INTO users (username, password_hash, created) VALUES (?, 'unused-fixture', 0)",
                           [("alice",), ("bob",), ("carol",)])
            db.executemany("INSERT INTO sessions VALUES (?, ?, ?)",
                           [(main.auth._token_hash(f"{user}-session"), user, 10 ** 12) for user in ("alice", "bob", "carol")])
            db.commit()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url=ORIGIN)
        self.addAsyncCleanup(self.client.aclose)
        self.user("alice")

    def user(self, username):
        self.client.cookies.clear()
        if username:
            self.client.cookies.set(main.auth.COOKIE, f"{username}-session")

    async def call(self, method, path, status=200, **kwargs):
        headers = kwargs.setdefault("headers", {})
        if method not in ("GET", "HEAD") and "Referer" not in headers:
            headers.setdefault("Origin", ORIGIN)  # what a browser sends for a same-origin fetch
        response = await self.client.request(method, path, **kwargs)
        self.assertEqual(response.status_code, status, f"{method} {path}: {response.text}")
        return response

    async def create(self, kind, team_id=None, **overrides):
        body = {"data": data_for(kind, **overrides), "team_id": team_id}
        return (await self.call("POST", f"/api/training/entries/{kind}", json=body)).json()["entry"]

    def rows(self, sql, *args):
        with closing(sqlite3.connect(self.members)) as db:
            return db.execute(sql, args).fetchall()

    async def test_router_is_mounted_behind_the_app_session_check_and_security_headers(self):
        response = await self.call("GET", "/api/training")
        self.assertEqual(set(response.json()), {"catalog", "entries", "teams", "invitations", "limits"})
        self.assertIn("no-store", response.headers["cache-control"])
        csp = response.headers["content-security-policy"]
        self.assertIn("media-src 'self' blob:", csp, "Local review videos play from blob: URLs only")
        self.assertIn("connect-src 'self'", csp, "Nothing may send data elsewhere")
        self.assertNotIn("http", csp.split("media-src", 1)[1].split(";", 1)[0], "No remote media sources")
        self.user(None)
        for method, path in (("GET", "/api/training"), ("GET", "/api/training/export"),
                             ("POST", "/api/training/teams"), ("DELETE", "/api/training/teams/x")):
            with self.subTest(method=method, path=path):
                self.assertEqual((await self.call(method, path, 401, json={})).json(), {"detail": "Not logged in"})

    async def test_training_never_touches_the_riot_cache_or_marks_the_site_busy(self):
        with patch.object(main.store, "connect", side_effect=AssertionError("Training read cache.db")):
            await self.create("plans")
            await self.call("GET", "/api/training")
            await self.call("GET", "/api/training/export")
        self.assertEqual(main.state.get("last_activity", 0), 0,
                         "Training must not pause the background sampler like a player lookup")

    async def test_cross_origin_mutations_are_rejected_before_storage(self):
        before = self.rows("SELECT COUNT(*) FROM sqlite_master WHERE name='training_entries'")
        for headers in ({"Origin": "https://evil.example"}, {"Referer": "https://evil.example/page"},
                        {"Origin": ORIGIN, "Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                await self.call("POST", "/api/training/entries/plans", 403,
                                json={"data": data_for("plans")}, headers=headers)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM sqlite_master WHERE name='training_entries'"), before)
        await self.create("plans")

    async def test_index_loads_the_training_workspace_and_never_the_simulator(self):
        html = (await self.call("GET", "/")).text
        for name in ("training.js", "training-review.js", "training-team.js", "training-lab.js", "training.css"):
            self.assertRegex(html, rf"/static/{name}\?v=[0-9a-f]{{12}}")
        self.assertNotIn("practice.js", html)
        self.assertNotIn("practice-renderer.js", html)
        self.assertNotIn("practice.css", html)
        self.assertLess(html.index("training.js"), html.index("training-review.js"))
        for path in ("/static/practice.js", "/static/practice-renderer.js", "/static/practice.css",
                     "/static/practice-assets/manifest.json", "/legacy-practice/static/practice.js"):
            with self.subTest(path=path):
                await self.call("GET", path, 404)

    async def test_private_notes_stay_with_their_member(self):
        review = await self.create("reviews", title="Lane review", moments=[])
        await self.create("lessons", question=SECRET, answer="Take a break", source_review_id=review["id"])
        # Other members, and app endpoints that describe members, never carry another member's notes.
        self.user("bob")
        for path in ("/api/training", "/api/training/export", "/api/training/entries/lessons", "/api/me"):
            with self.subTest(path=path):
                self.assertNotIn(SECRET, (await self.call("GET", path)).text)
        await self.call("PUT", f"/api/training/entries/reviews/{review['id']}", 404,
                        json={"data": review["data"], "revision": 1})
        with patch.object(main.auth, "role_of", return_value="admin"):
            self.assertNotIn(SECRET, (await self.call("GET", "/api/admin/activity")).text)
        self.user("alice")
        self.assertIn(SECRET, (await self.call("GET", "/api/training/export")).text)

    async def test_unlinking_or_switching_riot_accounts_keeps_training_notes(self):
        main.auth.set_account("alice", "euw1", "Alice", "ONE", "alice-puuid")
        for kind in training.KINDS:
            await self.create(kind, **({"status": "archived"} if kind == "plans" else {}))
        team = (await self.call("POST", "/api/training/teams", json={"name": "Duo"})).json()["team"]
        await self.create("boards", team_id=team["id"])
        await self.call("DELETE", "/api/me/account")
        main.auth.set_account("alice", "euw1", "Alice", "TWO", "other-puuid")
        entries = (await self.call("GET", "/api/training")).json()["entries"]
        self.assertEqual({kind: len(rows) for kind, rows in entries.items()}, {kind: 1 for kind in training.KINDS})
        self.assertEqual(len((await self.call("GET", f"/api/training/teams/{team['id']}")).json()["entries"]["boards"]), 1)

    async def test_removing_a_member_erases_their_training_data_and_owned_teams(self):
        # alice owns a team with bob; bob owns a team with alice and carol.
        alice_team = (await self.call("POST", "/api/training/teams", json={"name": "Alice's team"})).json()["team"]["id"]
        await self.call("POST", f"/api/training/teams/{alice_team}/invite", json={"username": "bob"})
        personal = await self.create("reviews", title="Alice personal")
        self.user("bob")
        await self.call("POST", f"/api/training/teams/{alice_team}/accept", json={})
        bob_in_alice_team = await self.create("boards", team_id=alice_team)
        bob_team = (await self.call("POST", "/api/training/teams", json={"name": "Bob's team"})).json()["team"]["id"]
        for name in ("alice", "carol"):
            await self.call("POST", f"/api/training/teams/{bob_team}/invite", json={"username": name})
        bob_review = await self.create("reviews", team_id=bob_team, title="Bob shared review")
        bob_personal = await self.create("boards", title="Bob personal")
        self.user("alice")
        await self.call("POST", f"/api/training/teams/{bob_team}/accept", json={})
        alice_review = await self.create("reviews", team_id=bob_team, title="Alice shared review")
        self.user("bob")
        puzzle = await self.create("puzzles", team_id=bob_team, source_review_id=alice_review["id"])

        with redirect_stdout(io.StringIO()):
            main.auth.main(["remove", "alice"])

        self.assertEqual(self.rows("SELECT COUNT(*) FROM training_entries WHERE owner='alice'"), [(0,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM training_teams WHERE owner='alice'"), [(0,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM training_memberships WHERE username='alice'"), [(0,)])
        ids = {row[0] for row in self.rows("SELECT id FROM training_entries")}
        self.assertNotIn(personal["id"], ids)
        self.assertNotIn(bob_in_alice_team["id"], ids, "Documents in a deleted team go with it")
        self.assertTrue({bob_review["id"], bob_personal["id"], puzzle["id"]} <= ids, "Other members' data survives")
        team = (await self.call("GET", f"/api/training/teams/{bob_team}")).json()
        self.assertEqual([m["username"] for m in team["team"]["members"]], ["bob", "carol"])
        kept = next(entry for entry in team["entries"]["puzzles"] if entry["id"] == puzzle["id"])
        self.assertIsNone(kept["data"]["source_review_id"], "A link to the erased review is detached, not left dangling")
        self.assertEqual(self.rows("PRAGMA foreign_key_check"), [])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM users WHERE username='alice'"), [(0,)])

    async def test_removing_a_member_without_training_tables_still_works(self):
        with redirect_stdout(io.StringIO()):
            main.auth.main(["remove", "carol"])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM users WHERE username='carol'"), [(0,)])
        self.assertEqual(self.rows("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'training_%'"), [(0,)],
                         "Removal must not create training tables")

    async def test_a_removed_member_session_cannot_write_training_data(self):
        await self.create("plans")
        with redirect_stdout(io.StringIO()):
            main.auth.main(["remove", "alice"])
        await self.call("POST", "/api/training/entries/plans", 401, json={"data": data_for("plans")})
        self.assertEqual(self.rows("SELECT COUNT(*) FROM training_entries WHERE owner='alice'"), [(0,)])


if __name__ == "__main__":
    unittest.main()
