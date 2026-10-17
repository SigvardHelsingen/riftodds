"""Fixture-only service, validation, transaction and privacy tests."""
import copy
import importlib
import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
from pathlib import Path
from unittest.mock import patch

import auth
import training


def data_for(kind, **overrides):
    values = {
        "plans": {"title": "A consistent setup", "focus": "Watch the wave", "role": "MIDDLE", "champion": "Ahri",
                  "workout_id": "last-hit", "minutes": 10, "games": 2, "status": "active"},
        "sessions": {"plan_id": None, "workout_id": "last-hit", "minutes": 0, "repetitions": 1, "result": 0,
                     "unit": "last hits", "focus": "Same setup", "reflection": "Not a causal claim\nTry again\tcarefully",
                     "adhered": False, "role": "", "champion": "", "patch": ""},
        "reviews": {"title": "A completed match", "match_id": "EUW1_123", "source_label": "Local replay",
                    "moments": [{"id": "moment-1", "seconds": 0, "title": "Before leaving lane", "known": "Enemy missing",
                                 "options": "Wait or move", "decision": "Wait", "outcome": "Lost a wave", "lesson": "Check cover",
                                 "annotations": [{"kind": "arrow", "x": 0, "y": 1, "x2": 0.5, "y2": 0.2, "text": "Route"}]}]},
        "lessons": {"question": "What was known?", "answer": "Only the visible information", "source_review_id": None,
                    "due": 0, "interval_days": 1, "repetitions": 0},
        "puzzles": {"title": "Wait or move?", "prompt": "What would change your choice?", "context": "Two opponents missing",
                    "choices": [{"label": "Wait", "tradeoff": "Lose tempo"}, {"label": "Move", "tradeoff": "Lose safety"}],
                    "discussion": "Both depend on context", "source_review_id": None, "seconds": None},
        "attempts": {"puzzle_id": "recall-window", "choice_index": 0, "reason": "Low resources", "reflection": "Need wave context"},
        "experiments": {"title": "One change", "hypothesis": "A repeatable setup may be easier to compare",
                        "change": "Keep the same items", "measure": "Time", "unit": "seconds", "better": "lower", "role": "JUNGLE",
                        "champion": "", "patch": "16.1", "phase": "baseline", "observations": []},
        "boards": {"title": "Objective setup", "notes": "Original strategy diagram",
                   "marks": [{"id": "mark-1", "kind": "ward", "x": 0, "y": 1, "x2": 0.5, "y2": 0.5,
                              "label": "Check entrance", "team": "neutral"}]},
    }
    result = copy.deepcopy(values[kind])
    result.update(overrides)
    return result


class TrainingFixture(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.db_path = Path(directory) / "fixture-members.sqlite"
        self.stack.enter_context(patch.object(auth, "DB_PATH", self.db_path))
        original_connect = sqlite3.connect

        def fixture_only(database, *args, **kwargs):
            self.assertEqual(Path(database), self.db_path, "Test tried to access a non-fixture database")
            return original_connect(database, *args, **kwargs)

        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=fixture_only))
        with closing(auth.connect()) as db:
            db.executemany("INSERT INTO users (username,password_hash,created) VALUES (?,'unused-fixture',0)",
                           [(name,) for name in ("alice", "bob", "carol", "dave")])
            db.commit()

    def create(self, kind="reviews", username="alice", team_id=None, **overrides):
        return training.create_entry(username, kind, data_for(kind, **overrides), team_id)

    def assert_error(self, status, function, *args, **kwargs):
        with self.assertRaises(training.Error) as raised:
            function(*args, **kwargs)
        self.assertEqual(raised.exception.status, status, str(raised.exception))
        return raised.exception

    def team_with_bob(self):
        team = training.create_team("alice", "Practice together")
        training.invite_member("alice", team["id"], "bob")
        training.accept_invitation("bob", team["id"])
        return team["id"]

    def stored_count(self, table="training_entries"):
        with closing(training.connect()) as db:
            return db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


