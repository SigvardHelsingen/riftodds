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

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import auth
import history
import stats
import store
from riot import PLATFORMS, Riot, RiotError, load_champions, load_spells, profile_icon

SOLO_QUEUE = 420
TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND",
         "MASTER", "GRANDMASTER", "CHALLENGER"]
STATIC = Path(__file__).with_name("static")

SAMPLER = {
    "enabled": os.environ.get("SAMPLER", "1") != "0",
    "platform": os.environ.get("SAMPLER_PLATFORM", "euw1"),
    "target": int(os.environ.get("SAMPLER_TARGET", "10000")),  # matches per patch, then idle
    "players": int(os.environ.get("SAMPLER_PLAYERS", "8")),     # players sampled in parallel per tier
    "share": 0.5,  # fraction of the rate limits the sampler may use
}
QUEUES = {420: "Ranked Solo", 440: "Ranked Flex", 400: "Normal Draft", 430: "Normal Blind", 450: "ARAM",
          490: "Quickplay", 1700: "Arena", 1900: "URF"}
LIVE_TTL = 60  # seconds before re-checking the spectator endpoint while polling (ranks/mastery: once per game)
LIVE_FORM_GAMES = 10  # recent games synced per live participant (matches only, no timelines)
PROFILE_TTL = 6 * 3600  # Riot ID -> PUUID, profile icon, level and mastery are reused this long
FIRST_RESPONSE_WAIT = 3  # seconds a lookup waits for its sync before answering with what's cached
SAMPLER_QUIET = 120      # the sampler stays off this long after any user activity (= Riot's long window)
DDRAGON_REFRESH = 1800   # re-check Riot's live version (patch, new champions) this often
MIN_PATCH_GAMES = 50     # games a new patch needs before the landing page switches its stats to it
HISTORY_SHARE = 0.85  # player history syncs; leaves headroom so new lookups never queue

log = logging.getLogger("sampler")
state = {"sampler": {"status": "off"}, "live": {}, "last_activity": 0.0}
ACTIVE_PATHS = ("/api/player", "/api/sync", "/api/live", "/api/pick")


@asynccontextmanager
async def lifespan(app):
    state["riot"] = Riot()
    state["ddragon"], state["champions"] = await load_champions()
    state["spells"] = await load_spells(state["ddragon"])
    await ensure_cache_matches_key(state["riot"])
    store.backfill_bans(store.connect())
    tasks = [asyncio.create_task(refresh_ddragon())]
    if SAMPLER["enabled"]:
        tasks.append(asyncio.create_task(sampler()))
    yield
    for task in tasks:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    await state["riot"].http.aclose()


async def refresh_ddragon():
    """The server runs for weeks: pick up a new patch (and new champions) without a restart."""
    while True:
        await asyncio.sleep(DDRAGON_REFRESH)
        try:
            state["ddragon"], state["champions"] = await load_champions()
            state["spells"] = await load_spells(state["ddragon"])
        except Exception:
            log.warning("could not refresh Data Dragon; keeping %s", state["ddragon"])


def current_patch(db):
    """The live patch: Riot's client version, or newer if games from a newer patch are already cached."""
    live = ".".join(state["ddragon"].split(".")[:2])
    cached = stats.latest_patch(db)
    return max(filter(None, (live, cached)), key=stats._patch_key)


async def ensure_cache_matches_key(riot):
    """PUUIDs are encrypted per API key, so a cache built with another key can't be joined
    to anything this key returns. Riot answers 400 when asked to decrypt a foreign PUUID:
    if that happens, archive the cache and re-resolve users' linked accounts by Riot ID."""
    db = store.connect()
    sample = store.oldest_participant(db)
    db.close()
    if not sample:
        return
    try:
        await riot.account_by_puuid(*sample)
        return
    except RiotError as e:
        if e.status != 400:
            log.warning("could not verify cache against API key: %s", e)
            return
    log.warning("API key changed — archived the old cache as %s", store.archive("PUUIDs from a different API key"))
    for link in auth.all_accounts():
        try:
            acc = await riot.account(link["platform"], link["game_name"], link["tag_line"])
            auth.set_account(link["username"], link["platform"], acc["gameName"], acc["tagLine"], acc["puuid"])
        except RiotError:
            auth.clear_account(link["username"])


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")

