"""SQLite cache. Matches are immutable, so once fetched they are kept forever.

Raw match JSON is stored (compressed) so new stats can be derived later without
re-fetching; the flattened `participants` / `teams` tables are what queries use.
"""
import json
import sqlite3
import time
import zlib
from contextlib import contextmanager
from pathlib import Path

import perf
import timeline

DB_PATH = Path(__file__).with_name("cache.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
    match_id   TEXT PRIMARY KEY,
    platform   TEXT,
    queue_id   INTEGER,
    game_start INTEGER,  -- unix ms
    duration   INTEGER,  -- seconds
    patch      TEXT,
    remake     INTEGER,
    raw        BLOB
);
CREATE TABLE IF NOT EXISTS participants (
    match_id    TEXT,
    puuid       TEXT,
    team_id     INTEGER,
    champion_id INTEGER,
    position    TEXT,
    win         INTEGER,
    kills INTEGER, deaths INTEGER, assists INTEGER,
    cs INTEGER, gold INTEGER, damage INTEGER, vision INTEGER,
    lane_adv    INTEGER,  -- challenges.laningPhaseGoldExpAdvantage (1 = ahead), NULL if missing
    PRIMARY KEY (match_id, puuid)
);
CREATE INDEX IF NOT EXISTS ix_part_puuid ON participants(puuid);
CREATE INDEX IF NOT EXISTS ix_part_champ ON participants(champion_id);
CREATE TABLE IF NOT EXISTS teams (
    match_id TEXT, team_id INTEGER, win INTEGER,
    first_blood INTEGER, first_tower INTEGER, first_dragon INTEGER, first_herald INTEGER,
    PRIMARY KEY (match_id, team_id)
);
CREATE TABLE IF NOT EXISTS bans (
    match_id TEXT, team_id INTEGER, pick_turn INTEGER, champion_id INTEGER,
    PRIMARY KEY (match_id, team_id, pick_turn)
);
CREATE INDEX IF NOT EXISTS ix_match_patch ON matches(patch, queue_id);
-- which rank population a match belongs to (a match can be tagged by several samples)
CREATE TABLE IF NOT EXISTS match_tier (
    match_id TEXT, tier TEXT, PRIMARY KEY (match_id, tier)
);
CREATE INDEX IF NOT EXISTS ix_match_tier_tier ON match_tier(tier);
CREATE TABLE IF NOT EXISTS players (
    puuid TEXT PRIMARY KEY, game_name TEXT, tag_line TEXT, platform TEXT,
    tier TEXT, division TEXT, lp INTEGER, wins INTEGER, losses INTEGER, updated INTEGER
);
-- timeline snapshots: each participant's gold/xp/cs at a few fixed minutes
CREATE TABLE IF NOT EXISTS frames (
    match_id TEXT, puuid TEXT, minute INTEGER, gold INTEGER, xp INTEGER, cs INTEGER,
    PRIMARY KEY (match_id, puuid, minute)
);
CREATE INDEX IF NOT EXISTS ix_frames_minute ON frames(minute, match_id);
-- which matches have had their timeline fetched (short games have no frames)
CREATE TABLE IF NOT EXISTS timelines (match_id TEXT PRIMARY KEY);
-- each player's final items, runes and summoner spells, flattened from the raw match for builds
CREATE TABLE IF NOT EXISTS builds (
    match_id TEXT, puuid TEXT,
    items TEXT,  -- final inventory item0-item5 (no trinket), comma-separated, empty slots left out
    keystone INTEGER, primary_style INTEGER, sub_style INTEGER,
    spells TEXT,  -- both summoner spell ids, sorted, comma-separated
    PRIMARY KEY (match_id, puuid)
);
-- solo-queue rank over time (Riot has no LP history): a row whenever a check finds it changed
CREATE TABLE IF NOT EXISTS rank_history (
    puuid TEXT, at INTEGER, tier TEXT, division TEXT, lp INTEGER, wins INTEGER, losses INTEGER,
    PRIMARY KEY (puuid, at)
);
CREATE TABLE IF NOT EXISTS mastery (
    puuid TEXT, champion_id INTEGER, level INTEGER, points INTEGER, last_play INTEGER,
    PRIMARY KEY (puuid, champion_id)
);
-- a timeline boiled down to a few KB (timeline.extract), zlib-compressed JSON; NULL when Riot has none
CREATE TABLE IF NOT EXISTS timeline_digest (match_id TEXT PRIMARY KEY, data BLOB);
-- purchase and skill order per player, from timelines: "itemId:second,..." and one digit per ability point
CREATE TABLE IF NOT EXISTS purchases (
    match_id TEXT, puuid TEXT, items TEXT, skills TEXT, PRIMARY KEY (match_id, puuid)
);
-- per-player coaching numbers from the raw match (perf.METRICS)
CREATE TABLE IF NOT EXISTS perf (
    match_id TEXT, puuid TEXT, """ + ", ".join(f"{c} REAL" for c in perf.COLUMNS) + """,
    PRIMARY KEY (match_id, puuid)
);
-- trained win-probability models and their scorecards (model.py)
CREATE TABLE IF NOT EXISTS models (name TEXT PRIMARY KEY, trained_at INTEGER, params TEXT, report TEXT);
"""
VERSION = 2  # non-destructive migration; digest version is independently timeline.DIGEST_VERSION
FRAME_MINUTES = (10, 15)
# columns added after the first release; connect() adds them to older databases
MIGRATIONS = [("players", "profile_icon", "INTEGER"), ("players", "level", "INTEGER"),
              ("players", "profile_updated", "INTEGER"),  # when summoner + mastery were last fetched
              ("players", "rank_checked", "INTEGER")]     # when the solo rank was last checked


def init(db):
    """Create the tables and add columns from later releases (older databases are upgraded in place)."""
    db.executescript(SCHEMA)
    for table, col, kind in MIGRATIONS:
        if col not in {r[1] for r in db.execute(f"PRAGMA table_info({table})")}:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {kind}")
    if db.execute("PRAGMA user_version").fetchone()[0] < VERSION:
        # Keep fetched markers AND old SQL gold frames. Missing/v1 digests cannot
        # recover actual timestamps, but are not permission for a bulk re-download.
        # digest() reports them unavailable; explicit bounded refreshes may replace
        # them later. has_timeline() continues to mean 'already fetched', not v2-ready.
        db.execute(f"PRAGMA user_version = {VERSION}")
        db.commit()


def connect():
    db = sqlite3.connect(DB_PATH, timeout=30)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")  # stats reads don't block (or wait on) history writes
        db.execute("PRAGMA cache_size=-2048")  # target 2 MiB of pages per connection, not the whole DB
        db.execute("PRAGMA temp_store=FILE")   # large sorts/groupings can spill to disk on a 1 GiB server
        db.execute("PRAGMA mmap_size=0")
        init(db)
    except BaseException:
        db.close()
        raise
    return db


@contextmanager
def read_snapshot(db):
    """Use one read snapshot, leaving any caller-owned transaction untouched."""
    owned = not db.in_transaction
    if owned:
        db.execute("BEGIN")  # sqlite3 does not implicitly BEGIN for SELECTs
    try:
        yield db
    finally:
        if owned:
            db.rollback()


def archive(reason):
    """Move the cache aside (cache.db -> cache.db.<timestamp>.old) so the next connect() starts fresh."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for suffix in ("", "-wal", "-shm"):
        src = DB_PATH.with_name(DB_PATH.name + suffix)
        if src.exists():
            src.rename(DB_PATH.with_name(f"{DB_PATH.name}.{stamp}.old{suffix}"))
    return f"{DB_PATH.name}.{stamp}.old ({reason})"


