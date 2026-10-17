"""FastAPI app: syncs a player's ranked games into the cache and serves stats.

A background sampler keeps pulling recent solo-queue games from random players
across all tiers, so the landing page can show stats for the current patch.

Run:  uv run fastapi dev main.py
"""
import asyncio
import hashlib
import logging
import math
import os
import random
import sys
import threading
import time
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from config import load_env

load_env()

import auth
import history
import insights
import model
import perf
import randomizer
import scouting
import stats
import store
import timeline
import training_api
from riot import PLATFORMS, Riot, RiotError, load_champions, load_items, load_runes, load_spells, profile_icon

SOLO_QUEUE = 420
TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND",
         "MASTER", "GRANDMASTER", "CHALLENGER"]
# the sampler's target share of each patch's games: a softened ladder bell curve, so mid elo leads
# but every tier keeps enough games for its own stats
TIER_WEIGHTS = {"IRON": 6, "BRONZE": 10, "SILVER": 14, "GOLD": 16, "PLATINUM": 16, "EMERALD": 14,
                "DIAMOND": 10, "MASTER": 6, "GRANDMASTER": 4, "CHALLENGER": 4}
STATIC = Path(__file__).with_name("static")
SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "auto").strip().lower()
if SESSION_COOKIE_SECURE not in {"auto", "0", "1"}:
    raise RuntimeError("SESSION_COOKIE_SECURE must be auto, 0 or 1")

SAMPLER = {
    "enabled": os.environ.get("SAMPLER", "1") != "0",
    "platform": os.environ.get("SAMPLER_PLATFORM", "euw1"),
    "target": int(os.environ.get("SAMPLER_TARGET", "10000")),  # matches per patch, then idle
    "players": int(os.environ.get("SAMPLER_PLAYERS", "8")),     # players sampled in parallel per tier
    "share": 0.5,  # fraction of the rate limits the sampler may use
}
# IDs from https://static.developer.riotgames.com/docs/lol/queues.json.
# Both Arena queues exist; actual 16-player match-v5 responses also use 1700.
QUEUES = {420: "Ranked Solo", 440: "Ranked Flex", 400: "Normal Draft", 430: "Normal Blind", 450: "ARAM",
          480: "Swiftplay", 490: "Quickplay", 1700: "Arena", 1710: "Arena", 1900: "URF", 2300: "Brawl",
          2400: "ARAM: Mayhem"}
LIVE_TTL = 60  # seconds before re-checking the spectator endpoint while polling (ranks/mastery: once per game)
LIVE_CACHE_TTL = 6 * 3600  # expire unwatched players; polling keeps a game's ranks/mastery alive
LIVE_CACHE_MAX = 64
LIVE_FORM_GAMES = 10  # recent games synced per live participant (matches only, no timelines)
PROFILE_TTL = 6 * 3600  # Riot ID -> PUUID, profile icon, level and mastery are reused this long
FIRST_RESPONSE_WAIT = 3  # seconds a lookup waits for its sync before answering with what's cached
SAMPLER_QUIET = 120      # the sampler stays off this long after any user activity (= Riot's long window)
DDRAGON_REFRESH = 1800   # re-check Riot's live version (patch, new champions) this often
MIN_PATCH_GAMES = 50     # games a new patch needs before the landing page switches its stats to it
HISTORY_SHARE = 0.85  # player history syncs; leaves headroom so new lookups never queue
RANK_EVERY = 20 * 60      # tracked players' solo rank is re-checked this often (Riot keeps no LP history)
RANK_RECENT = 14 * 86400  # players looked up this recently are tracked; linked accounts always are
RANK_SHARE = 0.2          # rank checks only use this much of the rate limits
MODEL_EVERY = 6 * 3600    # the win-probability models are retrained this often
LIVE_ODDS_ENABLED = os.environ.get("LIVE_ODDS", "0") == "1"  # requires Riot use-case review before public enablement

SEEN_EVERY = 60  # seconds between "last seen" writes per user
SEEN_MAX = 1024

log = logging.getLogger("sampler")
state = {"sampler": {"status": "off"}, "live": {}, "last_activity": 0.0}
_seen = {}  # username -> when "last seen" was last written
ACTIVE_PATHS = ("/api/player", "/api/sync", "/api/live", "/api/pick", "/api/clash", "/api/match")


def _live_cached(puuid, entry=None):
    """Get/store an entry, refreshing its idle TTL and least-recently-used position."""
    now, cache = time.time(), state["live"]
    for key in list(cache):
        if now - cache[key].get("used_at", cache[key]["at"]) >= LIVE_CACHE_TTL:
            del cache[key]
    cached = cache.pop(puuid, None)
    if entry is not None:
        cached = entry
    if cached is not None:
        cached["used_at"] = now
        cache[puuid] = cached
    while len(cache) > LIVE_CACHE_MAX:
        # Only drop the cache's reference: an in-flight request may still use the entry.
        del cache[next(iter(cache))]
    return cached


def _seen_due(username, now):
    for user in list(_seen):
        if now - _seen[user] >= SEEN_EVERY:
            del _seen[user]
    # Keep active throttles when full, rather than evicting them into per-request writes.
    if username in _seen or len(_seen) >= SEEN_MAX:
        return False
    _seen[username] = now
    return True


@asynccontextmanager
async def lifespan(app):
    riot = state["riot"] = Riot()
    tasks = []
    try:
        state["ddragon"], state["champions"] = await load_champions()
        state["spells"] = await load_spells(state["ddragon"])
        await load_build_data()
        await ensure_cache_matches_key(riot)
        with closing(store.connect()) as db:
            store.backfill_bans(db)
        tasks.append(asyncio.create_task(refresh_ddragon()))
        tasks.append(asyncio.create_task(backfill_derived()))
        tasks.append(asyncio.create_task(track_ranks()))
        tasks.append(asyncio.create_task(train_models()))
        if SAMPLER["enabled"]:
            tasks.append(asyncio.create_task(sampler()))
        yield
    finally:
        for task in tasks:
            task.cancel()
        try:
            await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            await riot.http.aclose()


async def refresh_ddragon():
    """The server runs for weeks: pick up a new patch (and new champions) without a restart."""
    while True:
        await asyncio.sleep(DDRAGON_REFRESH)
        try:
            state["ddragon"], state["champions"] = await load_champions()
            state["spells"] = await load_spells(state["ddragon"])
            await load_build_data()
        except Exception:
            log.warning("could not refresh Data Dragon; keeping %s", state["ddragon"])


async def load_build_data():
    """Item and rune names for builds. Builds are optional: a Data Dragon hiccup must not stop the site."""
    try:
        version = state["ddragon"]
        state["items"] = await load_items(version)
        state["items_version"] = version
        state["runes"] = await load_runes(version)
    except Exception:
        log.warning("could not load items/runes from Data Dragon", exc_info=True)
        state.setdefault("items", {})
        state.setdefault("runes", {})


