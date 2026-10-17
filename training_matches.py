"""Opt-in, private observations of completed cached matches. Never fetch or train.

Only explicit match endpoints use this module. Cache connections are read-only,
non-migrating and short-lived; at most 200 candidate rows, 40 progress digests or
20 review digests are inspected, one compressed document at a time.
"""
import json
import sqlite3
import time
import zlib
from contextlib import closing
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator

import store
import timeline
import training

ROLES = {"TOP": "Top", "JUNGLE": "Jungle", "MIDDLE": "Middle", "BOTTOM": "Bottom", "UTILITY": "Support"}
QUEUES = {420: "Ranked Solo", 440: "Ranked Flex", 400: "Normal Draft", 490: "Quickplay"}
CANDIDATE_LIMIT = 200
MAX_RAW_BYTES = 2 * 1024 * 1024
MAX_RAW_COMPRESSED = 512 * 1024
# A generous cache-corruption bound for per-game counters, not a performance target.
MAX_CACHED_COUNTER = 1_000_000_000
NOTE = ("Descriptive observations, not evidence that practice caused a change. Missing metrics are not zeros. "
        "Filters and game window are captured at tracking start; explicitly restart to change them. "
        "Lane gold at 10 minutes uses the nearest complete cached frame within 15 seconds, so it is approximate. "
        "Early-death counts require timeline coverage through 10 minutes or the end of a shorter match. "
        "Candidate searches are bounded to 200 cached player matches.")
REVIEW_NOTE = ("Prompts describe cached events, not causes or recommended plays. Review what was known at the time. "
               "Missing timelines are not games without events; nothing is fetched automatically.")
CACHE_REASON = "Completed match cache is unavailable; no data was fetched."


class StartTracking(training.RevisionBody):
    role: Literal["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
    champion_id: Annotated[int, Field(ge=1, le=2 ** 31 - 1)] | None
    queue_id: Annotated[int, Field(strict=True)]
    patch: Annotated[training.Title, Field(max_length=32)]

    @field_validator("queue_id")
    @classmethod
    def known_queue(cls, value):
        if value not in QUEUES:
            raise ValueError("Unsupported training queue")
        return value


def _cached(function, unavailable):
    """No store.connect/init: even missing/old caches must never be created/upgraded."""
    try:
        uri = Path(store.DB_PATH).resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=0.25)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA query_only=ON")
            db.execute("PRAGMA cache_size=-1024")
            db.execute("PRAGMA temp_store=FILE")
            db.execute("PRAGMA mmap_size=0")
            db.execute("BEGIN")
            return function(db)
    except (sqlite3.DatabaseError, OSError, ValueError):
        return unavailable


def _account(db, username):
    row = db.execute("SELECT game_name,tag_line,platform,puuid FROM accounts WHERE username=?", (username,)).fetchone()
    return dict(row) if row and row["puuid"] else None


def _plan(db, username, plan_id):
    row = training._find_entry(db, username, "plans", plan_id)
    if row["owner"] != username or row["team_id"] is not None:
        raise training.Error(404, "Training entry not found")
    return row


def _link(db, username, plan_id):
    row = db.execute("SELECT * FROM training_plan_links WHERE plan_id=? AND owner=?", (plan_id, username)).fetchone()
    return dict(row) if row else None


def _tracking(link):
    return {key: link[key] for key in ("started", "games", "role", "champion_id", "queue_id", "patch")} if link else None


def _reason(account, link=None):
    if not account:
        return "Link your Riot account to use completed cached matches."
    if link and account["puuid"] != link["puuid"]:
        return "Tracking belongs to a different linked account. Relink that account or explicitly restart tracking."
    return None


def _raw_info(db, match_id):
    # Refuse large compressed blobs in SQL, before loading them into Python.
    row = db.execute("SELECT raw FROM matches WHERE match_id=? AND length(raw)<=?",
                     (match_id, MAX_RAW_COMPRESSED)).fetchone()
    if not row or not isinstance(row[0], bytes):
        return None
    try:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(row[0], MAX_RAW_BYTES + 1)
        if len(raw) > MAX_RAW_BYTES or not decoder.eof or decoder.unused_data:
            return None
        value = json.loads(raw)
        info = value.get("info") if isinstance(value, dict) else None
        return info if isinstance(info, dict) else None
    except (ValueError, TypeError, zlib.error, RecursionError):
        return None


