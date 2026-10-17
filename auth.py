"""Invite-only login. Users live in users.db on the server and are managed from the CLI:

    uv run python auth.py add <username>       # prompts for a password
    uv run python auth.py passwd <username>
    uv run python auth.py remove <username>    # also logs them out everywhere
    uv run python auth.py role <username> admin|member   # admins see everyone's activity
    uv run python auth.py list

Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly
cookie, and only a SHA-256 of each token is stored.
"""
import getpass
import hashlib
import hmac
import math
import secrets
import sqlite3
import sys
import threading
import time
from collections import deque
from contextlib import closing
from pathlib import Path

import perf

DB_PATH = Path(__file__).with_name("users.db")
SESSION_DAYS = 30
COOKIE = "riftodds_session"

MAX_USERNAME_LENGTH = 64
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 1024

# Process-local limits: this app runs with a single worker.
MAX_FAILURES = 10
LOCKOUT = 15 * 60
RATE_WINDOW = 60
MAX_CLIENT_ATTEMPTS = 20
MAX_GLOBAL_ATTEMPTS = 100
MAX_CONCURRENT_LOGINS = 4
MAX_THROTTLE_KEYS = 1024


class LoginThrottle:
    def __init__(self):
        self.lock = threading.Lock()
        self.users = {}
        self.clients = {}
        self.attempts = deque()
        self.running = 0

    def reserve(self, username, client):
        """Atomically reserve budgets before opening SQLite or hashing a password."""
        with self.lock:
            now = time.monotonic()
            for entries, period in ((self.users, LOCKOUT), (self.clients, RATE_WINDOW)):
                for key in [k for k, (_, since) in entries.items() if now - since >= period]:
                    del entries[key]
            while self.attempts and now - self.attempts[0] >= RATE_WINDOW:
                self.attempts.popleft()
            user_count, user_since = self.users.get(username, (0, now))
            client_count, client_since = self.clients.get(client, (0, now))
            if (user_count >= MAX_FAILURES or client_count >= MAX_CLIENT_ATTEMPTS
                    or len(self.attempts) >= MAX_GLOBAL_ATTEMPTS
                    or self.running >= MAX_CONCURRENT_LOGINS):
                return False
            # Fail closed rather than evicting active lockouts when the map is full.
            if ((username not in self.users and len(self.users) >= MAX_THROTTLE_KEYS)
                    or (client not in self.clients and len(self.clients) >= MAX_THROTTLE_KEYS)):
                return False
            self.users[username] = (user_count + 1, user_since)
            self.clients[client] = (client_count + 1, client_since)
            self.attempts.append(now)
            self.running += 1
            return True

    def finish(self, username, success):
        with self.lock:
            self.running -= 1
            if success:
                self.users.pop(username, None)