async def backfill_derived():
    """Tables added after release (builds, coaching numbers) are flattened out of the cached raw
    matches in the background, a batch at a time, so startup isn't delayed by a large cache."""
    for what, step in (("builds", store.backfill_builds), ("coaching numbers", store.backfill_perf)):
        after = ""
        try:
            while after is not None:
                def batch(step=step, after=after):
                    with closing(store.connect()) as db:
                        return step(db, after)
                after = await asyncio.to_thread(batch)
                await asyncio.sleep(0)
        except Exception:
            log.exception("could not backfill %s; the rest are done at the next start", what)


async def track_ranks():
    """Build LP history: every RANK_EVERY, re-check the solo rank of linked accounts and recently
    viewed players (one request each). Only changes are stored."""
    while True:
        await asyncio.sleep(RANK_EVERY)
        try:
            linked = {a["puuid"] for a in await asyncio.to_thread(auth.all_accounts)}

            def tracked():
                with closing(store.connect()) as db:
                    return store.tracked_players(db, linked, time.time() - RANK_RECENT)
            players = await asyncio.to_thread(tracked)
            riot = state["riot"].background(RANK_SHARE)
            for puuid, platform in players:
                try:
                    entries = await riot.league_entries(platform, puuid)
                except RiotError as e:
                    if e.status in (401, 403):
                        raise
                    continue  # one player's hiccup doesn't stop the round
                solo = next((e for e in entries if e.get("queueType") == "RANKED_SOLO_5x5"), {})
                await asyncio.to_thread(record_rank, puuid, solo)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("rank tracking round failed", exc_info=True)


def record_rank(puuid, solo):
    with closing(store.connect()) as db:
        store.update_rank(db, puuid, solo)
        db.commit()


async def train_models():
    """Retrain both win-probability models every MODEL_EVERY in a separate, low-priority process:
    fitting is up to a minute of pure-Python CPU that must never hold up requests."""
    await asyncio.sleep(120)  # startup and the first lookups go first
    while True:
        proc = None
        try:
            def age():
                with closing(store.connect()) as db:
                    return time.time() - min(model.load(db, name, ttl=0)[2] or 0 for name in ("ingame", "pregame"))
            if await asyncio.to_thread(age) >= MODEL_EVERY:
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, str(Path(__file__).with_name("model.py")), "train", "--db", str(store.DB_PATH),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
                if proc.returncode:
                    log.warning("model training failed: %s", out.decode(errors="replace")[-2000:])
                model._loaded.clear()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("model training round failed", exc_info=True)
        finally:
            if proc and proc.returncode is None:
                proc.kill()
                await proc.wait()
        await asyncio.sleep(600)


def current_patch(db):
    """The live patch: Riot's client version, or newer if games from a newer patch are already cached."""
    live = ".".join(state["ddragon"].split(".")[:2])
    cached = stats.latest_patch(db)
    return max(filter(None, (live, cached)), key=stats._patch_key)


def shown_patch(db):
    """(live patch, its sampled games, the patch stats use): right after a patch drops, the
    previous one until the sampler has MIN_PATCH_GAMES on the new one."""
    current = current_patch(db)
    games = patch_matches(db, current)
    return current, games, current if games >= MIN_PATCH_GAMES else (stats.latest_patch(db, before=current) or current)


async def ensure_cache_matches_key(riot):
    """PUUIDs are encrypted per API key, so a cache built with another key can't be joined
    to anything this key returns. Riot answers 400 when asked to decrypt a foreign PUUID:
    if that happens, archive the cache and re-resolve users' linked accounts by Riot ID."""
    with closing(store.connect()) as db:
        sample = store.oldest_participant(db)
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
        except RiotError as e:
            if e.status == 404:
                auth.clear_account(link["username"])
            else:
                log.warning("could not re-resolve linked account for %s: %s", link["username"], e)


# No /docs, /redoc or /openapi.json: they'd publish the members-only API to anyone.
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.include_router(training_api.router)

# The client renders with innerHTML, so the CSP is the backstop for a missed esc(): scripts only from
# this origin, images from Data Dragon, fonts from Google Fonts. Inline style attributes position the charts.
SECURITY_HEADERS = {
    "Content-Security-Policy": "; ".join((
        "default-src 'self'", "script-src 'self'", "connect-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://ddragon.leagueoflegends.com", "media-src 'self' blob:",
        "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'")),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
}


@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    # Never echo passwords/request bodies or non-JSON values such as infinity from failed inputs.
    return JSONResponse({"detail": [{key: e[key] for key in ("loc", "msg", "type")} for e in error.errors()]},
                        status_code=422)


