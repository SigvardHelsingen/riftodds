"""Player-centred probability stats computed from the local match cache.

Win rates are treated as Beta posteriors with a uniform prior: after w wins and
l losses, the true win rate ~ Beta(1 + w, 1 + l). That gives honest credible
intervals and lets us say "P(this player is better than their rank on X)".
"""
import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from functools import wraps
from itertools import combinations
from statistics import NormalDist, median
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import store
import timeline

ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
SESSION_GAP_MS = 30 * 60 * 1000  # a new "session" starts after 30 min idle



def _snapshot(func):
    @wraps(func)
    def wrapped(db, *args, **kwargs):
        with store.read_snapshot(db):
            return func(db, *args, **kwargs)
    return wrapped


# --- probability helpers ------------------------------------------------------

def _beta_cf(a, b, x):
    """Continued fraction for the incomplete beta function (modified Lentz).

    Converges in O(sqrt(max(a, b))) steps when x < (a + 1) / (a + b + 2)."""
    tiny = 1e-300
    c, d = 1.0, 1.0 - (a + b) * x / (a + 1)
    d = 1.0 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 10000):
        delta = 1.0
        for num in (m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)),
                    -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))):
            d = 1.0 + num * d
            d = 1.0 / (d if abs(d) > tiny else tiny)
            c = 1.0 + num / c
            c = c if abs(c) > tiny else tiny
            delta = d * c
            h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    return h


def beta_sf(x, a, b):
    """P(X > x) for X ~ Beta(a, b): exact at any sample size (regularized incomplete beta)."""
    if x <= 0:
        return 1.0
    if x >= 1:
        return 0.0
    front = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
                     + a * math.log(x) + b * math.log1p(-x))
    if x < (a + 1) / (a + b + 2):
        return 1.0 - front * _beta_cf(a, b, x) / a
    return front * _beta_cf(b, a, 1.0 - x) / b  # the symmetric side, without cancellation


def beta_quantile(q, a, b):
    """x with P(X <= x) = q: Newton steps from a normal guess, kept inside a bisection bracket."""
    mean = a / (a + b)
    sd = math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
    x = min(max(NormalDist(mean, sd).inv_cdf(q), 1e-12), 1 - 1e-12)
    log_norm = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    lo, hi = 0.0, 1.0
    for _ in range(100):
        cdf = 1.0 - beta_sf(x, a, b)
        if cdf < q:
            lo = x
        else:
            hi = x
        pdf = math.exp(log_norm + (a - 1) * math.log(x) + (b - 1) * math.log1p(-x))
        nxt = x - (cdf - q) / pdf if pdf > 0 else lo
        if not lo < nxt < hi:
            nxt = (lo + hi) / 2
        if abs(nxt - x) < 1e-12:
            return nxt
        x = nxt
    return x


def prob_greater(a1, b1, a2, b2, bins=500):
    """P(X > Y) for independent X ~ Beta(a1, b1), Y ~ Beta(a2, b2), by grid integration."""
    xs = [(i + 0.5) / bins for i in range(bins)]

    def pmf(a, b):
        logs = [(a - 1) * math.log(x) + (b - 1) * math.log1p(-x) for x in xs]
        top = max(logs)
        w = [math.exp(l - top) for l in logs]
        s = sum(w)
        return [v / s for v in w]

    px, py = pmf(a1, b1), pmf(a2, b2)
    total, above = 0.0, 1.0  # `above` = P(X in a bin strictly higher than i)
    for i in range(bins):
        above -= px[i]
        total += py[i] * (above + px[i] / 2)
    return min(1.0, max(0.0, total))


def winrate(wins, games, ci=0.9):
    """Observed WR plus a central credible interval from Beta(1+w, 1+l)."""
    if games <= 0:
        return {"games": 0, "wins": 0, "wr": None, "lo": None, "hi": None}
    wins = min(max(wins, 0), games)
    a, b = 1 + wins, 1 + games - wins
    tail = (1 - ci) / 2
    return {"games": games, "wins": wins, "wr": wins / games,
            "lo": beta_quantile(tail, a, b), "hi": beta_quantile(1 - tail, a, b)}


def wr_of(games):
    return winrate(sum(g["win"] for g in games), len(games))


# --- loading ------------------------------------------------------------------

def player_games(db, puuid, queue=420):
    """The player's non-remake games, oldest first, with lane opponent + team objectives."""
    rows = db.execute(
        """
        SELECT m.match_id, m.game_start, m.duration, m.patch,
               p.champion_id, p.position, p.win, p.team_id, p.kills, p.deaths, p.assists,
               p.cs, p.gold, p.damage, p.vision, p.lane_adv,
               (SELECT SUM(o.kills) FROM participants o
                 WHERE o.match_id = p.match_id AND o.team_id = p.team_id) AS team_kills,
               (SELECT o.champion_id FROM participants o
                 WHERE o.match_id = p.match_id AND o.team_id != p.team_id
                   AND o.position = p.position AND o.position != '') AS opp_champ,
               t.first_blood, t.first_tower, t.first_dragon
        FROM participants p
        JOIN matches m ON m.match_id = p.match_id
        JOIN teams t ON t.match_id = p.match_id AND t.team_id = p.team_id
        WHERE p.puuid = ? AND m.queue_id = ? AND m.remake = 0
        ORDER BY m.game_start
        """,
        (puuid, queue),
    ).fetchall()
    return [dict(r) for r in rows]


