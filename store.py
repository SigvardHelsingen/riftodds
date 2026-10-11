"""SQLite cache. Matches are immutable, so once fetched they are kept forever.

Raw match JSON is stored (compressed) so new stats can be derived later without
re-fetching; the flattened `participants` / `teams` tables are what queries use.
"""
import json
import sqlite3
import time
import zlib
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
CREATE TABLE IF NOT EXISTS mastery (
    puuid TEXT, champion_id INTEGER, level INTEGER, points INTEGER, last_play INTEGER,
    PRIMARY KEY (puuid, champion_id)
);
"""
FRAME_MINUTES = (10, 15)
# columns added after the first release; connect() adds them to older databases
MIGRATIONS = [("players", "profile_icon", "INTEGER"), ("players", "level", "INTEGER"),
              ("players", "profile_updated", "INTEGER")]  # when summoner + mastery were last fetched


def connect():
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")  # stats reads don't block (or wait on) history writes
    db.executescript(SCHEMA)
    for table, col, kind in MIGRATIONS:
        if col not in {r[1] for r in db.execute(f"PRAGMA table_info({table})")}:
            db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {kind}")
    return db


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


def save_match(db, platform, m):
    info = m["info"]
    mid = m["metadata"]["matchId"]
    remake = int(info["gameDuration"] < 300 or any(
        p.get("gameEndedInEarlySurrender") for p in info["participants"]))
    db.execute(
        "INSERT OR REPLACE INTO matches VALUES (?,?,?,?,?,?,?,?)",
        (mid, platform, info["queueId"], info["gameStartTimestamp"], info["gameDuration"],
         ".".join(info["gameVersion"].split(".")[:2]), remake,
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
    for t in info["teams"]:
        o = t["objectives"]
        db.execute(
            "INSERT OR REPLACE INTO teams VALUES (?,?,?,?,?,?,?)",
            (mid, t["teamId"], int(t["win"]),
             int(o["champion"]["first"]), int(o["tower"]["first"]),
             int(o["dragon"]["first"]), int(o.get("riftHerald", {}).get("first", False))),
        )
    _save_bans(db, mid, info)


def _save_bans(db, mid, info):
    for t in info["teams"]:
        for b in t.get("bans", []):
            if b["championId"] > 0:
                db.execute("INSERT OR IGNORE INTO bans VALUES (?,?,?,?)",
                           (mid, t["teamId"], b["pickTurn"], b["championId"]))


def backfill_bans(db):
    """Derive bans for matches cached before the bans table existed."""
    rows = db.execute(
        "SELECT match_id, raw FROM matches WHERE match_id NOT IN (SELECT DISTINCT match_id FROM bans)")
    for mid, raw in rows.fetchall():
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
    if summoner:
        db.execute("UPDATE players SET profile_icon=?, level=?, profile_updated=? WHERE puuid=?",
                   (summoner.get("profileIconId"), summoner.get("summonerLevel"), now, puuid))


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
