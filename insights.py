"""Draft and coaching contracts for cached ranked solo-queue games (no Riot calls).

Public functions:
* draft(db, games, puuid, tier, patch, role, opponent=None): patch/tier/role/opponent,
  matchups, counters, note. Each matchup has champion_id/opponent_id, games/wins,
  observed wr and central 90% Beta(1+w, 1+l) lo/hi, score (a separately shrunk WR),
  gold10/gold15 = {mean, games}, and you = the same WR/gold summaries for the
  selected player range. Counters add reason and pool_games, are sorted by score,
  and only include sufficiently sampled champions already in that range's pool.
  Own-only matchups remain visible with zero peer games and null WR/score.
* coaching(db, games, puuid, tier, patch): patch/tier/next_tier and roles. Each role
  has role/games/metrics/fingerprint/focus/takeaway. Metrics have key/label/unit/
  better, you/current/next/percentile, games/baseline_games/next_games, and
  recent/previous = {value, games}. Focus copies a metric and adds advice/target/
  target_tier. Fingerprint entries have key/label/percentile. Values are means;
  percentiles are 0..100, direction-adjusted empirical midranks of the player's
  mean among valid peer participant-games (not ranks of peer player averages).
  Units reuse perf.METRICS: 'pct' means a 0..1 fraction, others are format strings.
* rank_forecast(ranks, profile): available/reason, lp_per_game, observations,
  games/net_lp, target = {tier, division, lp} or None, next_lp (displayed LP still
  needed for that next-tier checkpoint), uncertainty, note. estimated_games is
  ONLY present for an available positive-pace extrapolation. uncertainty holds
  lp_per_game_lo/hi and estimated_games_lo/hi, all nullable. These are observed
  interval extrema, NOT confidence limits or a probability of promotion.
  Ranks use store.rank_history's at/tier/division/lp/wins/losses. Profile accepts
  stored player/analysis fields or Riot's rank/leaguePoints/wins/losses fields.
  Reason codes are enumerated in FORECAST_REASONS. LP distance uses 100 displayed
  LP per division below Master; apex ranks share one LP band, not invented tier
  thresholds. Resets/corrections start a new segment; unchanged polls do not add
  observations. The latest history state must agree with the current profile.

`games` is the caller's selected range: only its distinct match IDs are used,
then authoritative cached participants are filtered by patch, queue and remake.
Inputs are never mutated. Baselines use EXACT patch and tier, never silently
fall back to another population, and exclude EVERY match containing puuid.
Draft tier=None explicitly means all tiers; coaching None/UNRANKED has no rank
baseline. Unknown tiers/roles or invalid opponent IDs raise ValueError.
EXISTS tier tags avoid duplicate counting; tags are a match-level rank proxy.
Both DB functions own one read snapshot unless the caller already owns one.
Missing/invalid numbers stay missing, never zero. Counts are valid samples even
when a mean/percentile is suppressed by the documented thresholds below.
"""
import math
from collections import Counter
from itertools import pairwise
from statistics import mean

import perf
import stats
import store

SOLO_QUEUE = 420
TIERS = ("IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND",
         "MASTER", "GRANDMASTER", "CHALLENGER")
CREDIBLE_LEVEL = 0.90
MATCHUP_PRIOR = 50  # pseudo-games at the full role population's observed WR
MIN_MATCHUP_GAMES = 15
MIN_POOL_GAMES = 3
MIN_GOLD_GAMES = 3
MAX_COUNTERS = 5
MIN_PLAYER_GAMES = 5  # per metric for percentiles/goals, not just games in the role
MIN_BASELINE_GAMES = 20  # per metric, separately for current and next tier
PROGRESS_WINDOW = 10  # newest ten selected role games vs the ten immediately before
MIN_PROGRESS_GAMES = 3  # per metric in each fixed window
MAX_FOCUS = 3
MIN_RANK_OBSERVATIONS = 3
MIN_RANK_GAMES = 10
MAX_RANK_OBSERVATIONS = 20
FORECAST_REASONS = (
    "observed_positive_pace", "insufficient_observations", "insufficient_games",
    "negative_pace", "zero_pace", "unranked", "invalid_profile", "invalid_history",
    "stale_history", "dynamic_apex_target",
)
SQL_CHUNK = 500