def _verified(db, row, now):
    if (row["queue_id"] not in QUEUES or row["remake"] != 0
            or timeline.number(row["game_start"]) is None or row["game_start"] <= 0
            or timeline.number(row["duration"]) is None or not 300 <= row["duration"] <= 28800
            or row["game_start"] + row["duration"] * 1000 > now * 1000):
        return False
    info = _raw_info(db, row["match_id"])
    # timeline.rift_map intentionally permits a queue-only legacy fallback. Here
    # we require explicit mapId, independently of digest/queue guesses.
    return (info is not None and type(info.get("mapId")) is int and info["mapId"] == 11
            and info.get("gameMode", "CLASSIC") == "CLASSIC"
            and info.get("queueId", row["queue_id"]) == row["queue_id"])


COLUMNS = """m.match_id,m.game_start,m.duration,m.patch,m.queue_id,m.remake,
             p.champion_id,p.position AS role,p.win,p.deaths,p.team_id"""


def _candidates(db, puuid, now, link=None, phase=None, queue_id=None):
    where, args = ["p.puuid=?", "m.remake=0", "m.queue_id IN (420,440,400,490)",
                   "m.game_start+m.duration*1000<=?"], [puuid, now * 1000]
    order = "DESC"
    if queue_id is not None:
        where.append("m.queue_id=?")
        args.append(queue_id)
    if link:
        where.extend(["p.position=?", "m.queue_id=?", "m.patch=?"])
        args.extend([link["role"], link["queue_id"], link["patch"]])
        if link["champion_id"] is not None:
            where.append("p.champion_id=?")
            args.append(link["champion_id"])
        if phase == "baseline":
            where.append("m.game_start+m.duration*1000<?")
        else:
            where.append("m.game_start>?")
            order = "ASC"
        args.append(link["started"] * 1000)
    # Only normalized columns are fetched in bulk; raw metadata is bounded and sequential.
    rows = db.execute(f"""SELECT {COLUMNS} FROM participants p JOIN matches m USING(match_id)
                          WHERE {' AND '.join(where)} ORDER BY m.game_start {order},m.match_id {order} LIMIT ?""",
                      (*args, CANDIDATE_LIMIT + 1)).fetchall()
    truncated = len(rows) > CANDIDATE_LIMIT
    return [dict(row) for row in rows[:CANDIDATE_LIMIT] if _verified(db, row, now)], truncated


def _options(db, account, now):
    rows, truncated = _candidates(db, account["puuid"], now)
    champions = sorted({r["champion_id"] for r in rows if type(r["champion_id"]) is int and r["champion_id"] > 0})
    patches = sorted({r["patch"] for r in rows if isinstance(r["patch"], str) and r["patch"]}, reverse=True)
    return {"patches": patches, "champions": [{"id": cid, "name": f"Champion {cid}"} for cid in champions],
            "available": bool(rows), "reason": None if rows else "No verified completed Rift matches in the bounded cache sample.",
            "truncated": truncated}


def options(username):
    with training._transaction(username) as members:
        account = _account(members, username)
        result = {"account": {k: account[k] for k in ("game_name", "tag_line", "platform")} if account else None,
                  "patches": [], "champions": [], "queues": [{"id": k, "label": v} for k, v in QUEUES.items()],
                  "roles": [{"id": k, "label": v} for k, v in ROLES.items()], "available": False,
                  "reason": _reason(account) or CACHE_REASON, "truncated": False}
        if account:
            result.update(_cached(lambda db: _options(db, account, time.time()), {}))
        return result


def _digest(db, match_id, puuid, team):
    try:
        dg = store.digest(db, match_id)  # bounded, version/map checked decompression
    except (sqlite3.DatabaseError, RecursionError):
        return None
    if dg is None or puuid not in dg["puuids"]:
        return None
    index = dg["puuids"].index(puuid)
    return dg if team in (100, 200) and dg["teams"][index] == team else None


def _optional_row(db, sql, args):
    try:
        return db.execute(sql, args).fetchone()
    except sqlite3.OperationalError:
        # Additive cache tables/columns may not exist in an older read-only cache.
        return None


def _counter(value):
    value = timeline.number(value)
    return value if value is not None and 0 <= value <= MAX_CACHED_COUNTER else None


def _match(row):
    return {key: row[key] for key in ("match_id", "game_start", "duration", "champion_id", "role", "patch", "queue_id")}