class PersistenceTests(TrainingFixture):
    def test_import_is_database_free_and_schema_is_lazy_additive(self):
        with patch.object(auth, "connect", side_effect=AssertionError("Import opened a database")):
            importlib.reload(training)
        with closing(auth.connect()) as db:
            self.assertFalse(db.execute("SELECT 1 FROM sqlite_master WHERE name='training_entries'").fetchone())
            db.execute("INSERT INTO goals VALUES ('alice','fixture-player','MIDDLE','cs',1,0)")
            db.commit()
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 0)
        self.assertEqual(training.workspace("alice")["entries"], {kind: [] for kind in training.KINDS})
        with closing(training.connect()) as db:
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM goals").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        with closing(auth.connect()) as db:
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 0)

    def test_all_kinds_full_crud_and_member_isolation(self):
        for kind in training.KINDS:
            with self.subTest(kind=kind):
                entry = self.create(kind)
                self.assertEqual(set(entry), {"id", "kind", "owner", "team_id", "revision", "created", "updated", "data"})
                self.assertEqual((entry["owner"], entry["team_id"], entry["revision"]), ("alice", None, 1))
                self.assertIsInstance(entry["created"], int)
                self.assertEqual(training.list_entries("alice", kind)["entries"], [entry])
                self.assertEqual(training.list_entries("bob", kind)["entries"], [])
                self.assert_error(404, training.update_entry, "bob", kind, entry["id"], entry["data"], 1)
                self.assert_error(404, training.delete_entry, "bob", kind, entry["id"], 1)
                self.assert_error(404, training.delete_entry, "alice", kind, "unknown", 1)
                updated = training.update_entry("alice", kind, entry["id"], entry["data"], 1)
                self.assertEqual(updated["revision"], 2)
                self.assertEqual(updated["created"], entry["created"])
                self.assert_error(409, training.update_entry, "alice", kind, entry["id"], entry["data"], 1)
                self.assert_error(409, training.delete_entry, "alice", kind, entry["id"], 1)
                self.assertEqual(training.delete_entry("alice", kind, entry["id"], 2), {"ok": True})
                self.assertEqual(training.list_entries("alice", kind)["entries"], [])

    def test_zero_and_null_results_remain_distinct(self):
        self.assertEqual(self.create("sessions", result=0)["data"]["result"], 0)
        self.assertIsNone(self.create("sessions", result=None)["data"]["result"])
        experiment = self.create("experiments")
        self.assertEqual(experiment["data"]["observations"], [])
        self.assertNotIn("summary", experiment["data"])

    def test_activation_archives_old_plan_and_invalidates_old_revision(self):
        first = self.create("plans")
        second = self.create("plans", title="A different plan")
        entries = training.list_entries("alice", "plans")["entries"]
        self.assertEqual(sum(e["data"]["status"] == "active" for e in entries), 1)
        archived = next(e for e in entries if e["id"] == first["id"])
        self.assertEqual((archived["data"]["status"], archived["revision"]), ("archived", 2))
        self.assert_error(409, training.update_entry, "alice", "plans", first["id"], first["data"], 1)
        training.update_entry("alice", "plans", first["id"], first["data"], 2)
        second_now = next(e for e in training.list_entries("alice", "plans")["entries"] if e["id"] == second["id"])
        self.assertEqual(second_now["data"]["status"], "archived")

    def test_newest_first_pagination_and_bootstrap_truncation(self):
        with patch.object(training.time, "time", return_value=1000):
            entries = [self.create(title=f"Review {i}") for i in range(52)]
        workspace = training.workspace("alice")
        self.assertEqual([e["id"] for e in workspace["entries"]["reviews"]], [e["id"] for e in reversed(entries[2:])])
        self.assertTrue(workspace["limits"]["has_more"]["reviews"])
        self.assertEqual(workspace["limits"]["personal_count"], 52)
        self.assertEqual(workspace["limits"]["remaining"], 148)
        last = training.list_entries("alice", "reviews", offset=50)
        self.assertEqual([e["id"] for e in last["entries"]], [entries[1]["id"], entries[0]["id"]])
        self.assertFalse(last["has_more"])
        self.assertFalse(training.list_entries("alice", "reviews", offset=200)["has_more"])
        for args in ({"offset": -1}, {"offset": 201}, {"limit": 0}, {"limit": 51}, {"offset": True}, {"limit": "2"}):
            self.assert_error(422, training.list_entries, "alice", "reviews", **args)

    def test_member_quota_is_total_across_kinds_and_team_docs(self):
        team_id = self.team_with_bob()
        with patch.object(training, "MAX_MEMBER_ENTRIES", 2):
            first = self.create("plans")
            self.create("boards", team_id=team_id)
            self.assert_error(409, self.create, "sessions")
            self.assert_error(409, self.create, "plans")
            self.assertEqual(training.list_entries("alice", "plans")["entries"][0], first)
            training.delete_entry("alice", "plans", first["id"], 1)
            self.create("sessions")
        self.assertEqual(self.stored_count(), 2)

    def test_revocation_releases_member_quota_without_freeing_team_storage(self):
        teams = []
        for index in range(2):
            team_id = training.create_team("alice", f"Team {index}")["id"]
            training.invite_member("alice", team_id, "bob")
            training.accept_invitation("bob", team_id)
            review = self.create("reviews", "bob", team_id)
            puzzle = self.create("puzzles", "bob", team_id, source_review_id=review["id"])
            for _ in range(training.MAX_TEAM_ENTRIES - 2):
                self.create("boards", "bob", team_id)
            teams.append((team_id, review, puzzle))

        limits = training.workspace("bob")["limits"]
        self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (200, 0, 0))
        self.assertEqual(training.workspace("alice")["limits"]["member_count"], 0)
        self.assert_error(409, self.create, "plans", "bob")
        for team_id, _, _ in teams:
            training.remove_member("alice", team_id, "bob")

        workspace = training.workspace("bob")
        self.assertEqual(workspace["teams"], [])
        limits = workspace["limits"]
        self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (0, 0, 200))
        self.assertTrue(all(not rows for rows in training.export_member("bob")["entries"].values()))
        for team_id, review, puzzle in teams:
            self.assert_error(404, training.get_team, "bob", team_id)
            self.assert_error(404, training.update_entry, "bob", "reviews", review["id"], review["data"], 1)
            self.assert_error(404, training.delete_entry, "bob", "reviews", review["id"], 1)
            shared = training.get_team("alice", team_id)["entries"]
            self.assertEqual(shared["reviews"], [review])
            self.assertEqual(shared["puzzles"], [puzzle])
            with closing(training.connect()) as db:
                count = db.execute("SELECT COUNT(*) FROM training_entries WHERE team_id=?", (team_id,)).fetchone()[0]
            self.assertEqual(count, 100)
            error = self.assert_error(409, self.create, "boards", "alice", team_id)
            self.assertIn("Team storage limit", error.detail)

        self.create("plans", "bob")
        for team_id, _, _ in teams:
            training.invite_member("alice", team_id, "bob")
            self.assert_error(404, training.get_team, "bob", team_id)
        workspace = training.workspace("bob")
        self.assertEqual(workspace["teams"], [])
        self.assertEqual(len(workspace["invitations"]), 2)
        limits = workspace["limits"]
        self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (1, 1, 199))
        self.create("sessions", "bob")
        self.assertEqual(training.workspace("bob")["limits"]["member_count"], 2)
        self.assertEqual(self.stored_count(), 202)

    def test_voluntary_leave_releases_only_authored_team_quota(self):
        team_id = self.team_with_bob()
        with patch.object(training, "MAX_MEMBER_ENTRIES", 2):
            shared = self.create("boards", "bob", team_id)
            personal = self.create("sessions", "bob")
            self.assert_error(409, self.create, "plans", "bob")
            training.remove_member("bob", team_id, "bob")
            limits = training.workspace("bob")["limits"]
            self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (1, 1, 1))
            self.assertEqual(training.list_entries("bob", "sessions")["entries"], [personal])
            self.assertEqual(training.get_team("alice", team_id)["entries"]["boards"], [shared])
            self.create("plans", "bob")
            self.assertEqual(training.workspace("bob")["limits"]["member_count"], 2)
            self.assert_error(409, self.create, "sessions", "bob")

    def test_accepted_rejoin_recaptures_quota_but_allows_editing_and_deletion(self):
        team_id = self.team_with_bob()
        with patch.object(training, "MAX_MEMBER_ENTRIES", 2):
            review = self.create("reviews", "bob", team_id)
            puzzle = self.create("puzzles", "bob", team_id, source_review_id=review["id"])
            training.remove_member("alice", team_id, "bob")
            plan = self.create("plans", "bob")
            training.invite_member("alice", team_id, "bob")
            session = self.create("sessions", "bob")
            self.assertEqual(training.workspace("bob")["limits"]["member_count"], 2)
            training.accept_invitation("bob", team_id)
            limits = training.workspace("bob")["limits"]
            self.assertEqual((limits["member_count"], limits["personal_count"], limits["remaining"]), (4, 2, 0))
            self.assert_error(409, self.create, "sessions", "bob")
            error = self.assert_error(409, self.create, "boards", "bob", team_id)
            self.assertIn("Member storage limit", error.detail)

            for entry in (review, plan):
                updated = training.update_entry("bob", entry["kind"], entry["id"], dict(entry["data"], title="Edited over quota"), 1)
                self.assertEqual((updated["owner"], updated["revision"]), ("bob", 2))
            self.assertEqual(training.list_entries("bob", "puzzles", team_id)["entries"], [puzzle])
            for entry, revision, expected in ((puzzle, 1, 3), (session, 1, 2), (plan, 2, 1)):
                training.delete_entry("bob", entry["kind"], entry["id"], revision)
                limits = training.workspace("bob")["limits"]
                self.assertEqual(limits["member_count"], expected)
                self.assertEqual(limits["remaining"], max(0, 2 - expected))
                if expected >= 2:
                    self.assert_error(409, self.create, "sessions", "bob")
            self.create("sessions", "bob")
            self.assertEqual(training.workspace("bob")["limits"]["member_count"], 2)

    def test_team_quota_does_not_block_personal_documents(self):
        team_id = self.team_with_bob()
        with patch.object(training, "MAX_TEAM_ENTRIES", 1):
            self.create(team_id=team_id)
            self.assert_error(409, self.create, "boards", "bob", team_id)
            self.create("boards", username="bob")
        self.assertEqual(self.stored_count(), 2)

    def test_concurrent_revision_race_has_exactly_one_winner(self):
        entry = self.create("boards")
        barrier = threading.Barrier(2)

        def save(title):
            barrier.wait(timeout=5)
            try:
                return training.update_entry("alice", "boards", entry["id"], data_for("boards", title=title), 1)["revision"]
            except training.Error as error:
                return error.status

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, ["First writer", "Second writer"]))
        self.assertEqual(sorted(results), [2, 409])

    def test_concurrent_plan_activations_leave_one_active(self):
        barrier = threading.Barrier(2)

        def activate(title):
            barrier.wait(timeout=5)
            return self.create("plans", title=title)

        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(activate, ["First plan", "Second plan"]))
        entries = training.list_entries("alice", "plans")["entries"]
        self.assertEqual(sorted(e["data"]["status"] for e in entries), ["active", "archived"])

    def test_concurrent_creates_cannot_exceed_member_quota(self):
        barrier = threading.Barrier(2)

        def create(title):
            barrier.wait(timeout=5)
            try:
                self.create("boards", title=title)
                return 200
            except training.Error as error:
                return error.status

        with patch.object(training, "MAX_MEMBER_ENTRIES", 1), ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(create, ["First", "Second"]))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(self.stored_count(), 1)

    def test_member_revoked_between_connection_open_and_transaction_cannot_write(self):
        original = training.connect

        def revoke_before_transaction():
            db = original()
            with closing(auth.connect()) as revocation:
                training.erase_member(revocation, "alice")
                revocation.execute("DELETE FROM users WHERE username='alice'")
                revocation.commit()
            return db

        with patch.object(training, "connect", side_effect=revoke_before_transaction):
            self.assert_error(401, self.create, "boards")
        self.assertEqual(self.stored_count(), 0)

    def test_team_revocation_is_rechecked_inside_each_transaction(self):
        team_id = self.team_with_bob()
        board = self.create("boards", "bob", team_id)
        original = training.connect

        def revoke_before_transaction():
            db = original()
            with closing(auth.connect()) as revocation:
                revocation.execute("DELETE FROM training_memberships WHERE team_id=? AND username='bob'", (team_id,))
                revocation.commit()
            return db

        operations = ((training.get_team, (team_id,)), (training.list_entries, ("boards", team_id)),
                      (training.create_entry, ("boards", data_for("boards"), team_id)),
                      (training.update_entry, ("boards", board["id"], board["data"], 1)),
                      (training.delete_entry, ("boards", board["id"], 1)),
                      (training.accept_invitation, (team_id,)))
        for function, args in operations:
            with self.subTest(operation=function.__name__):
                training.invite_member("alice", team_id, "bob")
                training.accept_invitation("bob", team_id)
                with patch.object(training, "connect", side_effect=revoke_before_transaction):
                    self.assert_error(404, function, "bob", *args)
        self.assertEqual(training.get_team("alice", team_id)["entries"]["boards"], [board])

    def test_revision_limit_blocks_increment_but_not_deletion(self):
        entry = self.create("boards")
        with closing(training.connect()) as db:
            db.execute("UPDATE training_entries SET revision=? WHERE id=?", (training.MAX_REVISION, entry["id"]))
            db.commit()
        self.assert_error(409, training.update_entry, "alice", "boards", entry["id"], entry["data"], training.MAX_REVISION)
        self.assertEqual(training.delete_entry("alice", "boards", entry["id"], training.MAX_REVISION), {"ok": True})

    def test_removed_member_is_rechecked_even_with_old_session_identity(self):
        self.create()
        with closing(auth.connect()) as db:
            training.erase_member(db, "alice")
            db.execute("DELETE FROM users WHERE username='alice'")
            db.commit()
        for function, args in ((training.workspace, ()), (training.create_entry, ("boards", data_for("boards"))),
                               (training.create_team, ("A team",)), (training.export_member, ())):
            self.assert_error(401, function, "alice", *args)

    def test_unlink_does_not_erase_authored_training(self):
        team_id = self.team_with_bob()
        for kind in training.KINDS:
            self.create(kind)
        self.create("boards", team_id=team_id)
        before = training.workspace("alice")
        team_before = training.get_team("alice", team_id)
        auth.set_account("alice", "euw1", "Fixture", "ONE", "fixture-player")
        auth.clear_account("alice")
        self.assertIsNone(auth.get_account("alice"))
        self.assertEqual(training.workspace("alice"), before)
        self.assertEqual(training.get_team("alice", team_id), team_before)

    def test_connections_close_on_success_and_failure(self):
        opened = []
        original = training.connect

        def track():
            db = original()
            opened.append(db)
            return db

        with patch.object(training, "connect", side_effect=track):
            self.create()
            self.assert_error(404, training.delete_entry, "alice", "reviews", "missing", 1)
            training.workspace("bob")
        for db in opened:
            with self.assertRaises(sqlite3.ProgrammingError):
                db.execute("SELECT 1")

    def test_initialization_failure_closes_connection(self):
        with closing(auth.connect()) as db:
            db.execute("CREATE TABLE training_teams (incompatible TEXT)")
            db.commit()
        opened = []
        original = auth.connect

        def track():
            db = original()
            opened.append(db)
            return db

        with patch.object(auth, "connect", side_effect=track), self.assertRaises(sqlite3.OperationalError):
            training.workspace("alice")
        self.assertEqual(len(opened), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].execute("SELECT 1")