POPULATION_NOTE = (
    "Same-patch ranked solo queue only. Tier tags describe sampled matches, not verified "
    "ranks of every participant; a match can belong to both tier cohorts. All matches "
    "containing you are excluded from peers. These are cached, game-weighted associations, "
    "not causal effects; champion mix, game length and selection can affect comparisons."
)
FORECAST_NOTE = (
    "Observed Riot displayed ranks and season win/loss counters only. LP is displayed-rank "
    "distance (100 LP per division), not a reconstruction of individual LP awards. Interval pace varies; "
    "the range describes observed snapshot intervals, not a calibrated confidence interval. "
    "Future LP gains, losses and rank rules can change. This is a conditional pace "
    "extrapolation, not a promise of promotion. No hidden-rating estimate is used."
)

ADVICE = {
    "cs_min": "Review missed waves and last hits in three replays; plan recalls around waves. Do not trade necessary team participation for CS alone.",
    "cs10": "Practise last-hitting under pressure and review the first ten minutes for missed waves and recall timing; account for the matchup.",
    "jungle_cs10": "Review your first two clears for idle travel and camp sequencing; adapt the route to useful ganks and contested objectives.",
    "deaths": "Review your last three deaths for avoidable positioning or information errors. Keep worthwhile trades and objective contests; fewer deaths alone is not always better.",
    "kp": "Before leaving a wave or camp, check which nearby fights you can influence; review missed useful rotations rather than chasing every kill.",
    "vision_min": "Place and refresh useful vision before the next contested objective, then review whether it informed a decision; score alone does not measure vision quality.",
    "control_wards": "Plan a useful control ward for your next objective setup and protect it when feasible; do not buy wards just to increase a count.",
    "ward_kills": "Sweep a safe route with teammates before an objective; review missed clears without taking unsafe detours to chase ward counts.",
    "solo_kills": "Review favourable trading windows and cooldown advantages in lane; practise recognising an opportunity, not forcing a solo kill quota.",
    "early_takedowns": "Review early lane or jungle opportunities with numbers and wave priority; avoid forcing fights simply to raise this count.",
    "plates": "Look for safe plate windows after an advantageous trade or enemy recall; weigh the recall, map pressure and retaliation risk first.",
    "objectives": "Review your setup before epic monsters: nearby waves, vision and teammate arrival. Takedown counts also depend on team opportunities.",
    "lane_lead": "Review early trades, wave control and recall timings against your lane opponent. This aggregate lead indicator is context-dependent, not a guaranteed outcome.",
    "cc_min": "Review whether key crowd-control abilities enabled useful picks or protected teammates; prioritise timing and target choice over seconds of CC.",
}


def _validate_tier(tier):
    if tier is not None and tier not in (*TIERS, "UNRANKED"):
        raise ValueError("Unknown Riot tier")


def _number(value, upper=None):
    if not isinstance(value, (int, float)):
        return None
    try:
        value = float(value)
    except OverflowError:
        return None
    if not math.isfinite(value) or value < 0 or (upper is not None and value > upper):
        return None
    return value


def _metric_number(key, value):
    return _number(value, 1 if perf.METRICS[key][1] == "pct" else None)


def _own_rows(db, games, puuid, patch, with_perf=False):
    ids = list(dict.fromkeys(g["match_id"] for g in games))
    rows = []
    columns = ", " + ", ".join(f'f."{k}"' for k in perf.COLUMNS) if with_perf else ""
    join = "LEFT JOIN perf f ON f.match_id = p.match_id AND f.puuid = p.puuid" if with_perf else ""
    for start in range(0, len(ids), SQL_CHUNK):
        chunk = ids[start:start + SQL_CHUNK]
        marks = ",".join("?" for _ in chunk)
        cursor = db.execute(
            f"""SELECT p.match_id, p.champion_id, p.position, p.win, m.game_start {columns}
                FROM participants p JOIN matches m ON m.match_id = p.match_id {join}
                WHERE p.puuid = ? AND m.patch = ? AND m.queue_id = ? AND m.remake = 0
                  AND p.match_id IN ({marks})""", (puuid, patch, SOLO_QUEUE, *chunk))
        names = [c[0] for c in cursor.description]
        rows.extend(dict(zip(names, row)) for row in cursor)
    return sorted(rows, key=lambda r: (r["game_start"], r["match_id"]))