# --- overview -----------------------------------------------------------------

SERIES_FIELDS = ("match_id", "game_start", "win", "champion_id", "position", "kills", "deaths", "assists", "cs", "gold", "damage",
                 "vision", "duration", "team_kills", "lane_diff15", "team_diff15")


def game_series(games):
    """Per-game numbers for the profile chart, oldest first (the client derives KDA, per-minute rates...)."""
    return [{k: g.get(k) for k in SERIES_FIELDS} for g in games]


def _pool(games):
    """How predictable is the player's champion choice?"""
    counts = Counter(g["champion_id"] for g in games)
    n = len(games)
    probs = [c / n for c in counts.values()]
    entropy = -sum(p * math.log(p) for p in probs)
    top = counts.most_common(3)
    return {
        "games": n,
        "distinct": len(counts),
        "effective_pool": math.exp(entropy),  # "plays like an N-champion pool"
        "top1_share": top[0][1] / n,
        "top3_share": sum(c for _, c in top) / n,
        "top": [{"champion_id": c, "share": k / n} for c, k in top],
    }


def _sessions(games):
    sessions, current, last_end = [], [], None
    for g in games:
        if last_end is not None and g["game_start"] - last_end > SESSION_GAP_MS:
            sessions.append(current)
            current = []
        current.append(g)
        last_end = g["game_start"] + g["duration"] * 1000
    if current:
        sessions.append(current)
    return sessions


def _momentum(games):
    after_win, after_loss, after_2losses = [], [], []
    swap_after_win, swap_after_loss = [], []
    by_index = defaultdict(list)
    for s in _sessions(games):
        for i, g in enumerate(s):
            by_index[min(i + 1, 4)].append(g)
            if i == 0:
                continue
            prev = s[i - 1]
            (after_win if prev["win"] else after_loss).append(g)
            (swap_after_win if prev["win"] else swap_after_loss).append(
                g["champion_id"] != prev["champion_id"])
            if i >= 2 and not prev["win"] and not s[i - 2]["win"]:
                after_2losses.append(g)
    share = lambda xs: {"n": len(xs), "p": sum(xs) / len(xs) if xs else None}
    sessions = _sessions(games)
    return {
        "sessions": len(sessions),
        "avg_session_len": len(games) / len(sessions) if sessions else 0,
        "after_win": wr_of(after_win),
        "after_loss": wr_of(after_loss),
        "after_2_losses": wr_of(after_2losses),
        "by_game_in_session": [{"label": f"Game {i}" if i < 4 else "Game 4+", **wr_of(by_index[i])}
                               for i in sorted(by_index)],
        "swap_after_win": share(swap_after_win),
        "swap_after_loss": share(swap_after_loss),
    }


def _bucketed(games, key, buckets):
    out = []
    for label, test in buckets:
        out.append({"label": label, **wr_of([g for g in games if test(key(g))])})
    return out


def _conditional(games, label, pred):
    yes = [g for g in games if pred(g) is True]
    no = [g for g in games if pred(g) is False]
    return {"label": label, "yes": wr_of(yes), "no": wr_of(no)}


def _lane_ahead(g):
    """Ahead of the lane opponent in gold at 15 (timeline), else Riot's coarse laning flag."""
    if g.get("lane_diff15") is not None:
        return g["lane_diff15"] > 0
    return None if g["lane_adv"] is None else bool(g["lane_adv"])


def local_zone(name=None, offset_min=0):
    """The viewer's time zone: an IANA name follows daylight saving per game; else a fixed
    offset in minutes behind UTC, as JavaScript's getTimezoneOffset() reports it."""
    if name:
        try:
            return ZoneInfo(name)
        except (ValueError, ZoneInfoNotFoundError):
            pass
    return timezone(-timedelta(minutes=offset_min))