class SchemaTests(TrainingFixture):
    def test_every_kind_rejects_unknown_and_missing_fields(self):
        for kind in training.KINDS:
            invalid = data_for(kind, owner="bob")
            self.assert_error(422, training.validate_data, kind, invalid)
            invalid = data_for(kind)
            invalid.pop(next(iter(invalid)))
            self.assert_error(422, training.validate_data, kind, invalid)
        for kind in ("extra", "plans; DROP TABLE users", "review"):
            self.assert_error(404, training.validate_data, kind, {})

    def test_nested_unknown_keys_rejected(self):
        cases = []
        review = data_for("reviews")
        review["moments"][0]["video_url"] = "https://example.invalid"
        cases.append(("reviews", review))
        review = data_for("reviews")
        review["moments"][0]["annotations"][0]["color"] = "red"
        cases.append(("reviews", review))
        puzzle = data_for("puzzles")
        puzzle["choices"][0]["correct"] = True
        cases.append(("puzzles", puzzle))
        board = data_for("boards")
        board["marks"][0]["live_player"] = "enemy"
        cases.append(("boards", board))
        for kind, value in cases:
            self.assert_error(422, training.validate_data, kind, value)

    def test_numeric_and_boolean_types_are_strict_finite_and_bounded(self):
        cases = [
            ("plans", "minutes", [True, "10", 1.0, 0, 121]),
            ("plans", "games", [False, 0, 21]),
            ("sessions", "minutes", [-1, 241, True]),
            ("sessions", "repetitions", [0, 101, True]),
            ("sessions", "result", [True, "0", float("nan"), float("inf"), float("-inf"), 1e10]),
            ("sessions", "adhered", [0, 1, "true", None]),
            ("lessons", "due", [True, -1, 1.5, training.MAX_TIMESTAMP + 1]),
            ("lessons", "interval_days", [0, 366, True]),
            ("lessons", "repetitions", [-1, 1001, True]),
            ("puzzles", "seconds", [True, -1, 28801, float("nan"), float("inf")]),
            ("attempts", "choice_index", [True, -1, 5, 0.0]),
        ]
        for kind, field, values in cases:
            for value in values:
                with self.subTest(kind=kind, field=field, value=value):
                    self.assert_error(422, training.validate_data, kind, data_for(kind, **{field: value}))
        for value in (True, "0", -0.1, 1.1, float("nan"), float("inf")):
            board = data_for("boards")
            board["marks"][0]["x"] = value
            self.assert_error(422, training.validate_data, "boards", board)
        for kind, field in (("plans", "minutes"), ("sessions", "result"), ("puzzles", "seconds")):
            value = {"plans": 120, "sessions": -100, "puzzles": 28800}[kind]
            training.validate_data(kind, data_for(kind, **{field: value}))

    def test_string_limits_controls_and_source_paths(self):
        for title in ("", "   ", "x" * 121, "title\nnewline", "nul\x00", "bidi\u202e", "bad\ud800"):
            self.assert_error(422, training.validate_data, "boards", data_for("boards", title=title))
        for notes in ("x" * 4001, "bad\x01", "bad\x7f"):
            self.assert_error(422, training.validate_data, "boards", data_for("boards", notes=notes))
        training.validate_data("boards", data_for("boards", title="Å practice", notes="Line one\nLine two\t\r"))
        for label in ("/Users/alice/private.mp4", "C:\\private.mp4", "https://site/video", "file:private", "data:video/mp4", "blob:123", "~/clip"):
            self.assert_error(422, training.validate_data, "reviews", data_for("reviews", source_label=label))
        self.assert_error(422, training.validate_data, "plans", data_for("plans", workout_id="unknown"))
        self.assert_error(422, training.validate_data, "plans", data_for("plans", role="SUPPORT"))
        self.assert_error(422, training.validate_data, "sessions", data_for("sessions", unit="x" * 161))

    def test_collection_limits_unique_ids_and_calendar_dates(self):
        review = data_for("reviews")
        review["moments"] *= 51
        self.assert_error(422, training.validate_data, "reviews", review)
        review = data_for("reviews")
        review["moments"][0]["annotations"] *= 31
        self.assert_error(422, training.validate_data, "reviews", review)
        review = data_for("reviews")
        review["moments"] *= 2
        self.assert_error(422, training.validate_data, "reviews", review)
        board = data_for("boards")
        board["marks"] *= 2
        self.assert_error(422, training.validate_data, "boards", board)
        for count in (1, 6):
            self.assert_error(422, training.validate_data, "puzzles", data_for("puzzles", choices=[{"label": "Option", "tradeoff": ""}] * count))
        observation = {"id": "obs-1", "date": "2024-02-29", "phase": "baseline", "value": 0, "adhered": False, "context": ""}
        training.validate_data("experiments", data_for("experiments", observations=[observation]))
        for field, value in (("date", "2025-02-29"), ("date", "2026-2-03"), ("date", "20260203xx"),
                             ("value", True), ("value", -1), ("value", 100001), ("value", float("nan")),
                             ("adhered", 1), ("phase", "complete")):
            bad = dict(observation, **{field: value})
            self.assert_error(422, training.validate_data, "experiments", data_for("experiments", observations=[bad]))
        self.assert_error(422, training.validate_data, "experiments", data_for("experiments", observations=[observation] * 2))
        self.assert_error(422, training.validate_data, "experiments", data_for("experiments", observations=[observation] * 101))

    def test_encoded_payload_limit_counts_utf8_bytes(self):
        observation = {"id": "0", "date": "2026-10-15", "phase": "practice", "value": 1, "adhered": True, "context": "界" * 3000}
        observations = [dict(observation, id=str(i)) for i in range(4)]
        invalid = data_for("experiments", observations=observations)
        self.assertLess(len(json.dumps(invalid, ensure_ascii=False)), training.MAX_ENTRY_BYTES)
        self.assert_error(413, training.create_entry, "alice", "experiments", invalid)
        self.assertEqual(self.stored_count(), 0)

    def test_private_kinds_cannot_be_shared(self):
        team_id = self.team_with_bob()
        for kind in set(training.KINDS) - set(training.TEAM_KINDS):
            self.assert_error(422, training.create_entry, "alice", kind, data_for(kind), team_id)
        self.assert_error(422, training.create_entry, "alice", "boards", data_for("boards"), True)

    def test_error_status_detail_and_sanitization_are_stable(self):
        error = training.Error(409, "Reload first")
        self.assertEqual((error.status, error.detail, str(error)), (409, "Reload first", "Reload first"))
        error = self.assert_error(422, training.validate_data, "boards", data_for("boards", **{"PRIVATE-KEY": "PRIVATE-VALUE"}))
        self.assertEqual(error.detail, "Invalid training data: Unknown fields are not allowed")
        error = self.assert_error(422, training.validate_data, "boards", data_for("boards", title="PRIVATE\x00VALUE"))
        self.assertEqual(error.detail, "Invalid training data: title: Value error, Control characters are not allowed")
        self.assertNotIn("PRIVATE", error.detail)

    def test_revision_and_grade_are_strict(self):
        entry = self.create("lessons")
        for revision in (True, 0, -1, "1", 1.0, training.MAX_REVISION + 1):
            self.assert_error(422, training.update_entry, "alice", "lessons", entry["id"], entry["data"], revision)
            self.assert_error(422, training.delete_entry, "alice", "lessons", entry["id"], revision)
        for rating in ("perfect", True, None):
            self.assert_error(422, training.grade_lesson, "alice", entry["id"], 1, rating)