def _population(tier, patch, puuid):
    where = """m.patch = ? AND m.queue_id = ? AND m.remake = 0
               AND NOT EXISTS (SELECT 1 FROM participants me
                               WHERE me.match_id = m.match_id AND me.puuid = ?)"""
    args = [patch, SOLO_QUEUE, puuid]
    if tier is not None:
        where += " AND EXISTS (SELECT 1 FROM match_tier tag WHERE tag.match_id = m.match_id AND tag.tier = ?)"
        args.append(tier)
    return where, args


def _gold_difference(minute):
    a, b = f"a{minute}.gold", f"b{minute}.gold"
    valid = " AND ".join(f"typeof({v}) IN ('integer', 'real') AND {v} >= 0 AND {v} <= 1e100" for v in (a, b))
    return f"CASE WHEN {valid} THEN {a} - {b} END"


def _pair_counts(db, where, args, role, opponent):
    difference10, difference15 = _gold_difference(10), _gold_difference(15)
    # Require exactly one participant per team in this role: ambiguous lanes must
    # not multiply WR samples or invent a lane-gold opponent.
    cursor = db.execute(
        f"""SELECT p.champion_id, o.champion_id, COUNT(*), SUM(p.win),
                   SUM({difference10}), COUNT({difference10}),
                   SUM({difference15}), COUNT({difference15})
            FROM participants p JOIN matches m ON m.match_id = p.match_id
            JOIN participants o ON o.match_id = p.match_id AND o.team_id != p.team_id AND o.position = p.position
            LEFT JOIN frames a10 ON a10.match_id = p.match_id AND a10.puuid = p.puuid AND a10.minute = 10
            LEFT JOIN frames b10 ON b10.match_id = o.match_id AND b10.puuid = o.puuid AND b10.minute = 10
            LEFT JOIN frames a15 ON a15.match_id = p.match_id AND a15.puuid = p.puuid AND a15.minute = 15
            LEFT JOIN frames b15 ON b15.match_id = o.match_id AND b15.puuid = o.puuid AND b15.minute = 15
            WHERE {where} AND p.position = ?
              AND (SELECT COUNT(*) FROM participants x WHERE x.match_id = p.match_id AND x.position = p.position AND x.team_id = p.team_id) = 1
              AND (SELECT COUNT(*) FROM participants x WHERE x.match_id = p.match_id AND x.position = p.position AND x.team_id != p.team_id) = 1
              {"AND o.champion_id = ?" if opponent is not None else ""}
            GROUP BY p.champion_id, o.champion_id""",
        (*args, role, *((opponent,) if opponent is not None else ())))
    return {(champ, opp): [n, w, s10 or 0, n10, s15 or 0, n15]
            for champ, opp, n, w, s10, n10, s15, n15 in cursor}


def _gold_summary(total, n):
    value = total / n if n >= MIN_GOLD_GAMES else None
    return {"mean": value if value is None or math.isfinite(value) else None, "games": n}


def _matchup_summary(counts):
    n, wins, total10, n10, total15, n15 = counts
    return {**stats.winrate(wins, n, CREDIBLE_LEVEL),
            "gold10": _gold_summary(total10, n10), "gold15": _gold_summary(total15, n15)}


