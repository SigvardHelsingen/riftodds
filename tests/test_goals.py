"""Private goal persistence using temporary member databases only."""
import io
import math
import sqlite3
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import auth


class GoalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "fixture-users.db"
        db_patch = patch.object(auth, "DB_PATH", self.path)
        db_patch.start()
        self.addCleanup(db_patch.stop)
        with closing(auth.connect()) as db:
            db.executemany("INSERT INTO users (username, password_hash, created) VALUES (?, 'fixture', 0)",
                           [("alice",), ("bob",)])
            db.commit()
        auth.set_account("alice", "FIXTURE", "Fixture", "ONE", "alice-puuid")
        auth.set_account("bob", "FIXTURE", "Fixture", "TWO", "bob-puuid")

    def count(self):
        with closing(auth.connect()) as db:
            return db.execute("SELECT COUNT(*) FROM goals").fetchone()[0]

    def test_public_contract_upsert_and_created_timestamp(self):
        self.assertEqual(auth.get_goals("alice", "alice-puuid"), [])
        with patch.object(auth.time, "time", return_value=100):
            first = auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
        self.assertEqual(first, {"puuid": "alice-puuid", "role": "TOP", "metric": "cs_min", "target": 6.0, "created": 100})
        with patch.object(auth.time, "time", return_value=200):
            updated = auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 7)
        self.assertEqual(updated, {**first, "target": 7.0})
        self.assertEqual(auth.get_goals("alice", "alice-puuid"), [updated])
        self.assertEqual(self.count(), 1)
        self.assertTrue(auth.delete_goal("alice", "alice-puuid", "TOP", "cs_min"))
        self.assertFalse(auth.delete_goal("alice", "alice-puuid", "TOP", "cs_min"))
        self.assertEqual(self.count(), 0)

    def test_member_account_role_metric_isolation_and_stable_order(self):
        for role, key in (("TOP", "deaths"), ("MIDDLE", "cs_min"), ("TOP", "cs_min")):
            auth.set_goal("alice", "alice-puuid", role, key, 5)
        auth.set_goal("bob", "bob-puuid", "TOP", "cs_min", 8)
        rows = auth.get_goals("alice", "alice-puuid")
        self.assertEqual([(r["role"], r["metric"]) for r in rows],
                         [("MIDDLE", "cs_min"), ("TOP", "cs_min"), ("TOP", "deaths")])
        self.assertEqual(auth.get_goals("alice", "bob-puuid"), [])
        self.assertEqual(auth.get_goals("missing", "bob-puuid"), [])
        self.assertFalse(auth.delete_goal("alice", "bob-puuid", "TOP", "cs_min"))
        with self.assertRaises(ValueError):
            auth.set_goal("alice", "bob-puuid", "TOP", "cs_min", 1)
        self.assertTrue(auth.delete_goal("alice", "alice-puuid", "TOP", "cs_min"))
        self.assertEqual(len(auth.get_goals("alice", "alice-puuid")), 2)
        self.assertEqual(auth.get_goals("bob", "bob-puuid")[0]["target"], 8)

    def test_two_members_sharing_a_linked_puuid_still_have_private_goals(self):
        auth.set_account("bob", "FIXTURE", "Fixture", "ONE", "alice-puuid")
        auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
        auth.set_goal("bob", "alice-puuid", "TOP", "cs_min", 8)
        self.assertEqual(auth.get_goals("alice", "alice-puuid")[0]["target"], 6)
        self.assertEqual(auth.get_goals("bob", "alice-puuid")[0]["target"], 8)
        auth.clear_account("alice")
        self.assertEqual(auth.get_goals("bob", "alice-puuid")[0]["target"], 8)
        self.assertEqual(self.count(), 1)

    def test_finite_target_role_and_actionable_metric_validation(self):
        cases = [("SUPPORT", "cs_min", 6), ("UTILITY", "cs_min", 6),
                 ("TOP", "jungle_cs10", 10), ("TOP", "missing", 6),
                 ("TOP", "gold_min", 500), ("TOP", "dmg_share", 0.2),
                 ("TOP", "cs_min", -1), ("TOP", "cs_min", math.nan),
                 ("TOP", "cs_min", math.inf), ("TOP", "cs_min", -math.inf),
                 ("TOP", "cs_min", "6"), ("TOP", "cs_min", True),
                 ("TOP", "cs_min", None), ("TOP", "cs_min", 10 ** 1000),
                 ("TOP", "cs_min", auth.MAX_GOAL_TARGET + 1), ("TOP", "kp", 50)]
        with patch.object(auth, "connect", side_effect=AssertionError("Invalid targets must not open SQLite")):
            for role, key, target in cases:
                with self.subTest(role=role, metric=key, target=repr(target)), self.assertRaises(ValueError):
                    auth.set_goal("alice", "alice-puuid", role, key, target)
        for target in (0, 1):
            self.assertEqual(auth.set_goal("alice", "alice-puuid", "TOP", "kp", target)["target"], target)
        self.assertEqual(auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", auth.MAX_GOAL_TARGET)["target"], auth.MAX_GOAL_TARGET)

    def test_unlink_relink_and_account_replacement_cleanup(self):
        auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
        # Name/platform updates for the same PUUID preserve goals.
        auth.set_account("alice", "FIXTURE-2", "Renamed", "THREE", "alice-puuid")
        self.assertEqual(self.count(), 1)
        auth.set_account("alice", "FIXTURE", "Other", "FOUR", "new-puuid")
        self.assertEqual(self.count(), 0)
        with self.assertRaises(ValueError):
            auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
        auth.set_goal("alice", "new-puuid", "TOP", "cs_min", 6)
        auth.clear_account("alice")
        self.assertEqual(self.count(), 0)
        self.assertFalse(auth.delete_goal("alice", "new-puuid", "TOP", "cs_min"))
        with self.assertRaises(ValueError):
            auth.set_goal("alice", "new-puuid", "TOP", "cs_min", 6)
        auth.set_account("alice", "FIXTURE", "Other", "FOUR", "new-puuid")
        self.assertEqual(auth.get_goals("alice", "new-puuid"), [])

    def test_remove_cleans_goals_but_password_and_role_changes_preserve_them(self):
        auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
        auth.set_goal("bob", "bob-puuid", "TOP", "cs_min", 7)
        with patch.object(auth, "_ask_password", return_value="fixture-password"), redirect_stdout(io.StringIO()):
            auth.main(["passwd", "alice"])
            auth.main(["role", "alice", "admin"])
        self.assertEqual(self.count(), 2)
        with redirect_stdout(io.StringIO()):
            auth.main(["remove", "alice"])
        self.assertEqual(self.count(), 1)
        self.assertEqual(auth.get_goals("alice", "alice-puuid"), [])
        with self.assertRaises(ValueError):
            auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
        self.assertEqual(len(auth.get_goals("bob", "bob-puuid")), 1)

    def test_revocation_after_connection_open_cannot_leave_new_goal(self):
        original = auth.connect

        def revoke_before_write():
            db = original()
            try:
                with patch.object(auth, "connect", side_effect=original):
                    auth.clear_account("alice")
            except BaseException:
                db.close()
                raise
            return db

        with patch.object(auth, "connect", side_effect=revoke_before_write), self.assertRaises(ValueError):
            auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
        self.assertEqual(self.count(), 0)

    def test_orphaned_account_cannot_read_or_write_goals(self):
        auth.set_account("orphan", "FIXTURE", "None", "NONE", "orphan-puuid")
        with self.assertRaises(ValueError):
            auth.set_goal("orphan", "orphan-puuid", "TOP", "cs_min", 6)
        # Even legacy/manual orphaned rows are invisible until a real member and
        # matching current link exist. Runtime removal explicitly deletes them.
        with closing(auth.connect()) as db:
            db.execute("INSERT INTO goals VALUES ('orphan', 'orphan-puuid', 'TOP', 'cs_min', 6, 0)")
            db.commit()
        self.assertEqual(auth.get_goals("orphan", "orphan-puuid"), [])
        self.assertFalse(auth.delete_goal("orphan", "orphan-puuid", "TOP", "cs_min"))

    def test_schema_migrates_existing_members_without_changing_accounts(self):
        old_path = self.path.with_name("legacy.db")
        with closing(sqlite3.connect(old_path)) as db:
            db.executescript("""CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created INTEGER);
                              INSERT INTO users VALUES ('legacy', 'fixture', 0);
                              CREATE TABLE accounts (username TEXT PRIMARY KEY, platform TEXT, game_name TEXT, tag_line TEXT, puuid TEXT);
                              INSERT INTO accounts VALUES ('legacy', 'FIXTURE', 'Old', 'ONE', 'old-puuid');""")
            db.commit()
        with patch.object(auth, "DB_PATH", old_path):
            result = auth.set_goal("legacy", "old-puuid", "TOP", "cs_min", 6)
            self.assertEqual(auth.get_goals("legacy", "old-puuid"), [result])
            self.assertEqual(auth.get_account("legacy"), {"platform": "FIXTURE", "game_name": "Old",
                                                         "tag_line": "ONE", "puuid": "old-puuid"})
            self.assertEqual(auth.role_of("legacy"), "member")

    def test_connections_close_on_rejected_writes_and_success(self):
        opened = []

        class TrackedConnection(sqlite3.Connection):
            closed = False

            def close(self):
                self.closed = True
                super().close()

        def connect():
            db = sqlite3.connect(self.path, factory=TrackedConnection)
            db.executescript(auth.SCHEMA)
            opened.append(db)
            return db

        with patch.object(auth, "connect", side_effect=connect):
            auth.set_goal("alice", "alice-puuid", "TOP", "cs_min", 6)
            auth.get_goals("alice", "alice-puuid")
            auth.delete_goal("alice", "alice-puuid", "TOP", "cs_min")
            with self.assertRaises(ValueError):
                auth.set_goal("alice", "unlinked", "TOP", "cs_min", 6)
        self.assertEqual(len(opened), 4)
        self.assertTrue(all(db.closed for db in opened))


if __name__ == "__main__":
    unittest.main()
