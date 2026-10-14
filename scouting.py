"""Read-only Clash scouting from normalized identities and the local cache.

Public functions:
* normalize_role(role): Riot/Clash role strings -> stats.ROLES, otherwise UNKNOWN.
* report(db, team, members): team = {id, name, tag, tier}; members = [{puuid,
  riot_id, role, tier, pool, pockets, cached_games, pending}]; bans =
  [{champion_id, games, share, players}]; pending and note.

`team` is a Clash team DTO (abbreviation becomes tag), or its normalized form.
`members` is the caller's normalized [{puuid, riot_id, role, tier, division, lp}].
Only supplied PUUIDs are used: no account lookup, summonerId conversion or invented
roster entries. Missing league tier stays None; explicit UNRANKED is preserved.
Division/LP are not used for scouting. The caller owns auth, rate limits and sync.

Each member's newest 50 cached non-remake solo-queue games are SQL-limited BEFORE
materialization and filtering by assigned role, with match_id breaking timestamp
ties. cached_games counts that bounded, all-role window;
pool rows flatten stats.winrate and add champion_id/share. Unknown roles have no
pool. Pockets reuse stats.mastery: up to six mastery champions absent from the
entire recent window, with predicted=False, never scored as picks or bans.

Ban games count observed player-games, once per PUUID; share divides by ALL
scored roster role-games, not a sum of member shares or a pick probability.
players = [{puuid, riot_id, role, games, share}] records each contributor's role
pool evidence. Pool and bans sort by descending game count, then champion ID.
Repeated member rows remain visible/pending but only the first contributes bans.

pending is a data/roster flag, NOT a claim that a sync job is running: a member
is pending without a usable PUUID, known role or observed role pool (also for a
repeated PUUID). The report is pending if any member is, or the roster does not
have five distinct identified members assigned one each of the five roles.
Optional league or mastery data does not make an otherwise usable member pending.
One read snapshot is used without committing/rolling back caller-owned writes.
"""
from collections import defaultdict

import stats
import store

RECENT_GAMES = 50
UNKNOWN_ROLE = "UNKNOWN"
ROLE_MAP = {role: role for role in stats.ROLES} | {
    "MID": "MIDDLE", "BOT": "BOTTOM", "ADC": "BOTTOM", "SUPPORT": "UTILITY",
}
NOTE = (
    "Observed assigned-role frequencies within each player's newest 50 cached non-remake "
    "ranked solo-queue games, not predicted Clash picks. Cached histories may be incomplete "
    "or out of date. Mastery pockets are historical comfort signals, not role/pick predictions, "
    "and do not affect bans. Ban share is a game-weighted roster frequency, not a probability "
    "that the team will pick a champion. Missing league information stays unknown."
)


def normalize_role(role):
    """Map explicit role strings only; never infer a role for FILL/UNSELECTED/unknown."""
    return ROLE_MAP.get(role.strip().upper(), UNKNOWN_ROLE) if isinstance(role, str) else UNKNOWN_ROLE


def _recent_games(db, puuid):
    """Read only the bounded scouting window, oldest first with stable timestamp ties."""
    cursor = db.execute(
        """SELECT m.match_id, m.game_start, p.champion_id, p.position, p.win
           FROM participants p JOIN matches m ON m.match_id = p.match_id
           WHERE p.puuid = ? AND m.queue_id = ? AND m.remake = 0
           ORDER BY m.game_start DESC, m.match_id DESC LIMIT ?""",
        (puuid, 420, RECENT_GAMES))
    games = [dict(row) for row in cursor]
    games.reverse()
    return games


def report(db, team, members):
    """Return the cached scouting contract documented above; no network or cache writes."""
    members = list(members)
    rows, bans, seen = [], {}, set()
    total_role_games = 0
    unresolved = unknown_roles = missing_history = duplicate_members = False
    with store.read_snapshot(db):
        for member in members:
            puuid = member.get("puuid")
            identified = isinstance(puuid, str) and bool(puuid.strip())
            duplicate = identified and puuid in seen
            if identified:
                seen.add(puuid)
            role = normalize_role(member.get("role"))
            games = _recent_games(db, puuid) if identified else []
            in_role = [g for g in games if normalize_role(g["position"]) == role
                       and type(g["champion_id"]) is int and g["champion_id"] > 0] if role in stats.ROLES else []
            champions = defaultdict(list)
            for game in in_role:
                champions[game["champion_id"]].append(game)
            pool = [{**stats.wr_of(played), "champion_id": champion, "share": len(played) / len(in_role)}
                    for champion, played in champions.items()]
            pool.sort(key=lambda row: (-row["games"], row["champion_id"]))
            pockets = [{**pocket, "predicted": False}
                       for pocket in stats.mastery(db, puuid, games)["pockets"]] if identified else []
            rows.append({
                "puuid": puuid, "riot_id": member.get("riot_id"), "role": role,
                "tier": member.get("tier"), "pool": pool, "pockets": pockets,
                "cached_games": len(games), "pending": not in_role or duplicate,
            })
            unresolved |= not identified
            unknown_roles |= role == UNKNOWN_ROLE
            missing_history |= identified and role != UNKNOWN_ROLE and not in_role
            duplicate_members |= duplicate
            if not identified or duplicate:
                continue
            total_role_games += len(in_role)
            for pick in pool:
                ban = bans.setdefault(pick["champion_id"], {
                    "champion_id": pick["champion_id"], "games": 0, "players": [],
                })
                ban["games"] += pick["games"]
                ban["players"].append({
                    "puuid": puuid, "riot_id": member.get("riot_id"), "role": role,
                    "games": pick["games"], "share": pick["share"],
                })

    ban_rows = [{**ban, "share": ban["games"] / total_role_games} for ban in bans.values()]
    ban_rows.sort(key=lambda row: (-row["games"], row["champion_id"]))
    incomplete = (len(rows) != 5 or len(seen) != 5 or {row["role"] for row in rows} != set(stats.ROLES)
                  or len(team.get("players") or []) > len(rows))
    notes = [NOTE]
    if incomplete:
        notes.append("Incomplete roster or missing/duplicate assigned roles; no players or roles were invented.")
    if unresolved:
        notes.append("Unresolved members have no usable PUUID; legacy summonerId values are not used as PUUIDs.")
    if unknown_roles:
        notes.append("Unknown, unselected and fill roles stay UNKNOWN and are not scored.")
    if missing_history:
        notes.append("Some members have no cached assigned-role games in this window; sync is left to the caller.")
    if duplicate_members:
        notes.append("Repeated PUUIDs contribute to ban counts only once.")
    return {
        "team": {"id": team.get("id"), "name": team.get("name"),
                 "tag": team.get("tag", team.get("abbreviation")), "tier": team.get("tier")},
        "members": rows, "bans": ban_rows,
        "pending": incomplete or any(row["pending"] for row in rows), "note": " ".join(notes),
    }