def draft(db, games, puuid, tier, patch, role, opponent=None):
    """See the module contract. No recommendation is returned below sample floors."""
    _validate_tier(tier)
    if role not in perf.ROLES:
        raise ValueError("Unknown role")
    if opponent is not None and (type(opponent) is not int or opponent <= 0):
        raise ValueError("opponent must be a positive champion ID")
    with store.read_snapshot(db):
        own = [r for r in _own_rows(db, games, puuid, patch) if r["position"] == role]
        pool = Counter(r["champion_id"] for r in own)
        mine = {}
        ids = [r["match_id"] for r in own]
        for start in range(0, len(ids), SQL_CHUNK):
            chunk = ids[start:start + SQL_CHUNK]
            marks = ",".join("?" for _ in chunk)
            samples = _pair_counts(db, f"p.puuid = ? AND p.match_id IN ({marks})",
                                   (puuid, *chunk), role, opponent)
            for key, counts in samples.items():
                previous = mine.setdefault(key, [0] * 6)
                mine[key] = [a + b for a, b in zip(previous, counts)]
        where, args = _population(tier, patch, puuid)
        role_n, role_w = db.execute(
            f"""SELECT COUNT(*), COALESCE(SUM(p.win), 0) FROM participants p
                JOIN matches m ON m.match_id = p.match_id WHERE {where} AND p.position = ?""",
            (*args, role)).fetchone()
        prior = role_w / role_n if role_n else 0.5
        population = _pair_counts(db, where, args, role, opponent)
        matchups = []
        for champ, opp in population.keys() | mine.keys():
            counts = population.get((champ, opp), [0] * 6)
            matchups.append({"champion_id": champ, "opponent_id": opp,
                             **_matchup_summary(counts),
                             "score": stats.shrunk(counts[1], counts[0], prior, MATCHUP_PRIOR) if counts[0] else None,
                             "you": _matchup_summary(mine.get((champ, opp), [0] * 6))})
        matchups.sort(key=lambda r: (-(r["score"] if r["score"] is not None else -1),
                                     -r["games"], r["champion_id"], r["opponent_id"]))
        counters = []
        if opponent is not None:
            for row in matchups:
                played = pool[row["champion_id"]]
                if row["games"] >= MIN_MATCHUP_GAMES and played >= MIN_POOL_GAMES:
                    counters.append({**row, "pool_games": played, "reason": (
                        f"In your selected {role} pool ({played} games); {row['games']} peer matchup games. "
                        f"Ranked by WR shrunk with {MATCHUP_PRIOR} role-average pseudo-games, "
                        "not proof that the pick counters this opponent.")})
            counters = counters[:MAX_COUNTERS]
    note = (f"{POPULATION_NOTE} WR intervals are {CREDIBLE_LEVEL:.0%} Beta(1+w, 1+l) credible intervals; "
            f"score separately shrinks WR toward the role average using {MATCHUP_PRIOR} pseudo-games. "
            f"Gold is your role's gold minus the opposing role's gold at exactly 10/15 minutes; "
            f"means require {MIN_GOLD_GAMES} paired frames. Counters require {MIN_MATCHUP_GAMES} peer "
            f"matchup games and {MIN_POOL_GAMES} of your selected same-patch role games. "
            "Bot/support gold does not isolate a 1v1 effect. No cross-tier or cross-patch fallback.")
    return {"patch": patch, "tier": tier, "role": role, "opponent": opponent,
            "matchups": matchups, "counters": counters, "note": note}


def _valid_sql(key):
    value = f'f."{key}"'
    upper = 1 if perf.METRICS[key][1] == "pct" else 1e100
    return f"(typeof({value}) IN ('integer', 'real') AND {value} >= 0 AND {value} <= {upper})"


def _baseline(db, tier, patch, puuid, role, own_means):
    if tier not in TIERS:
        return {}
    keys = perf.role_metrics(role)
    expressions = []
    for key in keys:
        valid, value = _valid_sql(key), f'f."{key}"'
        # Parameters, not interpolated values, also keep missing means harmless.
        direction = "<" if perf.METRICS[key][2] == 1 else ">"
        expressions.extend((f"COUNT(CASE WHEN {valid} THEN 1 END)",
                            f"AVG(CASE WHEN {valid} THEN {value} END)",
                            f"SUM(CASE WHEN {valid} AND {value} {direction} ? THEN 1 ELSE 0 END)",
                            f"SUM(CASE WHEN {valid} AND {value} = ? THEN 1 ELSE 0 END)"))
    where, args = _population(tier, patch, puuid)
    row = db.execute(
        f"""SELECT {', '.join(expressions)} FROM participants p
            JOIN matches m ON m.match_id = p.match_id
            JOIN perf f ON f.match_id = p.match_id AND f.puuid = p.puuid
            WHERE {where} AND p.position = ?""",
        (*(v for key in keys for v in (own_means[key], own_means[key])), *args, role)).fetchone()
    out = {}
    for i, key in enumerate(keys):
        n, average, below, ties = row[i * 4:i * 4 + 4]
        out[key] = {"games": n, "value": average if n >= MIN_BASELINE_GAMES else None,
                    "percentile": 100 * ((below or 0) + (ties or 0) / 2) / n
                    if n >= MIN_BASELINE_GAMES and own_means[key] is not None else None}
    return out


def _values(rows, key):
    return [v for r in rows if (v := _metric_number(key, r[key])) is not None]


def _progress(rows, key):
    values = _values(rows, key)
    return {"value": mean(values) if len(values) >= MIN_PROGRESS_GAMES else None, "games": len(values)}