_throttle = LoginThrottle()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER
);
-- the Riot account a user has marked as "this is me"
CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY, platform TEXT, game_name TEXT, tag_line TEXT, puuid TEXT
);
-- what members do on the site (logins, player lookups), shown to admins
CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_activity_at ON activity(at);
-- private coaching goals for the member's linked Riot account
CREATE TABLE IF NOT EXISTS goals (
    username TEXT NOT NULL, puuid TEXT NOT NULL, role TEXT NOT NULL, metric TEXT NOT NULL,
    target REAL NOT NULL CHECK (target >= 0 AND target <= 10000), created INTEGER NOT NULL,
    PRIMARY KEY (username, puuid, role, metric),
    FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
);
"""
# columns added after the first release; connect() adds them to older databases
MIGRATIONS = [("users", "role", "TEXT NOT NULL DEFAULT 'member'"), ("users", "last_seen", "INTEGER")]
ROLES = ("member", "admin")
ACTIVITY_DAYS = 90  # activity older than this is deleted
GOAL_ROLES = perf.ROLES
GOAL_METRICS = tuple(k for k, m in perf.METRICS.items() if m[3])
MAX_GOAL_TARGET = 10000  # bounded finite raw units; pct metrics instead use 0..1


def connect():
    db = sqlite3.connect(DB_PATH)
    try:
        db.executescript(SCHEMA)
        for table, col, kind in MIGRATIONS:
            if col not in {r[1] for r in db.execute(f"PRAGMA table_info({table})")}:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {kind}")
    except BaseException:
        db.close()
        raise
    return db


# --- passwords ---------------------------------------------------------------

def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password, stored):
    _, salt, digest = stored.split("$")
    candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
    return hmac.compare_digest(candidate.hex(), digest)


# a real hash to check against when the username doesn't exist, so timing doesn't reveal it
_DUMMY_HASH = hash_password(secrets.token_hex(8))


# --- sessions ----------------------------------------------------------------

def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def login(username, password, client="local"):
    """Return a session token, or None for invalid, revoked or throttled credentials."""
    username = username.strip()
    if (not username or len(username) > MAX_USERNAME_LENGTH
            or not MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH):
        return None
    if not _throttle.reserve(username, client):
        return None
    success = False
    try:
        with closing(connect()) as db:
            row = db.execute("SELECT password_hash FROM users WHERE username = ?", (username,)).fetchone()
        if not check_password(password, row[0] if row else _DUMMY_HASH) or row is None:
            return None
        token = secrets.token_urlsafe(32)
        with closing(connect()) as db:
            # The conditional write serializes with CLI revocation without holding a lock during scrypt.
            inserted = db.execute(
                """INSERT INTO sessions (token_hash, username, expires)
                   SELECT ?, username, ? FROM users WHERE username = ? AND password_hash = ?""",
                (_token_hash(token), int(time.time()) + SESSION_DAYS * 86400, username, row[0]))
            if inserted.rowcount != 1:
                return None
            db.execute("DELETE FROM sessions WHERE expires < ?", (int(time.time()),))
            db.commit()
        success = True
        return token
    finally:
        _throttle.finish(username, success)


def user_for(token):
    if not token:
        return None
    with closing(connect()) as db:
        row = db.execute(
            """SELECT s.username FROM sessions s JOIN users u ON u.username = s.username
               WHERE s.token_hash = ? AND s.expires > ?""",
            (_token_hash(token), int(time.time()))).fetchone()
    return row[0] if row else None


def logout(token):
    if token:
        with closing(connect()) as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
            db.commit()


# --- linked Riot account -----------------------------------------------------

def get_account(username):
    with closing(connect()) as db:
        row = db.execute("SELECT platform, game_name, tag_line, puuid FROM accounts WHERE username = ?",
                         (username,)).fetchone()
    return dict(zip(("platform", "game_name", "tag_line", "puuid"), row)) if row else None


def set_account(username, platform, game_name, tag_line, puuid):
    with closing(connect()) as db:
        db.execute("INSERT OR REPLACE INTO accounts VALUES (?, ?, ?, ?, ?)", (username, platform, game_name, tag_line, puuid))
        db.execute("DELETE FROM goals WHERE username = ? AND puuid IS NOT ?", (username, puuid))
        db.commit()


def all_accounts():
    with closing(connect()) as db:
        return [dict(zip(("username", "platform", "game_name", "tag_line", "puuid"), r))
                for r in db.execute("SELECT username, platform, game_name, tag_line, puuid FROM accounts")]


def clear_account(username):
    with closing(connect()) as db:
        db.execute("DELETE FROM accounts WHERE username = ?", (username,))
        db.execute("DELETE FROM goals WHERE username = ?", (username,))
        db.commit()


# --- private coaching goals --------------------------------------------------

GOAL_FIELDS = ("puuid", "role", "metric", "target", "created")


def get_goals(username, puuid):
    """Return [{puuid, role, metric, target, created}], sorted by role/metric.

    Only an existing member's currently linked puuid is readable, otherwise [].
    `created` is Unix seconds and survives target updates. Targets use perf's raw
    units (pct metrics are fractions, not percentages). Authentication at the API
    boundary must supply username from the session, never from a request body.
    """
    with closing(connect()) as db:
        rows = db.execute(
            """SELECT g.puuid, g.role, g.metric, g.target, g.created FROM goals g
               JOIN users u ON u.username = g.username
               JOIN accounts a ON a.username = g.username AND a.puuid = g.puuid
               WHERE g.username = ? AND g.puuid = ? ORDER BY g.role, g.metric""",
            (username, puuid))
        return [dict(zip(GOAL_FIELDS, row)) for row in rows]


def set_goal(username, puuid, role, metric, target):
    """Upsert one goal and return {puuid, role, metric, target, created}.

    ValueError: invalid role, non-actionable/inapplicable metric, non-finite or
    out-of-range target, missing member, or puuid not currently linked to them.
    Targets must be int/float (not bool/string), 0..MAX_GOAL_TARGET inclusive,
    or 0..1 for pct metrics. The conditional write serializes with unlink/remove
    so a concurrent revocation cannot leave an orphaned goal.
    """
    if role not in GOAL_ROLES or metric not in GOAL_METRICS or role not in perf.METRICS[metric][4]:
        raise ValueError("Goal metric must be actionable and applicable to this role")
    if type(target) not in (int, float):
        raise ValueError("Goal target must be a finite number")
    try:
        target = float(target)
    except OverflowError:
        raise ValueError("Goal target must be a finite number") from None
    maximum = 1 if perf.METRICS[metric][1] == "pct" else MAX_GOAL_TARGET
    if not math.isfinite(target) or not 0 <= target <= maximum:
        raise ValueError(f"Goal target must be between 0 and {maximum} in raw metric units")
    with closing(connect()) as db:
        written = db.execute(
            """INSERT INTO goals (username, puuid, role, metric, target, created)
               SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
                   SELECT 1 FROM users u JOIN accounts a ON a.username = u.username
                   WHERE u.username = ? AND a.puuid = ?)
               ON CONFLICT (username, puuid, role, metric) DO UPDATE SET target = excluded.target""",
            (username, puuid, role, metric, target, int(time.time()), username, puuid))
        if written.rowcount != 1:
            raise ValueError("Goals require an existing member and their currently linked Riot account")
        row = db.execute(
            """SELECT puuid, role, metric, target, created FROM goals
               WHERE username = ? AND puuid = ? AND role = ? AND metric = ?""",
            (username, puuid, role, metric)).fetchone()
        db.commit()
        return dict(zip(GOAL_FIELDS, row))


def delete_goal(username, puuid, role, metric):
    """Delete just this member/account/role/metric goal; return whether it existed.

    Unknown or unlinked accounts return False. Like get/set, username must come
    from the authenticated session. This cannot delete another member's goals.
    """
    with closing(connect()) as db:
        removed = db.execute(
            """DELETE FROM goals WHERE username = ? AND puuid = ? AND role = ? AND metric = ?
               AND EXISTS (SELECT 1 FROM users u JOIN accounts a ON a.username = u.username
                           WHERE u.username = ? AND a.puuid = ?)""",
            (username, puuid, role, metric, username, puuid))
        db.commit()
        return removed.rowcount > 0


# --- roles and activity --------------------------------------------------------

def role_of(username):
    with closing(connect()) as db:
        row = db.execute("SELECT role FROM users WHERE username = ?", (username,)).fetchone()
    return row[0] if row else None


def record(username, kind, detail=""):
    """Append to the activity log, dropping entries older than ACTIVITY_DAYS."""
    now = int(time.time())
    with closing(connect()) as db:
        db.execute("INSERT INTO activity (username, at, kind, detail) VALUES (?, ?, ?, ?)", (username, now, kind, detail))
        db.execute("DELETE FROM activity WHERE at < ?", (now - ACTIVITY_DAYS * 86400,))
        db.commit()


def seen(username):
    with closing(connect()) as db:
        db.execute("UPDATE users SET last_seen = ? WHERE username = ?", (int(time.time()), username))
        db.commit()


def activity_report(days=30, limit=300):
    """Every user with role, last visit and event counts over `days`, plus the newest events."""
    now = int(time.time())
    with closing(connect()) as db:
        counts = {}
        for user, kind, n in db.execute("SELECT username, kind, COUNT(*) FROM activity WHERE at >= ? GROUP BY 1, 2",
                                        (now - days * 86400,)):
            counts.setdefault(user, {})[kind] = n
        sessions = dict(db.execute("SELECT username, COUNT(*) FROM sessions WHERE expires > ? GROUP BY 1", (now,)))
        accounts = {u: f"{g}#{t}" for u, g, t in db.execute("SELECT username, game_name, tag_line FROM accounts")}
        users = [{"username": u, "role": role, "created": created, "last_seen": last_seen,
                  "sessions": sessions.get(u, 0), "account": accounts.get(u), "counts": counts.get(u, {})}
                 for u, role, created, last_seen in db.execute(
                     "SELECT username, role, created, last_seen FROM users ORDER BY last_seen IS NULL, last_seen DESC, username")]
        events = [dict(zip(("username", "at", "kind", "detail"), r)) for r in db.execute(
            "SELECT username, at, kind, detail FROM activity WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?",
            (now - days * 86400, limit))]
    return {"days": days, "users": users, "events": events}


# --- CLI ---------------------------------------------------------------------

def _ask_password():
    pw = getpass.getpass("Password: ")
    if not MIN_PASSWORD_LENGTH <= len(pw) <= MAX_PASSWORD_LENGTH:
        sys.exit(f"Password must be {MIN_PASSWORD_LENGTH}-{MAX_PASSWORD_LENGTH} characters.")
    if pw != getpass.getpass("Repeat: "):
        sys.exit("Passwords don't match.")
    return pw


def main(argv):
    cmd, name = (argv + [None, None])[:2]
    if (cmd == "add" and name is not None
            and (not name or name != name.strip() or len(name) > MAX_USERNAME_LENGTH)):
        sys.exit(f"Username must be 1-{MAX_USERNAME_LENGTH} characters without surrounding whitespace.")
    with closing(connect()) as db:
        exists = name and db.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone()
        if cmd == "list":
            for user, role, created in db.execute("SELECT username, role, created FROM users ORDER BY username"):
                print(f"{user}\t{role}\t(added {time.strftime('%Y-%m-%d', time.localtime(created))})")
        elif cmd == "add" and name:
            if exists:
                sys.exit(f"{name} already exists — use passwd to change the password.")
            db.execute("INSERT INTO users (username, password_hash, created) VALUES (?, ?, ?)",
                       (name, hash_password(_ask_password()), int(time.time())))
            db.commit()
            print(f"Added {name}.")
        elif cmd == "passwd" and name:
            if not exists:
                sys.exit(f"No user {name}.")
            db.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(_ask_password()), name))
            db.execute("DELETE FROM sessions WHERE username = ?", (name,))
            db.commit()
            print(f"Password changed for {name}; their existing sessions were logged out.")
        elif cmd == "role" and name:
            role = argv[2] if len(argv) > 2 else None
            if role not in ROLES:
                sys.exit(f"Usage: auth.py role <username> {'|'.join(ROLES)}")
            if not exists:
                sys.exit(f"No user {name}.")
            db.execute("UPDATE users SET role = ? WHERE username = ?", (role, name))
            db.commit()
            print(f"{name} is now {'an admin' if role == 'admin' else 'a member'}.")
        elif cmd == "remove" and name:
            if not exists:
                sys.exit(f"No user {name}.")
            # Training imports auth for the member DB path; keep this import local.
            import training
            db.execute("BEGIN IMMEDIATE")
            training.erase_member(db, name)
            db.execute("DELETE FROM users WHERE username = ?", (name,))
            db.execute("DELETE FROM sessions WHERE username = ?", (name,))
            db.execute("DELETE FROM accounts WHERE username = ?", (name,))
            db.execute("DELETE FROM goals WHERE username = ?", (name,))
            db.commit()
            print(f"Removed {name}.")
        else:
            sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
