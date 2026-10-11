"""Invite-only login. Users live in users.db on the server and are managed from the CLI:

    uv run python auth.py add <username>       # prompts for a password
    uv run python auth.py passwd <username>
    uv run python auth.py remove <username>    # also logs them out everywhere
    uv run python auth.py list

Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly
cookie, and only a SHA-256 of each token is stored.
"""
import getpass
import hashlib
import hmac
import secrets
import sqlite3
import sys
import time
from pathlib import Path

DB_PATH = Path(__file__).with_name("users.db")
SESSION_DAYS = 30
COOKIE = "riftodds_session"

# brute-force guard: after MAX_FAILURES failed logins for a username, lock it for LOCKOUT seconds
MAX_FAILURES = 10
LOCKOUT = 15 * 60
_failures = {}  # username -> (count, first_failure_time)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER
);
"""


def connect():
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
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


def login(username, password):
    """Return a new session token, or None if the credentials are wrong / locked out."""
    count, since = _failures.get(username, (0, 0))
    if count >= MAX_FAILURES and time.time() - since < LOCKOUT:
        return None
    db = connect()
    row = db.execute("SELECT password_hash FROM users WHERE username = ?", (username,)).fetchone()
    ok = check_password(password, row[0] if row else _DUMMY_HASH) and row is not None
    if not ok:
        if time.time() - since >= LOCKOUT:
            count, since = 0, time.time()
        _failures[username] = (count + 1, since)
        return None
    _failures.pop(username, None)
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions VALUES (?, ?, ?)",
               (_token_hash(token), username, int(time.time()) + SESSION_DAYS * 86400))
    db.execute("DELETE FROM sessions WHERE expires < ?", (int(time.time()),))
    db.commit()
    return token


def user_for(token):
    if not token:
        return None
    row = connect().execute("SELECT username FROM sessions WHERE token_hash = ? AND expires > ?",
                            (_token_hash(token), int(time.time()))).fetchone()
    return row[0] if row else None


def logout(token):
    if token:
        db = connect()
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
        db.commit()


# --- CLI ---------------------------------------------------------------------

def _ask_password():
    pw = getpass.getpass("Password: ")
    if len(pw) < 8:
        sys.exit("Password must be at least 8 characters.")
    if pw != getpass.getpass("Repeat: "):
        sys.exit("Passwords don't match.")
    return pw


def main(argv):
    cmd, name = (argv + [None, None])[:2]
    db = connect()
    exists = name and db.execute("SELECT 1 FROM users WHERE username = ?", (name,)).fetchone()
    if cmd == "list":
        for user, created in db.execute("SELECT username, created FROM users ORDER BY username"):
            print(f"{user}\t(added {time.strftime('%Y-%m-%d', time.localtime(created))})")
    elif cmd == "add" and name:
        if exists:
            sys.exit(f"{name} already exists — use passwd to change the password.")
        db.execute("INSERT INTO users VALUES (?, ?, ?)", (name, hash_password(_ask_password()), int(time.time())))
        db.commit()
        print(f"Added {name}.")
    elif cmd == "passwd" and name:
        if not exists:
            sys.exit(f"No user {name}.")
        db.execute("UPDATE users SET password_hash = ? WHERE username = ?", (hash_password(_ask_password()), name))
        db.execute("DELETE FROM sessions WHERE username = ?", (name,))
        db.commit()
        print(f"Password changed for {name}; their existing sessions were logged out.")
    elif cmd == "remove" and name:
        if not exists:
            sys.exit(f"No user {name}.")
        db.execute("DELETE FROM users WHERE username = ?", (name,))
        db.execute("DELETE FROM sessions WHERE username = ?", (name,))
        db.commit()
        print(f"Removed {name}.")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