def _focus(metrics, tier, next_tier):
    candidates = []
    groups = {key: axis for axis, (_, keys) in perf.AXES.items() for key in keys}
    for metric in metrics:
        key, you = metric["key"], metric["you"]
        if not perf.METRICS[key][3] or metric["games"] < MIN_PLAYER_GAMES or you is None:
            continue
        baselines = [(metric["current"], tier), (metric["next"], next_tier)]
        baselines = [(v, t) for v, t in baselines if v is not None]
        if not baselines:
            continue
        benchmark, target_tier = max(baselines, key=lambda pair: pair[0] * metric["better"])
        gap = (benchmark - you) * metric["better"]
        if gap <= 0:
            continue
        severity = gap / max(abs(benchmark), 1)
        candidates.append((severity, key, {**metric, "target": you + (benchmark - you) / 2,
                                           "target_tier": target_tier, "advice": ADVICE[key]}))
    candidates.sort(key=lambda c: (-c[0], c[1]))
    focus, used = [], set()
    for _, key, entry in candidates:
        group = groups.get(key, key)
        if group not in used:
            focus.append(entry)
            used.add(group)
        if len(focus) == MAX_FOCUS:
            break
    return focus


def coaching(db, games, puuid, tier, patch):
    """Role-specific, per-metric comparisons; missing perf rows remain visible."""
    _validate_tier(tier)
    index = TIERS.index(tier) if tier in TIERS else -1
    next_tier = TIERS[index + 1] if 0 <= index < len(TIERS) - 1 else None
    roles = []
    with store.read_snapshot(db):
        own = _own_rows(db, games, puuid, patch, with_perf=True)
        for role in perf.ROLES:
            selected = [r for r in own if r["position"] == role]
            if not selected:
                continue
            keys = perf.role_metrics(role)
            values = {key: _values(selected, key) for key in keys}
            averages = {key: mean(v) if v else None for key, v in values.items()}
            current = _baseline(db, tier, patch, puuid, role, averages)
            following = _baseline(db, next_tier, patch, puuid, role, averages)
            metrics = []
            recent = selected[-PROGRESS_WINDOW:]
            previous = selected[-2 * PROGRESS_WINDOW:-PROGRESS_WINDOW]
            for key in keys:
                label, unit, better, *_ = perf.METRICS[key]
                baseline = current.get(key, {"value": None, "games": 0, "percentile": None})
                after = following.get(key, {"value": None, "games": 0})
                metrics.append({"key": key, "label": label, "unit": unit, "better": better,
                                "you": averages[key], "current": baseline["value"], "next": after["value"],
                                "percentile": baseline["percentile"] if len(values[key]) >= MIN_PLAYER_GAMES else None,
                                "games": len(values[key]), "baseline_games": baseline["games"], "next_games": after["games"],
                                "recent": _progress(recent, key), "previous": _progress(previous, key)})
            percentiles = {m["key"]: m["percentile"] for m in metrics}
            fingerprint = []
            for axis, (label, axis_keys) in perf.AXES.items():
                relevant = [percentiles[k] for k in axis_keys if k in percentiles]
                if not relevant:
                    continue
                valid = [v for v in relevant if v is not None]
                fingerprint.append({"key": axis, "label": "Death frequency (context matters)" if axis == "safety" else label,
                                    "percentile": mean(valid) if valid else None})
            focus = _focus(metrics, tier, next_tier)
            if focus:
                summary = "Try these modest practice targets, then review the next ten role games; targets are halfway toward a sampled peer mean, not promotion requirements. "
            else:
                summary = "No sufficiently sampled actionable gap is available; do not infer that no improvement is possible. "
            takeaway = (summary + f"Percentiles/goals require {MIN_PLAYER_GAMES} valid player samples and "
                        f"{MIN_BASELINE_GAMES} valid peer samples per metric. Recent/previous compare fixed "
                        f"{PROGRESS_WINDOW}-game windows within your selected range, needing "
                        f"{MIN_PROGRESS_GAMES} valid values each. " + POPULATION_NOTE +
                        " Fewer deaths, more aggression or a larger count are not universally beneficial; review the decisions and tradeoffs.")
            roles.append({"role": role, "games": len(selected), "metrics": metrics,
                          "fingerprint": fingerprint, "focus": focus, "takeaway": takeaway})
    return {"patch": patch, "tier": tier, "next_tier": next_tier, "roles": roles}