PUBLIC_API = {"/api/login", "/api/logout"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Every /api route except login/logout needs a valid session. The page shell is public."""
    if request.url.path.startswith("/api/") and request.url.path not in PUBLIC_API:
        user = await asyncio.to_thread(auth.user_for, request.cookies.get(auth.COOKIE))
        if not user:
            return JSONResponse({"detail": "Not logged in"}, status_code=401)
        request.state.user = user
        now = time.time()
        if _seen_due(user, now):
            await asyncio.to_thread(track, user, "seen")
        if request.url.path.startswith(ACTIVE_PATHS):
            state["last_activity"] = time.time()  # the sampler backs off while people use the site
    return await call_next(request)


@app.middleware("http")  # registered last, so it runs outermost and also covers require_login's 401s
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


def track(username, kind, detail=""):
    """Record activity for admins ("seen" only updates the user's last visit). Never fails the request."""
    try:
        auth.seen(username) if kind == "seen" else auth.record(username, kind, detail)
    except Exception:
        log.warning("could not record %s activity for %s", kind, username, exc_info=True)


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=auth.MAX_USERNAME_LENGTH)
    password: str = Field(min_length=auth.MIN_PASSWORD_LENGTH, max_length=auth.MAX_PASSWORD_LENGTH)


@app.post("/api/login")
def login(creds: Credentials, request: Request, response: Response):
    client = request.client.host if request.client else "unknown"
    token = auth.login(creds.username.strip(), creds.password, client=client)
    if not token:
        raise HTTPException(401, "Wrong username or password.")
    track(creds.username.strip(), "login")
    response.set_cookie(auth.COOKIE, token, max_age=auth.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=(SESSION_COOKIE_SECURE == "1"
                                                  or (SESSION_COOKIE_SECURE == "auto" and request.url.scheme == "https")))
    return {"username": creds.username.strip()}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    auth.logout(request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"username": request.state.user, "role": auth.role_of(request.state.user),
            "account": linked_account(request.state.user)}


def linked_account(username):
    link = auth.get_account(username)
    if not link:
        return None
    # prefer the latest name from the cache in case the player renamed
    with closing(store.connect()) as db:
        p = store.get_player(db, link["puuid"])
    if p:
        link.update(game_name=p["game_name"], tag_line=p["tag_line"])
    return link


class AccountLink(BaseModel):
    puuid: str


@app.put("/api/me/account")
def link_account(body: AccountLink, request: Request):
    with closing(store.connect()) as db:
        p = store.get_player(db, body.puuid)
    if not p:
        raise HTTPException(404, "Look the player up first.")
    auth.set_account(request.state.user, p["platform"], p["game_name"], p["tag_line"], p["puuid"])
    track(request.state.user, "link", f'{p["game_name"]}#{p["tag_line"]}')
    return linked_account(request.state.user)


@app.delete("/api/me/account")
def unlink_account(request: Request):
    auth.clear_account(request.state.user)
    track(request.state.user, "unlink")
    return {"ok": True}


@app.get("/api/admin/activity")
def admin_activity(request: Request, days: int = Query(30, ge=1, le=auth.ACTIVITY_DAYS)):
    """Users, their last visit and recent activity. Admins only (`auth.py role <user> admin`)."""
    if auth.role_of(request.state.user) != "admin":
        raise HTTPException(403, "Admins only.")
    return auth.activity_report(days)


def riot_errors(e: RiotError):
    bad_key = "Riot API key rejected (dev keys expire every 24h — refresh RIOT_API_KEY in .env and restart)."
    msg = {401: bad_key, 403: bad_key,
           404: "Not found on Riot's side — check the Riot ID and region."}.get(e.status, str(e))
    return HTTPException(404 if e.status == 404 else 502, msg)


async def fetch_matches(riot, platform, ids, tier, chunk=40, stop=None):
    """Fetch uncached matches + timelines for `ids` and tag them with the rank population.

    `stop()` is checked between chunks so background work can give way mid-batch."""
    with closing(store.connect()) as db:
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


def tier_games(db, patch):
    """{tier: games tagged with it} on `patch`: sampled games plus those from players' history syncs."""
    return dict(db.execute(
        """SELECT mt.tier, COUNT(*) FROM match_tier mt JOIN matches m ON m.match_id = mt.match_id
           WHERE m.patch = ? AND m.queue_id = ? AND m.remake = 0 GROUP BY mt.tier""", (patch, SOLO_QUEUE)))


def next_tier(games):
    """A random tier (by TIER_WEIGHTS) among those still at or below their share of `games`.

    Balancing on games rather than picks: apex players play far more games per patch than a
    random lower-tier ladder page, so equal picks gave the apex tiers about half the sample."""
    total = sum(games.get(t, 0) for t in TIER_WEIGHTS)
    weight = sum(TIER_WEIGHTS.values())
    behind = {t: w for t, w in TIER_WEIGHTS.items() if games.get(t, 0) * weight <= w * total}
    return random.choices(list(behind), weights=list(behind.values()))[0]


def users_active():
    """True while someone uses the site (or a player sync runs): the sampler must give way."""
    return history.any_running() or time.time() - state["last_activity"] < SAMPLER_QUIET


def sampler_share():
    """On small keys (e.g. 100 requests / 2 min) the sampler only sips; on big keys it may use half."""
    app = state["riot"].limiter.buckets.get(("app", PLATFORMS[SAMPLER["platform"]]))
    longest = max(app.windows, key=lambda w: w[1]) if app and app.windows else None
    per_minute = longest[0] / longest[1] * 60 if longest else 0
    return SAMPLER["share"] if per_minute >= 500 else 0.2


def sampler_round():
    """(patch, its games, up to 40 of them without a timeline, list-from time, {tier: games}): blocking reads."""
    with closing(store.connect()) as db:
        patch = current_patch(db)  # not the newest cached one: a finished old patch must not idle the sampler
        if not patch:
            return None, 0, [], patch_start(db, None), {}
        no_timeline = [r[0] for r in db.execute(
            """SELECT m.match_id FROM matches m LEFT JOIN timelines t ON t.match_id = m.match_id
               WHERE m.patch = ? AND m.queue_id = ? AND m.remake = 0 AND t.match_id IS NULL LIMIT 40""",
            (patch, SOLO_QUEUE))]
        return patch, patch_matches(db, patch), no_timeline, patch_start(db, patch), tier_games(db, patch)


async def sampler():
    """Several random players from a tier still short of its TIER_WEIGHTS share, their games on this patch.

    Every other round instead fetches timelines for current-patch matches cached without one
    (or before timeline digests existed), so lead curves, build order and the win-probability
    model cover the whole sample while it keeps growing.
    """
    s = state["sampler"]
    platform = SAMPLER["platform"]
    turn = 0
    while True:
        try:
            # users get the whole budget: wait until nobody has used the site for a full rate window
            if users_active():
                s["status"] = "paused"
                await asyncio.sleep(5)
                continue
            riot = state["riot"].background(sampler_share())
            patch, matches, no_timeline, since, games = await asyncio.to_thread(sampler_round)
            s.update(platform=platform, target=SAMPLER["target"], patch=patch, matches=matches)
            done = bool(patch) and s["matches"] >= SAMPLER["target"]
            turn += 1
            if no_timeline and (done or turn % 2):
                s.update(status="sampling", tier=None)
                await fetch_matches(riot, platform, no_timeline, None, chunk=10, stop=users_active)
                continue
            if done:
                s["status"] = "idle"
                await asyncio.sleep(600)
                continue
            tier = next_tier(games)
            s.update(status="sampling", tier=tier)
            division = random.choice(["I", "II", "III", "IV"])
            pool = (await riot.tier_players(platform, tier, division, page=random.randint(1, 3))
                    or await riot.tier_players(platform, tier, division, page=1))
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


def index_html():
    """index.html with content-hashed asset URLs: after a deploy, browsers can't pair the new API
    with a cached old app.js."""
    html = (STATIC / "index.html").read_text()
    for name in ("app.js", "style.css", "insights.js", "insights.css", "training.js", "training-review.js",
                     "training-team.js", "training-lab.js", "training.css"):
        digest = hashlib.sha256((STATIC / name).read_bytes()).hexdigest()[:12]
        html = html.replace(f"/static/{name}", f"/static/{name}?v={digest}")
    return html


INDEX_HTML = index_html()


@app.get("/")
def index():
    return HTMLResponse(INDEX_HTML, headers={"Cache-Control": "no-cache"})


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
            "queues": [{"key": str(q), "label": QUEUES[q]} for q in HISTORY_QUEUES],
            "items": {i: it["name"] for i, it in state.get("items", {}).items()}, "runes": state.get("runes", {}),
            "ddragon": state["ddragon"], "champions": state["champions"], "spells": state["spells"]}


