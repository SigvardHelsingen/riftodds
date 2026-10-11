"""Player match history: selectable ranges and background sync jobs with progress.

A season can be 1000+ games (plus a timeline each), more than one request should
wait for, so each lookup starts (or reuses) a job that lists the player's match ids
for the range, then fetches in two phases, newest-first: all uncached matches
(enough for most stats), then their timelines (gold leads at 10/15). Stats are
always computed from the cache, so they fill in while the job runs.
"""
import asyncio
import logging
import os
import time
from datetime import datetime, timezone

import store

SOLO_QUEUE = 420
SEASON_START = os.environ.get("SEASON_START", "2026-01-08")  # first day of the ranked season (UTC)
_SEASON_TS = datetime.fromisoformat(SEASON_START).replace(tzinfo=timezone.utc).timestamp()

RANGES = {
    "20": {"label": "Last 20 games", "count": 20},
    "50": {"label": "Last 50 games", "count": 50},
    "100": {"label": "Last 100 games", "count": 100},
    "200": {"label": "Last 200 games", "count": 200},
    "30d": {"label": "Last 30 days", "days": 30},
    "90d": {"label": "Last 90 days", "days": 90},
    "season": {"label": f"This season (since {SEASON_START})", "since": _SEASON_TS},
}
DEFAULT_RANGE = "100"
CHUNK = 20  # matches fetched in parallel (and committed) per step: small, so the first stats show fast
TIMELINE_LIMIT = int(os.environ.get("TIMELINE_LIMIT", "100"))  # newest games per sync that get a timeline
TIMELINE_SHARE = 0.5   # timelines are nice-to-have: they yield to other users' match fetches
ORPHAN_AFTER = 180     # stop a sync nobody has polled for this long (background tabs poll ~once a minute)
RESYNC_AFTER = 600  # incidental syncs (replace=False) skip players synced this recently
_incidental = None   # semaphore: incidental syncs run two at a time so results arrive one by one

log = logging.getLogger("history")
jobs = {}  # puuid -> {"range", "phase", "total", "done", "running", "error", "finished", "seen", "incidental", "task"}


def last_n(n):
    """A range that isn't offered in the UI, e.g. the live view's recent form."""
    return {"key": f"last{n}", "label": f"Last {n} games", "count": n, "since": None}


def resolve(key):
    key = key if key in RANGES else DEFAULT_RANGE
    r = RANGES[key]
    since = r.get("since") or (time.time() - r["days"] * 86400 if "days" in r else None)
    return {"key": key, "label": r["label"], "count": r.get("count"), "since": since}


def window(games, rng):
    """The slice of a player's cached games (oldest first) that a range covers."""
    if rng["count"]:
        return games[-rng["count"]:]
    since_ms = rng["since"] * 1000
    return [g for g in games if g["game_start"] >= since_ms]


def status(puuid):
    j = jobs.get(puuid)
    return None if j is None else {k: j[k] for k in ("range", "phase", "total", "done", "running", "error")}


def touch(puuid):
    """Someone is looking at this player's sync — keep it going."""
    if puuid in jobs:
        jobs[puuid]["seen"] = time.time()


async def wait_for_matches(puuid, timeout):
    """Wait (up to `timeout`) until the player's matches are cached — not their timelines."""
    j = jobs.get(puuid)
    if j and j["running"]:
        try:
            await asyncio.wait_for(j["matches_ready"].wait(), timeout)
        except asyncio.TimeoutError:
            pass


def any_running():
    return any(j["running"] for j in jobs.values())