def overview(games, tz=timezone.utc):
    local = lambda g: datetime.fromtimestamp(g["game_start"] / 1000, tz)
    by_role = defaultdict(list)
    for g in games:
        by_role[g["position"] or "UNKNOWN"].append(g)
    n = len(games)
    return {
        "record": wr_of(games),
        "roles": [
            {"role": r, "share": len(gs) / n, **wr_of(gs), "pool": _pool(gs)}
            for r, gs in sorted(by_role.items(), key=lambda kv: -len(kv[1]))
        ],
        "momentum": _momentum(games),
        "time_of_day": _bucketed(games, lambda g: local(g).hour, [
            ("Night 00–06", lambda h: h < 6), ("Morning 06–12", lambda h: 6 <= h < 12),
            ("Afternoon 12–18", lambda h: 12 <= h < 18), ("Evening 18–24", lambda h: h >= 18)]),
        "duration": _bucketed(games, lambda g: g["duration"] / 60, [
            ("< 25 min", lambda m: m < 25), ("25–30 min", lambda m: 25 <= m < 30),
            ("30–35 min", lambda m: 30 <= m < 35), ("35+ min", lambda m: m >= 35)]),
        "conversion": [
            _conditional(games, "Your team took first blood", lambda g: bool(g["first_blood"])),
            _conditional(games, "Your team took first tower", lambda g: bool(g["first_tower"])),
            _conditional(games, "Your team took first dragon", lambda g: bool(g["first_dragon"])),
            _conditional(games, "You were ahead in lane at 15", _lane_ahead),
            _conditional(games, "You died 4 times or fewer", lambda g: g["deaths"] <= 4),
        ],
    }


# --- pick probability -----------------------------------------------------------

def pick_probabilities(games, role, opp=None, alpha=5.0):
    """P(champion | role) and P(champion | role, lane opponent).

    The matchup-conditional estimate is shrunk towards the role prior with a
    Dirichlet(alpha * prior) pseudo-count, so 1-2 games vs a champion don't
    produce a 100% prediction:  (k + alpha * P(c|role)) / (n + alpha).
    """
    if not math.isfinite(alpha) or alpha < 0:
        raise ValueError("alpha must be finite and nonnegative")
    in_role = [g for g in games if g["position"] == role]
    n = len(in_role)
    if n == 0:
        return {"role": role, "games": 0, "rows": [], "opponents": []}
    prior = Counter(g["champion_id"] for g in in_role)
    vs = [g for g in in_role if opp is not None and g["opp_champ"] == opp]
    vs_counts = Counter(g["champion_id"] for g in vs)
    rows = []
    for champ, k in prior.items():
        p_role = k / n
        mine = [g for g in in_role if g["champion_id"] == champ]
        row = {"champion_id": champ, "games": k, "p_role": p_role, "wr": wr_of(mine)}
        if opp is not None:
            kv = vs_counts.get(champ, 0)
            row["games_vs"] = kv
            row["p_vs"] = (kv + alpha * p_role) / (len(vs) + alpha) if vs or alpha else p_role
            row["wr_vs"] = wr_of([g for g in vs if g["champion_id"] == champ])
        rows.append(row)
    rows.sort(key=lambda r: -(r.get("p_vs", r["p_role"])))
    opponents = Counter(g["opp_champ"] for g in in_role if g["opp_champ"])
    return {
        "role": role, "games": n, "opp": opp, "games_vs_opp": len(vs), "alpha": alpha,
        "rows": rows,
        "opponents": [{"champion_id": c, "games": k} for c, k in opponents.most_common()],
    }


# --- champion vs rank baseline ------------------------------------------------

@_snapshot
def champions_vs_rank(db, games, puuid, tier, queue=420):
    """Player WR per champion vs. everyone else's WR on it in matches tagged with `tier`."""
    # computed fresh: the player's own games arrive while their profile loads, so a cached
    # total minus their current rows would go out of sync (and negative)
    base = {
        r["champion_id"]: (r["games"], r["wins"])
        for r in db.execute(
            """
            SELECT p.champion_id, COUNT(*) AS games, SUM(p.win) AS wins
            FROM participants p
            JOIN match_tier mt ON mt.match_id = p.match_id AND mt.tier = ?
            JOIN matches m ON m.match_id = p.match_id
            WHERE p.puuid != ? AND m.queue_id = ? AND m.remake = 0
            GROUP BY p.champion_id
            """,
            (tier, puuid, queue),
        )
    }
    sample_matches = db.execute(
        """SELECT COUNT(*) FROM match_tier mt JOIN matches m ON m.match_id = mt.match_id
           WHERE mt.tier = ? AND m.queue_id = ? AND m.remake = 0""", (tier, queue)).fetchone()[0]
    by_champ = defaultdict(list)
    for g in games:
        by_champ[g["champion_id"]].append(g)
    rows = []
    for champ, gs in by_champ.items():
        mine = wr_of(gs)
        bg, bw = base.get(champ, (0, 0))
        baseline = winrate(bw, bg)
        row = {"champion_id": champ, "player": mine, "baseline": baseline,
               "delta": None, "p_better": None}
        if bg:
            row["delta"] = mine["wr"] - bw / bg
            # both sides are uncertain: compare the two posteriors, not you vs a point estimate
            row["p_better"] = prob_greater(1 + mine["wins"], 1 + mine["games"] - mine["wins"],
                                           1 + bw, 1 + bg - bw)
        rows.append(row)
    rows.sort(key=lambda r: -r["player"]["games"])
    return {"tier": tier, "sample_matches": sample_matches, "rows": rows}


# --- patch overview (landing page) ----------------------------------------------

