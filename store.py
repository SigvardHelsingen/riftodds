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
"""
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
    return db.execute("SELECT 1 FROM timelines WHERE match_id=?", (match_id,)).fetchone() is not None


def save_timeline(db, match_id, tl):
    """Keep only gold/xp/cs per participant at FRAME_MINUTES; timelines are ~1 MB raw."""
    db.execute("INSERT OR IGNORE INTO timelines VALUES (?)", (match_id,))
    if not tl:
        return
    info = tl["info"]
    by_id = {p["participantId"]: p["puuid"] for p in info.get("participants", [])} or \
        {i + 1: puuid for i, puuid in enumerate(tl["metadata"]["participants"])}
    frames = info["frames"]
    for minute in FRAME_MINUTES:
        if minute >= len(frames):
            continue
        for pid, f in frames[minute]["participantFrames"].items():
            puuid = by_id.get(int(pid))
            if puuid:
                db.execute("INSERT OR REPLACE INTO frames VALUES (?,?,?,?,?,?)",
                           (match_id, puuid, minute, f["totalGold"], f["xp"],
                            f["minionsKilled"] + f["jungleMinionsKilled"]))


def save_mastery(db, puuid, entries):
    db.execute("DELETE FROM mastery WHERE puuid=?", (puuid,))
    db.executemany("INSERT INTO mastery VALUES (?,?,?,?,?)",
                   [(puuid, m["championId"], m["championLevel"], m["championPoints"], m["lastPlayTime"])
                    for m in entries])


def get_player(db, puuid):
    return db.execute("SELECT * FROM players WHERE puuid=?", (puuid,)).fetchone()
