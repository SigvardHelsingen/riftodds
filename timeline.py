"""Compact, versioned Summoner's Rift timelines; no raw timeline is retained.

Digest v2 keeps aligned ``pids``, ``puuids`` and ``teams``; ``ts`` contains actual
frame timestamps in seconds (not frame indexes), and ``valid`` marks complete
10-player gold/XP snapshots. Missing participants/counters are never zero-filled.
``pos`` is flattened x/y; selected event arrays also use seconds, preserving ms.
``map_id`` must be 11 for map interpretations. Purchases/skills retain their SQL
text formats. v1 lacks reliable timestamps/mapping and is deliberately not used
for states, maps or model inputs; store preserves its fetched marker and SQL data.
"""
import json
from bisect import bisect_left
from collections import Counter
from itertools import pairwise
from math import hypot, isfinite

DIGEST_VERSION = 2
MAX_DIGEST_BYTES = 256 * 1024
MAP = 15000
NOT_BUILD = frozenset({3340, 3363, 3364, 2055})
INHIB_RESPAWN = 300
BARON_BUFF = 180
ELDER_BUFF = 150
SOUL_DRAGONS = 4
GANK_UNTIL = 600
FRAME_TOLERANCE = 15  # seconds; do not label a 14:40 frame as gold at 15
EARLY_JUNGLE_AT = 120
CAMP_DISTANCE = 1500
CAMP_MARGIN = 300
# Approximate camp centres; proximity is an observation, never evidence of first clear.
CAMPS = ((100, "blue", 3870, 7900), (100, "blue", 2100, 8400), (100, "blue", 3800, 6500),
         (100, "red", 7800, 4100), (100, "red", 6500, 5300), (100, "red", 8400, 2700),
         (200, "blue", 10900, 7000), (200, "blue", 12700, 6500), (200, "blue", 11100, 8400),
         (200, "red", 7100, 10800), (200, "red", 8000, 9600), (200, "red", 6400, 12200))
ZONES = {"base": "Your base", "enemy_base": "Enemy base", "top": "Top lane", "mid": "Mid lane", "bot": "Bot lane",
         "river": "River", "jungle": "Your jungle", "enemy_jungle": "Enemy jungle"}
LANE_ZONES = ("top", "mid", "bot")
MONSTERS = {"DRAGON": "Dragon", "BARON_NASHOR": "Baron", "RIFTHERALD": "Rift Herald", "HORDE": "Voidgrubs",
            "ATAKHAN": "Atakhan"}
LANES = {"TOP_LANE": "Top", "MID_LANE": "Mid", "BOT_LANE": "Bot"}
TOWERS = {"OUTER_TURRET": "outer turret", "INNER_TURRET": "inner turret", "BASE_TURRET": "inhibitor turret",
          "NEXUS_TURRET": "nexus turret"}
STANDARD_QUEUES = frozenset({400, 420, 430, 440, 490, 700, 830, 840, 850})
SELECTED_EVENTS = frozenset({"CHAMPION_KILL", "ELITE_MONSTER_KILL", "BUILDING_KILL", "TURRET_PLATE_DESTROYED",
                            "ITEM_PURCHASED", "ITEM_SOLD", "ITEM_DESTROYED", "ITEM_UNDO", "SKILL_LEVEL_UP",
                            "WARD_PLACED", "WARD_KILL", "GAME_END"})
ITEM_EVENTS = frozenset({"ITEM_PURCHASED", "ITEM_SOLD", "ITEM_DESTROYED", "ITEM_UNDO"})


