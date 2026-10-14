"""Per-game performance numbers for coaching, read from Riot's match JSON.

Each metric is one number per player per game, stored in the `perf` table so tier and role
averages are plain SQL. `better` is +1 when higher is better and -1 when lower is. `focus`
marks metrics a player can work on directly: gold per minute and damage share mostly follow
from winning, so they're compared but never suggested as a goal.
"""

from math import isfinite

ROLES = ("TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY")
LANERS = ("TOP", "MIDDLE", "BOTTOM")
CARRIES = ("TOP", "JUNGLE", "MIDDLE", "BOTTOM")


def _number(value, *, boolean=False):
    if isinstance(value, bool) and not boolean:
        return None
    if isinstance(value, (int, float)):
        try:
            return float(value) if isfinite(value) else None
        except OverflowError:
            pass
    return None


def _sum(source, keys):
    total = 0.0
    for key in keys:
        value = _number(source.get(key))
        if value is None or value < 0:
            return None
        total += value
    return total


def _per_min(value):
    def rate(p, ch, minutes):
        amount = _number(value(p, ch))
        return amount / minutes if amount is not None and minutes is not None else None
    return rate


METRICS = {
    # key: (label, unit, better, focus, roles, value(participant, challenges, minutes))
    "cs_min": ("CS per minute", "{:.1f}", 1, True, CARRIES,
               _per_min(lambda p, ch: _sum(p, ("totalMinionsKilled", "neutralMinionsKilled")))),
    "cs10": ("Lane CS at 10 minutes", "{:.0f}", 1, True, LANERS,
             lambda p, ch, m: ch.get("laneMinionsFirst10Minutes")),
    "jungle_cs10": ("Jungle CS at 10 minutes", "{:.0f}", 1, True, ("JUNGLE",),
                    lambda p, ch, m: ch.get("jungleCsBefore10Minutes")),
    "deaths": ("Deaths per game", "{:.1f}", -1, True, ROLES, lambda p, ch, m: p.get("deaths")),
    "kp": ("Kill participation", "pct", 1, True, ROLES, lambda p, ch, m: ch.get("killParticipation")),
    "vision_min": ("Vision score per minute", "{:.2f}", 1, True, ROLES, lambda p, ch, m: ch.get("visionScorePerMinute")),
    "control_wards": ("Control wards placed", "{:.1f}", 1, True, ROLES, lambda p, ch, m: ch.get("controlWardsPlaced")),
    "ward_kills": ("Wards destroyed", "{:.1f}", 1, True, ("JUNGLE", "UTILITY"), lambda p, ch, m: ch.get("wardTakedowns")),
    "solo_kills": ("Solo kills", "{:.1f}", 1, True, LANERS, lambda p, ch, m: ch.get("soloKills")),
    "early_takedowns": ("Early takedowns", "{:.1f}", 1, True, ROLES, lambda p, ch, m: ch.get("takedownsFirstXMinutes")),
    "plates": ("Turret plates", "{:.1f}", 1, True, LANERS, lambda p, ch, m: ch.get("turretPlatesTaken")),
    "objectives": ("Epic monster takedowns", "{:.1f}", 1, True, ("JUNGLE", "UTILITY", "MIDDLE"),
                   lambda p, ch, m: _sum(ch, ("dragonTakedowns", "baronTakedowns", "riftHeraldTakedowns"))),
    "lane_lead": ("Ahead after laning", "pct", 1, True, ("TOP", "MIDDLE", "BOTTOM", "UTILITY"),
                  lambda p, ch, m: ch.get("laningPhaseGoldExpAdvantage")),
    "cc_min": ("Crowd control per minute", "{:.1f}s", 1, True, ("UTILITY",), _per_min(lambda p, ch: p.get("timeCCingOthers"))),
    "dmg_share": ("Share of team damage", "pct", 1, False, CARRIES, lambda p, ch, m: ch.get("teamDamagePercentage")),
    "gold_min": ("Gold per minute", "{:.0f}", 1, False, ROLES, lambda p, ch, m: ch.get("goldPerMinute")),
}
COLUMNS = tuple(METRICS)

# the playstyle fingerprint: each axis averages the percentiles of the metrics it has for the role
AXES = {
    "farming": ("Farming", ("cs_min", "cs10", "jungle_cs10")),
    "fighting": ("Fighting", ("kp", "dmg_share")),
    "aggression": ("Aggression", ("solo_kills", "early_takedowns")),
    "vision": ("Vision", ("vision_min", "control_wards", "ward_kills")),
    "objectives": ("Objectives", ("objectives", "plates")),
    "control": ("Crowd control", ("cc_min",)),
    "safety": ("Staying alive", ("deaths",)),
}


def values(p, minutes, participants=None):
    """{metric: finite number or None}; missing counters are not observed zeros.

    The optional third argument is the match's complete participant list. It
    permits KP/team-damage fallback from explicit teamId totals, never from
    participant ordering or guessed team sizes. The two-argument API remains.
    """
    ch = p.get("challenges")
    ch = ch if isinstance(ch, dict) else {}
    minutes = _number(minutes)
    if minutes is not None and minutes <= 0:
        minutes = None
    out = {}
    for key, (*_, value) in METRICS.items():
        try:
            v = value(p, ch, minutes)
        except (TypeError, ZeroDivisionError, OverflowError):
            v = None
        out[key] = _number(v, boolean=key == "lane_lead")
        if out[key] is not None and (out[key] < 0 or key in ("kp", "dmg_share", "lane_lead") and out[key] > 1):
            out[key] = None
    for metric, counter in (("vision_min", "visionScore"), ("gold_min", "goldEarned")):
        amount = _number(p.get(counter))
        if out[metric] is None and minutes is not None and amount is not None and amount >= 0:
            out[metric] = _number(amount / minutes)
    for metric, counter in (("control_wards", "detectorWardsPlaced"), ("ward_kills", "wardsKilled")):
        amount = _number(p.get(counter))
        if out[metric] is None and amount is not None and amount >= 0:
            out[metric] = amount
    team = p.get("teamId")
    if participants is not None and team is not None:
        people = list(participants)
        teammates = [other for other in people if other.get("teamId") == team]
        present = any(other is p or p.get("puuid") and other.get("puuid") == p["puuid"] for other in teammates)
        if present and all(other.get("teamId") is not None for other in people):
            for metric, counter, numerator in (("kp", "kills", _sum(p, ("kills", "assists"))),
                                                ("dmg_share", "totalDamageDealtToChampions",
                                                 _number(p.get("totalDamageDealtToChampions")))):
                amounts = [_number(other.get(counter)) for other in teammates]
                if out[metric] is None and numerator is not None and numerator >= 0 \
                        and all(v is not None and v >= 0 for v in amounts):
                    total = sum(v for v in amounts if v is not None)
                    if isfinite(total) and numerator <= total:
                        out[metric] = numerator / total if total else 0.0
    return out


def role_metrics(role):
    return [k for k, m in METRICS.items() if role in m[4]]
