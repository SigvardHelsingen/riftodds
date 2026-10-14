"""Leakage-safe pregame and retrospective in-game win probabilities.

The newest fifth of matches is a chronological holdout (equal starts stay together).
Published weights are TRAIN-only: there is deliberately no full-data refit. Pregame
training features use only games already finished at that row's start; holdout features
use frozen TRAIN counts/history. Reliability bins are diagnostics, not a calibrator
fitted to the holdout. Current rank/mastery are never historical model inputs.

Fitting is bounded, pure Python, and belongs in the low-priority background
`python model.py train [--db PATH]` job. Bounded inputs are extracted under a short
snapshot, released before fitting (unless the caller owns the transaction).
Importing, loading or predicting never trains, fetches data, or writes to the database.
Replayed in-game odds are retrospective estimates, not predictions issued historically;
only the held-out scorecards, not an arbitrary replay, have independent evaluation.
"""
import argparse
import heapq
import json
import logging
import math
import os
import random
import sqlite3
import sys
import time
import zlib
from collections import OrderedDict, defaultdict, namedtuple
from contextlib import closing
from pathlib import Path

import store
import timeline

MODEL_VERSION = 2
TRAIN_DAYS = 120
MIN_GAMES = 200
MAX_GAMES = 6000           # latest eligible matches; also bounds population/player state
INGAME_ROWS = 20000        # reservoir cap per training partition, not a fetch-all
MAX_DIGEST_BYTES = 256 * 1024
MAX_FRAMES = 181
MAX_CACHED_MODELS = 8
TEST_SHARE = 0.2
CHAMP_PRIOR = 50
MATCHUP_PRIOR = 20
PLAYER_MIN_GAMES = 15      # completed, earlier cached TRAIN games, not a future eligibility count
SOLO = 420
ROLES = ("TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY")

INGAME_FEATURES = ["gold", "gold x time", "gold x time²", "xp", "towers", "inhibitors down", "dragons", "soul",
                   "baron", "elder", "voidgrubs", "heralds", "atakhan"]
PREGAME_FEATURES = ["draft", "matchups"]
PLAYER_FEATURES = ["champion games", "champion win rate", "recent form"]
Game = namedtuple("Game", "mid start end patch win lineup players")
log = logging.getLogger(__name__)
INGAME_LABEL = "Retrospective estimate from an earlier training sample, not a historical prediction"
INGAME_INTERPRETATION = {
    "mode": "retrospective", "label": INGAME_LABEL, "historical_prediction": False,
    "independent_story_prediction": False,
    "validation_scope": "overall/by_minute scorecards on the chronological holdout only; not arbitrary replay odds",
    "caveat": "Earlier means before the validation cohort, not necessarily before the replayed match; "
              "the displayed game may be in TRAIN or predate model fitting",
}


# --- fitting ------------------------------------------------------------------------------

def sigmoid(z):
    """Stable on both tails, including +/- infinity; NaN is not a prediction."""
    if math.isnan(z):
        raise ValueError("Non-finite log odds")
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def logit(p):
    if not math.isfinite(p):
        raise ValueError("Non-finite probability")
    p = min(max(p, 1e-9), 1 - 1e-9)
    return math.log(p) - math.log1p(-p)