def oldest_participant(db):
    """(platform, puuid) of someone in the oldest cached match — used to detect an API key change."""
    return db.execute(
        """SELECT m.platform, p.puuid FROM matches m JOIN participants p ON p.match_id = m.match_id
           ORDER BY m.game_start LIMIT 1""").fetchone()


def match_raw(db, match_id):
    """The full match JSON as Riot returned it (kept compressed in the cache)."""
    row = db.execute("SELECT raw FROM matches WHERE match_id=?", (match_id,)).fetchone()
    return json.loads(zlib.decompress(row[0])) if row else None


def has_match(db, match_id):
    return db.execute("SELECT 1 FROM matches WHERE match_id=?", (match_id,)).fetchone() is not None


def is_remake(info):
    # The Rift heuristic must not hide short Arena eliminations or ARAM/Mayhem games.
    if info.get("queueId") in (1700, 1710, 450, 2400):
        return False
    return info["gameDuration"] < 300 or any(p.get("gameEndedInEarlySurrender") for p in info["participants"])


def save_match(db, platform, m):
    info = m["info"]
    mid = m["metadata"]["matchId"]
    db.execute(
        "INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?,?)",
        (mid, platform, info["queueId"], info["gameStartTimestamp"], info["gameDuration"],
         ".".join(info["gameVersion"].split(".")[:2]), int(is_remake(info)),
         zlib.compress(json.dumps(m).encode())),
    )
    for p in info["participants"]:
        adv = (p.get("challenges") or {}).get("laningPhaseGoldExpAdvantage")
        db.execute(
            "INSERT OR REPLACE INTO participants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (mid, p["puuid"], p["teamId"], p["championId"], p.get("teamPosition") or "",
             int(p["win"]), p["kills"], p["deaths"], p["assists"],
             p["totalMinionsKilled"] + p["neutralMinionsKilled"], p["goldEarned"],
             p["totalDamageDealtToChampions"], p["visionScore"],
             None if adv is None else int(adv)),
        )
    for t in info.get("teams", []):
        o = t.get("objectives") or {}  # modes without Summoner's Rift objectives (e.g. Arena) may omit them
        first = lambda key: int(bool((o.get(key) or {}).get("first")))
        db.execute(
            "INSERT OR REPLACE INTO teams VALUES (?,?,?,?,?,?,?)",
            (mid, t["teamId"], int(bool(t.get("win"))),
             first("champion"), first("tower"), first("dragon"), first("riftHerald")),
        )
    _save_bans(db, mid, info)
    _save_builds(db, mid, info)
    _save_perf(db, mid, info)