def _values(db, row, puuid):
    result = {"cs10": None, "deaths": _counter(row["deaths"]), "early_deaths": None, "lane_gold10": None}
    role = row["role"]
    if role in ("TOP", "MIDDLE", "BOTTOM", "JUNGLE") and row["duration"] >= 600:
        column = "jungle_cs10" if role == "JUNGLE" else "cs10"
        perf = _optional_row(db, f"SELECT {column} FROM perf WHERE match_id=? AND puuid=?", (row["match_id"], puuid))
        result["cs10"] = _counter(perf[0]) if perf else None
    dg = _digest(db, row["match_id"], puuid, row["team_id"])
    if dg:
        me = dg["pids"][dg["puuids"].index(puuid)]
        cutoff = min(600, row["duration"])
        covered_to = max((t for t in dg["ts"] if t is not None), default=0)
        if dg.get("end") is not None:
            covered_to = min(covered_to, dg["end"])
        # End metadata alone cannot establish event coverage in a partial digest.
        if covered_to >= cutoff:
            result["early_deaths"] = sum(1 for k in dg["kills"] if k[2] == me and 0 <= k[0] < cutoff)
        # Lane gold comparisons do not apply to jungle/support. Require exactly
        # one of this role per team, explicit teams, and a complete actual frame.
        if role in ("TOP", "MIDDLE", "BOTTOM") and row["duration"] >= 600:
            people = db.execute("SELECT puuid,team_id FROM participants WHERE match_id=? AND position=? LIMIT 11",
                                (row["match_id"], role)).fetchall()
            if (len(people) == 2 and {p["team_id"] for p in people} == {100, 200}
                    and sum(p["puuid"] == puuid for p in people) == 1):
                opponent = next(p for p in people if p["team_id"] != row["team_id"])
                frame = timeline.nearest_frame(dg, 600)
                if frame is not None and dg["valid"][frame] and opponent["puuid"] in dg["puuids"]:
                    ours = dg["puuids"].index(puuid)
                    theirs = dg["puuids"].index(opponent["puuid"])
                    if dg["teams"][theirs] == opponent["team_id"]:
                        a, b = (_counter(dg["gold"][frame][i]) for i in (ours, theirs))
                        if a is not None and b is not None:
                            result["lane_gold10"] = a - b
    return {**_match(row), "win": bool(row["win"]) if row["win"] in (0, 1) else None, "values": result}


def _metrics(baseline, practice, role):
    definitions = [("deaths", "Deaths per game", "deaths"), ("early_deaths", "Deaths before 10 minutes", "deaths")]
    if role in ("TOP", "MIDDLE", "BOTTOM"):
        definitions = [("cs10", "Lane CS at 10 minutes", "lane minions"),
                       ("lane_gold10", "Gold difference vs lane opponent at 10 minutes", "gold"), *definitions]
    elif role == "JUNGLE":
        definitions.insert(0, ("cs10", "Jungle CS before 10 minutes", "jungle minions"))
    out = []
    for key, label, unit in definitions:
        groups = []
        for rows in (baseline, practice):
            values = [r["values"][key] for r in rows if r["values"][key] is not None]
            groups.append({"mean": sum(values) / len(values) if values else None, "n": len(values)})
        a, b = groups
        out.append({"key": key, "label": label, "unit": unit, "baseline": a, "practice": b,
                    "difference": b["mean"] - a["mean"] if a["n"] and b["n"] else None})
    return out


def _empty_progress(link, reason):
    return {"available": False, "reason": reason, "tracking": _tracking(link),
            "baseline": {"games": len(json.loads(link["baseline_ids"])) if link else 0, "rows": []},
            "practice": {"games": 0, "rows": []}, "metrics": _metrics([], [], link["role"] if link else None),
            "note": NOTE, "truncated": False}


def _progress(db, account, link, now):
    baseline = []
    for mid in json.loads(link["baseline_ids"]):
        row = db.execute(f"""SELECT {COLUMNS} FROM participants p JOIN matches m USING(match_id)
                             WHERE p.puuid=? AND m.match_id=?""", (account["puuid"], mid)).fetchone()
        if (row and _verified(db, row, now) and _matches_filters(row, link)
                and row["game_start"] + row["duration"] * 1000 < link["started"] * 1000):
            baseline.append(_values(db, row, account["puuid"]))
        else:
            baseline.append({"match_id": mid, "missing": True,
                             **dict.fromkeys(("game_start", "duration", "champion_id", "role", "patch", "queue_id", "win")),
                             "values": dict.fromkeys(("cs10", "deaths", "early_deaths", "lane_gold10"))})
    rows, truncated = _candidates(db, account["puuid"], now, link, "practice")
    practice = [_values(db, row, account["puuid"]) for row in rows[:link["games"]]]
    return {"available": True, "reason": None, "tracking": _tracking(link),
            "baseline": {"games": len(baseline), "rows": baseline}, "practice": {"games": len(practice), "rows": practice},
            "metrics": _metrics(baseline, practice, link["role"]), "note": NOTE, "truncated": truncated}