def number(value):
    """A finite JSON number, or None. Booleans are not counters/timestamps."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return value if isfinite(value) else None
        except OverflowError:
            pass
    return None


def rift_map(info):
    """11 only for a known standard Rift game, else None (including unknown maps).

    Match-v5 timelines normally omit map/mode: store supplies the cached match's
    info. Known standard queue IDs can establish Rift when old match JSON lacks
    mapId; an explicit non-Rift map/mode always takes precedence.
    """
    map_id, mode, queue = info.get("mapId"), info.get("gameMode"), info.get("queueId")
    if map_id is not None and map_id != 11 or mode is not None and mode != "CLASSIC":
        return None
    if queue is not None and queue not in STANDARD_QUEUES:
        return None
    return 11 if map_id == 11 or queue in STANDARD_QUEUES else None


def supported(dg):
    """A structurally usable current Rift digest, including explicitly invalid frames."""
    if not isinstance(dg, dict) or dg.get("v") != DIGEST_VERSION or dg.get("map_id") != 11:
        return False
    try:
        pids, puuids, teams, times = (dg[key] for key in ("pids", "puuids", "teams", "ts"))
        if not all(isinstance(row, list) for row in (pids, puuids, teams, times, dg["valid"])):
            return False
        size = len(pids)
        if size != 10 or len(puuids) != size or len(teams) != size or len(dg["valid"]) != len(times):
            return False
        if any(not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 for pid in pids) or len(set(pids)) != size:
            return False
        if any(not isinstance(puuid, str) or not puuid for puuid in puuids) or len(set(puuids)) != size:
            return False
        if any(team not in (None, 100, 200) for team in teams) or any(not isinstance(v, bool) for v in dg["valid"]):
            return False
        if any(t is not None and (number(t) is None or t < 0) for t in times):
            return False
        for key, width in (("gold", size), ("xp", size), ("cs", size), ("pos", size * 2)):
            rows = dg[key]
            if not isinstance(rows, list) or len(rows) != len(times):
                return False
            for row in rows:
                if not isinstance(row, list) or len(row) != width or any(v is not None and number(v) is None for v in row):
                    return False
        for key, width in (("kills", 6), ("monsters", 4), ("buildings", 5), ("plates", 3), ("wards", 6)):
            rows = dg.get(key, []) if key == "wards" else dg[key]
            if not isinstance(rows, list) or any(not isinstance(e, list) or len(e) != width
                                                 or number(e[0]) is None or e[0] < 0 for e in rows):
                return False
        if any(not isinstance(e[5], list) for e in dg["kills"]):
            return False
        end = dg.get("end")
        return end is None or number(end) is not None and end >= 0
    except (KeyError, TypeError, ValueError):
        return False


def team_of(pid, dg=None):
    """A participant's explicit digest team; the one-argument API is legacy only.

    Callers with a digest MUST pass it: noncanonical IDs cannot be interpreted
    from the ID alone. Unknown IDs/teams return None rather than assigning red.
    """
    if dg is not None:
        try:
            team = dg["teams"][dg["pids"].index(pid)]
            return team if team in (100, 200) else None
        except (KeyError, ValueError, IndexError, TypeError):
            return None
    return (100 if pid <= 5 else 200) if isinstance(pid, int) and 1 <= pid <= 10 else None


# --- extraction ---------------------------------------------------------------------

def _participants(tl, match_info):
    info = tl["info"]
    people = info.get("participants") or []
    matched = (match_info or {}).get("participants") or []
    explicit = [p for p in people if p.get("participantId") is not None]
    if not explicit:
        explicit = [p for p in matched if p.get("participantId") is not None]
    if not explicit:
        explicit = [{"participantId": i + 1, "puuid": puuid}
                    for i, puuid in enumerate((tl.get("metadata") or {}).get("participants") or [])]
    by_id, teams = {}, {}
    by_puuid = {p["puuid"]: p for p in matched if p.get("puuid")}
    for p in explicit:
        pid, puuid = p["participantId"], p["puuid"]
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or not isinstance(puuid, str) or not puuid:
            raise ValueError("Invalid timeline participantId/puuid")
        if pid in by_id or puuid in by_id.values():
            raise ValueError("Duplicate timeline participantId/puuid")
        other = by_puuid.get(puuid, {})
        if other.get("participantId", pid) != pid:
            raise ValueError("Timeline participantId disagrees with match")
        if p.get("teamId") is not None and other.get("teamId", p["teamId"]) != p["teamId"]:
            raise ValueError("Timeline teamId disagrees with match")
        by_id[pid] = puuid
        teams[pid] = other.get("teamId", p.get("teamId"))
    if matched and set(by_id.values()) != set(by_puuid):
        raise ValueError("Timeline participants disagree with match")
    # Only old, entirely metadata-free canonical 5v5 timelines need this fallback.
    if not any(t is not None for t in teams.values()) and set(by_id) == set(range(1, 11)):
        teams = {pid: team_of(pid) for pid in by_id}
    return by_id, teams


def _counter(frame, key):
    value = number(frame[key])  # a present but malformed participant frame is an error, not a zero
    if value is None or value < 0:
        raise ValueError(f"Invalid participant frame {key}")
    return value


def _selected_events(frames):
    """Sort only selected events; deduplicate overlap between frames.

    Identical item transactions within one frame may be real multiple purchases
    at the same millisecond, so their multiplicity is preserved. Overlapping
    frames keep the maximum multiplicity, not a doubled purchase/undo history.
    """
    events, seen = [], {}
    fields = ("timestamp", "type", "participantId", "killerId", "victimId", "killerTeamId", "monsterType",
              "monsterSubType", "teamId", "buildingType", "laneType", "towerType", "beforeId", "afterId",
              "itemId", "goldGain", "skillSlot", "levelUpType", "creatorId", "wardType", "winningTeam")
    for frame in frames:
        counts = {}
        for e in frame.get("events") or []:
            if e.get("type") not in SELECTED_EVENTS:
                continue
            at = number(e.get("timestamp"))
            if at is None or at < 0:
                continue
            compact = {key: e[key] for key in fields if key in e}
            if e.get("position"):
                compact["position"] = {key: e["position"].get(key) for key in ("x", "y")}
            if e.get("assistingParticipantIds"):
                compact["assists"] = sorted(set(e["assistingParticipantIds"]))
            key = json.dumps(compact, sort_keys=True, separators=(",", ":"))
            counts[key] = counts.get(key, 0) + 1
            occurrence = counts[key] if e["type"] in ITEM_EVENTS else 1
            if e["type"] not in ITEM_EVENTS and counts[key] > 1:
                continue
            if occurrence > seen.get(key, 0):
                events.append((at, e))
        for key, count in counts.items():
            seen[key] = max(seen.get(key, 0), count)
    return sorted(events, key=lambda entry: entry[0])


def _undo(history, before, after):
    if before == after:
        return
    # Undo of a buy/change cancels only its latest live purchase, not a historical
    # buy of an item subsequently sold. Undoing a sale restores inventory, not a buy.
    for item, kinds in ((before, ("ITEM_PURCHASED",)), (after, ("ITEM_SOLD", "ITEM_DESTROYED"))):
        if not item:
            continue
        for transaction in reversed(history):
            if transaction[1] == item and not transaction[3]:
                if transaction[0] in kinds:
                    transaction[3] = True
                break


def extract(tl, match_info=None):
    """(digest, {puuid: (items, skills)}) from a raw timeline, optionally with match info.

    items: ``itemId:second,...`` for non-undone buys (excluding wards/trinkets).
    Sales/consumption do not erase real purchase history; undoing a sale does not
    fabricate a buy. Skills: Q/W/E/R as digits 1-4, normal ability points only.
    """
    info = tl["info"]
    frames = info["frames"]
    if not isinstance(frames, list):
        raise ValueError("Timeline frames must be a list")
    by_id, teams = _participants(tl, match_info)
    pids = sorted(by_id)
    # Validate both sources: a timeline must not override conflicting match map metadata.
    map_info = {k: v for k, v in info.items() if k in ("mapId", "gameMode", "queueId")}
    if match_info is not None:
        map_info = {**{k: v for k, v in match_info.items() if k in ("mapId", "gameMode", "queueId")}, **map_info}
    map_id = rift_map(map_info)
    if match_info is not None and rift_map(match_info) != 11:
        map_id = None
    dg = {"v": DIGEST_VERSION, "map_id": map_id, "pids": pids, "puuids": [by_id[i] for i in pids],
          "teams": [teams[i] for i in pids], "ts": [], "valid": [], "gold": [], "xp": [], "cs": [], "pos": [],
          "kills": [], "monsters": [], "buildings": [], "plates": [], "wards": [], "end": None, "winner": None}
    history, skills = {pid: [] for pid in pids}, {pid: [] for pid in pids}
    timed = [(number(frame.get("timestamp")), i, frame) for i, frame in enumerate(frames)]
    timed.sort(key=lambda entry: (entry[0] is None, entry[0] if entry[0] is not None else entry[1]))
    for timestamp, _, frame in timed:
        t = timestamp / 1000 if timestamp is not None and timestamp >= 0 else None
        pf = frame.get("participantFrames") or {}
        gold, xp, cs, pos = [], [], [], []
        for pid in pids:
            f = pf.get(str(pid), pf.get(pid))
            if f is None:
                gold.append(None)
                xp.append(None)
                cs.append(None)
                pos.extend((None, None))
                continue
            gold.append(_counter(f, "totalGold"))
            xp.append(_counter(f, "xp"))
            cs.append(_counter(f, "minionsKilled") + _counter(f, "jungleMinionsKilled"))
            where = f.get("position") or {}
            pos.extend((number(where.get("x")), number(where.get("y"))))
        dg["ts"].append(t)
        dg["gold"].append(gold)
        dg["xp"].append(xp)
        dg["cs"].append(cs)
        dg["pos"].append(pos)
        dg["valid"].append(t is not None and len(pids) == 10 and dg["teams"].count(100) == 5
                           and dg["teams"].count(200) == 5 and all(v is not None for v in gold + xp))
    for timestamp, e in _selected_events(frames):
        t = timestamp / 1000
        kind, pid = e["type"], e.get("participantId")
        if kind == "CHAMPION_KILL":
            where = e.get("position") or {}
            dg["kills"].append([t, e.get("killerId", 0), e.get("victimId", 0), number(where.get("x")),
                                number(where.get("y")), sorted(set(e.get("assistingParticipantIds") or []))])
        elif kind == "ELITE_MONSTER_KILL":
            team = e.get("killerTeamId")
            if team not in (100, 200):
                team = teams.get(e.get("killerId"))
            dg["monsters"].append([t, team, e.get("monsterType"), e.get("monsterSubType") or ""])
        elif kind == "BUILDING_KILL":
            dg["buildings"].append([t, e.get("teamId"), e.get("buildingType"), e.get("laneType"), e.get("towerType") or ""])
        elif kind == "TURRET_PLATE_DESTROYED":
            dg["plates"].append([t, e.get("teamId"), e.get("laneType")])
        elif kind in ("WARD_PLACED", "WARD_KILL"):
            where = e.get("position") or {}
            dg["wards"].append([t, "placed" if kind == "WARD_PLACED" else "killed",
                                e.get("creatorId") if kind == "WARD_PLACED" else e.get("killerId"), e.get("wardType"),
                                number(where.get("x")), number(where.get("y"))])
        elif kind in ITEM_EVENTS and pid in history:
            if kind == "ITEM_UNDO":
                _undo(history[pid], e.get("beforeId", 0), e.get("afterId", 0))
            elif e.get("itemId"):
                history[pid].append([kind, e["itemId"], t, False])
        elif kind == "SKILL_LEVEL_UP" and pid in skills and e.get("levelUpType", "NORMAL") == "NORMAL":
            if e.get("skillSlot") in (1, 2, 3, 4):
                skills[pid].append(str(e["skillSlot"]))
        elif kind == "GAME_END":
            dg["end"], dg["winner"] = t, e.get("winningTeam")
    if dg["end"] is None:
        dg["end"] = max((t for t in dg["ts"] if t is not None), default=None)
    orders = {by_id[pid]: (",".join(f"{item}:{int(t) if t.is_integer() else t}" for kind, item, t, undone in history[pid]
                                    if kind == "ITEM_PURCHASED" and not undone and item not in NOT_BUILD),
                           "".join(skills[pid])) for pid in pids}
    return dg, orders


def parse_items(text):
    """[(second, itemId)] from purchases text; accept old integer/new ms-precision seconds."""
    out = []
    for part in (text or "").split(","):
        item, _, t = part.partition(":")
        if item and t:
            seconds, item_id = float(t), int(item)
            if not isfinite(seconds) or seconds < 0 or item_id <= 0:
                raise ValueError("Invalid purchase")
            out.append((int(seconds) if seconds.is_integer() else seconds, item_id))
    return out


def nearest_frame(dg, seconds, tolerance=FRAME_TOLERANCE):
    """Index of the closest actual timestamp within tolerance; prefer the earlier tie.

    Missing timestamps are never reconstructed from array order. The caller
    checks individual counters/positions; an incomplete team frame can still
    supply a known player's position or SQL row.
    """
    valid = dg.get("valid") or []
    candidates = ((abs(t - seconds), t, not (i < len(valid) and valid[i]), -i, i)
                  for i, t in enumerate(dg.get("ts") or [])
                  if number(t) is not None and abs(t - seconds) <= tolerance)
    return min(candidates, default=(None, None, None, None, None))[4]


# --- the map ---------------------------------------------------------------------------

def zone(x, y, team=100):
    """Rift coordinates from `team`'s side. Callers must first validate map_id."""
    if number(x) is None or number(y) is None or not (0 <= x <= MAP and 0 <= y <= MAP) or team not in (100, 200):
        return None
    if team == 200:
        x, y = MAP - x, MAP - y
    if x < 4800 and y < 4800 and x + y < 5600:
        return "base"
    if x > 10200 and y > 10200 and x + y > 24400:
        return "enemy_base"
    if x < 2300 or y > 12700:
        return "top"
    if y < 2300 or x > 12700:
        return "bot"
    if abs(x - y) < 1600:
        return "mid"
    if abs(x + y - 14800) < 1500:
        return "river"
    return "jungle" if x + y < 14800 else "enemy_jungle"