def _save_perf(db, mid, info):
    duration = timeline.number(info.get("gameDuration"))
    minutes = duration / 60 if duration is not None else None
    cols = ", ".join(perf.COLUMNS)
    marks = ", ".join("?" for _ in perf.COLUMNS)
    for p in info["participants"]:
        values = perf.values(p, minutes, info["participants"])
        db.execute(f"INSERT OR REPLACE INTO perf (match_id, puuid, {cols}) VALUES (?, ?, {marks})",
                   (mid, p["puuid"], *(values[c] for c in perf.COLUMNS)))


def backfill_perf(db, after="", limit=50):
    """Coaching numbers for matches cached before the perf table existed, a batch at a time.

    Returns the last match_id handled (pass it back as `after`), or None when nothing is left."""
    ids = [r[0] for r in db.execute(
        """SELECT match_id FROM matches WHERE match_id > ? AND queue_id = 420
           AND match_id NOT IN (SELECT DISTINCT match_id FROM perf) ORDER BY match_id LIMIT ?""",
        (after, limit))]
    for mid in ids:
        raw = match_raw(db, mid)  # one decoded match at a time
        if raw is not None:
            _save_perf(db, mid, raw["info"])
    db.commit()
    return ids[-1] if ids else None


def _save_builds(db, mid, info):
    for p in info["participants"]:
        styles = (p.get("perks") or {}).get("styles") or []
        primary = styles[0] if styles else {}
        keystone = ((primary.get("selections") or [{}])[0]).get("perk")
        spells = sorted(s for s in (p.get("summoner1Id"), p.get("summoner2Id")) if s)
        db.execute("INSERT OR REPLACE INTO builds VALUES (?,?,?,?,?,?,?)",
                   (mid, p["puuid"], ",".join(str(p[f"item{i}"]) for i in range(6) if p.get(f"item{i}")),
                    keystone, primary.get("style"), styles[1].get("style") if len(styles) > 1 else None,
                    ",".join(map(str, spells))))


def backfill_builds(db, after="", limit=50):
    """Flatten builds out of matches cached before the builds table existed, a batch at a time.

    Returns the last match_id handled (pass it back as `after`), or None when nothing is left."""
    ids = [r[0] for r in db.execute(
        """SELECT match_id FROM matches WHERE match_id > ?
           AND match_id NOT IN (SELECT DISTINCT match_id FROM builds) ORDER BY match_id LIMIT ?""",
        (after, limit))]
    for mid in ids:
        raw = match_raw(db, mid)  # decode one match at a time, never a batch of compressed JSON
        _save_builds(db, mid, raw["info"])
    db.commit()
    return ids[-1] if ids else None


def _save_bans(db, mid, info):
    for t in info.get("teams", []):
        for b in t.get("bans", []):
            if b["championId"] > 0:
                db.execute("INSERT OR IGNORE INTO bans VALUES (?,?,?,?)",
                           (mid, t["teamId"], b["pickTurn"], b["championId"]))


def backfill_bans(db):
    """Derive bans for matches cached before the bans table existed."""
    rows = db.execute(
        "SELECT match_id, raw FROM matches WHERE match_id NOT IN (SELECT DISTINCT match_id FROM bans)")
    for mid, raw in rows:
        _save_bans(db, mid, json.loads(zlib.decompress(raw))["info"])
    db.commit()