def solve(a, b):
    """Small dense system, with partial pivoting and a zero solution for singular columns."""
    n = len(b)
    if len(a) != n or any(len(row) != n for row in a):
        raise ValueError("Invalid system dimensions")
    if any(not math.isfinite(v) for row in a for v in row) or any(not math.isfinite(v) for v in b):
        raise ValueError("Non-finite linear system")
    m = [list(row) + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        m[col], m[pivot] = m[pivot], m[col]
        if abs(m[col][col]) < 1e-12:
            continue
        for r in range(n):
            if r != col and m[r][col]:
                f = m[r][col] / m[col][col]
                m[r] = [x - f * y for x, y in zip(m[r], m[col])]
    return [m[i][n] / m[i][i] if abs(m[i][i]) > 1e-12 else 0.0 for i in range(n)]


def fit(rows, ys, l2=1.0, offsets=None, intercept=True, iters=30):
    """Standardized, damped Newton logistic fit, including empty/constant/separable data.

    Invalid dimensions/labels/non-finite inputs fail explicitly rather than storing NaN.
    An unpenalized bias still has a small ridge and bounded steps for single-class data.
    """
    n = len(rows)
    if len(ys) != n or (offsets is not None and len(offsets) != n):
        raise ValueError("Rows, labels and offsets must have equal lengths")
    if not math.isfinite(l2) or l2 < 0:
        raise ValueError("Invalid regularization")
    k = len(rows[0]) if n else 0
    d = k + int(intercept)
    if any(len(row) != k for row in rows) or any(y not in (0, 1) for y in ys):
        raise ValueError("Invalid rows or binary labels")
    if any(not math.isfinite(v) or abs(v) > 1e12 for row in rows for v in row):
        raise ValueError("Non-finite or out-of-range features")
    offsets = [0.0] * n if offsets is None else list(offsets)
    if any(not math.isfinite(v) or abs(v) > 1000 for v in offsets):
        raise ValueError("Non-finite or out-of-range offsets")
    if not n or not d:
        return [0.0] * d
    means = [math.fsum(row[j] for row in rows) / n if intercept else 0.0 for j in range(k)]
    scales = [max(math.sqrt(math.fsum((row[j] - means[j]) ** 2 for row in rows) / n), 1e-6)
              for j in range(k)]
    xs = [((1.0,) if intercept else ()) + tuple((v - means[j]) / scales[j] for j, v in enumerate(row))
          for row in rows]
    penalty = ([1e-6] if intercept else []) + [max(l2, 1e-6)] * k

    def loss(weights):
        total = 0.0
        for x, y, offset in zip(xs, ys, offsets):
            z = math.fsum(w * v for w, v in zip(weights, x)) + offset
            total += max(z, 0) + math.log1p(math.exp(-abs(z))) - y * z
        return total + 0.5 * math.fsum(p * w * w for p, w in zip(penalty, weights))

    w = [0.0] * d
    old_loss = loss(w)
    for _ in range(iters):
        h, g = [[0.0] * d for _ in range(d)], [0.0] * d
        for x, y, offset in zip(xs, ys, offsets):
            p = sigmoid(math.fsum(wj * xj for wj, xj in zip(w, x)) + offset)
            residual, curvature = y - p, p * (1 - p)
            for a in range(d):
                g[a] += residual * x[a]
                for b in range(a + 1):
                    h[a][b] += curvature * x[a] * x[b]
        for a in range(d):
            for b in range(a):
                h[b][a] = h[a][b]
            g[a] -= penalty[a] * w[a]
            h[a][a] += penalty[a] + 1e-9
        step = solve(h, g)
        size = max(abs(s) for s in step)
        if size < 1e-7:
            break
        damping = min(1.0, 8.0 / size)
        accepted = False
        candidate, candidate_loss = w, old_loss
        for _ in range(24):
            candidate = [max(-32.0, min(32.0, a + damping * b)) for a, b in zip(w, step)]
            candidate_loss = loss(candidate)
            if math.isfinite(candidate_loss) and candidate_loss <= old_loss:
                accepted = True
                break
            damping *= 0.5
        if not accepted:
            break
        change = max(abs(a - b) for a, b in zip(candidate, w))
        w, old_loss = candidate, candidate_loss
        if change < 1e-7:
            break
    slopes = [w[j + int(intercept)] / scales[j] for j in range(k)]
    return [w[0] - math.fsum(a * b for a, b in zip(slopes, means)), *slopes] if intercept else slopes


def predict(w, row, offset=0.0, intercept=True):
    x = (1.0, *row) if intercept else row
    if len(w) != len(x) or not math.isfinite(offset):
        raise ValueError("Invalid prediction dimensions or offset")
    if any(not math.isfinite(v) for v in (*w, *x)):
        raise ValueError("Non-finite prediction inputs")
    return sigmoid(math.fsum(wj * xj for wj, xj in zip(w, x)) + offset)


def grade(probs, ys, game_ids=None, baseline_prob=0.5) -> dict:
    """Sample-weighted scores and reliability bins, with distinct match counts explicitly.

    The baseline is fixed from TRAIN, never the empirical holdout win rate. Repeated
    minute observations are samples, not independent games or confidence intervals.
    """
    n = len(ys)
    if len(probs) != n or (game_ids is not None and len(game_ids) != n):
        raise ValueError("Predictions, labels and game IDs must have equal lengths")
    if any(not math.isfinite(p) or not 0 <= p <= 1 for p in probs) or any(y not in (0, 1) for y in ys):
        raise ValueError("Invalid probabilities or labels")
    if not math.isfinite(baseline_prob) or not 0 <= baseline_prob <= 1:
        raise ValueError("Invalid baseline")
    if not n:
        return {"samples": 0, "games": 0}
    ids = list(range(n)) if game_ids is None else game_ids
    buckets: defaultdict[int, tuple[int, int, float, set[object]]] = defaultdict(lambda: (0, 0, 0.0, set()))
    for p, y, mid in zip(probs, ys, ids):
        b = min(int(p * 10), 9)
        count, wins, total, matches = buckets[b]
        matches.add(mid)
        buckets[b] = count + 1, wins + y, total + p, matches

    def log_loss(ps):
        return -math.fsum(y * math.log(max(p, 1e-12)) + (1 - y) * math.log(max(1 - p, 1e-12))
                          for p, y in zip(ps, ys)) / n

    calibration = [{"lo": b / 10, "hi": (b + 1) / 10, "samples": count, "games": len(matches),
                    "wins": wins, "predicted": total / count, "observed": wins / count}
                   for b, (count, wins, total, matches) in sorted(buckets.items())]
    return {"samples": n, "games": len(set(ids)),
            "accuracy": sum((p >= 0.5) == bool(y) for p, y in zip(probs, ys)) / n,
            "log_loss": log_loss(probs), "brier": math.fsum((p - y) ** 2 for p, y in zip(probs, ys)) / n,
            "coin_log_loss": math.log(2), "coin_brier": 0.25,
            "baseline": {"probability": baseline_prob, "log_loss": log_loss([baseline_prob] * n),
                         "brier": math.fsum((baseline_prob - y) ** 2 for y in ys) / n},
            "calibration": calibration,
            "ece": math.fsum(b["samples"] * abs(b["predicted"] - b["observed"]) for b in calibration) / n}


# --- chronological data ownership ----------------------------------------------------------

def _window(now):
    now = time.time() if now is None else now
    return (now - TRAIN_DAYS * 86400) * 1000, now * 1000


def _games(db, since, before, draft=False):
    """Bound the game set before loading any participants; labels come from blue's team."""
    digest_join = "" if draft else "JOIN timeline_digest d ON d.match_id = m.match_id AND d.data IS NOT NULL"
    candidates = db.execute(f"""SELECT m.match_id, m.game_start, m.game_start + m.duration * 1000,
                               m.patch, t.win FROM matches m JOIN teams t
                               ON t.match_id = m.match_id AND t.team_id = 100 {digest_join}
                               WHERE m.queue_id = ? AND m.remake = 0 AND m.game_start >= ?
                               AND m.duration > 0 AND m.duration <= 10800
                               AND m.game_start + m.duration * 1000 < ? AND t.win IN (0, 1)
                               ORDER BY m.game_start DESC, m.match_id DESC LIMIT ?""",
                            (SOLO, since, before, MAX_GAMES))
    out = []
    for mid, start, end, patch, win in candidates:
        lineup, players = {}, {}
        if draft:
            if not isinstance(patch, str) or not patch:
                continue
            valid = True
            for puuid, team, role, champion in db.execute(
                    "SELECT puuid, team_id, position, champion_id FROM participants WHERE match_id = ?", (mid,)):
                key = (team, role)
                if team not in (100, 200) or role not in ROLES or key in lineup or not champion or champion < 0:
                    valid = False
                    break
                lineup[key], players[key] = champion, puuid
            if not valid or len(lineup) != 10:
                continue
        out.append(Game(mid, start, end, patch, win, lineup, players))
    return sorted(out, key=lambda game: (game.start, game.mid))


def _split_games(games):
    """No match or same-start group can straddle the split; training labels must be resolved."""
    if len(games) < 2:
        return [], [], 0
    cut = min(len(games) - 1, max(1, int(len(games) * (1 - TEST_SHARE))))
    boundary = games[cut].start
    while cut and games[cut - 1].start == boundary:
        cut -= 1
    train = [game for game in games[:cut] if game.end < boundary]
    return train, games[cut:], cut - len(train)


def _report(train, test, excluded, features):
    return {"version": MODEL_VERSION, "games": len(train) + len(test), "train_games": len(train),
            "test_games": len(test), "features": features, "max_games": MAX_GAMES,
            "split": {"method": "chronological matches; equal starts grouped; TRAIN completed before TEST",
                      "train_first_start": train[0].start, "train_last_start": train[-1].start,
                      "test_first_start": test[0].start, "test_last_start": test[-1].start,
                      "excluded_overlapping_games": excluded},
            "feature_policy": "earlier completed games for TRAIN rows; frozen TRAIN sources for TEST",
            "fit_policy": "TRAIN only; no holdout refit",
            "calibration_method": "held-out reliability bins, not holdout-fitted recalibration",
            "limitations": ["cached ranked-solo population, not a representative global sample",
                            "rank and mastery excluded: historical values unavailable",
                            "calibration is sample-weighted; repeated minutes are correlated"]}


def _validate(params, report, scores):
    """Do not expose a candidate that loses to either coin odds or the TRAIN-prior baseline."""
    enough = scores.get("games", 0) >= max(2, math.ceil(MIN_GAMES * TEST_SHARE / 2))
    good = enough and all(scores[metric] <= min(coin, scores["baseline"][metric]) + 1e-9
                          for metric, coin in (("log_loss", math.log(2)), ("brier", 0.25)))
    params["validated"] = good
    report["ready"] = good
    report["status"] = "validated" if good else "unavailable"
    report["reason"] = (None if good else "Insufficient held-out games" if not enough
                        else "Held-out log loss or Brier score is worse than the baseline")
    report["validation"] = {"passed": good, "baseline": "both 50/50 and the frozen TRAIN win prior",
                            "metrics": ["log_loss", "brier"], "weights_fit_games": report["train_games"]}
    return params, report


# --- in-game ------------------------------------------------------------------------------

def ingame_features(s):
    """Only observed blue-minus-red state, with symmetric physical/numerical caps."""
    def bounded(value, cap):
        if not math.isfinite(value):
            raise ValueError("Non-finite state")
        return max(-cap, min(cap, value))

    if s["soul"] not in (None, 0, 1):
        raise ValueError("Invalid soul side")
    tau = max(0, bounded(s["m"], 60)) / 20
    gold = bounded(s["gold"] / 1000, 100)
    diff = lambda pair: bounded(pair[0] - pair[1], 20)
    return (gold, gold * tau, gold * tau * tau, bounded(s["xp"] / 1000, 100),
            diff(s["towers"]), diff(s["inhibs"]), diff(s["dragons"]),
            0 if s["soul"] is None else (1 if s["soul"] == 0 else -1),
            diff(s["baron"]), diff(s["elder"]), diff(s["grubs"]), diff(s["heralds"]), diff(s["atakhan"]))


def _digest(data):
    if len(data) > MAX_DIGEST_BYTES:
        raise ValueError("Oversized compressed digest")
    decoder = zlib.decompressobj()
    raw = decoder.decompress(data, MAX_DIGEST_BYTES + 1)
    if len(raw) > MAX_DIGEST_BYTES or not decoder.eof:
        raise ValueError("Oversized or incomplete digest")
    dg = json.loads(raw)
    if not timeline.supported(dg):
        raise ValueError("A timestamped v2 Rift digest is required; legacy frames are not reconstructed")
    frames = dg["gold"]
    if not 3 <= len(frames) <= MAX_FRAMES or any(len(dg[key]) != len(frames) for key in ("xp", "ts", "valid")):
        raise ValueError("Invalid frame count")
    if (len(dg["pids"]) != 10 or len(set(dg["pids"])) != 10 or len(dg["teams"]) != 10
            or dg["teams"].count(100) != 5 or dg["teams"].count(200) != 5):
        raise ValueError("Invalid participant/team mapping")
    for j, (gold, xp) in enumerate(zip(frames, dg["xp"])):
        if (len(gold) != 10 or len(xp) != 10 or timeline.number(dg["ts"][j]) is None
                or any(timeline.number(v) is None or v < 0 for v in gold + xp)):
            dg["valid"][j] = False  # incomplete snapshots do not invalidate earlier complete frames
    return dg


def _ingame_rows(db, ids):
    """(features, label, minute, match_id); never terminal/end-state or certainty rows.

    Use actual v2 timestamps, not list indexes. Legacy v1 lacks enough information to
    exclude irregular GAME_END frames reliably and is unavailable for model training.
    """
    for match_id in ids:
        row = db.execute("""SELECT d.data, t.win, m.duration FROM timeline_digest d JOIN teams t
                            ON t.match_id = d.match_id AND t.team_id = 100 JOIN matches m
                            ON m.match_id = d.match_id WHERE d.match_id = ?""", (match_id,)).fetchone()
        if not row or not row[0] or row[1] not in (0, 1):
            continue
        try:
            dg = _digest(row[0])
            end = min(dg["end"], row[2])
            if not math.isfinite(end) or end <= 0:
                continue
            for event in dg["buildings"]:
                if event[2] in ("NEXUS_BUILDING", "NEXUS"):
                    end = min(end, event[0])
            seen_minutes = set()
            for s in timeline.states(dg):
                minute = int(s["m"])
                if (minute < 2 or minute % 2 or minute in seen_minutes or s["t"] >= end
                        or s.get("final") or s.get("ended") or s.get("outcome_known")):
                    continue
                seen_minutes.add(minute)
                yield ingame_features(s), row[1], minute, match_id
        except (ValueError, TypeError, KeyError, IndexError, zlib.error, OverflowError):
            continue  # corrupt/missing timelines are not fabricated training observations


def _sample(stream, cap, rng):
    """Uniform reservoir sample, memory O(cap)."""
    out = []
    if cap <= 0:
        return out
    for i, item in enumerate(stream):
        if i < cap:
            out.append(item)
        else:
            j = rng.randrange(i + 1)
            if j < cap:
                out[j] = item
    return out


def train_ingame(db, now=None, cap=None):
    since, before = _window(now)
    cap = min(INGAME_ROWS, INGAME_ROWS if cap is None else max(0, int(cap)))
    with store.read_snapshot(db):
        games = _games(db, since, before)
        if len(games) < MIN_GAMES:
            return None
        train_games, test_games, excluded = _split_games(games)
        if len(train_games) < 2 or not test_games:
            return None
        # Decode one bounded digest at a time; retain only the capped feature reservoirs.
        train = _sample(_ingame_rows(db, [g.mid for g in train_games]), cap, random.Random(7))
        test = _sample(_ingame_rows(db, [g.mid for g in test_games]), max(1, cap // 4), random.Random(8))
    if not train or len({r[1] for r in train}) < 2:
        return None
    # No side bias: flipping every observed lead exactly complements the probability.
    w = [0.0, *fit([r[0] for r in train], [r[1] for r in train], intercept=False)]
    base = sum(g.win for g in train_games) / len(train_games)
    scores = grade([predict(w, r[0]) for r in test], [r[1] for r in test], [r[3] for r in test], base)
    report = _report(train_games, test_games, excluded, INGAME_FEATURES)
    report.update(train_samples=len(train), test_samples=len(test), overall=scores,
                  interpretation=dict(INGAME_INTERPRETATION),
                  row_cap=cap, test_row_cap=max(1, cap // 4),
                  frame_policy="timestamped v2 Rift states, even minutes from 2; GAME_END/nexus/end states excluded; no v1 reconstruction")
    report["by_minute"] = []
    for minute in sorted({r[2] for r in test}):
        part = [r for r in test if r[2] == minute]
        report["by_minute"].append({"minute": minute, "minutes": [minute, minute],
                                    **grade([predict(w, r[0]) for r in part], [r[1] for r in part],
                                            [r[3] for r in part], base)})
    params = {"version": MODEL_VERSION, "features": INGAME_FEATURES, "weights": w, "label": INGAME_LABEL,
              "training_before": test_games[0].start, "training_data_end": max(g.end for g in train_games),
              "validation_data_end": max(g.end for g in test_games)}
    return _validate(params, report, scores)


def ingame_chance(params):
    """Retrospective P(blue wins) for replay states, or None without a validated model.

    This is not a probability recorded at the historical game time, nor a claim that
    this particular story was held out. Independent scores describe the holdout only.
    """
    if not params or params.get("version") != MODEL_VERSION or not params.get("validated"):
        return None
    return lambda s: predict(params["weights"], ingame_features(s))


# --- pre-game -----------------------------------------------------------------------------

def _shrunk_logit(wins, games, prior):
    if games < 0 or wins < 0 or wins > games or prior <= 0:
        raise ValueError("Invalid historical counts")
    return math.log(wins + prior * 0.5) - math.log(games - wins + prior * 0.5)


def lineups(db, since, before=None):
    """Complete explicit role drafts, bounded and chronological; `before` is Unix ms."""
    before = time.time() * 1000 if before is None else before
    return [(g.mid, g.start, g.patch, g.win, g.lineup) for g in _games(db, since, before, draft=True)]


def draft_features(lineup, patch, champ_stats, matchup_stats, own_win=None):
    """Blue-minus-red draft and role matchup strength from the supplied counts.

    `own_win` remains a leave-one-out utility for callers, NOT the training policy:
    leave-one-out full-data counts still leak future labels. Training uses earlier data.
    """
    draft = matchup = 0.0
    for role in ROLES:
        blue, red = lineup.get((100, role)), lineup.get((200, role))
        for team, champ, sign in ((100, blue, 1), (200, red, -1)):
            games, wins = champ_stats.get((patch, role, champ), (0, 0))
            if own_win is not None and games:
                games, wins = games - 1, wins - (own_win if team == 100 else 1 - own_win)
            draft += sign * _shrunk_logit(wins, games, CHAMP_PRIOR)
        if blue == red:
            continue
        games, wins = matchup_stats.get((role, blue, red), (0, 0))
        if not games:
            games, reverse_wins = matchup_stats.get((role, red, blue), (0, 0))
            wins = games - reverse_wins
        if own_win is not None and games:
            games, wins = games - 1, wins - own_win
        matchup += _shrunk_logit(wins, games, MATCHUP_PRIOR)
    return draft, matchup


def _add_population(game, champ, matchups):
    for role in ROLES:
        blue, red = game.lineup[(100, role)], game.lineup[(200, role)]
        for team, champion, win in ((100, blue, game.win), (200, red, 1 - game.win)):
            key = (game.patch, role, champion)
            n, w = champ.get(key, (0, 0))
            champ[key] = (n + 1, w + win)
        # Store both orientations so inference is symmetric even on unseen matchups.
        for a, b, win in ((blue, red, game.win), (red, blue, 1 - game.win)):
            key = (role, a, b)
            n, w = matchups.get(key, (0, 0))
            matchups[key] = (n + 1, w + win)


def population_stats(db, since, before=None):
    """Bounded population counts strictly completed before an explicit Unix-ms cutoff."""
    if before is None:
        raise ValueError("Population features require an explicit before cutoff")
    champ, matchups = {}, {}
    for game in _games(db, since, before, draft=True):
        _add_population(game, champ, matchups)
    return champ, matchups


def player_features(history, champion, before):
    """Utility for earlier history [(game_start, champion, win)], with strict start cutoff.

    Model callers additionally require completion before the prediction and TRAIN membership.
    This is cached champion experience, not Riot mastery points or rank.
    """
    past = sorted((g for g in history if g[0] < before), key=lambda g: g[0])
    on = [g for g in past if g[1] == champion]
    recent = past[-10:]
    return (math.log1p(len(on)), _shrunk_logit(sum(g[2] for g in on), len(on), 6),
            _shrunk_logit(sum(g[2] for g in recent), len(recent), 10))


def _add_history(game, histories):
    for key, puuid in game.players.items():
        if not puuid:
            continue
        champion = game.lineup[key]
        win = game.win if key[0] == 100 else 1 - game.win
        history = histories.setdefault(puuid, {"games": 0, "champions": {}, "recent": []})
        history["games"] += 1
        n, w = history["champions"].get(champion, (0, 0))
        history["champions"][champion] = (n + 1, w + win)
        history["recent"] = sorted([*history["recent"], (game.start, game.mid, win)])[-10:]


def _history_features(history, champion):
    n, wins = history["champions"].get(champion, (0, 0))
    recent = history["recent"]
    return math.log1p(n), _shrunk_logit(wins, n, 6), _shrunk_logit(sum(r[2] for r in recent), len(recent), 10)


def _team_history(lineup, players, histories, minimum_games=None):
    minimum_games = PLAYER_MIN_GAMES if minimum_games is None else minimum_games
    result, covered = [0.0] * 3, 0
    for (team, role), puuid in players.items():
        history = histories.get(puuid)
        if not history or history["games"] < minimum_games:
            continue
        covered += 1
        sign = 1 if team == 100 else -1
        for j, value in enumerate(_history_features(history, lineup[(team, role)])):
            result[j] += sign * value / 5
    return tuple(result), covered


def _pregame_rows(games):
    """Online TRAIN rows, then frozen sufficient counts/history. One row per match."""
    champ, matchups, histories, pending, rows = {}, {}, {}, [], []

    def add(game):
        _add_population(game, champ, matchups)
        _add_history(game, histories)

    for game in games:
        while pending and pending[0][0] < game.start:
            add(heapq.heappop(pending)[2])
        draft = draft_features(game.lineup, game.patch, champ, matchups)
        history, covered = _team_history(game.lineup, game.players, histories)
        rows.append(((*draft, *history), game.win, game.mid, covered))
        heapq.heappush(pending, (game.end, game.mid, game))
    while pending:
        add(heapq.heappop(pending)[2])
    return rows, champ, matchups, histories


def train_pregame(db, now=None):
    since, before = _window(now)
    with store.read_snapshot(db):
        games = _games(db, since, before, draft=True)
    if len(games) < MIN_GAMES:
        return None
    train_games, test_games, excluded = _split_games(games)
    if len(train_games) < 2 or not test_games or len({g.win for g in train_games}) < 2:
        return None
    train, champ, matchups, histories = _pregame_rows(train_games)
    test = []
    for game in test_games:
        history, covered = _team_history(game.lineup, game.players, histories)
        test.append(((*draft_features(game.lineup, game.patch, champ, matchups), *history),
                     game.win, game.mid, covered))
    w = [0.0, *fit([r[0][:2] for r in train], [r[1] for r in train], intercept=False)]
    player_train = [r for r in train if r[3]]
    beta = None
    if len(player_train) >= MIN_GAMES:
        # The draft offset is TRAIN-fitted, never a full-data fit. Player observations
        # are team differences in a single match row, not independently split players.
        offsets = [math.fsum(a * b for a, b in zip(w[1:], r[0][:2])) for r in player_train]
        beta = fit([r[0][2:] for r in player_train], [r[1] for r in player_train],
                   offsets=offsets, intercept=False, l2=2.0)
    base = sum(g.win for g in train_games) / len(train_games)
    labels, ids = [r[1] for r in test], [r[2] for r in test]
    draft_probs = [predict(w, r[0][:2]) for r in test]
    probs = [predict(w, r[0][:2], math.fsum(a * b for a, b in zip(beta or (), r[0][2:]))) for r in test]
    scores = grade(probs, labels, ids, base)
    report = _report(train_games, test_games, excluded, PREGAME_FEATURES + (PLAYER_FEATURES if beta else []))
    report.update(train_samples=len(train), test_samples=len(test), overall=scores,
                  draft=grade(draft_probs, labels, ids, base))
    report["players"] = {"unit": "one blue-minus-red team-history row per match, never individual players",
                         "train_games": len(player_train), "train_samples": len(player_train),
                         "test_games_with_history": sum(bool(r[3]) for r in test),
                         "minimum_earlier_games": PLAYER_MIN_GAMES, "enabled": beta is not None,
                         "draft_only": report["draft"], "with_history": scores if beta is not None else None}
    params = {"version": MODEL_VERSION, "features": report["features"], "weights": w,
              "player_features": PLAYER_FEATURES, "player_weights": beta,
              "training_before": test_games[0].start, "training_data_end": max(g.end for g in train_games),
              "validation_data_end": max(g.end for g in test_games),
              "training_since": train_games[0].start, "training_match_ids": [g.mid for g in train_games],
              "history_window_days": TRAIN_DAYS, "player_min_games": PLAYER_MIN_GAMES,
              "champion_counts": [[*key, *value] for key, value in sorted(champ.items())],
              "matchup_counts": [[*key, *value] for key, value in sorted(matchups.items())]}
    return _validate(params, report, scores)


def _known_players(players):
    """Accept explicit snake_case API or Riot fields; no role, identity or rank inference."""
    lineup, identities = {}, {}
    if not isinstance(players, (list, tuple)) or len(players) != 10:
        raise ValueError("Exactly ten known champion/role assignments are required")
    for player in players:
        if not isinstance(player, dict):
            raise TypeError("Each player must provide a team, champion and explicit role")
        team = player.get("team_id", player.get("team", player.get("teamId")))
        role = player.get("position", player.get("role", player.get("teamPosition")))
        champion = player.get("champion_id", player.get("championId"))
        if team not in (100, 200) or role not in ROLES:
            raise ValueError("Known roles are required: one TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY per team; roles are not inferred")
        if isinstance(champion, bool) or not isinstance(champion, int) or champion <= 0:
            raise ValueError("A known positive champion_id is required for every role")
        key = (team, role)
        if key in lineup:
            raise ValueError("Duplicate team/role assignment")
        puuid = player.get("puuid") or None
        if puuid is not None and not isinstance(puuid, str):
            raise TypeError("Known PUUIDs must be strings; omit unknown identities")
        if puuid is not None and puuid in identities.values():
            raise ValueError("Known PUUIDs must be distinct; omit unknown identities")
        lineup[key], identities[key] = champion, puuid
    return lineup, identities


def _cached_histories(db, identities, params, cutoff):
    """Read only explicit identities and frozen TRAIN matches, with a strict completion cutoff."""
    allowed = set(params["training_match_ids"])
    histories = {}
    for puuid in set(identities.values()) - {None}:
        history = {"games": 0, "champions": {}, "recent": []}
        rows = db.execute("""SELECT m.game_start, p.champion_id,
                             CASE WHEN p.team_id = 100 THEN t.win ELSE 1 - t.win END, m.match_id
                             FROM participants p JOIN matches m ON m.match_id = p.match_id
                             JOIN teams t ON t.match_id = m.match_id AND t.team_id = 100
                             WHERE p.puuid = ? AND m.queue_id = ? AND m.remake = 0
                             AND m.game_start >= ? AND m.game_start < ?
                             AND m.game_start + m.duration * 1000 < ?
                             ORDER BY m.game_start DESC, m.match_id DESC LIMIT ?""",
                          (puuid, SOLO, params["training_since"], params["training_before"], cutoff, MAX_GAMES))
        recent = []
        for start, champion, win, mid in rows:
            if mid not in allowed or win not in (0, 1):
                continue
            history["games"] += 1
            n, w = history["champions"].get(champion, (0, 0))
            history["champions"][champion] = (n + 1, w + win)
            if len(recent) < 10:
                recent.append((start, mid, win))
        history["recent"] = sorted(recent)
        histories[puuid] = history
    return histories


def pregame_prediction(db, players, patch, start_cutoff=None):
    """Known-draft odds; optional start_cutoff is the target game's Unix-ms start.

    players: ten {team_id: 100|200, champion_id: int, position: ROLES, puuid?: str}.
    Explicit Riot teamId/championId/teamPosition fields also work. Missing PUUIDs are
    allowed; missing roles are not. Pass the real start when reviewing an existing game.
    A cutoff before the model's training/validation data is unavailable, not a backcast
    with future weights or future validation-based selection. No rank/mastery,
    final-match statistics, or identity inference is used.
    """
    with store.read_snapshot(db):
        params, report, trained_at = load(db, "pregame")
        result = {"ready": False, "reason": None, "blue": None, "red": None, "coverage": {},
                  "trained_at": trained_at, "features": {"used": [], "roles_required": list(ROLES),
                  "excluded": {"rank": "historical rank unavailable", "mastery": "historical mastery unavailable",
                               "hidden_identities": "never inferred"}}, "report": report}
        try:
            lineup, identities = _known_players(players)
        except (ValueError, TypeError) as exc:
            result["reason"] = str(exc)
            return result
        if not isinstance(patch, str) or not patch:
            result["reason"] = "A known patch is required"
            return result
        cutoff = time.time() * 1000 if start_cutoff is None else start_cutoff
        if timeline.number(cutoff) is None or cutoff <= 0:
            result["reason"] = "start_cutoff must be a positive Unix-millisecond game start"
            return result
        result["features"]["start_cutoff"] = cutoff
        if not params:
            result["reason"] = (report or {}).get("reason") or "No validated pregame model; train from enough cached games"
            return result
        if cutoff <= max(params["training_data_end"], params["validation_data_end"]):
            result["reason"] = "Model training or validation data is not strictly before this game start; historical backcast unavailable"
            return result
        champ = {tuple(r[:3]): tuple(r[3:]) for r in params["champion_counts"]}
        matchups = {tuple(r[:3]): tuple(r[3:]) for r in params["matchup_counts"]}
        slots = [{"team": team, "role": role, "champion_id": champion,
                  "games": champ.get((patch, role, champion), (0, 0))[0]}
                 for (team, role), champion in sorted(lineup.items())]
        lanes = [{"role": role, "games": matchups.get((role, lineup[(100, role)], lineup[(200, role)]), (0, 0))[0]}
                 for role in ROLES]
        histories = _cached_histories(db, identities, params, cutoff)
        history, covered = _team_history(lineup, identities, histories, params["player_min_games"])
        result["coverage"] = {"draft": {"known_slots": 10, "supported_slots": sum(s["games"] > 0 for s in slots),
                                         "slots": slots},
                              "matchups": {"supported_roles": sum(s["games"] > 0 for s in lanes), "roles": lanes},
                              "players": {"identified": sum(bool(p) for p in identities.values()),
                                          "with_cached_history": sum(h["games"] > 0 for h in histories.values()),
                                          "eligible": covered, "minimum_games": params["player_min_games"],
                                          "effect_enabled": params["player_weights"] is not None},
                              "source": "frozen TRAIN matches only; no TEST labels or current rank/mastery"}
        if not any(s["games"] for s in slots):
            result["reason"] = "No frozen TRAIN draft coverage for this patch and lineup"
            return result
        draft = draft_features(lineup, patch, champ, matchups)
        beta = params["player_weights"]
        blue = predict(params["weights"], draft, math.fsum(a * b for a, b in zip(beta or (), history)))
        used = PREGAME_FEATURES + (PLAYER_FEATURES if beta is not None else [])
        result["features"].update(used=used, values=dict(zip(used, (*draft, *history))),
                                  training_before=params["training_before"], available_after=params["validation_data_end"],
                                  history_window_days=params["history_window_days"],
                                  history_aggregation="blue-minus-red team means; unknown/insufficient histories contribute zero")
        result.update(ready=True, blue=blue, red=1 - blue)
        return result


# --- storage and the training job -----------------------------------------------------------

_loaded = OrderedDict()


def _database_key(db):
    filename = next((r[2] for r in db.execute("PRAGMA database_list") if r[1] == "main"), "")
    if filename:
        path = os.path.realpath(filename)
        stat = os.stat(path)
        return path, stat.st_dev, stat.st_ino
    # Keeping the object (not id(db)) prevents recycled IDs from crossing memory fixtures.
    return (db,)


def _check_params(params, name):
    expected = len(INGAME_FEATURES if name == "ingame" else PREGAME_FEATURES) + 1
    weights = params["weights"]
    if len(weights) != expected or any(not math.isfinite(w) for w in weights) or weights[0] != 0:
        raise ValueError("Invalid or asymmetric model weights")
    if (not math.isfinite(params["training_data_end"]) or not math.isfinite(params["training_before"])
            or params["training_data_end"] >= params["training_before"]
            or not math.isfinite(params["validation_data_end"]) or params["validation_data_end"] < params["training_before"]):
        raise ValueError("Invalid training boundary")
    if name == "pregame":
        beta = params["player_weights"]
        if beta is not None and (len(beta) != len(PLAYER_FEATURES) or any(not math.isfinite(w) for w in beta)):
            raise ValueError("Invalid player weights")
        if (not 1 <= len(params["training_match_ids"]) <= MAX_GAMES
                or not math.isfinite(params["training_since"]) or params["training_since"] > params["training_data_end"]
                or not isinstance(params["player_min_games"], int) or params["player_min_games"] < 1
                or not math.isfinite(params["history_window_days"]) or params["history_window_days"] <= 0):
            raise ValueError("Invalid training manifest or history policy")
        for key in ("champion_counts", "matchup_counts"):
            for row in params[key]:
                if len(row) != 5 or not 0 <= row[4] <= row[3] or not math.isfinite(row[3]):
                    raise ValueError("Invalid frozen counts")


def _stored_json(text):
    def reject_constant(value):
        raise ValueError(f"Non-finite persisted number: {value}")

    return json.loads(text, parse_constant=reject_constant)


def save(db, name, result, now=None):
    params, report = result if result else (None, {"games": 0, "ready": False, "status": "unavailable",
                                                "reason": "Insufficient eligible games or non-degenerate TRAIN observations"})
    if params and (params.get("version") != MODEL_VERSION or not params.get("validated") or not report.get("ready")):
        params = None
    if params:
        _check_params(params, name)
    cache_key = (_database_key(db), name)
    stamp = int(time.time() if now is None else now)
    db.execute("INSERT OR REPLACE INTO models VALUES (?, ?, ?, ?)",
               (name, stamp, json.dumps(params, allow_nan=False), json.dumps(report, allow_nan=False)))
    db.commit()
    _loaded.pop(cache_key, None)


def load(db, name, ttl=300):
    """(validated params or None, report, trained_at); bounded, database-scoped cache.

    Old full-data/leaky models are unavailable until retrained. This keeps main's existing
    /api/odds bool(params) and timeline call safe without changing any caller.
    """
    key = (_database_key(db), name)
    now = time.time()
    hit = _loaded.get(key)
    if hit and now - hit[0] < ttl:
        _loaded.move_to_end(key)
        return hit[1]
    row = db.execute("SELECT params, report, trained_at FROM models WHERE name = ?", (name,)).fetchone()
    if row:
        try:
            params, report = _stored_json(row[0]), _stored_json(row[1])
            if params and (params.get("version") != MODEL_VERSION or not params.get("validated") or not report.get("ready")):
                params = None
                report = {**report, "ready": False, "status": "unavailable",
                          "reason": "Legacy or unvalidated model; leakage-safe retraining required"}
            if params:
                _check_params(params, name)
            if name == "ingame":
                # Label older v2 artifacts too, without retraining or rewriting their rows.
                if params:
                    params = {**params, "label": INGAME_LABEL}
                if isinstance(report, dict):
                    report = {**report, "interpretation": dict(INGAME_INTERPRETATION)}
            value = params, report, row[2]
        except (ValueError, TypeError, AttributeError, KeyError, IndexError, OverflowError):
            value = None, {"ready": False, "status": "unavailable", "reason": "Invalid stored model; retrain"}, row[2]
    else:
        value = None, None, None
    _loaded[key] = now, value
    _loaded.move_to_end(key)
    while len(_loaded) > MAX_CACHED_MODELS:
        _loaded.popitem(last=False)
    return value


def scorecards(db):
    """Same ready/features/report contract as main's existing /api/odds loop."""
    out = {}
    for name in ("ingame", "pregame"):
        params, report, trained = load(db, name)
        out[name] = {"ready": bool(params), "reason": (report or {}).get("reason"), "trained_at": trained,
                     "report": report, "features": params.get("features") if params else None}
    return out


def _training_connect(db_path=None):
    if db_path is None:
        return store.connect()
    # store.connect has no path argument. Use its small-memory SQLite settings without
    # mutating store.DB_PATH, which may also be used by callers in this process.
    db = sqlite3.connect(db_path, timeout=30)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA cache_size=-2048")
        db.execute("PRAGMA temp_store=FILE")
        db.execute("PRAGMA mmap_size=0")
        store.init(db)
    except BaseException:
        db.close()
        raise
    return db


def train_all(db_path=None):
    """Background job: independent model saves, retaining old artifacts on exceptions.

    Returns a process exit status. Each trainer releases its extraction snapshot before
    fitting; this job must not wrap the whole fit in a read transaction. Cancellation
    and the process runtime bound belong to the parent, not another worker here.
    """
    if hasattr(os, "nice"):
        try:
            os.nice(10)
        except OSError:
            log.warning("Could not lower model training process priority", exc_info=True)
    failed = False
    try:
        with closing(_training_connect(db_path)) as db:
            for name, train in (("ingame", train_ingame), ("pregame", train_pregame)):
                try:
                    result = train(db)
                    status = result[1]["status"] if result else "not enough eligible games"
                    save(db, name, result)
                except Exception:
                    log.exception("%s: training/save failed; rolling back and preserving the stored artifact", name)
                    db.rollback()
                    failed = True
                    continue
                print(f"{name}: {status}", flush=True)
    except Exception:
        log.exception("Model training job failed to open or use its database")
        return 1
    return int(failed)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("train",))
    parser.add_argument("--db", type=Path, help="Train against this SQLite cache instead of store.DB_PATH")
    args = parser.parse_args(argv)
    return train_all(args.db)


if __name__ == "__main__":
    sys.exit(main())