@app.post("/api/random-build")
def random_build():
    """A just-for-fun champion, lane and six-item loadout; no Riot calls or per-roll storage."""
    champions = state.get("champions", {})
    items = state.get("items", {})
    version = state.get("items_version", state.get("ddragon"))
    try:
        champion_id, loadout = randomizer.roll(champions, items)
    except ValueError:
        raise HTTPException(503, "The dice are warming up—champion or item data isn't ready. Try again shortly.")
    if not version:
        raise HTTPException(503, "Item data isn't ready. Try again shortly.")
    return JSONResponse({
        "champion_id": champion_id, "champion": champions[champion_id], "role": random.choice(stats.ROLES),
        "version": version, "items": [{"id": i, "name": items[i]["name"], "boots": bool(items[i].get("boots")),
                   "icon": f"https://ddragon.leagueoflegends.com/cdn/{version}/img/item/{i}.png"}
                  for i in loadout],
    }, headers={"Cache-Control": "no-store"})


PATCH_BOARD_TTL = 60  # every landing page polls the board; reuse it until it changes or this long
PATCH_BOARD_MAX = 16
_patch_boards = {}  # (tier, live patch, its games, shown patch) -> (computed at, board)
_patch_boards_lock = threading.Lock()


@app.get("/api/patch")
def patch(tier: str | None = None):
    """Stats for the live patch — or, right after a patch drops, the previous one until the
    sampler has enough games on the new one (`patch` vs `current_patch` tells the client)."""
    if tier and tier not in TIERS:
        raise HTTPException(400, "Unknown tier")
    with closing(store.connect()) as db, store.read_snapshot(db):
        current, current_games, shown = shown_patch(db)
        key = (tier, current, current_games, shown)
        with _patch_boards_lock:
            hit = _patch_boards.get(key)
        if hit and time.time() - hit[0] < PATCH_BOARD_TTL:
            board = hit[1]
        else:
            board = stats.patch_overview(db, shown, tier) if shown else {"patch": None, "matches": 0, "tiers": []}
            if shown and board["matches"]:
                board["leads"] = stats.patch_lead_curve(db, shown, tier)
            with _patch_boards_lock:
                _patch_boards[key] = time.time(), board
                while len(_patch_boards) > PATCH_BOARD_MAX:
                    del _patch_boards[next(iter(_patch_boards))]
    return {**board, "current_patch": current, "current_patch_games": current_games, "sampler": state["sampler"]}


def analysis(puuid, rng, tz):
    """Stats for the player's cached games in `rng` — cheap, no Riot calls."""
    with closing(store.connect()) as db, store.read_snapshot(db):
        p = store.get_player(db, puuid)
        if not p:
            raise HTTPException(404, "Unknown player")
        games = stats.attach_gold(db, history.window(stats.player_games(db, puuid, SOLO_QUEUE), rng), puuid)
        return {
            "puuid": puuid,
            "profile": {"name": p["game_name"], "tag": p["tag_line"], "platform": p["platform"],
                        "tier": p["tier"], "division": p["division"], "lp": p["lp"],
                        "season_wins": p["wins"], "season_losses": p["losses"], "level": p["level"],
                        "rank_checked": p["rank_checked"],
                        "icon": profile_icon(state["ddragon"], p["profile_icon"]) if p["profile_icon"] is not None else None},
            "range": {"key": rng["key"], "label": rng["label"]},
            "games_analyzed": len(games),
            "first_game": games[0]["game_start"] if games else None,
            "last_game": games[-1]["game_start"] if games else None,
            "overview": stats.overview(games, tz) if games else None,
            "vs_rank": stats.champions_vs_rank(db, games, puuid, p["tier"], SOLO_QUEUE),
            "leads": stats.player_leads(db, games, puuid, p["tier"], SOLO_QUEUE),
            "mastery": stats.mastery(db, puuid, games),
            "series": stats.game_series(games),
            "ranks": store.rank_history(db, puuid, since=history.SEASON_TS),
            "sync": history.status(puuid),
        }


TzOffset = Annotated[int, Query(ge=-1439, le=1439)]  # minutes, as getTimezoneOffset() reports; datetime needs < 24 h


def cached_player(platform, name, tag):
    with closing(store.connect()) as db:
        return store.find_player(db, platform, name, tag)


def save_lookup(puuid, game_name, tag_line, platform, solo, profile):
    with closing(store.connect()) as db:
        store.save_player(db, puuid, game_name, tag_line, platform, solo, profile[0] if profile else None)
        if profile:
            store.save_mastery(db, puuid, profile[1])
        db.commit()


@app.get("/api/player")
async def player(request: Request, platform: str, riot_id: str,
                 range_: str = Query(history.DEFAULT_RANGE, alias="range"), tz: TzOffset = 0, tzname: str | None = None):
    """Resolve the player, start syncing their history for the range, and return what's cached.

    Small ranges usually finish within the wait below; big ones keep running in the
    background and the client polls /api/sync until done.
    """
    if platform not in PLATFORMS:
        raise HTTPException(400, "Unknown platform")
    name, _, tag = (x.strip() for x in riot_id.rpartition("#"))
    if not name or not tag:
        raise HTTPException(400, "Use the full Riot ID, e.g. Name#EUW")
    riot = state["riot"]
    cached = await asyncio.to_thread(cached_player, platform, name, tag)
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
    await asyncio.to_thread(save_lookup, puuid, game_name, tag_line, platform, solo, profile)
    if game:
        cached = _live_cached(puuid)
        same = cached and cached["game"] and cached["game"]["gameId"] == game["gameId"]
        _live_cached(puuid, {"at": time.time(), "game": game, "extra": cached["extra"] if same else None})

    rng = history.resolve(range_)
    await asyncio.to_thread(track, request.state.user, "lookup", f"{game_name}#{tag_line} ({platform}) · {rng['label']}")
    history.start(riot.background(HISTORY_SHARE), platform, puuid, solo.get("tier", "UNRANKED"), rng)
    await history.wait_for_matches(puuid, FIRST_RESPONSE_WAIT)  # timelines keep loading in the background
    # stats queries are blocking SQLite work: keep them off the event loop that drives the fetches
    return {**await asyncio.to_thread(analysis, puuid, rng, stats.local_zone(tzname, tz)),
            "live": live_summary(puuid, game)}