def tag_tier(db, match_id, tier):
    db.execute("INSERT OR IGNORE INTO match_tier VALUES (?,?)", (match_id, tier))


def save_player(db, puuid, name, tag, platform, solo, summoner=None):
    """Upsert rank info; summoner fields (icon, level) only when given, else keep the cached ones."""
    now = int(time.time())
    db.execute(
        """INSERT INTO players (puuid, game_name, tag_line, platform, tier, division, lp, wins, losses, updated)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(puuid) DO UPDATE SET game_name=excluded.game_name, tag_line=excluded.tag_line,
             platform=excluded.platform, tier=excluded.tier, division=excluded.division, lp=excluded.lp,
             wins=excluded.wins, losses=excluded.losses, updated=excluded.updated""",
        (puuid, name, tag, platform, solo.get("tier", "UNRANKED"), solo.get("rank", ""),
         solo.get("leaguePoints", 0), solo.get("wins", 0), solo.get("losses", 0), now))
    db.execute("UPDATE players SET rank_checked=? WHERE puuid=?", (now, puuid))
    save_rank(db, puuid, solo, now)
    if summoner:
        db.execute("UPDATE players SET profile_icon=?, level=?, profile_updated=? WHERE puuid=?",
                   (summoner.get("profileIconId"), summoner.get("summonerLevel"), now, puuid))


def save_rank(db, puuid, solo, at=None):
    """Record a solo-queue league entry if it differs from the last one recorded (unranked isn't).
    Two records in the same second keep the later one."""
    if not solo.get("tier"):
        return False
    rank = (solo["tier"], solo.get("rank", ""), solo.get("leaguePoints", 0), solo.get("wins", 0), solo.get("losses", 0))
    last = db.execute("SELECT tier, division, lp, wins, losses FROM rank_history WHERE puuid = ? ORDER BY at DESC LIMIT 1",
                      (puuid,)).fetchone()
    if last and tuple(last) == rank:
        return False
    db.execute("INSERT OR REPLACE INTO rank_history VALUES (?,?,?,?,?,?,?)", (puuid, int(at or time.time()), *rank))
    return True


def update_rank(db, puuid, solo):
    """A background rank check: refresh the cached player's rank and record it if it changed."""
    now = int(time.time())
    db.execute("UPDATE players SET tier=?, division=?, lp=?, wins=?, losses=?, rank_checked=? WHERE puuid=?",
               (solo.get("tier", "UNRANKED"), solo.get("rank", ""), solo.get("leaguePoints", 0),
                solo.get("wins", 0), solo.get("losses", 0), now, puuid))
    save_rank(db, puuid, solo, now)


def rank_history(db, puuid, since=0):
    """The player's recorded ranks since `since` (epoch seconds), oldest first."""
    return [dict(zip(("at", "tier", "division", "lp", "wins", "losses"), r)) for r in db.execute(
        "SELECT at, tier, division, lp, wins, losses FROM rank_history WHERE puuid = ? AND at >= ? ORDER BY at",
        (puuid, since))]


def tracked_players(db, linked, since):
    """[(puuid, platform)] whose rank is followed: linked accounts, and players looked up since `since`."""
    marks = ",".join("?" * len(linked))
    return db.execute(f"SELECT puuid, platform FROM players WHERE updated >= ?{f' OR puuid IN ({marks})' if linked else ''}",
                      (int(since), *linked)).fetchall()


def find_player(db, platform, name, tag):
    """A cached player by Riot ID (case-insensitive, like Riot's own lookup)."""
    return db.execute("""SELECT * FROM players WHERE platform = ? AND lower(game_name) = lower(?)
                         AND lower(tag_line) = lower(?) ORDER BY updated DESC LIMIT 1""",
                      (platform, name, tag)).fetchone()


def has_timeline(db, match_id):
    """Fetched marker, including missing/legacy/unsupported digests; NOT digest availability."""
    return db.execute("SELECT 1 FROM timelines WHERE match_id=?", (match_id,)).fetchone() is not None