PUBLIC_API = {"/api/login", "/api/logout"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Every /api route except login/logout needs a valid session. The page shell is public."""
    if request.url.path.startswith("/api/") and request.url.path not in PUBLIC_API:
        user = auth.user_for(request.cookies.get(auth.COOKIE))
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        request.state.user = user
        if request.url.path.startswith(ACTIVE_PATHS):
            state["last_activity"] = time.time()  # the sampler backs off while people use the site
    return await call_next(request)


class Credentials(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(creds: Credentials, request: Request, response: Response):
    token = auth.login(creds.username.strip(), creds.password)
    if not token:
        raise HTTPException(401, "Wrong username or password.")
    response.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=request.url.scheme == "https")
    return {"username": creds.username.strip()}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    auth.logout(request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"username": request.state.user, "account": linked_account(request.state.user)}


def linked_account(username):
    link = auth.get_account(username)
    if not link:
        return None
    # prefer the latest name from the cache in case the player renamed
    p = store.get_player(store.connect(), link["puuid"])
    if p:
        link.update(game_name=p["game_name"], tag_line=p["tag_line"])
    return link


class AccountLink(BaseModel):
    puuid: str


@app.put("/api/me/account")
def link_account(body: AccountLink, request: Request):
    p = store.get_player(store.connect(), body.puuid)
    if not p:
        raise HTTPException(404, "Look the player up first.")
    auth.set_account(request.state.user, p["platform"], p["game_name"], p["tag_line"], p["puuid"])
    return linked_account(request.state.user)


@app.delete("/api/me/account")
def unlink_account(request: Request):
    auth.clear_account(request.state.user)
    return {"ok": True}


def riot_errors(e: RiotError):
    bad_key = "Riot API key rejected (dev keys expire every 24h — refresh RIOT_API_KEY in .env and restart)."
    msg = {401: bad_key, 403: bad_key,
           404: "Not found on Riot's side — check the Riot ID and region."}.get(e.status, str(e))
    return HTTPException(e.status if e.status in (401, 403, 404) else 502, msg)


async def fetch_matches(riot, platform, ids, tier, chunk=40, stop=None):
    """Fetch uncached matches + timelines for `ids` and tag them with the rank population.

    `stop()` is checked between chunks so background work can give way mid-batch."""
    db = store.connect()
    before = sum(1 for m in ids if store.has_match(db, m))
    for i in range(0, len(ids), chunk):
        if stop and stop():
            break
        await history.fetch_chunk(riot, db, platform, ids[i:i + chunk], tier)
    return sum(1 for m in ids if store.has_match(db, m)) - before


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


def users_active():
    """True while someone uses the site (or a player sync runs): the sampler must give way."""
    return history.any_running() or time.time() - state["last_activity"] < SAMPLER_QUIET


def sampler_share():
    """On small keys (e.g. 100 requests / 2 min) the sampler only sips; on big keys it may use half."""
    app = state["riot"].limiter.buckets.get(("app", PLATFORMS[SAMPLER["platform"]]))
    longest = max(app.windows, key=lambda w: w[1]) if app and app.windows else None
    per_minute = longest[0] / longest[1] * 60 if longest else 0
    return SAMPLER["share"] if per_minute >= 500 else 0.2


async def sampler():
    """Round-robin over tiers: several random players per tier, their games on this patch.

    Also backfills timelines for current-patch matches cached before timelines were
    collected, so the patch lead curve covers the whole sample.
    """
    s = state["sampler"]
    platform = SAMPLER["platform"]
    i = 0
    while True:
        try:
            # users get the whole budget: wait until nobody has used the site for a full rate window
            if users_active():
                s["status"] = "paused"
                await asyncio.sleep(5)
                continue
            riot = state["riot"].background(sampler_share())
            db = store.connect()
            patch = stats.latest_patch(db)
            s.update(platform=platform, target=SAMPLER["target"], patch=patch,
                     matches=patch_matches(db, patch) if patch else 0)
            no_timeline = [r[0] for r in db.execute(
                """SELECT m.match_id FROM matches m LEFT JOIN timelines t ON t.match_id = m.match_id
                   WHERE m.patch = ? AND m.queue_id = ? AND m.remake = 0 AND t.match_id IS NULL LIMIT 40""",
                (patch, SOLO_QUEUE))] if patch else []
            if no_timeline:
                s.update(status="sampling", tier=None)
                await fetch_matches(riot, platform, no_timeline, None, chunk=10, stop=users_active)
                continue
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
            picked = random.sample(pool, min(SAMPLER["players"], len(pool)))
            id_lists = await asyncio.gather(*(riot.match_ids(platform, p, SOLO_QUEUE, 10, start_time=since)
                                              for p in picked), return_exceptions=True)
            ids = sorted({m for lst in id_lists if isinstance(lst, list) for m in lst})
            await fetch_matches(riot, platform, ids, tier, chunk=10, stop=users_active)
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


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC / "favicon-32.png", media_type="image/png")


@app.get("/riot.txt")
def riot_txt():
    """Riot's site-verification file (needed for a production key). Public, read on every request."""
    path = Path(__file__).with_name("riot.txt")
    if not path.exists():
        raise HTTPException(404, "riot.txt not found")
    return PlainTextResponse(path.read_text())


@app.get("/api/meta")
def meta():
    return {"platforms": list(PLATFORMS), "tiers": TIERS, "roles": stats.ROLES,
            "ranges": [{"key": k, "label": r["label"], "kind": "count" if "count" in r else "time"}
                       for k, r in history.RANGES.items()],
            "default_range": history.DEFAULT_RANGE,
            "ddragon": state["ddragon"], "champions": state["champions"], "spells": state["spells"]}


@app.get("/api/patch")
def patch(tier: str | None = None):
    """Stats for the live patch — or, right after a patch drops, the previous one until the
    sampler has enough games on the new one (`patch` vs `current_patch` tells the client)."""
    db = store.connect()
    current = current_patch(db)
    current_games = patch_matches(db, current)
    shown = current if current_games >= MIN_PATCH_GAMES else (stats.latest_patch(db) or current)
    overview = stats.patch_overview(db, shown, tier) if shown else {"patch": None, "matches": 0, "tiers": []}
    if shown and overview["matches"]:
        overview["leads"] = stats.patch_lead_curve(db, shown, tier)
    return {**overview, "current_patch": current, "current_patch_games": current_games, "sampler": state["sampler"]}


def analysis(puuid, rng, tz):
    """Stats for the player's cached games in `rng` — cheap, no Riot calls."""
    db = store.connect()
    p = store.get_player(db, puuid)
    if not p:
        raise HTTPException(404, "Unknown player")
    games = stats.attach_gold(db, history.window(stats.player_games(db, puuid, SOLO_QUEUE), rng), puuid)
    return {
        "puuid": puuid,
        "profile": {"name": p["game_name"], "tag": p["tag_line"], "platform": p["platform"],
                    "tier": p["tier"], "division": p["division"], "lp": p["lp"],
                    "season_wins": p["wins"], "season_losses": p["losses"], "level": p["level"],
                    "icon": profile_icon(state["ddragon"], p["profile_icon"]) if p["profile_icon"] is not None else None},
        "range": {"key": rng["key"], "label": rng["label"]},
        "games_analysed": len(games),
        "first_game": games[0]["game_start"] if games else None,
        "last_game": games[-1]["game_start"] if games else None,
        "overview": stats.overview(games, tz) if games else None,
        "vs_rank": stats.champions_vs_rank(db, games, puuid, p["tier"], SOLO_QUEUE),
        "leads": stats.player_leads(db, games, puuid, p["tier"], SOLO_QUEUE),
        "mastery": stats.mastery(db, puuid, games),
        "sync": history.status(puuid),
    }


@app.get("/api/player")
async def player(platform: str, riot_id: str, range_: str = Query(history.DEFAULT_RANGE, alias="range"),
                 tz: int = 0):
    """Resolve the player, start syncing their history for the range, and return what's cached.

    Small ranges usually finish within the wait below; big ones keep running in the
    background and the client polls /api/sync until done.
    """
    if platform not in PLATFORMS:
        raise HTTPException(400, "Unknown platform")
    if "#" not in riot_id:
        raise HTTPException(400, "Use the full Riot ID, e.g. Name#EUW")
    name, tag = (x.strip() for x in riot_id.rsplit("#", 1))
    riot = state["riot"]
    db = store.connect()
    cached = store.find_player(db, platform, name, tag)
    fresh = cached and cached["profile_updated"] and time.time() - cached["profile_updated"] < PROFILE_TTL
    try:
        # a fresh cached profile skips 3 of the 5 lookup calls (account, summoner, mastery)
        if fresh:
            puuid, game_name, tag_line = cached["puuid"], cached["game_name"], cached["tag_line"]
        else:
            account = await riot.account(platform, name, tag)
            puuid, game_name, tag_line = account["puuid"], account["gameName"], account["tagLine"]
        calls = [riot.league_entries(platform, puuid), riot.active_game(platform, puuid)]
        if not fresh:
            calls += [riot.summoner(platform, puuid), riot.mastery(platform, puuid)]
        entries, game, *profile = await asyncio.gather(*calls)
    except RiotError as e:
        raise riot_errors(e)
    solo = next((e for e in entries if e["queueType"] == "RANKED_SOLO_5x5"), {})
    store.save_player(db, puuid, game_name, tag_line, platform, solo, profile[0] if profile else None)
    if profile:
        store.save_mastery(db, puuid, profile[1])
    db.commit()
    if game:
        state["live"][puuid] = {"at": time.time(), "game": game, "extra": None}

    rng = history.resolve(range_)
    history.start(riot.background(HISTORY_SHARE), platform, puuid, solo.get("tier", "UNRANKED"), rng)
    await history.wait_for_matches(puuid, FIRST_RESPONSE_WAIT)  # timelines keep loading in the background
    # stats queries are blocking SQLite work: keep them off the event loop that drives the fetches
    return {**await asyncio.to_thread(analysis, puuid, rng, tz), "live": live_summary(puuid, game)}


def live_summary(puuid, game):
    """Small 'in game now' banner payload from a spectator response."""
    if not game:
        return None
    me = next((p for p in game["participants"] if p.get("puuid") == puuid), {})
    return {"queue": QUEUES.get(game.get("gameQueueConfigId"), game.get("gameMode", "Game").title()),
            "champion_id": me.get("championId"), "started": game.get("gameStartTime") or None}


@app.get("/api/live/{puuid}")
async def live(puuid: str, form: bool = False):
    """All ten players in the live game: rank, mastery on their champion, and recent form.

    Recent form comes from each participant's cached solo games. With form=1 this kicks
    off a short sync for each of them (≈10 players × 11 requests, so only on request) and
    the client polls until `pending` is 0. Players who hide their identity in live games
    come without a PUUID and are shown champion-only.
    """
    db = store.connect()
    me = store.get_player(db, puuid)
    if not me:
        raise HTTPException(404, "Unknown player")
    platform = me["platform"]
    riot = state["riot"]
    cached = state["live"].get(puuid)
    try:
        if not cached or time.time() - cached["at"] > LIVE_TTL:
            game = await riot.active_game(platform, puuid)
            same = cached and cached["game"] and game and cached["game"]["gameId"] == game["gameId"]
            cached = state["live"][puuid] = {"at": time.time(), "game": game, "extra": cached["extra"] if same else None}
        game = cached["game"]
        if not game:
            return {"in_game": False}
        people = [p for p in game["participants"] if p.get("puuid")]
        hidden = [p for p in game["participants"] if not p.get("puuid")]
        if cached["extra"] is None:  # ranks + mastery, once per TTL
            leagues, masteries = await asyncio.gather(
                asyncio.gather(*(riot.league_entries(platform, p["puuid"]) for p in people), return_exceptions=True),
                asyncio.gather(*(riot.mastery(platform, p["puuid"]) for p in people), return_exceptions=True))
            cached["extra"] = {p["puuid"]: (lg if isinstance(lg, list) else [], ms if isinstance(ms, list) else [])
                               for p, lg, ms in zip(people, leagues, masteries)}
    except RiotError as e:
        raise riot_errors(e)

    solo_of = {p["puuid"]: next((e for e in cached["extra"].get(p["puuid"], ([], []))[0]
                                 if e.get("queueType") == "RANKED_SOLO_5x5"), {}) for p in people}
    if form:
        bg = riot.background(HISTORY_SHARE)
        for p in people:
            history.start(bg, platform, p["puuid"], solo_of[p["puuid"]].get("tier", "UNRANKED"),
                          history.last_n(LIVE_FORM_GAMES), replace=False, timelines=False)  # form only needs matches

    def build_rows():  # blocking SQLite reads: run in a worker thread
        db = store.connect()
        rows = []
        for p in people:
            solo = solo_of[p["puuid"]]
            masteries = cached["extra"].get(p["puuid"], ([], []))[1]
            games = stats.player_games(db, p["puuid"], SOLO_QUEUE)
            on_champ = [g for g in games if g["champion_id"] == p["championId"]]
            m = next((x for x in masteries if x.get("championId") == p["championId"]), {})
            rows.append({
                "puuid": p["puuid"], "riot_id": p.get("riotId") or "Unknown", "team": p["teamId"],
                "champion_id": p["championId"], "is_me": p["puuid"] == puuid,
                "tier": solo.get("tier", "UNRANKED"), "division": solo.get("rank", ""), "lp": solo.get("leaguePoints", 0),
                "season_wins": solo.get("wins", 0), "season_losses": solo.get("losses", 0),
                "mastery_level": m.get("championLevel"), "mastery_points": m.get("championPoints"),
                "form": stats.wr_of(games[-LIVE_FORM_GAMES:]), "on_champ": stats.wr_of(on_champ),
                "cached_games": len(games), "loading": (history.status(p["puuid"]) or {}).get("running", False),
            })
        return rows

    rows = await asyncio.to_thread(build_rows)
    rows += [{"puuid": None, "riot_id": "Hidden player", "team": p["teamId"], "champion_id": p["championId"],
              "is_me": False, "hidden": True} for p in hidden]
    pending = sum(1 for p in people if (history.status(p["puuid"]) or {}).get("running"))
    missing = sum(1 for r in rows if not r.get("hidden") and not r["cached_games"] and not r["loading"])
    return {"in_game": True, "form_games": LIVE_FORM_GAMES, "without_history": missing, "queue": QUEUES.get(game.get("gameQueueConfigId"), game.get("gameMode", "Game").title()),
            "started": game.get("gameStartTime") or None, "pending": pending, "players": rows,
            "bans": [{"team": b["teamId"], "champion_id": b["championId"]}
                     for b in game.get("bannedChampions", []) if b["championId"] > 0]}


@app.get("/api/player/{puuid}/analysis")
def player_analysis(puuid: str, range_: str = Query(history.DEFAULT_RANGE, alias="range"), tz: int = 0):
    history.touch(puuid)
    return analysis(puuid, history.resolve(range_), tz)


ITEM_SLOTS = [f"item{i}" for i in range(7)]  # item6 is the trinket
POSITION_ORDER = {"TOP": 0, "JUNGLE": 1, "MIDDLE": 2, "BOTTOM": 3, "UTILITY": 4}


@app.get("/api/player/{puuid}/matches")
def player_matches(puuid: str, range_: str = Query(history.DEFAULT_RANGE, alias="range"),
                   offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100)):
    """One page of the player's games in the range, newest first, with items and session info.

    Items/spells come from the raw match JSON, so only the requested page is decoded."""
    history.touch(puuid)
    db = store.connect()
    games = stats.attach_gold(db, history.window(stats.player_games(db, puuid, SOLO_QUEUE),
                                                 history.resolve(range_)), puuid)
    sessions = stats.session_index(games)
    rows = []
    for g in games[::-1][offset:offset + limit]:
        raw = store.match_raw(db, g["match_id"])
        info = raw["info"] if raw else {"participants": [], "teams": []}
        me = next((p for p in info["participants"] if p["puuid"] == puuid), {})
        team_kills = next((t["objectives"]["champion"]["kills"] for t in info["teams"] if t["teamId"] == g["team_id"]), 0)
        rows.append({
            **{k: g[k] for k in ("match_id", "game_start", "duration", "champion_id", "position", "win", "kills",
                                 "deaths", "assists", "cs", "gold", "damage", "vision", "opp_champ",
                                 "team_diff15", "lane_diff15")},
            "items": [me.get(slot, 0) for slot in ITEM_SLOTS],
            "spells": [me.get("summoner1Id"), me.get("summoner2Id")],
            "level": me.get("champLevel"),
            "kill_participation": (g["kills"] + g["assists"]) / team_kills if team_kills else None,
            "session": sessions[g["match_id"]],
        })
    return {"total": len(games), "offset": offset, "rows": rows}