class ReferenceAndLessonTests(TrainingFixture):
    def test_plan_references_must_be_owned_and_correct_kind(self):
        plan = self.create("plans")
        self.create("sessions", plan_id=plan["id"])
        self.assert_error(404, self.create, "sessions", "bob", plan_id=plan["id"])
        wrong = self.create("boards")
        self.assert_error(404, self.create, "sessions", plan_id=wrong["id"])
        self.assert_error(404, self.create, "sessions", plan_id="unknown")
        session = self.create("sessions")
        bob_plan = self.create("plans", username="bob")
        self.assert_error(404, training.update_entry, "alice", "sessions", session["id"], data_for("sessions", plan_id=bob_plan["id"]), 1)
        self.assertEqual(training.list_entries("alice", "sessions")["entries"][0]["revision"], 1)

    def test_review_references_must_match_scope(self):
        team_id = self.team_with_bob()
        other_team = training.create_team("alice", "Other team")["id"]
        personal = self.create()
        shared = self.create(team_id=team_id)
        for kind in ("lessons", "puzzles"):
            self.create(kind, source_review_id=personal["id"])
            self.assert_error(404, self.create, kind, "bob", source_review_id=personal["id"])
            self.assert_error(404, self.create, kind, source_review_id=shared["id"])
        self.create("puzzles", "bob", team_id, source_review_id=shared["id"])
        self.assert_error(404, self.create, "puzzles", "alice", team_id, source_review_id=personal["id"])
        self.assert_error(404, self.create, "puzzles", "alice", other_team, source_review_id=shared["id"])

    def test_attempt_choice_bounds_and_accepted_shared_access(self):
        own = self.create("puzzles")
        self.create("attempts", puzzle_id=own["id"], choice_index=1)
        self.assert_error(422, self.create, "attempts", puzzle_id=own["id"], choice_index=2)
        self.assert_error(404, self.create, "attempts", "bob", puzzle_id=own["id"])
        self.assert_error(422, self.create, "attempts", puzzle_id="recall-window", choice_index=2)
        self.assert_error(404, self.create, "attempts", puzzle_id="nonexistent")
        self.assert_error(404, self.create, "attempts", puzzle_id=self.create("boards")["id"])
        team_id = self.team_with_bob()
        shared = self.create("puzzles", team_id=team_id)
        attempt = self.create("attempts", "bob", puzzle_id=shared["id"])
        training.remove_member("alice", team_id, "bob")
        self.assert_error(404, training.update_entry, "bob", "attempts", attempt["id"], attempt["data"], 1)
        # The member's own reasoning remains available after losing team access.
        self.assertEqual(training.list_entries("bob", "attempts")["entries"], [attempt])

    def test_deleting_nullable_sources_preserves_notes_and_invalidates_revisions(self):
        plan = self.create("plans")
        session = self.create("sessions", plan_id=plan["id"])
        review = self.create()
        lesson = self.create("lessons", source_review_id=review["id"])
        puzzle = self.create("puzzles", source_review_id=review["id"])
        other = self.create("puzzles")
        with patch.object(training.time, "time", return_value=2000000000):
            training.delete_entry("alice", "plans", plan["id"], 1)
            training.delete_entry("alice", "reviews", review["id"], 1)
        for original, field in ((session, "plan_id"), (lesson, "source_review_id"), (puzzle, "source_review_id")):
            current = next(e for e in training.list_entries("alice", original["kind"])["entries"] if e["id"] == original["id"])
            expected = dict(original, revision=2, updated=2000000000, data=dict(original["data"], **{field: None}))
            self.assertEqual(current, expected)
            self.assert_error(409, training.update_entry, "alice", current["kind"], current["id"], original["data"], 1)
            training.update_entry("alice", current["kind"], current["id"], current["data"], 2)
        self.assertIn(other, training.list_entries("alice", "puzzles")["entries"])

    def test_shared_source_cleanup_is_scope_limited_and_rolls_back_with_delete(self):
        team_id = self.team_with_bob()
        review = self.create(team_id=team_id)
        puzzle = self.create("puzzles", "bob", team_id, source_review_id=review["id"])
        private = self.create("puzzles", "bob")
        with closing(training.connect()) as db:
            db.execute("""CREATE TRIGGER fixture_fail_delete BEFORE DELETE ON training_entries
                          BEGIN SELECT RAISE(ABORT, 'fixture failure'); END""")
            db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            training.delete_entry("alice", "reviews", review["id"], 1)
        self.assertEqual(training.list_entries("bob", "puzzles", team_id)["entries"], [puzzle])
        self.assertEqual(training.list_entries("alice", "reviews", team_id)["entries"], [review])
        with closing(training.connect()) as db:
            db.execute("DROP TRIGGER fixture_fail_delete")
            db.commit()
        training.delete_entry("alice", "reviews", review["id"], 1)
        current = training.list_entries("bob", "puzzles", team_id)["entries"][0]
        self.assertIsNone(current["data"]["source_review_id"])
        self.assertEqual(current["revision"], 2)
        self.assertEqual(training.list_entries("bob", "puzzles")["entries"], [private])

    def test_cleanup_at_revision_limit_keeps_dependent_document_deletable(self):
        review = self.create()
        lesson = self.create("lessons", source_review_id=review["id"])
        with closing(training.connect()) as db:
            db.execute("UPDATE training_entries SET revision=? WHERE id=?", (training.MAX_REVISION, lesson["id"]))
            db.commit()
        training.delete_entry("alice", "reviews", review["id"], 1)
        current = training.list_entries("alice", "lessons")["entries"][0]
        self.assertEqual(current["revision"], training.MAX_REVISION)
        self.assertIsNone(current["data"]["source_review_id"])
        training.delete_entry("alice", "lessons", lesson["id"], training.MAX_REVISION)

    def test_deleted_puzzle_keeps_personal_attempt_history_without_source_access(self):
        team_id = self.team_with_bob()
        puzzle = self.create("puzzles", team_id=team_id)
        attempt = self.create("attempts", "bob", puzzle_id=puzzle["id"])
        training.delete_team("alice", team_id)
        self.assertEqual(training.export_member("bob")["entries"]["attempts"], [attempt])
        self.assert_error(404, training.update_entry, "bob", "attempts", attempt["id"], attempt["data"], 1)
        training.delete_entry("bob", "attempts", attempt["id"], 1)

    def test_server_scheduling_initialization_edit_and_rating_progression(self):
        with patch.object(training.time, "time", return_value=10000):
            entry = self.create("lessons", due=200000, interval_days=300, repetitions=999)
            self.assertEqual({k: entry["data"][k] for k in ("due", "interval_days", "repetitions")},
                             {"due": 10000, "interval_days": 1, "repetitions": 0})
            changed = dict(entry["data"], question="Updated question", due=1, interval_days=365, repetitions=1000)
            entry = training.update_entry("alice", "lessons", entry["id"], changed, 1)
            self.assertEqual((entry["data"]["due"], entry["data"]["interval_days"], entry["data"]["repetitions"]), (10000, 1, 0))
            for rating, interval, reps in (("good", 1, 1), ("good", 2, 2), ("easy", 6, 3), ("again", 1, 4)):
                entry = training.grade_lesson("alice", entry["id"], entry["revision"], rating)
                self.assertEqual((entry["data"]["due"], entry["data"]["interval_days"], entry["data"]["repetitions"]),
                                 (10000 + interval * 86400, interval, reps))
                self.assertEqual(entry["data"]["question"], "Updated question")
                self.assertEqual(entry["data"]["answer"], changed["answer"])
        self.assert_error(409, training.grade_lesson, "alice", entry["id"], 1, "easy")
        self.assert_error(404, training.grade_lesson, "bob", entry["id"], entry["revision"], "easy")

    def test_scheduling_caps_and_first_easy(self):
        entry = self.create("lessons")
        entry = training.grade_lesson("alice", entry["id"], 1, "easy")
        self.assertEqual(entry["data"]["interval_days"], 4)
        for _ in range(10):
            entry = training.grade_lesson("alice", entry["id"], entry["revision"], "easy")
        self.assertEqual(entry["data"]["interval_days"], 365)
        with closing(training.connect()) as db:
            data = dict(entry["data"], repetitions=1000)
            db.execute("UPDATE training_entries SET data=? WHERE id=?", (json.dumps(data), entry["id"]))
            db.commit()
        entry = training.grade_lesson("alice", entry["id"], entry["revision"], "good")
        self.assertEqual(entry["data"]["repetitions"], 1000)