def save_timeline(db, match_id, tl):
    """Atomically replace derived timeline data, leaving the caller's transaction open.

    Gold10/15 retain their SQL/API names: use the nearest actual timestamp within
    timeline.FRAME_TOLERANCE (15 seconds), never an array index. An incomplete
    participant snapshot yields absent SQL rows, not zeros. Only standard Rift
    metadata permits map/model/lead data; None is the sole missing-timeline value.
    """
    dg, orders = None, {}
    if tl is not None:
        if not isinstance(tl, dict):
            raise ValueError("Timeline must be an object or None")
        mid = (tl.get("metadata") or {}).get("matchId")
        if mid is not None and mid != match_id:
            raise ValueError("Timeline matchId disagrees with requested match")
        raw = match_raw(db, match_id)
        dg, orders = timeline.extract(tl, raw["info"] if raw else None)
    data = zlib.compress(json.dumps(dg, separators=(",", ":"), allow_nan=False).encode()) if dg else None
    # BEGIN ensures releasing our savepoint never commits an outermost savepoint.
    owned = not db.in_transaction
    if owned:
        db.execute("BEGIN")
    db.execute("SAVEPOINT timeline_write")
    try:
        db.execute("INSERT OR IGNORE INTO timelines VALUES (?)", (match_id,))
        db.execute("INSERT OR REPLACE INTO timeline_digest VALUES (?, ?)", (match_id, data))
        db.execute("DELETE FROM purchases WHERE match_id = ?", (match_id,))
        db.execute("DELETE FROM frames WHERE match_id = ?", (match_id,))
        if dg is not None and timeline.supported(dg):
            db.executemany("INSERT INTO purchases VALUES (?, ?, ?, ?)",
                           ((match_id, puuid, items, skills) for puuid, (items, skills) in orders.items()))
            for minute in FRAME_MINUTES:
                index = timeline.nearest_frame(dg, minute * 60)
                if index is None:
                    continue
                for puuid, gold, xp, cs in zip(dg["puuids"], dg["gold"][index], dg["xp"][index], dg["cs"][index]):
                    if all(timeline.number(v) is not None for v in (gold, xp, cs)):
                        db.execute("INSERT INTO frames VALUES (?,?,?,?,?,?)", (match_id, puuid, minute, gold, xp, cs))
        db.execute("RELEASE SAVEPOINT timeline_write")
    except BaseException:
        db.execute("ROLLBACK TO SAVEPOINT timeline_write")
        db.execute("RELEASE SAVEPOINT timeline_write")
        if owned:
            db.rollback()
        raise


def _stored_digest(db, match_id):
    row = db.execute("SELECT data FROM timeline_digest WHERE match_id = ?", (match_id,)).fetchone()
    if not row or not row[0]:
        return None
    try:
        if len(row[0]) > timeline.MAX_DIGEST_BYTES:
            return None
        decoder = zlib.decompressobj()
        data = decoder.decompress(row[0], timeline.MAX_DIGEST_BYTES + 1)
        if len(data) > timeline.MAX_DIGEST_BYTES or not decoder.eof or decoder.unused_data:
            return None
        return json.loads(data)
    except (ValueError, TypeError, zlib.error):
        return None


def digest_status(db, match_id):
    """available/missing/legacy/unsupported/not_rift/invalid/not_fetched.

    Availability is independent of has_timeline(), so schema upgrades do not
    invalidate fetch markers. v1 data/old gold rows remain untouched on disk;
    unavailable digests require an explicit, bounded refresh, not an automatic
    full-cache re-download. No attempt is made to invent missing timestamps.
    """
    row = db.execute("SELECT data FROM timeline_digest WHERE match_id = ?", (match_id,)).fetchone()
    if row is None:
        return "legacy" if has_timeline(db, match_id) else "not_fetched"
    if row[0] is None:
        return "missing"
    dg = _stored_digest(db, match_id)
    if not isinstance(dg, dict):
        return "invalid"
    if dg.get("v") == 1:
        return "legacy"
    if dg.get("v") != timeline.DIGEST_VERSION:
        return "unsupported"
    if dg.get("map_id") != 11:
        return "not_rift"
    return "available" if timeline.supported(dg) else "invalid"


def digest(db, match_id):
    """Current standard-Rift digest, or None (missing, legacy, unknown version/map).

    Fetched markers are deliberately independent; see digest_status(). Consumers
    that read timeline_digest.data directly must also check version/map before
    interpreting arrays or training (timeline.states does this automatically).
    """
    dg = _stored_digest(db, match_id)
    return dg if timeline.supported(dg) else None


def save_mastery(db, puuid, entries):
    db.execute("DELETE FROM mastery WHERE puuid=?", (puuid,))
    db.executemany("INSERT INTO mastery VALUES (?,?,?,?,?)",
                   [(puuid, m["championId"], m["championLevel"], m["championPoints"], m["lastPlayTime"])
                    for m in entries])


def get_player(db, puuid):
    return db.execute("SELECT * FROM players WHERE puuid=?", (puuid,)).fetchone()