def _patch_key(p):
    return tuple(int(x) for x in p.split(".") if x.isdigit())


def latest_patch(db, queue=420, before=None):
    """The newest patch with cached games (only patches older than `before`, if given)."""
    patches = [r[0] for r in db.execute(
        "SELECT DISTINCT patch FROM matches WHERE queue_id = ? AND remake = 0", (queue,))]
    if before:
        patches = [p for p in patches if _patch_key(p) < _patch_key(before)]
    return max(patches, key=_patch_key) if patches else None


@_snapshot
def patch_overview(db, patch, tier=None, queue=420):
    """Population stats for one patch, optionally restricted to games tagged with `tier`."""
    where = "m.patch = ? AND m.queue_id = ? AND m.remake = 0"
    args = [patch, queue]
    if tier:
        where += " AND m.match_id IN (SELECT match_id FROM match_tier WHERE tier = ?)"
        args.append(tier)
    one = lambda sql: db.execute(sql.format(where=where), args).fetchone()
    many = lambda sql: db.execute(sql.format(where=where), args).fetchall()

    matches, avg_duration = one("SELECT COUNT(*), AVG(m.duration) FROM matches m WHERE {where}")
    tiers = [{"tier": t, "matches": n} for t, n in db.execute(
        """SELECT mt.tier, COUNT(*) FROM match_tier mt JOIN matches m ON m.match_id = mt.match_id
           WHERE m.patch = ? AND m.queue_id = ? AND m.remake = 0 GROUP BY mt.tier""", (patch, queue))]
    if not matches:
        return {"patch": patch, "tier": tier, "matches": 0, "tiers": tiers}

    blue_wins, blue_games = one(
        "SELECT SUM(t.win), COUNT(*) FROM teams t JOIN matches m ON m.match_id = t.match_id "
        "WHERE {where} AND t.team_id = 100")
    objectives = []
    for col, label in [("first_blood", "First blood"), ("first_tower", "First tower"),
                       ("first_dragon", "First dragon"), ("first_herald", "First herald")]:
        w, n = one(f"SELECT SUM(t.win), COUNT(*) FROM teams t JOIN matches m ON m.match_id = t.match_id "
                   f"WHERE {{where}} AND t.{col} = 1")
        objectives.append({"label": label, **winrate(w or 0, n)})
    objectives.sort(key=lambda o: -(o["wr"] or 0))

    roles = defaultdict(Counter)
    for champ, pos, n in many(
            "SELECT p.champion_id, p.position, COUNT(*) FROM participants p "
            "JOIN matches m ON m.match_id = p.match_id WHERE {where} GROUP BY 1, 2"):
        roles[champ][pos or "UNKNOWN"] += n
    bans = dict(many("SELECT b.champion_id, COUNT(DISTINCT b.match_id) FROM bans b "
                     "JOIN matches m ON m.match_id = b.match_id WHERE {where} GROUP BY 1"))
    champions = []
    for champ, games, wins in many(
            "SELECT p.champion_id, COUNT(*), SUM(p.win) FROM participants p "
            "JOIN matches m ON m.match_id = p.match_id WHERE {where} GROUP BY 1"):
        role, role_games = roles[champ].most_common(1)[0]
        champions.append({
            "champion_id": champ, "role": role, "role_share": role_games / games,
            "pick_rate": games / matches, "ban_rate": bans.get(champ, 0) / matches,
            **winrate(wins, games),
        })
    for champ, n in bans.items():  # banned but never picked
        if champ not in roles:
            champions.append({"champion_id": champ, "role": None, "role_share": None, "pick_rate": 0,
                              "ban_rate": n / matches, **winrate(0, 0)})
    return {
        "patch": patch, "tier": tier, "matches": matches, "tiers": tiers,
        "avg_duration": avg_duration,
        "blue_side": winrate(blue_wins or 0, blue_games),
        "objectives": objectives,
        "champions": champions,
    }


# --- gold leads at 15 (from timelines) -----------------------------------------

LEAD_MINUTE = 15
LEAD_BUCKETS = [  # team gold difference at 15:00
    ("Behind 3k+", lambda d: d <= -3000),
    ("Behind 1–3k", lambda d: -3000 < d <= -1000),
    ("Even (±1k)", lambda d: -1000 < d < 1000),
    ("Ahead 1–3k", lambda d: 1000 <= d < 3000),
    ("Ahead 3k+", lambda d: d >= 3000),
]


