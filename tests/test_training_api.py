"""End-to-end router tests with real fixture auth sessions, no production lifespan.

This app deliberately does not import main: it cannot start sampling, model training,
Riot requests or touch cache.db. All SQLite connections are fixture-only guarded.
"""
import asyncio
import json
import sqlite3
from contextlib import closing
from unittest.mock import patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

import auth
import training
import training_api
from test_training import TrainingFixture, data_for


class TrainingAPITests(TrainingFixture):
    def setUp(self):
        super().setUp()
        with closing(auth.connect()) as db:
            db.executemany("INSERT INTO sessions VALUES (?,?,?)",
                           [(auth._token_hash(f"{user}-token"), user, 10 ** 12)
                            for user in ("alice", "bob", "carol", "dave")])
            db.commit()
        app = FastAPI()

        @app.middleware("http")
        async def auth_middleware(request: Request, call_next):
            username = await asyncio.to_thread(auth.user_for, request.cookies.get(auth.COOKIE))
            if not username:
                return JSONResponse({"detail": "Not logged in"}, status_code=401)
            request.state.user = username
            return await call_next(request)

        app.include_router(training_api.router)
        self.client = self.stack.enter_context(TestClient(app))
        self.user("alice")

    def user(self, username):
        self.client.cookies.clear()
        if username:
            self.client.cookies.set(auth.COOKIE, f"{username}-token")

    def request(self, method, path="", expected=200, **kwargs):
        response = self.client.request(method, "/api/training" + path, **kwargs)
        self.assertEqual(response.status_code, expected, f"{method} {path}: {response.text}")
        return response

    def post_entry(self, kind="reviews", data=None, team_id=None, expected=200):
        response = self.request("POST", f"/entries/{kind}", expected, json={"data": data or data_for(kind), "team_id": team_id})
        return response.json().get("entry")

    def test_workspace_requires_real_session_and_does_not_link_riot(self):
        response = self.request("GET")
        result = response.json()
        self.assertEqual(set(result), {"catalog", "entries", "teams", "invitations", "limits"})
        self.assertEqual(set(result["entries"]), set(training.KINDS))
        self.assertEqual(result["teams"], [])
        self.assertEqual(result["invitations"], [])
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertEqual(response.headers["vary"], "Cookie")
        self.assertIsNone(auth.get_account("alice"))
        self.user(None)
        for method, path, kwargs in (("GET", "", {}), ("GET", "/export", {}),
                                     ("POST", "/entries/boards", {"json": {"data": data_for("boards")}}),
                                     ("DELETE", "/teams/unknown", {})):
            self.request(method, path, 401, **kwargs)
        self.user("unknown")
        self.request("GET", expected=401)

    def test_router_itself_fails_closed_without_auth_middleware(self):
        app = FastAPI()
        app.include_router(training_api.router)
        with TestClient(app) as client, patch.object(training, "connect", side_effect=AssertionError("Unauthenticated database access")):
            self.assertEqual(client.get("/api/training").status_code, 401)
            self.assertEqual(client.post("/api/training/teams", json={"name": "No auth"}).status_code, 401)

    def test_all_kinds_http_crud_and_stale_revisions(self):
        for kind in training.KINDS:
            with self.subTest(kind=kind):
                entry = self.post_entry(kind)
                path = f"/entries/{kind}/{entry['id']}"
                listed = self.request("GET", f"/entries/{kind}").json()
                self.assertEqual(listed, {"entries": [entry], "has_more": False})
                replacement = self.request("PUT", path, json={"data": entry["data"], "revision": 1}).json()["entry"]
                self.assertEqual(replacement["revision"], 2)
                self.request("PUT", path, 409, json={"data": entry["data"], "revision": 1})
                self.request("DELETE", path + "?revision=1", 409)
                self.assertEqual(self.request("DELETE", path + "?revision=2").json(), {"ok": True})
                self.request("DELETE", path + "?revision=2", 404)

    def test_unknown_kinds_and_inaccessible_ids_are_404(self):
        entry = self.post_entry()
        lesson = self.post_entry("lessons")
        self.user("bob")
        for entry_id in (entry["id"], "guessed-id"):
            self.request("PUT", f"/entries/reviews/{entry_id}", 404, json={"data": entry["data"], "revision": 1})
            self.request("DELETE", f"/entries/reviews/{entry_id}?revision=1", 404)
        self.request("POST", f"/lessons/{lesson['id']}/grade", 404, json={"revision": 1, "rating": "easy"})
        self.request("GET", "/entries/extra", 404)
        self.request("POST", "/entries/extra", 404, json={"data": {}})
        self.request("GET", "/teams/unknown", 404)

    def test_inaccessible_and_unknown_ids_have_identical_error_bodies(self):
        team_id = training.create_team("alice", "Private team")["id"]
        shared = self.post_entry("reviews", team_id=team_id)
        private = self.post_entry("reviews")
        self.user("bob")
        for method in ("PUT", "DELETE"):
            bodies = []
            for entry_id in (shared["id"], private["id"], "unknown"):
                path = f"/entries/reviews/{entry_id}"
                kwargs = {"json": {"data": shared["data"], "revision": 1}} if method == "PUT" else {}
                if method == "DELETE":
                    path += "?revision=1"
                bodies.append(self.request(method, path, 404, **kwargs).json())
            self.assertEqual(bodies, [bodies[0]] * 3)
        bodies = [self.request("POST", "/entries/lessons", 404,
                               json={"data": data_for("lessons", source_review_id=entry_id)}).json()
                  for entry_id in (shared["id"], private["id"], "unknown")]
        self.assertEqual(bodies, [bodies[0]] * 3)

    def test_unknown_and_duplicate_query_fields_rejected(self):
        entry = self.post_entry("boards")
        for path in ("?owner=bob", "/export?username=bob", "/entries/boards?team=other",
                     "/entries/boards?team_id=one&team_id=two", "/entries/boards?limit=1&limit=50",
                     f"/entries/boards/{entry['id']}?revision=1&revision=2"):
            method = "DELETE" if "revision=" in path else "GET"
            self.request(method, path, 422)
        self.assertEqual(training.list_entries("alice", "boards")["entries"], [entry])

    def test_query_validation_is_strict_bounded_sanitized_and_not_cacheable(self):
        entry = self.post_entry("boards")
        with patch.object(training, "connect", side_effect=AssertionError("Invalid query opened training DB")):
            for value in ("1.0", "1e0", "+1", "%201", "1%20", "true", "-1", "", "9" * 5000, "١"):
                for path in (f"/entries/boards?limit={value}", f"/entries/boards/{entry['id']}?revision={value}"):
                    method = "DELETE" if "revision=" in path else "GET"
                    response = self.request(method, path, 422)
                    self.assertEqual(response.json(), {"detail": "Invalid query fields or types"})
                    self.assertEqual(response.headers["cache-control"], "no-store, private")
                    self.assertEqual(response.headers["vary"], "Cookie")
            response = self.request("DELETE", f"/entries/boards/{entry['id']}", 422)
            self.assertEqual(response.json(), {"detail": "Invalid query fields or types"})
            for team_id in ("", "x" * 161, "bad%00id", "%20"):
                response = self.request("GET", f"/entries/boards?team_id={team_id}", 422)
                self.assertEqual(response.json(), {"detail": "Invalid request fields or types"})
                self.assertIn("no-store", response.headers["cache-control"])

    def test_workspace_limits_are_exact_and_count_authored_shared_documents(self):
        team_id = training.create_team("alice", "Team")["id"]
        training.invite_member("alice", team_id, "bob")
        training.accept_invitation("bob", team_id)
        self.post_entry()
        shared = self.post_entry("boards", team_id=team_id)
        self.create("boards", "bob", team_id)
        training.update_entry("bob", "boards", shared["id"], shared["data"], 1)
        limits = self.request("GET").json()["limits"]
        self.assertEqual(limits, {"per_member": 200, "per_team": 100, "teams_per_member": 10,
                                  "members_per_team": 20, "entry_bytes": 32768, "page_size": 50,
                                  "member_count": 2, "personal_count": 1, "remaining": 198,
                                  "has_more": {kind: False for kind in training.KINDS}})

    def test_revocation_and_rejoin_keep_http_quota_counts_and_enforcement_in_sync(self):
        team_id = training.create_team("alice", "Team")["id"]
        training.invite_member("alice", team_id, "bob")
        training.accept_invitation("bob", team_id)
        self.user("bob")
        with patch.object(training, "MAX_MEMBER_ENTRIES", 2):
            review = self.post_entry("reviews", team_id=team_id)
            self.post_entry("puzzles", data_for("puzzles", source_review_id=review["id"]), team_id)
            self.post_entry("sessions", expected=409)
            training.remove_member("alice", team_id, "bob")
            limits = self.request("GET").json()["limits"]
            self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (0, 0, 2))
            self.post_entry("plans")
            training.invite_member("alice", team_id, "bob")
            self.request("GET", f"/teams/{team_id}", 404)
            self.post_entry("sessions")
            self.assertEqual(self.request("GET").json()["limits"]["member_count"], 2)
            self.request("POST", f"/teams/{team_id}/accept", json={})
            limits = self.request("GET").json()["limits"]
            self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (4, 2, 0))
            self.post_entry("sessions", expected=409)
            self.post_entry("boards", team_id=team_id, expected=409)
            updated = self.request("PUT", f"/entries/reviews/{review['id']}",
                                   json={"revision": 1, "data": dict(review["data"], title="Edited over quota")}).json()["entry"]
            self.assertEqual((updated["owner"], updated["revision"]), ("bob", 2))
            self.request("DELETE", f"/entries/reviews/{review['id']}?revision=2")
            limits = self.request("GET").json()["limits"]
            self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (3, 2, 0))
            self.assertIsNone(self.request("GET", f"/entries/puzzles?team_id={team_id}").json()["entries"][0]["data"]["source_review_id"])

    def test_service_errors_keep_exact_status_detail_json_and_private_headers(self):
        for status, detail in ((401, "Membership is no longer available"), (404, "Training entry not found"),
                               (409, "This entry changed. Reload it before saving or deleting."),
                               (413, "Entry exceeds the 32 KiB storage limit"), (422, "Invalid training data")):
            with patch.object(training, "workspace", side_effect=training.Error(status, detail)):
                response = self.request("GET", expected=status)
            self.assertEqual(response.json(), {"detail": detail})
            self.assertEqual(response.headers["cache-control"], "no-store, private")
            self.assertEqual(response.headers["vary"], "Cookie")
        entry = self.post_entry("boards")
        response = self.request("PUT", f"/entries/boards/{entry['id']}", 409, json={"data": entry["data"], "revision": 2})
        self.assertEqual(response.json(), {"detail": "This entry changed. Reload it before saving or deleting."})
        with patch.object(training, "MAX_MEMBER_ENTRIES", 1):
            response = self.request("POST", "/entries/boards", 409, json={"data": data_for("boards")})
        self.assertEqual(response.json(), {"detail": "Member storage limit reached; delete or export older records"})

    def test_mutation_origin_checks_work_under_a_mount_prefix(self):
        nested = FastAPI()
        nested.include_router(training_api.router)
        app = FastAPI()

        @app.middleware("http")
        async def member_identity(request: Request, call_next):
            request.state.user = "alice"
            return await call_next(request)

        app.mount("/workspace", nested)
        with TestClient(app) as client:
            allowed = client.post("/workspace/api/training/teams", json={"name": "Mounted team"},
                                  headers={"Origin": "http://testserver"})
            self.assertEqual(allowed.status_code, 200, allowed.text)
            rejected = client.post("/workspace/api/training/teams", json={"name": "Rejected"},
                                   headers={"Origin": "https://evil.example"})
            self.assertEqual(rejected.status_code, 403)

    def test_unknown_outer_fields_and_ownership_injection_rejected(self):
        for extra in ({"owner": "bob"}, {"username": "bob"}, {"revision": 1}, {"id": "chosen"}, {"created": 0}):
            self.request("POST", "/entries/boards", 422, json={"data": data_for("boards"), **extra})
        entry = self.post_entry("boards")
        for extra in ({"owner": "bob"}, {"team_id": "chosen"}, {"kind": "reviews"}, {"updated": 0}):
            self.request("PUT", f"/entries/boards/{entry['id']}", 422, json={"data": entry["data"], "revision": 1, **extra})
        self.request("POST", "/teams", 422, json={"name": "Team", "owner": "bob"})
        self.request("POST", "/entries/boards", 422, json={"data": data_for("boards", unexpected=True)})
        self.request("POST", "/entries/boards", 422, json={"data": [], "team_id": None})
        self.assertEqual(training.list_entries("alice", "boards")["entries"], [entry])

    def test_full_replacement_missing_fields_and_strict_numbers(self):
        entry = self.post_entry("boards")
        self.request("PUT", f"/entries/boards/{entry['id']}", 422, json={"revision": 1, "data": {"title": "Only a title"}})
        for revision in (True, "1", 1.0, 0, -1):
            self.request("PUT", f"/entries/boards/{entry['id']}", 422, json={"revision": revision, "data": entry["data"]})
        for result in (True, "0", 1e20):
            self.post_entry("sessions", data_for("sessions", result=result), expected=422)
        board = data_for("boards")
        board["marks"][0]["x"] = True
        self.post_entry("boards", board, expected=422)
        self.request("DELETE", f"/entries/boards/{entry['id']}", 422)
        self.request("DELETE", f"/entries/boards/{entry['id']}?revision=true", 422)

    def test_explicit_cross_origin_mutations_rejected_without_opening_training_db(self):
        entry = self.post_entry("lessons")
        team_id = training.create_team("alice", "Team")["id"]
        mutations = [
            ("POST", "/entries/boards", {"data": data_for("boards")}),
            ("PUT", f"/entries/lessons/{entry['id']}", {"data": entry["data"], "revision": 1}),
            ("DELETE", f"/entries/lessons/{entry['id']}?revision=1", None),
            ("POST", f"/lessons/{entry['id']}/grade", {"revision": 1, "rating": "good"}),
            ("POST", "/teams", {"name": "Team"}),
            ("POST", f"/teams/{team_id}/invite", {"username": "bob"}),
            ("POST", f"/teams/{team_id}/accept", {}),
            ("DELETE", f"/teams/{team_id}/members/bob", None),
            ("DELETE", f"/teams/{team_id}", None),
        ]
        with patch.object(training, "connect", side_effect=AssertionError("Cross-origin request opened training DB")):
            for method, path, body in mutations:
                kwargs = {"json": body} if body is not None else {}
                self.request(method, path, 403, headers={"Origin": "https://evil.example"}, **kwargs)
        for origin in ("null", "http://testserver.evil", "https://testserver", "http://testserver:81",
                       "http://testserver@evil.example", "http://testserver/path", "http://testserver#frag", "http://testserver?x=1"):
            self.request("POST", "/teams", 403, headers={"Origin": origin}, json={"name": "Rejected"})
        self.request("POST", "/teams", 403, headers=[("Origin", "http://testserver"), ("Origin", "https://evil.example")], json={"name": "Rejected"})
        self.request("POST", "/teams", 403, headers={"Sec-Fetch-Site": "cross-site"}, json={"name": "Rejected"})
        self.request("POST", "/teams", 403, headers={"Sec-Fetch-Site": "same-site"}, json={"name": "Rejected"})
        self.request("POST", "/teams", 403, headers={"Referer": "https://evil.example/page"}, json={"name": "Rejected"})
        self.assertEqual(self.stored_count("training_teams"), 1)

    def test_same_origin_and_nonbrowser_json_mutations_work(self):
        for headers in ({}, {"Origin": "http://testserver"}, {"Origin": "http://testserver:80"},
                        {"Origin": "http://TESTSERVER", "Sec-Fetch-Site": "same-origin"},
                        {"Referer": "http://testserver/practice?section=team"}, {"Sec-Fetch-Site": "none"}):
            self.request("POST", "/teams", json={"name": "Allowed"}, headers=headers)
        # A cross-origin GET does not mutate; no CORS headers grant script access.
        response = self.request("GET", headers={"Origin": "https://evil.example"})
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_media_types_malformed_json_and_duplicate_keys(self):
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data"):
            self.request("POST", "/teams", 415, content='{"name":"Team"}', headers={"Content-Type": content_type})
        self.request("POST", "/teams", 415, content='{"name":"Team"}')
        for body in ("", "{", "[]", "null", "true", '"string"', '{"name":"A","name":"B"}',
                     '{"data":{"title":"A","title":"B"}}', '{"name":NaN}', '{"name":Infinity}',
                     '{"name":-Infinity}', "[" * 2000 + "]" * 2000):
            self.request("POST", "/teams", 422, content=body, headers={"Content-Type": "application/json"})
        self.request("POST", "/teams", 422, content=b'{"name":"\xff"}', headers={"Content-Type": "application/json"})
        self.request("POST", "/teams", json={"name": "Charset accepted"}, headers={"Content-Type": "application/json; charset=utf-8"})

    def test_nonfinite_and_surrogate_inputs_return_sanitized_json_errors(self):
        for number in ("NaN", "Infinity", "-Infinity", "1e400"):
            session = json.dumps({"data": data_for("sessions")}).replace('"result": 0', f'"result": {number}')
            response = self.request("POST", "/entries/sessions", 422, content=session, headers={"Content-Type": "application/json"})
            self.assertIsInstance(response.json()["detail"], str)
            self.assertNotIn(number, response.text)
        self.request("POST", "/teams", 422, content='{"name":"bad\\ud800"}', headers={"Content-Type": "application/json"})
        # A private input is not echoed by failed outer-model validation.
        response = self.request("POST", "/teams", 422, json={"name": "Team", "secret": "PRIVATE-INPUT"})
        self.assertNotIn("PRIVATE-INPUT", response.text)
        response = self.request("POST", "/entries/boards", 422,
                                json={"data": dict(data_for("boards"), **{"PRIVATE-UNKNOWN-KEY": "value"})})
        self.assertNotIn("PRIVATE-UNKNOWN-KEY", response.text)
        huge_number = json.dumps({"data": data_for("sessions")}).replace('"result": 0', '"result": ' + "9" * 1000)
        self.request("POST", "/entries/sessions", 422, content=huge_number, headers={"Content-Type": "application/json"})

    def test_body_and_encoded_entry_size_limits(self):
        oversized = '{"name":"' + "x" * training_api.MAX_REQUEST_BYTES + '"}'
        self.request("POST", "/teams", 413, content=oversized, headers={"Content-Type": "application/json"})
        self.request("POST", "/teams", 413, content="{}", headers={"Content-Type": "application/json", "Content-Length": "99999999999999999999"})
        self.request("POST", "/teams", 400, content="{}", headers={"Content-Type": "application/json", "Content-Length": "-1"})

        def chunks():
            yield b'{"name":"'
            yield b"x" * 21000
            yield b"x" * 21000
            yield b'"}'

        self.request("POST", "/teams", 413, content=chunks(), headers={"Content-Type": "application/json"})
        # Valid bounded fields can still exceed the aggregate per-document budget.
        review = data_for("reviews")
        review["moments"] = [dict(review["moments"][0], id=str(i), known="x" * 4000, options="x" * 4000) for i in range(4)]
        self.post_entry("reviews", review, expected=413)
        self.assertEqual(self.stored_count(), 0)

    def test_exact_request_and_normalized_storage_byte_boundaries(self):
        body = b'{"name":"Exact boundary"}'
        padded = body + b" " * (training_api.MAX_REQUEST_BYTES - len(body))
        self.request("POST", "/teams", content=padded, headers={"Content-Type": "application/json"})
        response = self.request("POST", "/teams", 413, content=padded + b" ", headers={"Content-Type": "application/json"})
        self.assertEqual(response.json(), {"detail": "Training request exceeds the 40 KiB limit"})
        review = training.validate_data("reviews", data_for("reviews"))
        review["moments"] = [dict(review["moments"][0], id=str(i), known="x" * 4000, options="x" * 4000) for i in range(4)]
        review["moments"][-1]["options"] = ""
        size = len(json.dumps(review, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        padding = training.MAX_ENTRY_BYTES - size
        self.assertTrue(0 <= padding < 4000)
        review["moments"][-1]["options"] = "x" * padding
        entry = self.post_entry("reviews", review)
        with closing(training.connect()) as db:
            self.assertEqual(db.execute("SELECT length(CAST(data AS BLOB)) FROM training_entries WHERE id=?", (entry["id"],)).fetchone()[0], 32768)
        review["moments"][-1]["options"] += "x"
        response = self.request("POST", "/entries/reviews", 413, json={"data": review})
        self.assertEqual(response.json(), {"detail": "Entry exceeds the 32 KiB storage limit"})
        self.assertEqual(self.stored_count(), 1)

    def test_chunked_parser_stops_at_bound_without_reading_remaining_body(self):
        consumed = []
        chunks = iter([b'{"name":"', b"x" * training_api.MAX_REQUEST_BYTES, b"NEVER-READ-PRIVATE-TAIL"])

        async def receive():
            chunk = next(chunks)
            consumed.append(len(chunk))
            return {"type": "http.request", "body": chunk, "more_body": True}

        request = Request({"type": "http", "headers": [(b"content-type", b"application/json")]}, receive)
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(training_api._body(request))
        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(raised.exception.detail, "Training request exceeds the 40 KiB limit")
        self.assertEqual(consumed, [len(b'{"name":"'), training_api.MAX_REQUEST_BYTES])
        self.assertEqual(raised.exception.headers, training_api.PRIVATE_HEADERS)

    def test_duplicate_content_headers_are_rejected_before_storage_access(self):
        headers = [("Content-Type", "application/json")]
        with patch.object(training, "connect", side_effect=AssertionError("Invalid framing opened training DB")):
            response = self.request("POST", "/teams", 415, content='{"name":"Rejected"}', headers=headers * 2)
            self.assertEqual(response.json(), {"detail": "Use application/json"})
            response = self.request("POST", "/teams", 400, content='{"name":"Rejected"}',
                                    headers=headers + [("Content-Length", "19"), ("Content-Length", "19")])
            self.assertEqual(response.json(), {"detail": "Invalid Content-Length"})

    def test_lesson_grade_is_server_scheduled_and_revision_checked(self):
        with patch.object(training.time, "time", return_value=12345):
            entry = self.post_entry("lessons", data_for("lessons", due=10, interval_days=365, repetitions=1000))
            self.assertEqual((entry["data"]["due"], entry["data"]["repetitions"]), (12345, 0))
            path = f"/lessons/{entry['id']}/grade"
            for body in ({"revision": True, "rating": "good"}, {"revision": 1, "rating": "wrong"},
                         {"revision": 1, "rating": "easy", "due": 0}):
                self.request("POST", path, 422, json=body)
            graded = self.request("POST", path, json={"revision": 1, "rating": "easy"}).json()["entry"]
            self.assertEqual((graded["revision"], graded["data"]["interval_days"], graded["data"]["due"]), (2, 4, 12345 + 4 * 86400))
            self.request("POST", path, 409, json={"revision": 1, "rating": "easy"})

    def test_reference_validation_is_enforced_at_api_boundary(self):
        plan = self.post_entry("plans")
        review = self.post_entry()
        puzzle = self.post_entry("puzzles")
        self.post_entry("sessions", data_for("sessions", plan_id=plan["id"]))
        self.post_entry("lessons", data_for("lessons", source_review_id=review["id"]))
        self.post_entry("attempts", data_for("attempts", puzzle_id=puzzle["id"], choice_index=2), expected=422)
        self.user("bob")
        self.post_entry("sessions", data_for("sessions", plan_id=plan["id"]), expected=404)
        self.post_entry("lessons", data_for("lessons", source_review_id=review["id"]), expected=404)
        self.post_entry("attempts", data_for("attempts", puzzle_id=puzzle["id"]), expected=404)

    def test_source_deletion_preserves_private_notes_and_returns_revision_conflict(self):
        review = self.post_entry()
        lesson = self.post_entry("lessons", data_for("lessons", source_review_id=review["id"]))
        self.request("DELETE", f"/entries/reviews/{review['id']}?revision=1")
        current = self.request("GET", "/entries/lessons").json()["entries"][0]
        self.assertEqual(current["data"], dict(lesson["data"], source_review_id=None))
        self.assertEqual(current["revision"], 2)
        response = self.request("PUT", f"/entries/lessons/{lesson['id']}", 409, json={"revision": 1, "data": lesson["data"]})
        self.assertEqual(response.json(), {"detail": "This entry changed. Reload it before saving or deleting."})
        self.request("PUT", f"/entries/lessons/{lesson['id']}", json={"revision": 2, "data": current["data"]})

    def test_team_end_to_end_invite_accept_edit_remove_and_delete(self):
        team = self.request("POST", "/teams", json={"name": "Practice team"}).json()["team"]
        team_id = team["id"]
        board = self.post_entry("boards", team_id=team_id)
        review = self.post_entry("reviews", team_id=team_id)
        self.request("POST", f"/teams/{team_id}/invite", json={"username": "bob"})
        self.user("bob")
        bootstrap = self.request("GET").json()
        self.assertEqual(bootstrap["teams"], [])
        self.assertEqual(bootstrap["invitations"][0]["owner"], "alice")
        self.assertNotIn("members", bootstrap["invitations"][0])
        self.request("GET", f"/teams/{team_id}", 404)
        self.request("GET", f"/entries/boards?team_id={team_id}", 404)
        self.request("POST", f"/teams/{team_id}/accept", 422, json={"status": "active"})
        self.request("POST", f"/teams/{team_id}/accept", json={})
        detail = self.request("GET", f"/teams/{team_id}").json()
        self.assertEqual(detail["entries"]["boards"], [board])
        self.assertEqual(detail["has_more"], {kind: False for kind in training.TEAM_KINDS})
        self.assertEqual(self.request("GET", f"/entries/reviews?team_id={team_id}").json()["entries"], [review])
        self.assertEqual(self.request("GET", "/entries/boards").json()["entries"], [])
        self.request("PUT", f"/entries/reviews/{review['id']}", 403, json={"revision": 1, "data": review["data"]})
        self.request("PUT", f"/entries/boards/{board['id']}", json={"revision": 1, "data": dict(board["data"], notes="Team edit")})
        own = self.post_entry("puzzles", team_id=team_id)
        self.request("POST", f"/teams/{team_id}/invite", 403, json={"username": "carol"})
        self.user("alice")
        self.request("PUT", f"/entries/boards/{board['id']}", 409, json={"revision": 1, "data": board["data"]})
        self.request("PUT", f"/entries/puzzles/{own['id']}", 403, json={"revision": 1, "data": own["data"]})
        self.request("DELETE", f"/entries/puzzles/{own['id']}?revision=1")
        self.request("DELETE", f"/teams/{team_id}/members/alice", 409)
        self.request("DELETE", f"/teams/{team_id}/members/bob")
        self.user("bob")
        self.request("GET", f"/teams/{team_id}", 404)
        self.request("PUT", f"/entries/boards/{board['id']}", 404, json={"revision": 2, "data": board["data"]})
        self.request("POST", f"/teams/{team_id}/accept", 404, json={})
        self.user("alice")
        self.request("DELETE", f"/teams/{team_id}")
        self.assertEqual(self.stored_count(), 0)

    def test_decline_cancel_and_uninvited_accept_http(self):
        team_id = self.request("POST", "/teams", json={"name": "Team"}).json()["team"]["id"]
        self.user("bob")
        self.request("POST", f"/teams/{team_id}/accept", 404, json={})
        self.user("alice")
        self.request("POST", f"/teams/{team_id}/invite", 404, json={"username": "missing"})
        self.request("POST", f"/teams/{team_id}/invite", 422, json={"username": "bob", "status": "active"})
        self.request("POST", f"/teams/{team_id}/invite", json={"username": "bob"})
        self.user("bob")
        self.request("DELETE", f"/teams/{team_id}/members/bob")
        self.request("POST", f"/teams/{team_id}/accept", 404, json={})
        self.user("alice")
        self.request("POST", f"/teams/{team_id}/invite", json={"username": "bob"})
        self.request("DELETE", f"/teams/{team_id}/members/bob")
        self.user("bob")
        self.assertEqual(self.request("GET").json()["invitations"], [])

    def test_team_reference_cannot_expose_private_review_id(self):
        review = self.post_entry()
        team_id = self.request("POST", "/teams", json={"name": "Team"}).json()["team"]["id"]
        self.post_entry("puzzles", data_for("puzzles", source_review_id=review["id"]), team_id, expected=404)
        self.assertEqual(self.stored_count(), 1)

    def test_export_is_complete_and_private_with_download_headers(self):
        entries = [self.post_entry("reviews", data_for("reviews", title=f"Private {i}")) for i in range(51)]
        team_id = training.create_team("alice", "Team")["id"]
        shared = self.post_entry("boards", team_id=team_id)
        other = self.create("reviews", "bob", title="Bob's thought")
        bootstrap = self.request("GET").json()
        self.assertTrue(bootstrap["limits"]["has_more"]["reviews"])
        response = self.request("GET", "/export")
        self.assertIn("attachment", response.headers["content-disposition"])
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertEqual({e["id"] for e in response.json()["entries"]["reviews"]}, {e["id"] for e in entries})
        for inaccessible in (other["id"], shared["id"], team_id):
            self.assertNotIn(inaccessible, response.text)
        second_page = self.request("GET", "/entries/reviews?offset=50&limit=1").json()
        self.assertEqual(second_page["entries"], [entries[0]])
        self.assertFalse(second_page["has_more"])
        for query in ("offset=-1", "offset=201", "limit=0", "limit=51", "offset=abc"):
            self.request("GET", "/entries/reviews?" + query, 422)

    def test_storage_errors_are_retryable_without_sqlite_details(self):
        with patch.object(training, "connect", side_effect=sqlite3.OperationalError("private database path")):
            response = self.request("GET", expected=503)
        self.assertNotIn("private database path", response.text)
        self.assertIn("no-store", response.headers["cache-control"])

    def test_stale_authenticated_identity_cannot_recreate_removed_member_data(self):
        # Mimics authentication finishing just before CLI removal commits.
        with closing(auth.connect()) as db:
            training.erase_member(db, "alice")
            db.execute("DELETE FROM users WHERE username='alice'")
            db.commit()
        with patch.object(auth, "user_for", return_value="alice"):
            self.request("GET", expected=401)
            self.request("POST", "/entries/boards", 401, json={"data": data_for("boards")})
        self.assertEqual(self.stored_count(), 0)