def known_player(puuid):
    with closing(store.connect()) as db:
        return store.get_player(db, puuid)


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
    me = await asyncio.to_thread(known_player, puuid)
    if not me:
        raise HTTPException(404, "Unknown player")
    platform = me["platform"]
    riot = state["riot"]
    cached = _live_cached(puuid)
    try:
        if not cached or time.time() - cached["at"] > LIVE_TTL:
            game = await riot.active_game(platform, puuid)
            same = cached and cached["game"] and game and cached["game"]["gameId"] == game["gameId"]
            cached = _live_cached(puuid, {"at": time.time(), "game": game, "extra": cached["extra"] if same else None})
        game = cached["game"]
        if not game:
            return {"in_game": False}
        people = [p for p in game["participants"] if p.get("puuid")]
        hidden = [p for p in game["participants"] if not p.get("puuid")]
        fresh_ranks = cached["extra"] is None
        if fresh_ranks:  # ranks + mastery, once per game while watched
            leagues, masteries = await asyncio.gather(
                asyncio.gather(*(riot.league_entries(platform, p["puuid"]) for p in people), return_exceptions=True),
                asyncio.gather(*(riot.mastery(platform, p["puuid"]) for p in people), return_exceptions=True))
            cached["extra"] = {p["puuid"]: (lg if isinstance(lg, list) else [], ms if isinstance(ms, list) else [])
                               for p, lg, ms in zip(people, leagues, masteries)}
    except RiotError as e:
        raise riot_errors(e)

    solo_of = {p["puuid"]: next((e for e in cached["extra"].get(p["puuid"], ([], []))[0]
                                 if e.get("queueType") == "RANKED_SOLO_5x5"), {}) for p in people}
    if fresh_ranks:  # each live check is a free rank snapshot for all ten players
        def save_ranks():
            with closing(store.connect()) as db:
                for p in people:
                    store.save_rank(db, p["puuid"], solo_of[p["puuid"]])
                db.commit()
        await asyncio.to_thread(save_ranks)
    if form:
        bg = riot.background(HISTORY_SHARE)
        for p in people:
            history.start(bg, platform, p["puuid"], solo_of[p["puuid"]].get("tier", "UNRANKED"),
                          history.last_n(LIVE_FORM_GAMES), replace=False, timelines=False)  # form only needs matches

    def build_rows():  # blocking SQLite reads: run in a worker thread
        with closing(store.connect()) as db, store.read_snapshot(db):
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
                                        "jungle": jungle_history(db, p["puuid"], game.get("gameStartTime")),
                })
            return rows

    rows = await asyncio.to_thread(build_rows)
    rows += [{"puuid": None, "riot_id": "Hidden player", "team": p["teamId"], "champion_id": p["championId"],
              "is_me": False, "hidden": True} for p in hidden]
    pending = sum(1 for p in people if (history.status(p["puuid"]) or {}).get("running"))
    missing = sum(1 for r in rows if not r.get("hidden") and not r["cached_games"] and not r["loading"])
    return {"in_game": True, "form_games": LIVE_FORM_GAMES, "without_history": missing, "queue": QUEUES.get(game.get("gameQueueConfigId"), game.get("gameMode", "Game").title()),
            "game_id": game.get("gameId"), "started": game.get("gameStartTime") or None, "pending": pending, "players": rows,
                        "odds_enabled": LIVE_ODDS_ENABLED,
            "bans": [{"team": b["teamId"], "champion_id": b["championId"]}
                     for b in game.get("bannedChampions", []) if b["championId"] > 0]}


def jungle_history(db, puuid, before=None):
    """Only past cached jungle games; no role/path inference for the current spectator game."""
    def digests():
        ids = db.execute(
            """SELECT p.match_id FROM participants p JOIN matches m ON m.match_id = p.match_id
               WHERE p.puuid = ? AND p.position = 'JUNGLE' AND m.queue_id = ? AND m.remake = 0
                 AND m.game_start < ? ORDER BY m.game_start DESC LIMIT 10""",
            (puuid, SOLO_QUEUE, before or time.time() * 1000))
        for row in ids:
            dg = store.digest(db, row[0])
            if dg and puuid in dg["puuids"]:
                yield dg, dg["pids"][dg["puuids"].index(puuid)]
    habits = timeline.jungle_habits(digests())
    return habits if habits["games"] >= 3 else None


@app.get("/api/player/{puuid}/analysis")
def player_analysis(puuid: str, range_: str = Query(history.DEFAULT_RANGE, alias="range"), tz: TzOffset = 0,
                    tzname: str | None = None):
    history.touch(puuid)
    return analysis(puuid, history.resolve(range_), stats.local_zone(tzname, tz))


ITEM_SLOTS = [f"item{i}" for i in range(7)]  # item6 is the trinket
POSITION_ORDER = {"TOP": 0, "JUNGLE": 1, "MIDDLE": 2, "BOTTOM": 3, "UTILITY": 4}
HISTORY_QUEUES = (420, 440, 400, 480)  # visible tabs: ranked, normal draft and Swiftplay
HISTORY_API_QUEUES = (*HISTORY_QUEUES, 450, 2400, 1700, 1710)  # old clients can still read cached mode history
SUMMONERS_RIFT = 11  # mapId: dragons and barons only exist here


def queue_name(info):
    return QUEUES.get(info.get("queueId"), (info.get("gameMode") or "Game").title())


def team_of(p):
    """Arena puts duos in one Riot team: its subteam is the real team."""
    return p.get("playerSubteamId") or p["teamId"]


def placement_of(p):
    """Arena's duo placement takes precedence over the individual placement field."""
    return p.get("subteamPlacement") or p.get("placement") or None


def history_row(raw, puuid):
    """One match-history row for `puuid`, read from the raw match JSON (any queue)."""
    info = raw["info"]
    me = next((p for p in info["participants"] if p["puuid"] == puuid), None)
    if me is None or store.is_remake(info):
        return None
    position = me.get("teamPosition") or ""
    team_kills = sum(p["kills"] for p in info["participants"] if team_of(p) == team_of(me))
    return {
        "match_id": raw["metadata"]["matchId"], "queue": queue_name(info), "queue_id": info["queueId"],
        "game_start": info["gameStartTimestamp"], "duration": info["gameDuration"],
        "champion_id": me["championId"], "position": position, "team_id": me["teamId"], "win": bool(me["win"]),
        "placement": placement_of(me),  # Arena: 1st-8th
        "kills": me["kills"], "deaths": me["deaths"], "assists": me["assists"],
        "cs": me["totalMinionsKilled"] + me["neutralMinionsKilled"], "gold": me["goldEarned"],
        "damage": me["totalDamageDealtToChampions"], "vision": me["visionScore"],
        "opp_champ": next((p["championId"] for p in info["participants"] if position and p["teamId"] != me["teamId"]
                           and p.get("teamPosition") == position), None),
        "items": [me.get(slot, 0) for slot in ITEM_SLOTS],
        "spells": [me.get("summoner1Id"), me.get("summoner2Id")],
        "level": me.get("champLevel"),
        "kill_participation": (me["kills"] + me["assists"]) / team_kills if team_kills else None,
    }


def history_rows(db, puuid, match_ids):
    """Rows for the cached, non-remake games among `match_ids`, in order, with gold leads at 15."""
    raws = (store.match_raw(db, m) for m in match_ids)
    rows = [row for row in (history_row(raw, puuid) for raw in raws if raw) if row]
    return stats.attach_gold(db, rows, puuid)