def attach_gold(db, games, puuid):
    """Add team_diff15 / lane_diff15 (player's team minus enemy, player minus lane opponent)."""
    if not games:
        return games
    match_ids = list(dict.fromkeys(g["match_id"] for g in games))
    by_match = defaultdict(list)
    with store.read_snapshot(db):
        for i in range(0, len(match_ids), 500):  # stay below SQLite's legacy 999-variable limit
            chunk = match_ids[i:i + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows = db.execute(
                f"""SELECT f.match_id, p.puuid, p.team_id, p.position, f.gold
                    FROM frames f JOIN participants p ON p.match_id = f.match_id AND p.puuid = f.puuid
                    WHERE f.minute = ? AND f.match_id IN ({placeholders})""",
                (LEAD_MINUTE, *chunk)).fetchall()
            for mid, who, team, pos, gold in rows:
                by_match[mid].append((who, team, pos, gold))
    for g in games:
        g["team_diff15"] = g["lane_diff15"] = None
        ps = by_match.get(g["match_id"])
        if not ps or len(ps) < 10:
            continue
        g["team_diff15"] = sum(gold if team == g["team_id"] else -gold for _, team, _, gold in ps)
        mine = next((gold for who, *_ , gold in ps if who == puuid), None)
        opp = next((gold for _, team, pos, gold in ps if team != g["team_id"] and pos == g["position"] and pos), None)
        if mine is not None and opp is not None:
            g["lane_diff15"] = mine - opp
    return games


def _team_leads(db, where, args):
    """(match_id, gold diff at 15, win) for every team in matches matching `where` (alias m = matches)."""
    return db.execute(
        f"""WITH tg AS (
              SELECT f.match_id, p.team_id, SUM(f.gold) AS gold, MAX(p.win) AS win, COUNT(*) AS n
              FROM frames f
              JOIN participants p ON p.match_id = f.match_id AND p.puuid = f.puuid
              JOIN matches m ON m.match_id = f.match_id
              WHERE f.minute = {LEAD_MINUTE} AND m.remake = 0 AND {where}
              GROUP BY f.match_id, p.team_id)
            SELECT a.match_id, a.gold - b.gold, a.win FROM tg a
            JOIN tg b ON a.match_id = b.match_id AND a.team_id != b.team_id
            WHERE a.n = 5 AND b.n = 5""", args)


def lead_curve(rows):
    """Summarize a stream of teams in five counters, without retaining every timeline row."""
    counts = [[0, 0] for _ in LEAD_BUCKETS]
    n = 0
    for diff, win in rows:
        n += 1
        for i, (_, test) in enumerate(LEAD_BUCKETS):
            if test(diff):
                counts[i][0] += 1
                counts[i][1] += win
                break
    return [{"label": label, "share": games / n if n else None, **winrate(wins, games)}
            for (label, _), (games, wins) in zip(LEAD_BUCKETS, counts)]


def player_leads(db, games, puuid, tier, queue=420):
    """The player's lead-to-win curve vs their rank, plus comeback / close-out rates and laning."""
    mine = [(g["team_diff15"], g["win"]) for g in games if g.get("team_diff15") is not None]
    with store.read_snapshot(db):
        rank_rows = _team_leads(
            db, """m.queue_id = ? AND m.match_id IN (SELECT match_id FROM match_tier WHERE tier = ?)
                   AND m.match_id NOT IN (SELECT match_id FROM participants WHERE puuid = ?)""", (queue, tier, puuid))
        base = lead_curve((d, w) for _, d, w in rank_rows)
    you = lead_curve(mine)
    rate = lambda buckets: winrate(sum(b["wins"] for b in buckets), sum(b["games"] for b in buckets))
    lane = [g["lane_diff15"] for g in games if g.get("lane_diff15") is not None]
    return {
        "games_with_timeline": len(mine),
        "rank_games": sum(b["games"] for b in base) // 2,
        "curve": [{"label": y["label"], "share": y["share"], "you": {k: y[k] for k in ("games", "wins", "wr", "lo", "hi")},
                   "rank": {k: b[k] for k in ("games", "wins", "wr", "lo", "hi")}} for y, b in zip(you, base)],
        "comeback": {"you": rate(you[:2]), "rank": rate(base[:2])},    # win when behind 1k+
        "close_out": {"you": rate(you[3:]), "rank": rate(base[3:])},  # win when ahead 1k+
        "lane": {
            "games": len(lane),
            "ahead_share": sum(1 for d in lane if d > 0) / len(lane) if lane else None,
            "avg_diff": sum(lane) / len(lane) if lane else None,
        },
    }


def patch_lead_curve(db, patch, tier=None, queue=420):
    where, args = "m.patch = ? AND m.queue_id = ?", [patch, queue]
    if tier:
        where += " AND m.match_id IN (SELECT match_id FROM match_tier WHERE tier = ?)"
        args.append(tier)
    with store.read_snapshot(db):
        curve = lead_curve((d, w) for _, d, w in _team_leads(db, where, args))
    return {"games": sum(b["games"] for b in curve) // 2, "curve": curve}


# --- mastery --------------------------------------------------------------------

@_snapshot
def mastery(db, puuid, games, pockets=6):
    """Mastery per champion, plus high-mastery champions not played in `games` ("pocket picks")."""
    rows = db.execute("SELECT champion_id, level, points, last_play FROM mastery WHERE puuid = ? ORDER BY points DESC",
                      (puuid,)).fetchall()
    played = {g["champion_id"] for g in games}
    by_champ = {c: {"level": lv, "points": pts, "last_play": lp} for c, lv, pts, lp in rows}
    return {
        "by_champion": by_champ,
        "total_points": sum(r[2] for r in rows),
        "pockets": [{"champion_id": c, "level": lv, "points": pts, "last_play": lp}
                    for c, lv, pts, lp in rows if c not in played][:pockets],
    }


# --- builds and suggested picks ------------------------------------------------------

PICK_PRIOR = 50         # pseudo-games pulling a champion's win rate towards its role's average
BUILD_PRIOR = 20        # pseudo-games pulling a build option's win rate towards the champion's
MIN_PICK_GAMES = 15     # games a champion needs in a role before it can be suggested
MIN_BUILD_GAMES = 5     # games a build option needs (and MIN_BUILD_SHARE of the champion's) to be ranked
MIN_BUILD_SHARE = 0.05
MIN_TIER_MATCHES = 300  # below this many sampled games in the player's tier, suggestions use every tier


def shrunk(wins, games, mean, k):
    """Win rate pulled towards `mean` by k pseudo-games, so 3-0 doesn't outrank 300-200."""
    return (wins + k * mean) / (games + k)


def _population(patch, tier, queue):
    where, args = "m.patch = ? AND m.queue_id = ? AND m.remake = 0", [patch, queue]
    if tier:
        where += " AND m.match_id IN (SELECT match_id FROM match_tier WHERE tier = ?)"
        args.append(tier)
    return where, args


@_snapshot
def role_champions(db, patch, role, tier=None, queue=420):
    """[(champion_id, games, wins)] for everyone who played `role` on `patch` (optionally in `tier`)."""
    where, args = _population(patch, tier, queue)
    return [tuple(r) for r in db.execute(
        f"""SELECT p.champion_id, COUNT(*), SUM(p.win) FROM participants p JOIN matches m ON m.match_id = p.match_id
            WHERE {where} AND p.position = ? GROUP BY p.champion_id""", (*args, role))]


def _ranked(table, mean, n):
    """Options for one build choice ({key: [games, wins]}) as (key, games, wins), best first: those
    played often enough by shrunk win rate; if none is, just the most played one."""
    floor = max(MIN_BUILD_GAMES, MIN_BUILD_SHARE * n)
    options = [(key, g, w) for key, (g, w) in table.items() if g >= floor]
    if options:
        return sorted(options, key=lambda o: -shrunk(o[2], o[1], mean, BUILD_PRIOR))
    return sorted(((key, g, w) for key, (g, w) in table.items()), key=lambda o: -o[1])[:1]


@_snapshot
def champion_build(db, champion_id, role, patch, items, tier=None, queue=420):
    """The most successful core items, boots, runes and summoner spells for a champion in a role.

    `items` is Data Dragon's {itemId: {completed, boots, support}}. The core comes from final
    inventories (three finished items from the same game, most-built first); games with a
    timeline add the actual purchase order, starting items and skill order (`order`)."""
    where, args = _population(patch, tier, queue)
    rows = db.execute(
        f"""SELECT b.items, b.keystone, b.primary_style, b.sub_style, b.spells, p.win
            FROM participants p JOIN matches m ON m.match_id = p.match_id
            JOIN builds b ON b.match_id = p.match_id AND b.puuid = p.puuid
            WHERE {where} AND p.champion_id = ? AND p.position = ?""", (*args, champion_id, role))
    n = wins = 0
    tables = defaultdict(lambda: defaultdict(lambda: [0, 0]))

    def add(kind, key, win):
        tables[kind][key][0] += 1
        tables[kind][key][1] += win

    for item_list, keystone, primary, sub, spells, win in rows:
        n += 1
        wins += win
        ids = [int(i) for i in (item_list or "").split(",") if i]
        finished = sorted({i for i in ids if items.get(i, {}).get("completed")})
        for i in finished:
            add("item", i, win)
        for trio in combinations(finished, 3):
            add("core", trio, win)
        for kind in ("boots", "support"):
            for i in {i for i in ids if items.get(i, {}).get(kind)}:
                add(kind, i, win)
        if keystone:
            add("runes", (keystone, primary, sub), win)
        if spells:
            add("spells", spells, win)
    out = {"champion_id": champion_id, "role": role, "patch": patch, "tier": tier, **winrate(wins, n),
           "core": [], "boots": [], "support": [], "runes": [], "spells": [], "situational": []}
    if not n:
        return out
    mean = wins / n
    entry = lambda g, w: {**winrate(w, g), "share": g / n}
    built = {i: g for i, (g, _) in tables["item"].items()}
    out["core"] = [{"items": sorted(trio, key=lambda i: -built[i]), **entry(g, w)}
                   for trio, g, w in _ranked(tables["core"], mean, n)[:3]]
    out["boots"] = [{"item": i, **entry(g, w)} for i, g, w in _ranked(tables["boots"], mean, n)[:2]]
    out["support"] = [{"item": i, **entry(g, w)} for i, g, w in _ranked(tables["support"], mean, n)[:1]]
    out["runes"] = [{"keystone": k, "primary": p, "secondary": s, **entry(g, w)}
                    for (k, p, s), g, w in _ranked(tables["runes"], mean, n)[:2]]
    out["spells"] = [{"spells": [int(x) for x in key.split(",")], **entry(g, w)}
                     for key, g, w in _ranked(tables["spells"], mean, n)[:1]]
    in_core = set(out["core"][0]["items"]) if out["core"] else set()
    floor = max(MIN_BUILD_GAMES, MIN_BUILD_SHARE * n)
    out["situational"] = [{"item": i, **entry(g, w)} for i, (g, w) in sorted(
        tables["item"].items(), key=lambda kv: -kv[1][0]) if i not in in_core and g >= floor][:5]
    out["order"] = build_order(db, where, args, champion_id, role, items)
    return out


def skill_order(skills, *, details=False):
    """Q/W/E priority, with optional observed-vs-estimated evidence.

    The default remains a string. Only reaching five points is observed; a
    remaining priority inferred from partial allocations is not a completed max.
    Nonstandard rank counts cannot establish the usual five-point max order.
    """
    skills = skills if isinstance(skills, str) else ""
    valid = bool(skills) and all(c in "1234" for c in skills)
    points = {c: 0 for c in "1234"}
    maxed = []
    if valid:
        for c in skills:
            points[c] += 1
            if c != "4" and points[c] == 5:
                maxed.append(c)
    standard = all(points[c] <= 5 for c in "123") and points["4"] <= 3
    if not standard:
        maxed = []
    first_point = lambda c: skills.find(c) if c in skills else len(skills)
    rest = sorted((c for c in "123" if c not in maxed), key=lambda c: (-points[c], first_point(c)))
    letters = lambda digits: "".join("QWER"[int(c) - 1] for c in digits)
    evidence = {"order": letters(maxed + rest) if valid and any(points[c] for c in "123") else "",
                "observed_order": letters(maxed),
                "inferred_order": letters(c for c in rest if points[c]),
                "unknown": letters(c for c in rest if not points[c]),
                "estimated": len(maxed) < 3, "standard_ranks": standard,
                "label": "Estimated ability priority (partial points)" if standard and len(maxed) < 3
                         else "Estimated ability priority (nonstandard ranks)" if not standard
                         else "Observed five-point ability order"}
    return evidence if details else evidence["order"]


@_snapshot
def build_order(db, where, args, champion_id, role, items):
    """Actual first three distinct finished purchases, starters and skill evidence.

    Stream one cursor in the caller's snapshot (or own/release one). Per-option
    timings use bounded whole-second histograms, not per-game timestamp arrays;
    medians are displayed in rounded minutes. Values beyond three hours go into
    an overflow bin: a median landing there is unknown, never a capped fake time.
    First later shop timing uses each player's first retained non-ward/trinket
    purchase at or after 60 seconds; it is an observation, not an inferred recall.
    """
    rows = db.execute(
        f"""SELECT pu.items, pu.skills, p.win FROM participants p JOIN matches m ON m.match_id = p.match_id
            JOIN purchases pu ON pu.match_id = p.match_id AND pu.puuid = p.puuid
            WHERE {where} AND p.champion_id = ? AND p.position = ?""", (*args, champion_id, role))
    n = wins = 0
    max_seconds = 180 * 60
    tables = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    timings = defaultdict(dict)  # kind -> option -> bounded per-slot histograms
    skill_starts = defaultdict(Counter)
    first_shop_times = Counter()

    def add_time(histogram, t):
        bucket = round(t) if t <= max_seconds else max_seconds + 1
        histogram[bucket] += 1

    def add(kind, key, win, seconds=()):
        row = tables[kind][key]
        row[0] += 1
        row[1] += win
        if seconds:
            histograms = timings[kind].get(key)
            if histograms is None:
                histograms = tuple(Counter() for _ in seconds)
                timings[kind][key] = histograms
            for histogram, t in zip(histograms, seconds):
                add_time(histogram, t)

    def minute(histogram):
        count = sum(histogram.values())
        if not count:
            return None
        middle, cumulative = [], 0
        for seconds, frequency in sorted(histogram.items()):
            for rank in ((count - 1) // 2, count // 2):
                if cumulative <= rank < cumulative + frequency:
                    middle.append(seconds)
            cumulative += frequency
            if len(middle) == 2:
                return None if max(middle) > max_seconds else round(sum(middle) / 120)
        return None

    for item_text, skills, win in rows:
        n += 1
        wins += win
        bought = sorted(timeline.parse_items(item_text), key=lambda buy: buy[0])
        start = tuple(sorted(i for t, i in bought if t < 60 and i not in timeline.NOT_BUILD))
        if start:
            add("start", start, win)
        first_shop = next((t for t, i in bought if t >= 60 and i not in timeline.NOT_BUILD), None)
        if first_shop is not None:
            add_time(first_shop_times, first_shop)
        done, seen = [], set()
        for t, i in bought:
            kind = items.get(i, {})
            if kind.get("completed") and not kind.get("boots") and not kind.get("support") \
                    and i not in timeline.NOT_BUILD and i not in seen:
                seen.add(i)
                done.append((t, i))
        if done:
            add("first", done[0][1], win, (done[0][0],))
        if len(done) >= 3:
            add("core", tuple(i for _, i in done[:3]), win, tuple(t for t, _ in done[:3]))
        if isinstance(skills, str) and len(skills) >= 9:
            evidence = skill_order(skills, details=True)
            if evidence["order"]:
                key = (evidence["order"], evidence["observed_order"], evidence["inferred_order"],
                       evidence["unknown"], evidence["standard_ranks"])
                add("skills", key, win)
                skill_starts[key]["".join("QWER"[int(c) - 1] for c in skills[:3])] += 1
    out = {"games": n, "core": [], "first": [], "start": [], "skills": [], "first_shop": None,
           "timing_resolution_seconds": 1}
    if not n:
        return out
    if first_shop_times:
        out["first_shop"] = {"minute": minute(first_shop_times), "games": sum(first_shop_times.values()),
                             "label": "First later shop purchase (not necessarily first recall)"}
    mean = wins / n
    ranked = lambda kind: _ranked(tables[kind], mean, n)
    entry = lambda g, w: {**winrate(w, g), "share": g / n}
    out["core"] = [{"items": list(trio), "minutes": [minute(h) for h in timings["core"][trio]],
                    **entry(g, w)} for trio, g, w in ranked("core")[:2]]
    out["first"] = [{"item": i, "minute": minute(timings["first"][i][0]), **entry(g, w)} for i, g, w in ranked("first")[:3]]
    out["start"] = [{"items": list(s), **entry(g, w)} for s, g, w in ranked("start")[:1]]
    for key, g, w in ranked("skills")[:1]:
        order, observed, inferred, unknown, standard = key
        starts = skill_starts[key]
        first = min(starts, key=lambda s: (-starts[s], s)) if starts else None
        estimated = len(observed) < 3
        out["skills"].append({"order": order, "first": first, "observed_order": observed,
                              "inferred_order": inferred, "unknown": unknown,
                              "estimated": estimated, "standard_ranks": standard,
                              "label": "Estimated ability priority (partial points)" if standard and estimated
                                       else "Estimated ability priority (nonstandard ranks)" if not standard
                                       else "Observed five-point ability order", **entry(g, w)})
    return out


def player_roles(games, min_share=0.2, most=2):
    """[(role, share)] for the player's main roles: up to `most`, each at least `min_share` of their games."""
    counts = Counter(g["position"] for g in games if g["position"])
    n = sum(counts.values())
    return [(r, c / n) for r, c in counts.most_common(most) if c / n >= min_share] if n else []


@_snapshot
def tier_population(db, tier, patch, queue=420):
    """`tier` when the sample has MIN_TIER_MATCHES of its games on `patch`, else None (every tier)."""
    tier_matches = db.execute(
        """SELECT COUNT(*) FROM match_tier mt JOIN matches m ON m.match_id = mt.match_id
           WHERE mt.tier = ? AND m.patch = ? AND m.queue_id = ? AND m.remake = 0""",
        (tier, patch, queue)).fetchone()[0] if tier else 0
    return tier if tier_matches >= MIN_TIER_MATCHES else None


@_snapshot
def suggested_picks(db, games, tier, patch, items, per_role=4, queue=420):
    """The highest win-rate champions in the player's main roles on `patch`, each with its build.

    Uses games from the player's tier when the sample has enough of them, else every tier.
    Champions are ranked by win rate shrunk towards the role's average."""
    population = tier_population(db, tier, patch, queue)
    mine = defaultdict(list)
    for g in games:
        mine[g["champion_id"]].append(g)
    roles = []
    for role, share in player_roles(games):
        champs = role_champions(db, patch, role, population, queue)
        role_games, role_wins = sum(c[1] for c in champs), sum(c[2] for c in champs)
        mean = role_wins / role_games if role_games else 0.5
        ranked = sorted((c for c in champs if c[1] >= MIN_PICK_GAMES),
                        key=lambda c: -shrunk(c[2], c[1], mean, PICK_PRIOR))[:per_role]
        roles.append({"role": role, "share": share, "games": role_games, "average": mean, "picks": [{
            "champion_id": champ, **winrate(w, g), "pick_share": g / role_games, "score": shrunk(w, g, mean, PICK_PRIOR),
            "you": wr_of(mine.get(champ, [])),
            "build": champion_build(db, champ, role, patch, items, population, queue),
        } for champ, g, w in ranked]})
    return {"patch": patch, "tier": population, "roles": roles}