class TeamAndDeletionTests(TrainingFixture):
    def test_invitation_is_explicit_and_hides_documents_and_roster(self):
        team = training.create_team("alice", "Private practice")
        team_id = team["id"]
        entry = self.create(team_id=team_id)
        training.invite_member("alice", team_id, "bob")
        training.invite_member("alice", team_id, "bob")
        bootstrap = training.workspace("bob")
        self.assertEqual(bootstrap["teams"], [])
        self.assertEqual(len(bootstrap["invitations"]), 1)
        invitation = bootstrap["invitations"][0]
        self.assertEqual(set(invitation), {"team_id", "team_name", "owner", "created"})
        self.assertEqual((invitation["owner"], invitation["team_name"]), ("alice", team["name"]))
        for function, args in ((training.get_team, (team_id,)), (training.list_entries, ("reviews", team_id)),
                               (training.update_entry, ("reviews", entry["id"], entry["data"], 1)),
                               (training.delete_entry, ("reviews", entry["id"], 1)),
                               (training.create_entry, ("boards", data_for("boards"), team_id))):
            self.assert_error(404, function, "bob", *args)
        self.assert_error(404, training.accept_invitation, "carol", team_id)
        accepted = training.accept_invitation("bob", team_id)
        self.assertEqual(next(m["status"] for m in accepted["members"] if m["username"] == "bob"), "active")
        self.assertEqual(training.get_team("bob", team_id)["entries"]["reviews"], [entry])
        self.assertEqual(training.accept_invitation("bob", team_id), accepted)
        self.assertEqual(training.workspace("bob")["invitations"], [])

    def test_pending_invitations_can_be_declined_or_cancelled(self):
        team_id = training.create_team("alice", "Team")["id"]
        training.invite_member("alice", team_id, "bob")
        self.assert_error(403, training.remove_member, "bob", team_id, "alice")

        self.assert_error(404, training.invite_member, "bob", team_id, "carol")
        training.remove_member("bob", team_id, "bob")
        self.assert_error(404, training.accept_invitation, "bob", team_id)
        training.invite_member("alice", team_id, "bob")
        training.remove_member("alice", team_id, "bob")
        self.assertEqual(training.workspace("bob")["invitations"], [])
        self.assert_error(404, training.accept_invitation, "bob", team_id)
        self.assert_error(409, training.remove_member, "alice", team_id, "alice")

    def test_edit_permissions_owner_moderation_and_revocation(self):
        team_id = self.team_with_bob()
        for kind in ("reviews", "puzzles"):
            entry = self.create(kind, "bob", team_id)
            self.assert_error(403, training.update_entry, "alice", kind, entry["id"], entry["data"], 1)
            training.delete_entry("alice", kind, entry["id"], 1)
            entry = self.create(kind, "alice", team_id)
            self.assert_error(403, training.update_entry, "bob", kind, entry["id"], entry["data"], 1)
            self.assert_error(403, training.delete_entry, "bob", kind, entry["id"], 1)
        board = self.create("boards", team_id=team_id)
        updated = training.update_entry("bob", "boards", board["id"], dict(board["data"], notes="Shared edit"), 1)
        self.assertEqual((updated["owner"], updated["revision"]), ("alice", 2))
        self.assert_error(409, training.update_entry, "alice", "boards", board["id"], board["data"], 1)
        own = self.create("reviews", "bob", team_id)
        training.remove_member("bob", team_id, "bob")
        self.assert_error(404, training.get_team, "bob", team_id)
        self.assert_error(404, training.update_entry, "bob", "reviews", own["id"], own["data"], 1)
        self.assert_error(404, training.delete_entry, "bob", "reviews", own["id"], 1)
        training.delete_entry("alice", "reviews", own["id"], 1)

    def test_invite_permissions_existing_members_and_no_auto_activation(self):
        team_id = self.team_with_bob()
        self.assert_error(403, training.invite_member, "bob", team_id, "carol")
        self.assert_error(404, training.invite_member, "alice", team_id, "unknown")
        training.invite_member("alice", team_id, "bob")
        training.invite_member("alice", team_id, "alice")
        self.assertEqual(len(training.get_team("alice", team_id)["team"]["members"]), 2)
        self.assert_error(403, training.delete_team, "bob", team_id)
        self.assert_error(404, training.delete_team, "carol", team_id)
        self.assert_error(403, training.remove_member, "bob", team_id, "carol")

    def test_team_and_invitation_budgets_include_pending(self):
        with patch.object(training, "MAX_MEMBER_TEAMS", 1):
            team_id = training.create_team("alice", "One team")["id"]
            training.invite_member("alice", team_id, "bob")
            self.assert_error(409, training.create_team, "bob", "Cannot bypass pending invitation")
            other = training.create_team("carol", "Another team")["id"]
            self.assert_error(409, training.invite_member, "carol", other, "bob")
            training.remove_member("bob", team_id, "bob")
            training.invite_member("carol", other, "bob")
        with patch.object(training, "MAX_TEAM_MEMBERS", 2):
            self.assert_error(409, training.invite_member, "carol", other, "dave")
            training.accept_invitation("bob", other)
            self.assert_error(409, training.invite_member, "carol", other, "dave")

    def test_concurrent_invitations_cannot_exceed_membership_budgets(self):
        first = training.create_team("alice", "First")
        second = training.create_team("carol", "Second")
        barrier = threading.Barrier(2)

        def invite(team):
            barrier.wait(timeout=5)
            try:
                training.invite_member(team["owner"], team["id"], "bob")
                return 200
            except training.Error as error:
                return error.status

        with patch.object(training, "MAX_MEMBER_TEAMS", 1), ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(invite, [first, second]))
        self.assertEqual(sorted(statuses), [200, 409])
        self.assertEqual(len(training.workspace("bob")["invitations"]), 1)
        team_id = training.workspace("bob")["invitations"][0]["team_id"]
        training.remove_member("bob", team_id, "bob")
        barrier = threading.Barrier(2)

        def invite_to_one_team(username):
            barrier.wait(timeout=5)
            try:
                training.invite_member("alice", first["id"], username)
                return 200
            except training.Error as error:
                return error.status

        with patch.object(training, "MAX_TEAM_MEMBERS", 2), ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(invite_to_one_team, ["bob", "dave"]))
        self.assertEqual(sorted(statuses), [200, 409])
        self.assertEqual(len(training.get_team("alice", first["id"])["team"]["members"]), 2)

    def test_team_detail_lists_are_bounded_and_pageable(self):
        team_id = self.team_with_bob()
        for i in range(51):
            self.create("boards", "bob", team_id, title=f"Board {i}")
        detail = training.get_team("alice", team_id)
        self.assertEqual(len(detail["entries"]["boards"]), 50)
        self.assertTrue(detail["has_more"]["boards"])
        page = training.list_entries("bob", "boards", team_id, offset=50)
        self.assertEqual(len(page["entries"]), 1)
        self.assertFalse(page["has_more"])
        self.assertEqual(training.workspace("bob")["entries"]["boards"], [])

    def test_export_contains_all_personal_records_and_no_team_or_other_private_data(self):
        team_id = self.team_with_bob()
        personal_ids = {self.create(title=f"Private {i}")["id"] for i in range(52)}
        other = self.create(username="bob", title="Bob's private thought")
        shared = self.create(team_id=team_id, title="Shared discussion")
        for user in ("alice", "bob"):
            exported = training.export_member(user)
            self.assertEqual(set(exported), {"version", "username", "exported", "entries"})
            records = [e for values in exported["entries"].values() for e in values]
            self.assertTrue(all(e["owner"] == user and e["team_id"] is None for e in records))
            self.assertNotIn(shared["id"], json.dumps(exported))
            self.assertNotIn(team_id, json.dumps(exported))
            if user == "alice":
                self.assertEqual({e["id"] for e in records}, personal_ids)
                self.assertNotIn(other["id"], json.dumps(exported))
            else:
                self.assertEqual(records, [other])

    def test_team_deletion_cascades_only_team_documents_and_invites(self):
        team_id = self.team_with_bob()
        training.invite_member("alice", team_id, "carol")
        self.create(team_id=team_id)
        self.create("boards", "bob", team_id)
        personal = self.create("boards", "bob")
        training.delete_team("alice", team_id)
        self.assertEqual(training.list_entries("bob", "boards")["entries"], [personal])
        self.assertEqual(self.stored_count("training_memberships"), 0)
        self.assertEqual(training.workspace("carol")["invitations"], [])
        self.assert_error(404, training.get_team, "alice", team_id)

    def test_erase_member_on_fk_off_connection_is_transactional_and_complete(self):
        owned = self.team_with_bob()
        elsewhere = training.create_team("bob", "Bob's team")["id"]
        training.invite_member("bob", elsewhere, "alice")
        training.accept_invitation("alice", elsewhere)
        training.invite_member("bob", elsewhere, "carol")
        self.create(team_id=owned)
        self.create("boards", "bob", owned)
        self.create(team_id=elsewhere)
        self.create("boards", "bob", elsewhere)
        self.create("lessons")
        bob_private = self.create("reviews", "bob")
        before = self.stored_count()
        with closing(auth.connect()) as db:
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 0)
            db.execute("BEGIN IMMEDIATE")
            training.erase_member(db, "alice")
            self.assertTrue(db.in_transaction)
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 0)
            db.rollback()
        self.assertEqual(self.stored_count(), before)
        with closing(auth.connect()) as db:
            training.erase_member(db, "alice")
            db.execute("DELETE FROM users WHERE username='alice'")
            db.commit()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_entries WHERE owner='alice'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_memberships WHERE username='alice'").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_teams WHERE owner='alice'").fetchone()[0], 0)
        self.assertEqual(training.list_entries("bob", "reviews")["entries"], [bob_private])
        self.assertEqual(len(training.get_team("bob", elsewhere)["entries"]["boards"]), 1)
        self.assertEqual(len(training.workspace("carol")["invitations"]), 1)
        with closing(training.connect()) as db:
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_erasing_author_detaches_surviving_teammate_sources_without_committing(self):
        team_id = training.create_team("bob", "Bob's team")["id"]
        training.invite_member("bob", team_id, "alice")
        training.accept_invitation("alice", team_id)
        review = self.create(team_id=team_id)
        puzzle = self.create("puzzles", "bob", team_id, source_review_id=review["id"])
        for row_factory in (None, sqlite3.Row):
            with closing(auth.connect()) as db:
                db.row_factory = row_factory
                db.execute("BEGIN IMMEDIATE")
                training.erase_member(db, "alice")
                self.assertIs(db.row_factory, row_factory)
                self.assertTrue(db.in_transaction)
                data, revision = db.execute("SELECT data,revision FROM training_entries WHERE id=?", (puzzle["id"],)).fetchone()
                self.assertIsNone(json.loads(data)["source_review_id"])
                self.assertEqual(revision, 2)
                db.rollback()
            self.assertEqual(training.list_entries("bob", "puzzles", team_id)["entries"], [puzzle])
        with closing(auth.connect()) as db:
            training.erase_member(db, "alice")
            db.execute("DELETE FROM users WHERE username='alice'")
            db.commit()
        current = training.list_entries("bob", "puzzles", team_id)["entries"][0]
        self.assertIsNone(current["data"]["source_review_id"])
        self.assertEqual(current["data"]["discussion"], puzzle["data"]["discussion"])
        self.assertEqual(current["revision"], 2)

    def test_erase_without_training_tables_is_a_noop_without_schema_or_commit(self):
        with closing(auth.connect()) as db:
            db.execute("BEGIN")
            training.erase_member(db, "alice")
            self.assertTrue(db.in_transaction)
            self.assertFalse(db.execute("SELECT 1 FROM sqlite_master WHERE name='training_entries'").fetchone())
            db.rollback()

    def test_catalog_is_complete_text_only_and_detached(self):
        bootstrap = training.workspace("alice")
        workouts = bootstrap["catalog"]["workouts"]
        self.assertEqual({w["id"] for w in workouts}, {"last-hit", "recall", "jungle-clear", "vision-setup", "review-rotation", "trading-window"})
        for workout in workouts:
            self.assertEqual(set(workout), {"id", "title", "roles", "minutes", "goal", "steps", "measure", "unit", "tip"})
            self.assertGreater(len(workout["steps"]), 1)
        puzzles = bootstrap["catalog"]["starter_puzzles"]
        self.assertEqual({p["id"] for p in puzzles}, {"recall-window", "objective-trade", "unsafe-wave"})
        for puzzle in puzzles:
            training.validate_data("puzzles", {k: v for k, v in puzzle.items() if k != "id"})
            self.assertNotIn("correct", json.dumps(puzzle))
        workouts[0]["steps"].clear()
        puzzles[0]["choices"].clear()
        fresh = training.workspace("alice")["catalog"]
        self.assertTrue(fresh["workouts"][0]["steps"])
        self.assertEqual(len(fresh["starter_puzzles"][0]["choices"]), 2)


if __name__ == "__main__":
    unittest.main()
