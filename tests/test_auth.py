import io
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

import auth


class AuthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = "old-password"
        cls.password_hash = auth.hash_password(cls.password)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "users.db"
        self.db_patch = patch.object(auth, "DB_PATH", self.path)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        self.throttle_patch = patch.object(auth, "_throttle", auth.LoginThrottle())
        self.throttle_patch.start()
        self.addCleanup(self.throttle_patch.stop)
        with closing(auth.connect()) as db:
            db.execute("INSERT INTO users (username, password_hash, created) VALUES (?, ?, ?)",
                       ("alice", self.password_hash, int(time.time())))
            db.commit()

    def test_login_logout_and_session_token_hash(self):
        token = auth.login(" alice ", self.password)
        self.assertIsNotNone(token)
        self.assertEqual(auth.user_for(token), "alice")
        with closing(auth.connect()) as db:
            stored = db.execute("SELECT token_hash FROM sessions").fetchone()[0]
        self.assertNotEqual(stored, token)
        self.assertEqual(stored, auth._token_hash(token))
        auth.logout(token)
        self.assertIsNone(auth.user_for(token))

    def test_orphaned_and_expired_sessions_do_not_authenticate(self):
        with closing(auth.connect()) as db:
            db.executemany("INSERT INTO sessions VALUES (?, ?, ?)", [
                (auth._token_hash("orphan"), "removed", int(time.time()) + 3600),
                (auth._token_hash("expired"), "alice", int(time.time()) - 1),
            ])
            db.commit()
        self.assertIsNone(auth.user_for("orphan"))
        self.assertIsNone(auth.user_for("expired"))
        self.assertIsNone(auth.user_for(None))

    def check_revocation_race(self, command):
        started, proceed = threading.Event(), threading.Event()
        original_check = auth.check_password

        def paused_check(password, stored):
            started.set()
            if not proceed.wait(5):
                raise AssertionError("Revocation did not finish")
            return original_check(password, stored)

        with patch.object(auth, "check_password", side_effect=paused_check):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(auth.login, "alice", self.password)
                try:
                    self.assertTrue(started.wait(5))
                    with patch.object(auth, "_ask_password", return_value="new-password"), redirect_stdout(io.StringIO()):
                        auth.main([command, "alice"])
                finally:
                    proceed.set()
                self.assertIsNone(pending.result(timeout=5))
        with closing(auth.connect()) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
        self.assertEqual(auth._throttle.running, 0)

    def test_password_change_prevents_pending_login(self):
        self.check_revocation_race("passwd")

    def test_removal_prevents_pending_login(self):
        self.check_revocation_race("remove")

    def test_cli_revokes_already_created_sessions(self):
        token = auth.login("alice", self.password)
        with patch.object(auth, "_ask_password", return_value="new-password"), redirect_stdout(io.StringIO()):
            auth.main(["passwd", "alice"])
        self.assertIsNone(auth.user_for(token))

    def test_concurrent_attempts_are_reserved_before_hashing(self):
        barrier = threading.Barrier(auth.MAX_FAILURES)

        def failed_check(*args):
            barrier.wait(timeout=5)
            return False

        with patch.object(auth, "MAX_CONCURRENT_LOGINS", 20), patch.object(auth, "check_password", side_effect=failed_check) as check:
            with ThreadPoolExecutor(max_workers=20) as pool:
                futures = [pool.submit(auth.login, "alice", "wrong-password") for _ in range(20)]
                self.assertTrue(all(f.result(timeout=10) is None for f in futures))
        self.assertEqual(check.call_count, auth.MAX_FAILURES)
        self.assertEqual(auth._throttle.users["alice"][0], auth.MAX_FAILURES)
        self.assertEqual(auth._throttle.running, 0)

    def test_throttled_login_does_not_open_db_or_hash(self):
        with patch.object(auth._throttle, "reserve", return_value=False) as reserve, patch.object(auth, "connect") as connect, patch.object(auth, "check_password") as check:
            self.assertIsNone(auth.login("alice", self.password, client="client"))
        reserve.assert_called_once_with("alice", "client")
        connect.assert_not_called()
        check.assert_not_called()
        self.assertEqual(auth._throttle.running, 0)

    def test_invalid_credentials_do_not_open_db_or_hash(self):
        cases = [("", self.password), ("   ", self.password),
                 ("a" * (auth.MAX_USERNAME_LENGTH + 1), self.password),
                 ("alice", "short"), ("alice", "p" * (auth.MAX_PASSWORD_LENGTH + 1))]
        with patch.object(auth, "connect") as connect, patch.object(auth, "check_password") as check:
            for username, password in cases:
                self.assertIsNone(auth.login(username, password))
        connect.assert_not_called()
        check.assert_not_called()

    def test_database_error_releases_concurrent_reservation(self):
        with patch.object(auth, "connect", side_effect=sqlite3.OperationalError("unavailable")):
            with self.assertRaises(sqlite3.OperationalError):
                auth.login("alice", self.password)
        self.assertEqual(auth._throttle.running, 0)

    def test_auth_connections_close_on_success_and_failure(self):
        connections = []

        class TrackedConnection(sqlite3.Connection):
            closed = False

            def close(self):
                self.closed = True
                super().close()

        def connect():
            db = sqlite3.connect(self.path, factory=TrackedConnection)
            db.executescript(auth.SCHEMA)
            connections.append(db)
            return db

        with patch.object(auth, "connect", side_effect=connect):
            token = auth.login("alice", self.password)
            self.assertIsNone(auth.login("alice", "wrong-password"))
            self.assertEqual(auth.user_for(token), "alice")
            auth.set_account("alice", "euw1", "Test", "EUW", "dummy-puuid")
            self.assertIsNotNone(auth.get_account("alice"))
            self.assertEqual(len(auth.all_accounts()), 1)
            auth.clear_account("alice")
            auth.logout(token)
            with redirect_stdout(io.StringIO()):
                auth.main(["list"])
            with self.assertRaises(SystemExit):
                auth.main(["remove", "missing-user"])
            with patch.object(auth, "check_password", side_effect=RuntimeError("hash failed")):
                with self.assertRaises(RuntimeError):
                    auth.login("alice", self.password)
        self.assertTrue(connections)
        self.assertTrue(all(db.closed for db in connections))
        self.assertEqual(auth._throttle.running, 0)

    def test_failed_schema_initialization_closes_connection(self):
        db = Mock()
        db.executescript.side_effect = sqlite3.OperationalError("schema failed")
        with patch.object(auth.sqlite3, "connect", return_value=db):
            with self.assertRaises(sqlite3.OperationalError):
                auth.connect()
        db.close.assert_called_once_with()

    def test_cli_rejects_unusable_usernames_and_password_lengths(self):
        with patch.object(auth, "connect") as connect:
            for name in ("", " alice", "alice ", "a" * (auth.MAX_USERNAME_LENGTH + 1)):
                with self.subTest(name=name), self.assertRaises(SystemExit):
                    auth.main(["add", name])
        connect.assert_not_called()
        for password in ("short", "p" * (auth.MAX_PASSWORD_LENGTH + 1)):
            with patch.object(auth.getpass, "getpass", return_value=password):
                with self.assertRaises(SystemExit):
                    auth._ask_password()

    def test_cli_and_login_accept_length_boundaries(self):
        name = "a" * auth.MAX_USERNAME_LENGTH
        password = "p" * auth.MAX_PASSWORD_LENGTH
        with patch.object(auth.getpass, "getpass", return_value=password), redirect_stdout(io.StringIO()):
            auth.main(["add", name])
        token = auth.login(name, password)
        self.assertEqual(auth.user_for(token), name)


class RoleAndActivityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        db_patch = patch.object(auth, "DB_PATH", self.dir / "users.db")
        db_patch.start()
        self.addCleanup(db_patch.stop)
        with closing(auth.connect()) as db:
            db.execute("INSERT INTO users (username, password_hash, created) VALUES ('alice', 'x', 0)")
            db.commit()

    def test_roles_default_to_member_and_cli_promotes(self):
        self.assertEqual(auth.role_of("alice"), "member")
        with redirect_stdout(io.StringIO()) as out:
            auth.main(["role", "alice", "admin"])
        self.assertEqual((auth.role_of("alice"), out.getvalue().strip()), ("admin", "alice is now an admin."))
        for argv in (["role", "alice", "owner"], ["role", "alice"], ["role", "nobody", "admin"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                auth.main(argv)
        self.assertEqual(auth.role_of("alice"), "admin")
        self.assertIsNone(auth.role_of("nobody"))

    def test_existing_database_gains_role_and_last_seen(self):
        old = self.dir / "old.db"
        with closing(sqlite3.connect(old)) as db:
            db.execute("CREATE TABLE users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created INTEGER)")
            db.execute("INSERT INTO users VALUES ('bob', 'x', 0)")
            db.commit()
        with patch.object(auth, "DB_PATH", old):
            self.assertEqual(auth.role_of("bob"), "member")
            auth.seen("bob")
            self.assertIsNotNone(auth.activity_report()["users"][0]["last_seen"])

    def test_report_counts_recent_events_and_old_ones_are_pruned(self):
        with closing(auth.connect()) as db:
            db.execute("INSERT INTO activity (username, at, kind, detail) VALUES ('alice', 0, 'login', '')")
            db.commit()
        auth.record("alice", "login")
        auth.record("alice", "lookup", "Faker#KR1 (kr) · Last 20 games")
        auth.record("alice", "login")
        report = auth.activity_report(days=7)
        self.assertEqual([(u["username"], u["role"], u["counts"], u["last_seen"]) for u in report["users"]],
                         [("alice", "member", {"login": 2, "lookup": 1}, None)])
        self.assertEqual([e["kind"] for e in report["events"]], ["login", "lookup", "login"])
        with closing(auth.connect()) as db:  # the 1970 row was pruned, not just filtered out
            self.assertEqual(db.execute("SELECT COUNT(*) FROM activity WHERE at = 0").fetchone()[0], 0)
        self.assertEqual(report["events"][1]["detail"], "Faker#KR1 (kr) · Last 20 games")


class ThrottleTests(unittest.TestCase):
    def setUp(self):
        self.throttle = auth.LoginThrottle()
        self.clock = patch.object(auth.time, "monotonic", return_value=1000)
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)

    def attempt(self, username, client="client"):
        admitted = self.throttle.reserve(username, client)
        if admitted:
            self.throttle.finish(username, False)
        return admitted

    def test_username_budget_and_expiration(self):
        for _ in range(auth.MAX_FAILURES):
            self.assertTrue(self.attempt("alice"))
        self.assertFalse(self.attempt("alice"))
        self.now.return_value += auth.LOCKOUT
        self.assertTrue(self.attempt("alice"))
        self.assertEqual(self.throttle.users["alice"][0], 1)

    def test_client_and_global_budgets(self):
        for i in range(auth.MAX_CLIENT_ATTEMPTS):
            self.assertTrue(self.attempt(f"user-{i}"))
        self.assertFalse(self.attempt("another-user"))
        self.now.return_value += auth.RATE_WINDOW
        self.assertTrue(self.attempt("another-user"))
        with patch.object(auth, "MAX_GLOBAL_ATTEMPTS", 3):
            self.throttle = auth.LoginThrottle()
            for i in range(3):
                self.assertTrue(self.attempt(f"user-{i}", f"client-{i}"))
            self.assertFalse(self.attempt("extra-user", "extra-client"))
            self.now.return_value += auth.RATE_WINDOW
            self.assertTrue(self.attempt("extra-user", "extra-client"))

    def test_maps_are_bounded_and_expired_entries_are_removed(self):
        with patch.object(auth, "MAX_THROTTLE_KEYS", 2):
            self.assertTrue(self.attempt("a", "a"))
            self.assertTrue(self.attempt("b", "b"))
            self.assertFalse(self.attempt("c", "c"))
            self.assertEqual(len(self.throttle.users), 2)
            self.assertEqual(len(self.throttle.clients), 2)
            self.now.return_value += auth.LOCKOUT
            self.assertTrue(self.attempt("c", "c"))
        self.assertEqual(set(self.throttle.users), {"c"})
        self.assertEqual(set(self.throttle.clients), {"c"})
        self.assertEqual(len(self.throttle.attempts), 1)

    def test_concurrent_hash_budget(self):
        for i in range(auth.MAX_CONCURRENT_LOGINS):
            self.assertTrue(self.throttle.reserve(f"user-{i}", f"client-{i}"))
        self.assertFalse(self.throttle.reserve("extra", "extra"))
        for i in range(auth.MAX_CONCURRENT_LOGINS):
            self.throttle.finish(f"user-{i}", False)
        self.assertTrue(self.attempt("extra", "extra"))
        self.assertEqual(self.throttle.running, 0)

    def test_success_only_resets_username_budget(self):
        self.assertTrue(self.throttle.reserve("alice", "client"))
        self.throttle.finish("alice", True)
        self.assertNotIn("alice", self.throttle.users)
        self.assertEqual(self.throttle.clients["client"][0], 1)
        self.assertEqual(len(self.throttle.attempts), 1)
        self.assertEqual(self.throttle.running, 0)