# --- game state at actual frame times ---------------------------------------------------

def states(dg):
    """Complete pre-outcome frames, blue's side; ``m`` is actual seconds / 60.

    Invalid snapshots are skipped, not zero-imputed. ``t`` gives exact seconds.
    Outcome/end/winner are NEVER passed to a model. Terminal GAME_END frames are
    excluded; story may append a separate display-only final point.
    """
    return _states(dg)


def _states(dg, include_terminal=False):
    if not supported(dg):
        return []
    events = sorted([(k[0], "kill", k) for k in dg["kills"]] + [(e[0], "monster", e) for e in dg["monsters"]]
                    + [(e[0], "building", e) for e in dg["buildings"]], key=lambda e: e[0])
    side = lambda team: 0 if team == 100 else 1
    kills, executions, towers, dragons, grubs, heralds, atakhan = ([0, 0] for _ in range(7))
    inhibs, barons, elders = [], [], []
    soul = None
    out, i = [], 0
    # Repeated snapshots must not overweight model training; prefer the latest
    # complete snapshot at a timestamp, while preserving all raw frame validity.
    snapshots = {t: j for j, t in enumerate(dg["ts"]) if number(t) is not None and dg["valid"][j]}
    frames = sorted(snapshots.items())
    for t, j in frames:
        if dg.get("winner") in (100, 200) and dg.get("end") is not None \
                and (t > dg["end"] or not include_terminal and t == dg["end"]):
            continue
        gold, xp = dg["gold"][j], dg["xp"][j]
        if dg["teams"].count(100) != 5 or dg["teams"].count(200) != 5 \
                or any(number(v) is None or v < 0 for v in gold + xp):
            continue
        while i < len(events) and events[i][0] <= t:
            at, kind, e = events[i]
            i += 1
            if kind == "kill":
                killer, victim = team_of(e[1], dg), team_of(e[2], dg)
                if e[1] == 0 and victim is not None:
                    executions[side(victim)] += 1
                elif killer is not None and victim is not None and killer != victim:
                    kills[side(killer)] += 1
            elif kind == "building" and e[1] in (100, 200):
                taker = 1 - side(e[1])
                if e[2] == "TOWER_BUILDING":
                    towers[taker] += 1
                elif e[2] == "INHIBITOR_BUILDING":
                    inhibs.append((at, taker))
            elif kind == "monster" and e[1] in (100, 200):
                s = side(e[1])
                if e[2] == "DRAGON" and e[3] == "ELDER_DRAGON":
                    elders.append((at, s))
                elif e[2] == "DRAGON":
                    dragons[s] += 1
                    if soul is None and dragons[s] >= SOUL_DRAGONS:
                        soul = s
                elif e[2] == "BARON_NASHOR":
                    barons.append((at, s))
                elif e[2] == "HORDE":
                    grubs[s] += 1
                elif e[2] == "RIFTHERALD":
                    heralds[s] += 1
                elif e[2] == "ATAKHAN":
                    atakhan[s] += 1
        # Expired effects need not accumulate for the remainder of a long game.
        inhibs = [(at, s) for at, s in inhibs if t - at < INHIB_RESPAWN]
        barons = [(at, s) for at, s in barons if t - at < BARON_BUFF]
        elders = [(at, s) for at, s in elders if t - at < ELDER_BUFF]
        active = lambda took: [sum(s == k for _, s in took) for k in (0, 1)]
        lead = lambda row: sum(v if team == 100 else -v for v, team in zip(row, dg["teams"]))
        out.append({"m": t / 60, "t": t, "gold": lead(gold), "xp": lead(xp),
                    "kills": kills[:], "executions": executions[:], "towers": towers[:], "dragons": dragons[:],
                    "grubs": grubs[:], "heralds": heralds[:], "atakhan": atakhan[:], "soul": soul,
                    "inhibs": active(inhibs), "baron": active(barons), "elder": active(elders)})
    return out