@app.get("/api/match/{match_id}")
def match_detail(match_id: str):
    """Full scoreboard for one cached match: both teams, objectives, bans, gold at 15."""
    db = store.connect()
    raw = store.match_raw(db, match_id)
    if not raw:
        raise HTTPException(404, "Match not in the cache")
    info = raw["info"]
    platform = db.execute("SELECT platform FROM matches WHERE match_id = ?", (match_id,)).fetchone()[0]
    gold15 = dict(db.execute("SELECT puuid, gold FROM frames WHERE match_id = ? AND minute = 15", (match_id,)).fetchall())
    teams = []
    for t in info["teams"]:
        o = t["objectives"]
        players = sorted((p for p in info["participants"] if p["teamId"] == t["teamId"]),
                         key=lambda p: POSITION_ORDER.get(p.get("teamPosition"), 9))
        teams.append({
            "team_id": t["teamId"], "win": t["win"],
            "kills": o["champion"]["kills"], "towers": o["tower"]["kills"], "dragons": o["dragon"]["kills"],
            "barons": o["baron"]["kills"], "grubs": o.get("horde", {}).get("kills", 0),
            "gold15": sum(gold15.get(p["puuid"], 0) for p in players) if len(gold15) == 10 else None,
            "bans": [b["championId"] for b in t.get("bans", []) if b["championId"] > 0],
            "players": [{
                "puuid": p["puuid"], "champion_id": p["championId"], "position": p.get("teamPosition") or "",
                "riot_id": f'{p.get("riotIdGameName") or p.get("summonerName") or "?"}#{p.get("riotIdTagline") or ""}',
                "level": p.get("champLevel"), "kills": p["kills"], "deaths": p["deaths"], "assists": p["assists"],
                "cs": p["totalMinionsKilled"] + p["neutralMinionsKilled"], "damage": p["totalDamageDealtToChampions"],
                "gold": p["goldEarned"], "vision": p["visionScore"], "gold15": gold15.get(p["puuid"]),
                "items": [p.get(slot, 0) for slot in ITEM_SLOTS], "spells": [p.get("summoner1Id"), p.get("summoner2Id")],
            } for p in players],
        })
    return {"match_id": match_id, "platform": platform, "game_start": info["gameStartTimestamp"],
            "duration": info["gameDuration"], "patch": ".".join(info["gameVersion"].split(".")[:2]), "teams": teams}


@app.get("/api/sync/{puuid}")
def sync_status(puuid: str):
    history.touch(puuid)  # the client polls this while it shows the profile: that keeps the sync alive
    return history.status(puuid) or {"running": False}


@app.get("/api/pick")
def pick(puuid: str, role: str, opp: int | None = None, alpha: float = 5.0,
         range_: str = Query(history.DEFAULT_RANGE, alias="range")):
    games = history.window(stats.player_games(store.connect(), puuid, SOLO_QUEUE), history.resolve(range_))
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
