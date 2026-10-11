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
CREATE TABLE IF NOT EXISTS players (
    puuid TEXT PRIMARY KEY, game_name TEXT, tag_line TEXT, platform TEXT,
    tier TEXT, division TEXT, lp INTEGER, wins INTEGER, losses INTEGER, updated INTEGER
);
"""


def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


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


def save_player(db, puuid, name, tag, platform, solo):
    db.execute(
        "INSERT OR REPLACE INTO players VALUES (?,?,?,?,?,?,?,?,?,?)",
        (puuid, name, tag, platform,
         solo.get("tier", "UNRANKED"), solo.get("rank", ""), solo.get("leaguePoints", 0),
         solo.get("wins", 0), solo.get("losses", 0), int(time.time())),
    )


def get_player(db, puuid):
    return db.execute("SELECT * FROM players WHERE puuid=?", (puuid,)).fetchone()