# --- the story of one game -------------------------------------------------------------

def _monster_label(e):
    if e[2] == "DRAGON":
        sub = e[3].replace("_DRAGON", "").title()
        return "Elder Dragon" if sub == "Elder" else f"{sub} Dragon" if sub else "Dragon"
    return MONSTERS.get(e[2], (e[2] or "Monster").replace("_", " ").title())


def story_events(dg, team):
    """Chronological takedowns, executions and objectives, viewed from `team`.

    Voidgrubs merge only inside one actual snapshot interval (left-open,
    right-closed), never across a displayed cutoff. Each group retains its first
    ``t``, last ``end_t`` and individual ``times``; unbounded/untimed tails do not
    merge because no snapshot establishes when the whole group was observable.
    """
    if not supported(dg):
        return []
    ours = lambda t: "us" if t == team else "them" if t in (100, 200) else None
    out = []
    for k in dg["kills"]:
        if not k[2]:
            continue
        execution = k[1] == 0
        out.append({"t": k[0], "kind": "execution" if execution else "kill",
                    "side": None if execution else ours(team_of(k[1], dg)), "killer": k[1], "victim": k[2],
                    "assists": k[5], "x": k[3], "y": k[4]})
    cutoffs = {t for t in dg["ts"] if number(t) is not None}
    if dg.get("winner") in (100, 200) and dg.get("end") is not None:
        cutoffs.add(dg["end"])  # story's display-only final point is also a cutoff
    cutoffs = sorted(cutoffs)
    grubs = {}
    for e in sorted(dg["monsters"], key=lambda event: event[0]):
        if e[1] not in (100, 200):
            continue
        if e[2] == "HORDE":
            interval = bisect_left(cutoffs, e[0])  # an event exactly at a frame belongs to that frame
            key = (e[1], interval)
            prev = grubs.get(key) if interval < len(cutoffs) else None
            if prev and e[0] - prev["t"] < 90:
                prev["times"].append(e[0])
                prev["end_t"] = e[0]
                prev["count"] += 1
                prev["label"] = f"Voidgrubs ×{prev['count']}"
                continue
            group = {"t": e[0], "end_t": e[0], "times": [e[0]], "kind": "monster", "side": ours(e[1]),
                     "label": "Voidgrub", "count": 1, "monster": "HORDE"}
            if interval < len(cutoffs):
                grubs[key] = group
            out.append(group)
            continue
        out.append({"t": e[0], "kind": "monster", "side": ours(e[1]), "label": _monster_label(e), "monster": e[2]})
    for e in dg["buildings"]:
        if e[1] not in (100, 200):
            continue
        what = "inhibitor" if e[2] == "INHIBITOR_BUILDING" else TOWERS.get(e[4], "turret")
        lane = LANES.get(e[3], "")
        out.append({"t": e[0], "kind": "building", "side": ours(200 if e[1] == 100 else 100),
                    "label": f"{lane} {what}".strip().capitalize(), "building": e[2]})
    return sorted(out, key=lambda e: e["t"])


