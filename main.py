"""FastAPI app: syncs a player's ranked games into the cache and serves stats.

A background sampler keeps pulling recent solo-queue games from random players
across all tiers, so the landing page can show stats for the current patch.

Run:  uv run fastapi dev main.py
"""
import asyncio
import logging
import os
import random
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import stats
import store
from riot import PLATFORMS, Riot, RiotError, load_champions

SOLO_QUEUE = 420
TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND",
         "MASTER", "GRANDMASTER", "CHALLENGER"]
STATIC = Path(__file__).with_name("static")

SAMPLER = {
    "enabled": os.environ.get("SAMPLER", "1") != "0",
    "platform": os.environ.get("SAMPLER_PLATFORM", "euw1"),
    "target": int(os.environ.get("SAMPLER_TARGET", "2000")),  # matches per patch, then idle
    "share": 0.6,  # fraction of the rate limit the sampler may use
}

log = logging.getLogger("sampler")
state = {"sampler": {"status": "off"}}


@asynccontextmanager
async def lifespan(app):
    state["riot"] = Riot()
    state["ddragon"], state["champions"] = await load_champions()
    store.backfill_bans(store.connect())
    task = asyncio.create_task(sampler()) if SAMPLER["enabled"] else None
    yield
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    await state["riot"].http.aclose()


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def riot_errors(e: RiotError):
    bad_key = "Riot API key rejected (dev keys expire every 24h — refresh RIOT_API_KEY in .env and restart)."
    msg = {401: bad_key, 403: bad_key,
           404: "Not found on Riot's side — check the Riot ID and region."}.get(e.status, str(e))
    return HTTPException(e.status if e.status in (401, 403, 404) else 502, msg)


async def fetch_matches(riot, platform, ids, tier):
    """Fetch any uncached match ids, then tag all of them with the rank population."""
    db = store.connect()
    missing = [m for m in ids if not store.has_match(db, m)]
    results = await asyncio.gather(*(riot.match(platform, m) for m in missing), return_exceptions=True)
    for m in results:
        if isinstance(m, dict):
            store.save_match(db, platform, m)
    for m in ids:
        if store.has_match(db, m):
            store.tag_tier(db, m, tier)
    db.commit()
    return len(missing)


def patch_matches(db, patch):
    return db.execute("SELECT COUNT(*) FROM matches WHERE patch = ? AND queue_id = ? AND remake = 0",
                      (patch, SOLO_QUEUE)).fetchone()[0]


def patch_start(db, patch):
    """Epoch seconds of the earliest cached game on `patch` (or two weeks ago if none).

    Ladders are full of inactive accounts; asking only for games since the patch
    started means those cost one request instead of a batch of stale matches.
    """
    two_weeks_ago = time.time() - 14 * 86400
    if not patch:
        return two_weeks_ago
    first = db.execute("SELECT MIN(game_start) FROM matches WHERE patch = ? AND queue_id = ?",
                       (patch, SOLO_QUEUE)).fetchone()[0]
    return max(first / 1000, two_weeks_ago) if first else two_weeks_ago


async def sampler():
    """Round-robin over tiers: a couple of random players per tier, their recent games."""
    s = state["sampler"]
    riot = state["riot"].background(SAMPLER["share"])
    platform = SAMPLER["platform"]
    i = 0
    while True:
        try:
            db = store.connect()
            patch = stats.latest_patch(db)
            s.update(platform=platform, target=SAMPLER["target"], patch=patch,
                     matches=patch_matches(db, patch) if patch else 0)
            if patch and s["matches"] >= SAMPLER["target"]:
                s["status"] = "idle"
                await asyncio.sleep(600)
                continue
            tier = TIERS[i % len(TIERS)]
            i += 1
            s.update(status="sampling", tier=tier)
            division = random.choice(["I", "II", "III", "IV"])
            pool = (await riot.tier_players(platform, tier, division, page=random.randint(1, 3))
                    or await riot.tier_players(platform, tier, division, page=1))
            since = patch_start(db, patch)
            for puuid in random.sample(pool, min(4, len(pool))):
                ids = await riot.match_ids(platform, puuid, SOLO_QUEUE, 6, start_time=since)
                await fetch_matches(riot, platform, ids, tier)
        except asyncio.CancelledError:
            raise
        except RiotError as e:
            s["status"] = "key rejected" if e.status in (401, 403) else "error"
            log.warning("sampler: %s", e)
            await asyncio.sleep(600 if e.status in (401, 403) else 60)
        except Exception:
            s["status"] = "error"
            log.exception("sampler crashed, retrying in 60s")
            await asyncio.sleep(60)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/meta")