def _rank_state(row):
    row = dict(row)
    tier = row.get("tier")
    division = row.get("division", row.get("rank", ""))
    lp = row.get("lp", row.get("leaguePoints"))
    wins = row.get("wins", row.get("season_wins"))
    losses = row.get("losses", row.get("season_losses"))
    if tier not in TIERS or type(lp) is not int or type(wins) is not int or type(losses) is not int:
        return None
    if min(lp, wins, losses) < 0:
        return None
    if tier in TIERS[:7]:
        if division not in ("IV", "III", "II", "I") or lp >= 100:
            return None
        position = TIERS.index(tier) * 400 + ("IV", "III", "II", "I").index(division) * 100 + lp
    else:
        # Apex ranks share the same displayed LP ladder; tier cutoff LP depends
        # on region/time, so it is not another fixed 400-LP band.
        position = 7 * 400 + lp
    return {"tier": tier, "division": division, "lp": lp, "wins": wins, "losses": losses, "position": position}


def rank_forecast(ranks, profile):
    """Honest observed LP pace; do not bridge resets, corrections or stale data."""
    out = {"available": False, "reason": "insufficient_observations", "lp_per_game": None,
           "observations": 0, "games": 0, "net_lp": None, "target": None, "next_lp": None,
           "uncertainty": {"lp_per_game_lo": None, "lp_per_game_hi": None,
                           "estimated_games_lo": None, "estimated_games_hi": None}, "note": FORECAST_NOTE}
    profile = dict(profile or {})
    current = _rank_state(profile)
    if current is None:
        out["reason"] = "unranked" if profile.get("tier") in (None, "UNRANKED") else "invalid_profile"
        return out
    tier_index = TIERS.index(current["tier"])
    if tier_index < 7:
        out["target"] = {"tier": TIERS[tier_index + 1], "division": "IV" if tier_index < 6 else "I", "lp": 0}
        out["next_lp"] = (tier_index + 1) * 400 - current["position"]
    timed = {}
    for row in ranks:
        row = dict(row)
        state, at = _rank_state(row), row.get("at")
        if state is None or type(at) is not int or at < 0 or (at in timed and timed[at] != state):
            out["reason"] = "invalid_history"
            return out
        timed[at] = state
    segment = []
    reset = False
    for _, state in sorted(timed.items()):
        if segment:
            last = segment[-1]
            played = state["wins"] + state["losses"] - last["wins"] - last["losses"]
            if (state["wins"] < last["wins"] or state["losses"] < last["losses"]
                    or (played == 0 and state["position"] != last["position"])):
                segment = []
                reset = True
            elif played == 0:
                # Unchanged polls (including an apex-label change) are not new
                # observations of LP gained from games.
                segment[-1] = state
                continue
        segment.append(state)
    segment = segment[-MAX_RANK_OBSERVATIONS:]
    out["observations"] = len(segment)
    if reset:
        out["note"] += " History before the latest counter reset or LP change without games was excluded."
    if not segment:
        return out
    last = segment[-1]
    if any(last[k] != current[k] for k in ("tier", "lp", "wins", "losses")) or (
            current["tier"] in TIERS[:7] and last["division"] != current["division"]):
        out["reason"] = "stale_history"
        return out
    first = segment[0]
    games = last["wins"] + last["losses"] - first["wins"] - first["losses"]
    net = last["position"] - first["position"]
    out.update(games=games, net_lp=net, lp_per_game=net / games if games else None)
    paces = [(b["position"] - a["position"]) /
             (b["wins"] + b["losses"] - a["wins"] - a["losses"])
             for a, b in pairwise(segment)]
    if paces:
        out["uncertainty"].update(lp_per_game_lo=min(paces), lp_per_game_hi=max(paces))
    if len(segment) < MIN_RANK_OBSERVATIONS:
        return out
    if games < MIN_RANK_GAMES:
        out["reason"] = "insufficient_games"
        return out
    if net <= 0:
        out["reason"] = "negative_pace" if net < 0 else "zero_pace"
        return out
    if out["target"] is None:
        out["reason"] = "dynamic_apex_target"
        return out
    pace = out["lp_per_game"]
    out.update(available=True, reason="observed_positive_pace", estimated_games=math.ceil(out["next_lp"] / pace))
    low, high = min(paces), max(paces)
    out["uncertainty"].update(estimated_games_lo=math.ceil(out["next_lp"] / high),
                              estimated_games_hi=math.ceil(out["next_lp"] / low) if low > 0 else None)
    if low <= 0:
        out["note"] += " Some observed intervals were flat or negative, so the slow end has no finite games estimate."
    return out