def story(dg, team, me=None, chance=None):
    """Gold/XP story, chance(state), and personal death map (including executions).

    A known participant's digest team overrides legacy ID-based inference by the
    caller. Final certainty is display-only and never enters chance/state inputs.
    """
    if me is not None:
        team = team_of(me, dg) or team
    sign = 1 if team == 100 else -1
    events, minutes = story_events(dg, team), []
    display_states = _states(dg, include_terminal=True)
    for s in display_states:
        if dg.get("winner") in (100, 200) and s["t"] == dg.get("end"):
            continue
        p_blue = number(chance(s)) if chance else None
        if p_blue is not None and not 0 <= p_blue <= 1:
            p_blue = None
        minutes.append({"m": s["m"], "t": s["t"], "gold": sign * s["gold"], "xp": sign * s["xp"],
                        "kills": s["kills"] if team == 100 else s["kills"][::-1],
                        "executions": s["executions"] if team == 100 else s["executions"][::-1],
                        "chance": None if p_blue is None else (p_blue if team == 100 else 1 - p_blue)})
    if supported(dg) and dg.get("winner") in (100, 200) and display_states:
        last = display_states[-1]
        predicted = any(m["chance"] is not None for m in minutes)
        minutes.append({"m": dg["end"] / 60, "t": dg["end"], "gold": sign * last["gold"], "xp": sign * last["xp"],
                        "kills": last["kills"] if team == 100 else last["kills"][::-1],
                        "executions": last["executions"] if team == 100 else last["executions"][::-1],
                        "chance": (1.0 if dg["winner"] == team else 0.0) if predicted else None, "final": True,
                        "snapshot_t": last["t"]})
    turning = None
    if chance:
        steps = [(abs(b["chance"] - a["chance"]), a, b) for a, b in pairwise(minutes)
                 if not b.get("final") and a["chance"] is not None and b["chance"] is not None]
        if steps:
            _, a, b = max(steps, key=lambda step: step[0])
            happened = [e for e in events if a["t"] < e["t"] <= b["t"]]
            turning = {"from": a["chance"], "to": b["chance"], "minute": b["m"], "events": happened}
    mine = {}
    if me is not None:
        mine = {"deaths": [e for e in events if e["kind"] in ("kill", "execution") and e["victim"] == me],
                "kills": [e for e in events if e["kind"] == "kill" and e["killer"] == me]}
    return {"team": team, "minutes": minutes, "events": events, "turning": turning, **mine}