def start(riot, platform, puuid, tier, rng, replace=True, timelines=True):
    """Start a sync job for this player, or reuse the running one.

    replace=True (a user picked this range) cancels a running job for another range;
    replace=False (incidental syncs, e.g. live-game participants) leaves it alone.
    """
    j = jobs.get(puuid)
    if j and j["running"]:
        if j["range"] == rng["key"] or not replace:
            return j["task"]
        j["task"].cancel()  # switched range: anything already fetched stays cached
    elif j and not replace and time.time() - j["finished"] < RESYNC_AFTER:
        return j["task"]  # e.g. live-view polling: don't re-list a player every few seconds
    j = jobs[puuid] = {"range": rng["key"], "phase": "listing", "total": None, "done": 0, "running": True,
                       "error": None, "finished": 0, "seen": time.time(), "incidental": not replace,
                       "matches_ready": asyncio.Event()}  # set once every match is cached (timelines may follow)
    j["task"] = asyncio.create_task(_run(riot, platform, puuid, tier, rng, j, timelines, queued=not replace))
    return j["task"]


async def _list_ids(riot, platform, puuid, rng):
    ids = []
    while True:
        want = 100 if not rng["count"] else min(100, rng["count"] - len(ids))
        page = await riot.match_ids(platform, puuid, SOLO_QUEUE, want, start=len(ids), start_time=rng["since"])
        ids += page
        if len(page) < want or (rng["count"] and len(ids) >= rng["count"]):
            return ids


async def fetch_chunk(riot, db, platform, ids, tier, timelines=True):
    """Fetch whatever is missing (match and/or timeline) for `ids` in parallel, then save."""
    need_match = [m for m in ids if not store.has_match(db, m)]
    need_tl = [m for m in ids if timelines and not store.has_timeline(db, m)]
    results = await asyncio.gather(*(riot.match(platform, m) for m in need_match),
                                   *(riot.timeline(platform, m) for m in need_tl), return_exceptions=True)
    matches, tls = results[:len(need_match)], results[len(need_match):]
    for m in matches:
        if isinstance(m, dict):
            store.save_match(db, platform, m)
    for mid, tl in zip(need_tl, tls):
        if not isinstance(tl, Exception) and store.has_match(db, mid):
            store.save_timeline(db, mid, tl)
    for mid in ids:
        if tier and store.has_match(db, mid):
            store.tag_tier(db, mid, tier)
    db.commit()


async def _phase(j, name, todo, step):
    """Run `step` over `todo` in chunks. Returns False if the sync was abandoned midway."""
    j.update(phase=name, total=len(todo), done=0)
    for i in range(0, len(todo), CHUNK):
        if not j["incidental"] and time.time() - j["seen"] > ORPHAN_AFTER:
            j["phase"] = "paused"  # nobody is watching; what's fetched stays cached, next visit resumes
            return False
        await step(todo[i:i + CHUNK])
        j["done"] += len(todo[i:i + CHUNK])
    return True


async def _run(riot, platform, puuid, tier, rng, j, timelines, queued=False):
    global _incidental
    if queued:
        _incidental = _incidental or asyncio.Semaphore(2)
        async with _incidental:
            return await _run(riot, platform, puuid, tier, rng, j, timelines)
    try:
        ids = await _list_ids(riot, platform, puuid, rng)
        db = store.connect()
        for m in ids:
            if store.has_match(db, m):
                store.tag_tier(db, m, tier)
        db.commit()
        if not await _phase(j, "matches", [m for m in ids if not store.has_match(db, m)],
                            lambda chunk: fetch_chunk(riot, db, platform, chunk, tier, timelines=False)):
            return
        j["matches_ready"].set()
        if timelines:
            slow = riot.background(TIMELINE_SHARE)
            todo = [m for m in ids[:TIMELINE_LIMIT] if store.has_match(db, m) and not store.has_timeline(db, m)]
            if not await _phase(j, "timelines", todo, lambda chunk: fetch_chunk(slow, db, platform, chunk, tier)):
                return
        j["phase"] = "done"
    except asyncio.CancelledError:
        raise
    except Exception as e:  # surfaced to the UI via status()
        j["error"] = str(e)
        log.exception("history sync failed for %s", puuid)
    finally:
        j["running"] = False
        j["finished"] = time.time()
        j["matches_ready"].set()