def meta():
    return {"platforms": list(PLATFORMS), "tiers": TIERS, "roles": stats.ROLES,
            "ddragon": state["ddragon"], "champions": state["champions"]}


@app.get("/api/patch")
def patch(tier: str | None = None):
    db = store.connect()
    latest = stats.latest_patch(db)
    overview = stats.patch_overview(db, latest, tier) if latest else {"patch": None, "matches": 0, "tiers": []}
    return {**overview, "sampler": state["sampler"]}


@app.get("/api/player")
async def player(platform: str, riot_id: str, count: int = Query(40, ge=1, le=100), tz: int = 0):
    if platform not in PLATFORMS:
        raise HTTPException(400, "Unknown platform")
    if "#" not in riot_id:
        raise HTTPException(400, "Use the full Riot ID, e.g. Name#EUW")
    name, tag = riot_id.rsplit("#", 1)
    riot = state["riot"]
    try:
        account = await riot.account(platform, name.strip(), tag.strip())
        puuid = account["puuid"]
        entries = await riot.league_entries(platform, puuid)
        solo = next((e for e in entries if e["queueType"] == "RANKED_SOLO_5x5"), {})
        ids = await riot.match_ids(platform, puuid, SOLO_QUEUE, count)
    except RiotError as e:
        raise riot_errors(e)

    tier = solo.get("tier", "UNRANKED")
    fetched = await fetch_matches(riot, platform, ids, tier)

    db = store.connect()
    store.save_player(db, puuid, account["gameName"], account["tagLine"], platform, solo)
    db.commit()
    # analyse exactly the window the user asked for (the cache may hold older games too)
    window = set(ids)
    games = [g for g in stats.player_games(db, puuid, SOLO_QUEUE) if g["match_id"] in window]
    return {
        "puuid": puuid,
        "profile": {"name": account["gameName"], "tag": account["tagLine"], "platform": platform,
                    "tier": tier, "division": solo.get("rank", ""), "lp": solo.get("leaguePoints", 0),
                    "season_wins": solo.get("wins", 0), "season_losses": solo.get("losses", 0)},
        "games_analysed": len(games),
        "newly_fetched": fetched,
        "overview": stats.overview(games, tz) if games else None,
        "vs_rank": stats.champions_vs_rank(db, games, puuid, tier, SOLO_QUEUE),
        "match_ids": ids,
    }


@app.get("/api/pick")
def pick(puuid: str, role: str, opp: int | None = None, alpha: float = 5.0,
         match_ids: str | None = None):
    db = store.connect()
    games = stats.player_games(db, puuid, SOLO_QUEUE)
    if match_ids:
        window = set(match_ids.split(","))
        games = [g for g in games if g["match_id"] in window]
    return stats.pick_probabilities(games, role, opp, alpha)


@app.post("/api/sample")
async def sample(platform: str, tier: str, division: str = "", players: int = Query(4, ge=1, le=20),
                 per_player: int = Query(5, ge=1, le=20)):
    """Grow one tier's baseline now: recent solo games from random players in `tier`."""
    tier = tier.upper()
    if tier not in TIERS:
        raise HTTPException(400, "Unknown tier")
    division = division or random.choice(["I", "II", "III", "IV"])
    riot = state["riot"]
    try:
        pool = await riot.tier_players(platform, tier, division, page=random.randint(1, 3))
        if not pool:
            pool = await riot.tier_players(platform, tier, division, page=1)
        picked = random.sample(pool, min(players, len(pool)))
        id_lists = await asyncio.gather(*(riot.match_ids(platform, p, SOLO_QUEUE, per_player) for p in picked))
    except RiotError as e:
        raise riot_errors(e)
    ids = sorted({m for lst in id_lists for m in lst})
    fetched = await fetch_matches(riot, platform, ids, tier)
    return {"tier": tier, "division": division, "players": len(picked), "matches": len(ids),
            "newly_fetched": fetched}