def _matches_filters(row, link):
    return (row["role"] == link["role"] and row["patch"] == link["patch"] and row["queue_id"] == link["queue_id"]
            and (link["champion_id"] is None or row["champion_id"] == link["champion_id"]))


def progress(username, plan_id):
    with training._transaction(username) as members:
        _plan(members, username, plan_id)
        link, account = _link(members, username, plan_id), _account(members, username)
        reason = _reason(account, link) or ("Start match tracking for this plan." if not link else None)
        empty = _empty_progress(link, reason or CACHE_REASON)
        return empty if reason else _cached(lambda db: _progress(db, account, link, time.time()), empty)


def start(username, plan_id, data):
    data = training._model(StartTracking, data)
    with training._transaction(username, write=True) as members:
        row = _plan(members, username, plan_id)
        training._revision(row, data["revision"])
        account = _account(members, username)
        if account is None:
            raise training.Error(409, _reason(account))
        # Match timestamps are milliseconds: rounding down could include a game
        # already underway when the member opted in, or omit a completed baseline.
        started = time.time()
        link = {k: data[k] for k in ("role", "champion_id", "queue_id", "patch")}
        link.update(plan_id=plan_id, owner=username, puuid=account["puuid"], started=started,
                    games=json.loads(row["data"])["games"])

        def capture(cache):
            metadata = _options(cache, account, started)
            if (data["patch"] not in metadata["patches"] or data["champion_id"] is not None
                    and data["champion_id"] not in {c["id"] for c in metadata["champions"]}):
                raise training.Error(422, "Choose a patch and champion from the available cached match options")
            rows, truncated = _candidates(cache, account["puuid"], started, link, "baseline")
            link["baseline_ids"] = json.dumps([r["match_id"] for r in rows[:link["games"]]])
            result = _progress(cache, account, link, started)
            result["truncated"] |= truncated or metadata["truncated"]
            return result

        result = _cached(capture, None)
        if result is None:
            raise training.Error(503, CACHE_REASON)
        members.execute("""INSERT OR REPLACE INTO training_plan_links
                           (plan_id,owner,puuid,role,champion_id,queue_id,patch,started,games,baseline_ids)
                           VALUES (:plan_id,:owner,:puuid,:role,:champion_id,:queue_id,:patch,:started,:games,:baseline_ids)""", link)
        members.execute("UPDATE training_entries SET revision=revision+1,updated=? WHERE id=?", (int(started), plan_id))
        result["entry"] = training._entry(_plan(members, username, plan_id))
        return result


def stop(username, plan_id, revision):
    with training._transaction(username, write=True) as members:
        row = _plan(members, username, plan_id)
        training._revision(row, revision)
        members.execute("DELETE FROM training_plan_links WHERE plan_id=? AND owner=?", (plan_id, username))
        members.execute("UPDATE training_entries SET revision=revision+1,updated=? WHERE id=?", (int(time.time()), plan_id))
        return {"ok": True, "entry": training._entry(_plan(members, username, plan_id))}