# --- a jungler's habits over many games -------------------------------------------------

def jungle_habits(games):
    """Streaming [(digest, pid), ...]; early side is a 2:00 camp-proximity PROXY.

    Legacy start/first_gank/ganks_per_game keys remain, but these are neither
    starting buffs nor all ganks: only lane kills/assists before 10:00. No 1:00
    pre-spawn positions are used. Unknown/ambiguous samples stay unclassified.
    """
    starts, invades, first_lanes, first_times = {"red": 0, "blue": 0}, 0, {lane: 0 for lane in LANE_ZONES}, Counter()
    takedowns, n, observed = 0, 0, 0
    for dg, pid in games:
        if not supported(dg):
            continue
        team = team_of(pid, dg)
        if team is None:
            continue
        index = dg["pids"].index(pid)
        n += 1
        frame = nearest_frame(dg, EARLY_JUNGLE_AT)
        if frame is not None:
            pos = dg["pos"][frame]
            x, y = pos[2 * index:2 * index + 2]
            if zone(x, y, team) in ("jungle", "enemy_jungle"):
                camps = sorted((hypot(x - cx, y - cy), owner, buff) for owner, buff, cx, cy in CAMPS)
                distance, owner, buff = camps[0]
                other = min(d for d, o, b in camps if (o, b) != (owner, buff))
                if distance <= CAMP_DISTANCE and other - distance >= CAMP_MARGIN:
                    starts[buff] += 1
                    invades += owner != team
                    observed += 1
        first = None
        for k in dg["kills"]:
            lane = zone(k[3], k[4], team)
            if 0 < k[0] <= GANK_UNTIL and k[1] != 0 and (k[1] == pid or pid in k[5]) \
                    and team_of(k[1], dg) == team and team_of(k[2], dg) not in (None, team) and lane in LANE_ZONES:
                takedowns += 1
                if first is None or k[0] < first[0]:
                    first = (k[0], lane)
        if first is not None:
            first_times[round(first[0] * 1000)] += 1  # bounded by the 600,000 ms early window, not games
            first_lanes[first[1]] += 1
    first_count = sum(first_times.values())
    middle, cumulative = [], 0
    for timestamp, count in sorted(first_times.items()):
        for rank in ((first_count - 1) // 2, first_count // 2):
            if cumulative <= rank < cumulative + count:
                middle.append(timestamp / 1000)
        cumulative += count
        if len(middle) == 2:
            break
    return {"games": n, "start": starts, "invades": invades, "early_jungle_side": starts.copy(),
            "early_jungle_proxy": {"label": "Early jungle side at 2:00 (nearest-camp proximity proxy, not starting buff)",
                                   "t": EARLY_JUNGLE_AT, "observed": observed, "unknown": n - observed},
            "first_gank": {"games": first_count, "lanes": first_lanes,
                           "median_t": sum(middle) / 2 if middle else None,
                           "label": "First lane takedown before 10:00 (kill/assist, not all ganks)"},
            "ganks_per_game": takedowns / n if n else None,
            "lane_takedowns_per_game": takedowns / n if n else None}
