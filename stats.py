"""Player-centred probability stats computed from the local match cache.

Win rates are treated as Beta posteriors with a uniform prior: after w wins and
l losses, the true win rate ~ Beta(1 + w, 1 + l). That gives honest credible
intervals and lets us say "P(this player is better than their rank on X)".
"""
import math
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]
SESSION_GAP_MS = 30 * 60 * 1000  # a new "session" starts after 30 min idle


# --- small TTL memo for rank-wide aggregates ------------------------------------
# The lead curve scans every cached timeline in a tier; it barely moves minute to minute,
# and a loading profile re-requests its stats several times. Cache it briefly. Only cache
# values that are later *filtered* per player, never ones that get subtracted from.
_memo = {}
MEMO_TTL = 300


def _memoized(key, compute):
    hit = _memo.get(key)
    if hit and time.time() - hit[0] < MEMO_TTL:
        return hit[1]
    value = compute()
    _memo[key] = (time.time(), value)
    return value


# --- probability helpers ------------------------------------------------------

def beta_sf(x, a, b):
    """P(X > x) for X ~ Beta(a, b), integer a, b (exact via the binomial identity)."""
    if x <= 0:
        return 1.0
    if x >= 1:
        return 0.0
    if a + b > 400:  # normal approximation is excellent here and avoids huge sums
        mean = a / (a + b)
        sd = math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)))
        return 0.5 * math.erfc((x - mean) / (sd * math.sqrt(2)))
    n = a + b - 1
    # P(X > x) = P(Binomial(n, x) <= a - 1), summed in log space
    lx, l1x, lgn = math.log(x), math.log1p(-x), math.lgamma(n + 1)
    return min(1.0, sum(
        math.exp(lgn - math.lgamma(k + 1) - math.lgamma(n - k + 1) + k * lx + (n - k) * l1x)
        for k in range(a)))


def beta_quantile(q, a, b):
    lo, hi = 0.0, 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if 1 - beta_sf(mid, a, b) < q:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


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
               p.cs, p.lane_adv,
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


def overview(games, tz_offset_min=0):
    local = lambda g: datetime.fromtimestamp(g["game_start"] / 1000, timezone.utc) - timedelta(minutes=tz_offset_min)
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
            row["p_vs"] = (kv + alpha * p_role) / (len(vs) + alpha)
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


def latest_patch(db, queue=420):
    patches = [r[0] for r in db.execute(
        "SELECT DISTINCT patch FROM matches WHERE queue_id = ? AND remake = 0", (queue,))]
    return max(patches, key=_patch_key) if patches else None


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
    rows = db.execute(
        """SELECT f.match_id, p.puuid, p.team_id, p.position, f.gold
           FROM frames f JOIN participants p ON p.match_id = f.match_id AND p.puuid = f.puuid
           WHERE f.minute = ? AND f.match_id IN (SELECT match_id FROM participants WHERE puuid = ?)""",
        (LEAD_MINUTE, puuid)).fetchall()
    by_match = defaultdict(list)
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
            WHERE a.n = 5 AND b.n = 5""", args).fetchall()


def lead_curve(rows):
    """P(win | gold-lead bucket at 15) and how often each bucket happens."""
    n = len(rows)
    out = []
    for label, test in LEAD_BUCKETS:
        hits = [w for d, w in rows if test(d)]
        out.append({"label": label, "share": len(hits) / n if n else None, **winrate(sum(hits), len(hits))})
    return out


def player_leads(db, games, puuid, tier, queue=420):
    """The player's lead-to-win curve vs their rank, plus comeback / close-out rates and laning."""
    mine = [(g["team_diff15"], g["win"]) for g in games if g.get("team_diff15") is not None]
    tier_rows = _memoized(("leads", tier, queue), lambda: _team_leads(
        db, "m.queue_id = ? AND m.match_id IN (SELECT match_id FROM match_tier WHERE tier = ?)", (queue, tier)))
    own_matches = {r[0] for r in db.execute("SELECT match_id FROM participants WHERE puuid = ?", (puuid,))}
    rank = [(d, w) for mid, d, w in tier_rows if mid not in own_matches]
    you, base = lead_curve(mine), lead_curve(rank)
    rate = lambda rows, test: winrate(sum(w for d, w in rows if test(d)), sum(1 for d, _ in rows if test(d)))
    behind, ahead = (lambda d: d <= -1000), (lambda d: d >= 1000)
    lane = [g["lane_diff15"] for g in games if g.get("lane_diff15") is not None]
    return {
        "games_with_timeline": len(mine),
        "rank_games": len(rank) // 2,
        "curve": [{"label": y["label"], "share": y["share"], "you": {k: y[k] for k in ("games", "wins", "wr", "lo", "hi")},
                   "rank": {k: b[k] for k in ("games", "wins", "wr", "lo", "hi")}} for y, b in zip(you, base)],
        "comeback": {"you": rate(mine, behind), "rank": rate(rank, behind)},   # win when behind 1k+
        "close_out": {"you": rate(mine, ahead), "rank": rate(rank, ahead)},    # win when ahead 1k+
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
    rows = [(d, w) for _, d, w in _team_leads(db, where, args)]
    return {"games": len(rows) // 2, "curve": lead_curve(rows)}


# --- mastery --------------------------------------------------------------------

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