def _review(db, row, puuid):
    dg = _digest(db, row["match_id"], puuid, row["team_id"])
    if dg is None:
        return None
    team = row["team_id"]
    me = dg["pids"][dg["puuids"].index(puuid)]
    # Ignore terminal/nexus states, even for a partial digest without winner metadata.
    end = min(row["duration"], dg["end"]) if dg.get("end") is not None else row["duration"]
    states = [s for s in timeline.states(dg) if s["t"] < end - 60]
    events = [e for e in timeline.story_events(dg, team) if 0 <= e["t"] < end]
    deaths = [e for e in events if e["kind"] in ("kill", "execution") and e["victim"] == me]
    prompts = []

    def prompt(kind, seconds, title, question, evidence):
        if len(prompts) < 3:
            prompts.append({"id": f"{row['match_id']}:{kind}:{seconds:g}", "match_id": row["match_id"],
                            "seconds": seconds, "title": title, "question": question, "evidence": evidence, "kind": kind})

    used_deaths = set()
    objectives = [e for e in events if e["kind"] == "monster" and e["side"] == "them"]
    for death in deaths:
        objective = next((e for e in objectives if 0 < e["t"] - death["t"] <= 60), None)
        if objective:
            prompt("death_before_objective", death["t"], "A death before an enemy objective",
                   "What information and options did you have before this death?",
                   f"Your death was {objective['t'] - death['t']:g}s before the enemy team took {objective['label']}. Timing alone is not causation.")
            used_deaths.add(death["t"])
    for death in deaths:
        if death["t"] < 600 and death["t"] not in used_deaths:
            prompt("early_death", death["t"], "An early death", "What was visible, and what alternatives did you consider?",
                   f"The cached timeline records your death at {death['t']:g}s, before 10 minutes.")
    sign = 1 if team == 100 else -1
    largest = None
    for i, b in enumerate(states):
        for j in range(i - 1, -1, -1):
            a = states[j]
            if b["t"] - a["t"] > 180:
                break
            loss = sign * (a["gold"] - b["gold"])
            if largest is None or loss > largest[0]:
                largest = loss, a, b
    if largest:
        loss, a, b = largest
        if loss >= 1500:
            prompt("gold_swing", a["t"], "A fall in team gold lead",
                   "Which visible events and decisions are worth reviewing in this interval?",
                   f"Team gold lead fell by {loss:g} gold between complete frames at {a['t']:g}s and {b['t']:g}s; this is not a cause attribution.")
    early = next((s for s in states if s["t"] <= 900 and sign * s["gold"] >= 1000), None)
    later = next((s for s in states if early and s["t"] > early["t"] and sign * s["gold"] <= 0), None)
    if early and later:
        prompt("lead_lost", early["t"], "An early team lead later disappeared",
               "What changed between these snapshots, without assuming one decision caused the result?",
               f"Team gold lead was {sign * early['gold']:g} at {early['t']:g}s and {sign * later['gold']:g} at {later['t']:g}s.")
    public_events = [{"seconds": e["t"], "kind": "death", "label": "Your death", "side": "us"} for e in deaths]
    public_events.extend({"seconds": e["t"], "kind": e["kind"], "label": e["label"], "side": e["side"]}
                         for e in events if e["kind"] in ("monster", "building"))
    public_events.extend({"seconds": s["t"], "kind": "gold", "label": f"Team gold lead: {sign * s['gold']:g}", "side": "us"}
                         for s in states)
    return {"events": sorted(public_events, key=lambda e: e["seconds"])[:80], "prompts": prompts}


def review_queue(username, plan_id=None):
    with training._transaction(username) as members:
        account, link = _account(members, username), None
        if plan_id is not None:
            _plan(members, username, plan_id)
            link = _link(members, username, plan_id)
        reason = _reason(account, link) or ("Start match tracking for this plan." if plan_id and not link else None)
        result = {"available": False, "reason": reason or CACHE_REASON,
                  "scope": {"plan_id": plan_id, **(_tracking(link) or {"queue_id": 420, "games": 10})},
                  "games_considered": 0, "timelines_available": 0, "prompts": [], "missing_timelines": 0,
                  "note": REVIEW_NOTE, "truncated": False}
        if reason or account is None:
            return result

        def read(cache):
            if link:
                rows, truncated = _candidates(cache, account["puuid"], time.time(), link, "practice")
                rows = rows[:link["games"]]
            else:
                # Default is newest ten solo games, across roles/champions/patches.
                rows, truncated = _candidates(cache, account["puuid"], time.time(), queue_id=420)
                rows = rows[:10]
            out = {**result, "available": True, "reason": None, "games_considered": len(rows), "truncated": truncated}
            prompts, available = [], 0
            for row in rows:
                context = _review(cache, row, account["puuid"])
                if context is not None:
                    available += 1
                    prompts.extend(context["prompts"][:max(0, 6 - len(prompts))])
            out.update(prompts=prompts, timelines_available=available, missing_timelines=len(rows) - available)
            return out

        return _cached(read, result)


def review_context(username, match_id):
    with training._transaction(username) as members:
        account = _account(members, username)
        if not account:
            raise training.Error(404, "Completed match not found")

        def read(cache):
            row = cache.execute(f"""SELECT {COLUMNS} FROM participants p JOIN matches m USING(match_id)
                                    WHERE p.puuid=? AND m.match_id=?""", (account["puuid"], match_id)).fetchone()
            if row is None or not _verified(cache, row, time.time()):
                return None
            context = _review(cache, row, account["puuid"])
            return {"match": _match(row), "available": context is not None,
                    "reason": None if context is not None else "A usable cached timeline is unavailable; nothing was fetched.",
                    "events": context["events"] if context else [], "prompts": context["prompts"] if context else [],
                    "note": REVIEW_NOTE}

        result = _cached(read, None)
        if result is None:
            raise training.Error(404, "Completed match not found")
        return result