@app.get("/api/player/{puuid}/matches")
async def player_matches(puuid: str, range_: str = Query(history.DEFAULT_RANGE, alias="range"),
                         queue: str = str(SOLO_QUEUE), offset: int = Query(0, ge=0),
                         limit: int = Query(20, ge=1, le=100)):
    """One page of the player's games, newest first, with items and lane opponent.

    Ranked solo is the synced range, straight from the cache. Other queues ("all" = every
    queue) aren't synced: each page lists its IDs from Riot and fetches only the uncached
    matches (no timelines). `next` is the offset of the following page, or null."""
    if queue != "all" and queue not in {str(q) for q in HISTORY_API_QUEUES}:
        raise HTTPException(400, "Unknown queue")
    history.touch(puuid)
    if queue == str(SOLO_QUEUE):
        def solo_page():
            with closing(store.connect()) as db, store.read_snapshot(db):
                games = history.window(stats.player_games(db, puuid, SOLO_QUEUE), history.resolve(range_))
                page = [g["match_id"] for g in games[::-1][offset:offset + limit]]
                return {"total": len(games), "next": offset + limit if offset + limit < len(games) else None,
                        "rows": history_rows(db, puuid, page)}
        return {"queue": queue, "offset": offset, "error": None, **await asyncio.to_thread(solo_page)}

    with closing(store.connect()) as db:
        p = store.get_player(db, puuid)
        if not p:
            raise HTTPException(404, "Unknown player")
        riot, error = state["riot"], None
        try:
            ids = await riot.match_ids(p["platform"], puuid, None if queue == "all" else int(queue), limit, start=offset)
            await history.fetch_chunk(riot, db, p["platform"], ids, None, timelines=False)
        except RiotError as e:
            raise riot_errors(e)
        except history.FetchChunkError:
            error = "Some games couldn't be loaded from Riot. Show more or refresh to retry."

    def page_rows():
        with closing(store.connect()) as db, store.read_snapshot(db):
            return history_rows(db, puuid, ids)
    rows = await asyncio.to_thread(page_rows)
    if queue != "all":
        filtered = [row for row in rows if row["queue_id"] == int(queue)]
        if len(filtered) != len(rows):
            error = error or "Some returned games didn't match the selected match type. Please retry."
        rows = filtered
    return {"queue": queue, "offset": offset, "total": None, "error": error, "rows": rows,
            "next": offset + len(ids) if len(ids) == limit else None}


@app.get("/api/match/{match_id}")
def match_detail(match_id: str):
    """Full scoreboard for one cached match: every team, objectives, bans, gold at 15."""
    with closing(store.connect()) as db:
        raw = store.match_raw(db, match_id)
        if not raw:
            raise HTTPException(404, "Match not in the cache")
        platform = db.execute("SELECT platform FROM matches WHERE match_id = ?", (match_id,)).fetchone()[0]
        gold15 = dict(db.execute("SELECT puuid, gold FROM frames WHERE match_id = ? AND minute = 15", (match_id,)).fetchall())
    info = raw["info"]
    riot_teams = {t["teamId"]: t for t in info.get("teams", [])}
    rift = info.get("mapId", SUMMONERS_RIFT) == SUMMONERS_RIFT
    by_team = {}
    for p in info["participants"]:
        by_team.setdefault(team_of(p), []).append(p)
    teams = []
    for team_id, players in by_team.items():
        players.sort(key=lambda p: POSITION_ORDER.get(p.get("teamPosition"), 9))
        t = riot_teams.get(team_id, {})
        o = t.get("objectives") or {}
        count = lambda key: (o.get(key) or {}).get("kills")
        teams.append({
            "team_id": team_id, "win": bool(players[0]["win"]), "placement": placement_of(players[0]),
            "kills": sum(p["kills"] for p in players), "towers": count("tower"),
            "dragons": count("dragon") if rift else None, "barons": count("baron") if rift else None,
            "gold15": sum(gold15.get(p["puuid"], 0) for p in players) if len(gold15) == len(info["participants"]) else None,
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
    teams.sort(key=lambda t: (t["placement"] or 0, t["team_id"]))  # blue, red — or Arena's standings
    return {"match_id": match_id, "platform": platform, "queue": queue_name(info), "game_start": info["gameStartTimestamp"],
            "duration": info["gameDuration"], "patch": ".".join(info["gameVersion"].split(".")[:2]), "teams": teams}


def build_steps(bought, items):
    """Starting items (bought in the first minute) and each finished item, boots or support item
    the first time it was bought, as [second, itemId]."""
    start = [[t, i] for t, i in bought if t < 60]
    seen, steps = set(), []
    for t, i in bought:
        kind = items.get(i, {})
        if t >= 60 and i not in seen and (kind.get("completed") or kind.get("boots") or kind.get("support")):
            seen.add(i)
            steps.append([t, i])
    return start, steps


@app.get("/api/match/{match_id}/story")
def match_story(match_id: str, puuid: str | None = None):
    """How one game went, minute by minute, from `puuid`'s team (blue if not given): gold leads,
    kills and objectives, win chance with its biggest swing, and the player's build, skill order
    and where they died. Needs the match's timeline digest."""
    with closing(store.connect()) as db, store.read_snapshot(db):
        raw = store.match_raw(db, match_id)
        if not raw:
            raise HTTPException(404, "Match not in the cache")
        dg = store.digest(db, match_id)
        order = db.execute("SELECT items, skills FROM purchases WHERE match_id = ? AND puuid = ?",
                           (match_id, puuid)).fetchone() if puuid else None
        params, report, trained = model.load(db, "ingame")
        if raw["info"].get("queueId") != SOLO_QUEUE:
            params = None  # Normal/Flex/Clash/bot games are outside the validated model population.
    if not dg:
        return {"available": False, "reason": "A current timeline digest is not cached for this game.",
                "can_fetch": timeline.rift_map(raw["info"]) == 11}
    people = raw["info"]["participants"]
    me = dg["pids"][dg["puuids"].index(puuid)] if puuid in dg["puuids"] else None
    if puuid and me is None:
        raise HTTPException(400, "Player did not participate in this match")
    team = timeline.team_of(me, dg) if me is not None else 100
    by_puuid = {p["puuid"]: p for p in people}
    bought = timeline.parse_items(order["items"]) if order else []
    start, steps = build_steps(bought, state.get("items", {}))
    return {"available": True, "team": team, "me": me,
            "odds_reason": "The win-probability model is evaluated on ranked solo queue only. Other match types show gold and events."
                           if raw["info"].get("queueId") != SOLO_QUEUE else (report or {}).get("reason"),
            "players": [{"participant_id": pid, "champion_id": by_puuid[who]["championId"],
                         "position": by_puuid[who].get("teamPosition") or "", "team": timeline.team_of(pid, dg)}
                        for pid, who in zip(dg["pids"], dg["puuids"])],
            "start": start, "build": steps, "skills": order["skills"] if order else "",
                        "first_shop": next((t for t, _ in bought if t >= 60), None),
            "model": {"trained_at": trained, "label": params.get("label"),
                                  "accuracy": ((report or {}).get("overall") or {}).get("accuracy")} if params else None,
            **timeline.story(dg, team, me, model.ingame_chance(params))}


@app.post("/api/match/{match_id}/timeline")
async def fetch_story_timeline(match_id: str):
    """Explicit, one-request timeline upgrade; legacy cached snapshots stay intact until success."""
    with closing(store.connect()) as db:
        raw = store.match_raw(db, match_id)
        if not raw:
            raise HTTPException(404, "Match not in the cache")
        platform = db.execute("SELECT platform FROM matches WHERE match_id = ?", (match_id,)).fetchone()[0]
    if timeline.rift_map(raw["info"]) != 11:
        raise HTTPException(400, "Game stories are available for standard Summoner's Rift games")
    async with history.fetch_slots():
        try:
            result = await state["riot"].timeline(platform, match_id)
        except RiotError as e:
            raise riot_errors(e)
        with closing(store.connect()) as db:
            if result is None and store.has_timeline(db, match_id):
                return {"available": False}  # Riot has none: keep an earlier fetch's gold-at-10/15 rows
            try:
                db.execute("BEGIN")
                store.save_timeline(db, match_id, result)
                db.commit()
            except Exception:
                db.rollback()
                raise
    return {"available": result is not None}


@app.get("/api/player/{puuid}/draft")
def draft_insights(puuid: str, role: str, opp: int | None = Query(None, ge=1),
                   range_: str = Query(history.DEFAULT_RANGE, alias="range")):
    if role not in stats.ROLES:
        raise HTTPException(400, "Unknown role")
    with closing(store.connect()) as db, store.read_snapshot(db):
        player = store.get_player(db, puuid)
        if not player:
            raise HTTPException(404, "Unknown player")
        games = history.window(stats.player_games(db, puuid), history.resolve(range_))
        patch = shown_patch(db)[2]
        population = stats.tier_population(db, player["tier"], patch)
        return insights.draft(db, games, puuid, population, patch, role, opp)


def goal_progress(db, puuid, goals):
    """The newest ten role-games STARTED after a goal was set, independent of profile range."""
    for goal in goals:
        metric = goal["metric"]
        if metric not in perf.METRICS:
            continue
        rows = db.execute(
            f"""SELECT f.{metric} FROM participants p JOIN matches m ON m.match_id = p.match_id
                LEFT JOIN perf f ON f.match_id = p.match_id AND f.puuid = p.puuid
                WHERE p.puuid = ? AND p.position = ? AND m.queue_id = ? AND m.remake = 0
                  AND m.game_start > ? ORDER BY m.game_start DESC, m.match_id DESC LIMIT 10""",
            (puuid, goal["role"], SOLO_QUEUE, goal["created"] * 1000))
        values = [r[0] for r in rows if isinstance(r[0], (int, float)) and math.isfinite(r[0])]
        goal["progress"] = {"games": len(values), "value": sum(values) / len(values) if values else None}
    return goals


@app.get("/api/player/{puuid}/coaching")
def coaching_insights(puuid: str, request: Request, range_: str = Query(history.DEFAULT_RANGE, alias="range")):
    link = auth.get_account(request.state.user)
    can_edit = bool(link and link["puuid"] == puuid)
    goals = auth.get_goals(request.state.user, puuid) if can_edit else []
    with closing(store.connect()) as db, store.read_snapshot(db):
        player = store.get_player(db, puuid)
        if not player:
            raise HTTPException(404, "Unknown player")
        games = history.window(stats.player_games(db, puuid), history.resolve(range_))
        result = insights.coaching(db, games, puuid, player["tier"], shown_patch(db)[2])
        result["forecast"] = insights.rank_forecast(store.rank_history(db, puuid, int(history.SEASON_TS)), dict(player))
        result["goals"] = goal_progress(db, puuid, goals)
    return {**result, "can_edit": can_edit}


class CoachingGoal(BaseModel):
    role: str
    metric: str
    target: float = Field(ge=0, le=10000, allow_inf_nan=False, strict=True)


def require_own_account(request, puuid):
    linked = auth.get_account(request.state.user)
    if not linked or linked["puuid"] != puuid:
        raise HTTPException(403, "Goals are private to your linked account")


@app.post("/api/player/{puuid}/goals")
def set_coaching_goal(puuid: str, body: CoachingGoal, request: Request):
    require_own_account(request, puuid)
    try:
        auth.set_goal(request.state.user, puuid, body.role, body.metric, body.target)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"goals": auth.get_goals(request.state.user, puuid)}


@app.delete("/api/player/{puuid}/goals")
def delete_coaching_goal(puuid: str, request: Request, role: str, metric: str):
    require_own_account(request, puuid)
    auth.delete_goal(request.state.user, puuid, role, metric)
    return {"goals": auth.get_goals(request.state.user, puuid)}


class LiveRole(BaseModel):
    team: int
    champion_id: int = Field(gt=0)
    role: str


class LiveRoles(BaseModel):
    roles: list[LiveRole] = Field(min_length=10, max_length=10)
    game_id: int | None = None


@app.post("/api/live/{puuid}/odds")
async def live_odds(puuid: str, body: LiveRoles):
    """Only user-confirmed roles for the actual cached spectator lineup, never invented identities."""
    if not LIVE_ODDS_ENABLED:
        return {"ready": False, "reason": "Live odds are disabled pending Riot use-case review. Post-game estimates and model evidence remain available."}
    cached = _live_cached(puuid)
    game = cached["game"] if cached else None
    if cached and time.time() - cached["at"] > LIVE_TTL:
        # One explicit odds request can renew stale spectator data. Assignment may take >60s;
        # a retry must not dead-end. live() reuses ranks/mastery if the game hasn't changed.
        await live(puuid, form=False)
        cached = _live_cached(puuid)
        game = cached["game"] if cached else None
    if not game:
        raise HTTPException(409, "No current game. Refresh the live view before assigning roles")
    if body.game_id is not None and body.game_id != game.get("gameId"):
        raise HTTPException(409, "The game changed. Refresh the live view and assign the new lineup")
    if game.get("gameQueueConfigId") != SOLO_QUEUE:
        return {"ready": False, "reason": "The odds model covers ranked solo queue only"}
    people = game["participants"]
    slots = {(p["teamId"], p["championId"]): p for p in people}
    assignments = {(r.team, r.champion_id): r.role for r in body.roles}
    if len(people) != 10 or len(slots) != 10 or len(assignments) != 10 or slots.keys() != assignments.keys():
        raise HTTPException(400, "Roles must match all ten champions in this live game")
    if any({assignments[key] for key in assignments if key[0] == team} != set(stats.ROLES) for team in (100, 200)):
        raise HTTPException(400, "Assign each role once per team")
    players = [{"team_id": team, "champion_id": champion, "position": role,
                "puuid": slots[(team, champion)].get("puuid")} for (team, champion), role in assignments.items()]
    def prediction():
        with closing(store.connect()) as db, store.read_snapshot(db):
            return model.pregame_prediction(db, players, current_patch(db), start_cutoff=game.get("gameStartTime") or None)
    return await asyncio.to_thread(prediction)


@app.get("/api/clash/{platform}/{team_id}")
async def clash_scout(platform: str, team_id: str, sync: bool = False):
    if platform not in PLATFORMS:
        raise HTTPException(400, "Unknown platform")
    if not team_id or len(team_id) > 128:
        raise HTTPException(400, "Invalid Clash team ID")
    riot = state["riot"]
    try:
        team = await riot.clash_team(platform, team_id)
    except RiotError as e:
        raise riot_errors(e)
    roster = team.get("players") or []
    if len(roster) > 5:
        raise HTTPException(502, "Riot returned an unexpected Clash roster")
    members = []
    for member in roster:
        who = member.get("puuid")
        role = scouting.normalize_role(member.get("position"))
        if not who:
            members.append({"puuid": None, "riot_id": "Unresolved player", "role": role, "tier": None})
            continue  # legacy summoner IDs are not PUUIDs; do not invent a mapping
        with closing(store.connect()) as db:
            player = store.get_player(db, who)
        if player and not sync:
            members.append({"puuid": who, "riot_id": f'{player["game_name"]}#{player["tag_line"]}',
                            "role": role, "tier": player["tier"]})
            continue
        try:
            account = await riot.account_by_puuid(platform, who)
            entries = await riot.league_entries(platform, who)
            solo = next((e for e in entries if e.get("queueType") == "RANKED_SOLO_5x5"), {})
            if sync:
                mastery = await riot.mastery(platform, who)
                with closing(store.connect()) as db:
                    store.save_player(db, who, account["gameName"], account["tagLine"], platform, solo)
                    store.save_mastery(db, who, mastery)
                    db.commit()
                history.start(riot.background(HISTORY_SHARE), platform, who, solo.get("tier", "UNRANKED"),
                              history.last_n(scouting.RECENT_GAMES), replace=False, timelines=False)
            members.append({"puuid": who, "riot_id": f'{account["gameName"]}#{account["tagLine"]}',
                            "role": role, "tier": solo.get("tier", "UNRANKED")})
        except RiotError as e:
            if e.status in (401, 403):
                raise riot_errors(e)
            members.append({"puuid": who, "riot_id": "Name unavailable", "role": role, "tier": None})
    def report():
        with closing(store.connect()) as db:
            return scouting.report(db, team, members)
    return await asyncio.to_thread(report)


@app.get("/api/odds")
def odds():
    """The win-probability models' scorecards: graded on the newest games, which they never saw."""
    with closing(store.connect()) as db, store.read_snapshot(db):
        return model.scorecards(db)


@app.get("/api/builds/{champion_id}")
def build(champion_id: int, role: str, tier: str | None = None, fallback: bool = False):
    """The most successful build for a champion in a role on the patch the landing page shows.

    With `fallback`, a tier with too few sampled games uses every tier instead (as suggested picks do)."""
    if role not in stats.ROLES:
        raise HTTPException(400, "Unknown role")
    if tier and tier not in TIERS:
        raise HTTPException(400, "Unknown tier")
    with closing(store.connect()) as db:
        patch = shown_patch(db)[2]
        if fallback:
            tier = stats.tier_population(db, tier, patch, SOLO_QUEUE)
        return stats.champion_build(db, champion_id, role, patch, state.get("items", {}), tier)


@app.get("/api/player/{puuid}/picks")
def player_picks(puuid: str, range_: str = Query(history.DEFAULT_RANGE, alias="range")):
    """Suggested champions for the player's main roles (highest win rate on the patch), with builds."""
    history.touch(puuid)
    with closing(store.connect()) as db:
        p = store.get_player(db, puuid)
        if not p:
            raise HTTPException(404, "Unknown player")
        games = history.window(stats.player_games(db, puuid, SOLO_QUEUE), history.resolve(range_))
        return stats.suggested_picks(db, games, p["tier"], shown_patch(db)[2], state.get("items", {}))


@app.get("/api/sync/{puuid}")
def sync_status(puuid: str):
    history.touch(puuid)  # the client polls this while it shows the profile: that keeps the sync alive
    return history.status(puuid) or {"running": False}


@app.get("/api/pick")
def pick(puuid: str, role: str, opp: int | None = None, alpha: float = Query(5.0, ge=0, allow_inf_nan=False),
         range_: str = Query(history.DEFAULT_RANGE, alias="range")):
    with closing(store.connect()) as db:
        games = history.window(stats.player_games(db, puuid, SOLO_QUEUE), history.resolve(range_))
    return stats.pick_probabilities(games, role, opp, alpha)


@app.post("/api/sample")
async def sample(request: Request, platform: str, tier: str, division: str = "", players: int = Query(4, ge=1, le=8),
                 per_player: int = Query(5, ge=1, le=10)):
    """Grow one tier's baseline now: recent solo games from random players in `tier`.

    Bounded (≤ 80 games, each with a timeline) and at the history-sync share, so one member's
    click can't take a development key's whole rate window from everyone else's lookups."""
    if platform not in PLATFORMS:
        raise HTTPException(400, "Unknown platform")
    tier = tier.upper()
    if tier not in TIERS:
        raise HTTPException(400, "Unknown tier")
    division = division or random.choice(["I", "II", "III", "IV"])
    if division not in ("I", "II", "III", "IV"):
        raise HTTPException(400, "Unknown division")
    riot = state["riot"].background(HISTORY_SHARE)
    await asyncio.to_thread(track, request.state.user, "sample", f"{tier.title()} {division} ({platform})")
    try:
        pool = await riot.tier_players(platform, tier, division, page=random.randint(1, 3))
        if not pool:
            pool = await riot.tier_players(platform, tier, division, page=1)
        picked = random.sample(pool, min(players, len(pool)))
        id_lists = await asyncio.gather(*(riot.match_ids(platform, p, SOLO_QUEUE, per_player) for p in picked))
        ids = sorted({m for lst in id_lists for m in lst})
        fetched = await fetch_matches(riot, platform, ids, tier)
    except RiotError as e:
        raise riot_errors(e)
    except history.FetchChunkError as e:
        raise HTTPException(502, "Sampling was incomplete. Any valid results were cached; "
                            f"retry to fetch missing matches/timelines. {e}") from e
    return {"tier": tier, "division": division, "players": len(picked), "matches": len(ids),
            "newly_fetched": fetched}
