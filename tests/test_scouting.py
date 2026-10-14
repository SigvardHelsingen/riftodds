import copy
import sqlite3
import tracemalloc
import unittest
from unittest.mock import patch

import scouting
import stats
import store


class RoleTests(unittest.TestCase):
    def test_explicit_riot_roles_and_aliases(self):
        roles = {"TOP": "TOP", "JUNGLE": "JUNGLE", "MIDDLE": "MIDDLE", "MID": "MIDDLE",
                 "BOTTOM": "BOTTOM", "BOT": "BOTTOM", "ADC": "BOTTOM", "UTILITY": "UTILITY",
                 "SUPPORT": "UTILITY", " support ": "UTILITY", "mid": "MIDDLE"}
        for supplied, expected in roles.items():
            with self.subTest(role=supplied):
                self.assertEqual(scouting.normalize_role(supplied), expected)

    def test_unknown_roles_are_not_guessed(self):
        for role in (None, "", "UNKNOWN", "UNSELECTED", "FILL", "NONE", "SOLO", 0, 1, [], {}):
            with self.subTest(role=role):
                self.assertEqual(scouting.normalize_role(role), "UNKNOWN")


class ScoutingTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        store.init(self.db)
        self.sequence = 0
        self.team = {"id": "team-id", "name": "Test Team", "abbreviation": "TEST", "tier": 2}

    def game(self, puuid, champion, role, win=1, queue=420, remake=0):
        self.sequence += 1
        mid = f"FIXTURE_{self.sequence}"
        self.db.execute("""INSERT INTO matches (match_id, platform, queue_id, game_start, duration, patch, remake)
                           VALUES (?, 'FIXTURE', ?, ?, 1800, '16.1.1', ?)""",
                        (mid, queue, self.sequence * 1000, remake))
        self.db.execute("INSERT INTO teams (match_id, team_id, win) VALUES (?, 100, ?)", (mid, win))
        self.db.execute("""INSERT INTO participants (match_id, puuid, team_id, champion_id, position, win, kills)
                           VALUES (?, ?, 100, ?, ?, ?, 0)""", (mid, puuid, champion, role, win))

    def mastery(self, puuid, champions):
        store.save_mastery(self.db, puuid, [
            {"championId": champion, "championLevel": 10, "championPoints": points, "lastPlayTime": 12345}
            for champion, points in champions
        ])

    def member(self, puuid, role, tier=None):
        return {"puuid": puuid, "riot_id": f"{puuid}#TEST" if puuid else None, "role": role,
                "tier": tier, "division": None, "lp": None}

    def test_role_pool_uses_observed_counts_and_flat_winrate(self):
        for champion, role, win in ((1, "MIDDLE", 1), (1, "MIDDLE", 0), (3, "MIDDLE", 0), (9, "JUNGLE", 1)):
            self.game("player", champion, role, win)
        members = [self.member("player", "MID", "GOLD")]
        original = copy.deepcopy((self.team, members))
        result = scouting.report(self.db, self.team, members)
        self.assertEqual((self.team, members), original)
        self.assertEqual(set(result), {"team", "members", "bans", "pending", "note"})
        self.assertEqual(result["team"], {"id": "team-id", "name": "Test Team", "tag": "TEST", "tier": 2})
        member = result["members"][0]
        self.assertEqual(set(member), {"puuid", "riot_id", "role", "tier", "pool", "pockets", "cached_games", "pending"})
        self.assertEqual(member["role"], "MIDDLE")
        self.assertEqual(member["cached_games"], 4)
        self.assertFalse(member["pending"])
        self.assertTrue(result["pending"])  # a usable member is not a complete roster
        self.assertEqual([row["champion_id"] for row in member["pool"]], [1, 3])
        first = member["pool"][0]
        self.assertEqual({key: first[key] for key in ("games", "wins", "wr")}, {"games": 2, "wins": 1, "wr": 0.5})
        self.assertAlmostEqual(first["share"], 2 / 3)
        self.assertLess(first["lo"], first["wr"])
        self.assertGreater(first["hi"], first["wr"])
        self.assertEqual({row["champion_id"] for row in result["bans"]}, {1, 3})

    def test_history_is_bounded_before_role_filtering(self):
        for _ in range(60):
            self.game("player", 99, "MIDDLE")
        for _ in range(10):
            self.game("player", 1, "MIDDLE")
        for _ in range(40):
            self.game("player", 7, "TOP")
        self.mastery("player", [(99, 900000), (1, 100000), (7, 80000)])
        result = scouting.report(self.db, self.team, [self.member("player", "MIDDLE")])
        member = result["members"][0]
        self.assertEqual(member["cached_games"], 50)
        self.assertEqual([(row["champion_id"], row["games"], row["share"]) for row in member["pool"]], [(1, 10, 1)])
        self.assertEqual([row["champion_id"] for row in member["pockets"]], [99])
        self.assertEqual([row["champion_id"] for row in result["bans"]], [1])

    def test_history_sql_limits_materialization_and_memory_without_fetchall(self):
        for _ in range(5000):
            self.game("player", 1, "TOP")
        self.db.commit()
        cursors = []
        statements = []
        self.db.set_trace_callback(statements.append)
        test = self
        db = self.db

        class Cursor:
            def __init__(self, raw):
                self.raw = raw
                self.rows_read = 0

            def __iter__(self):
                for row in self.raw:
                    self.rows_read += 1
                    test.assertLessEqual(self.rows_read, 50, "Unbounded history materialization")
                    yield row

            def fetchall(self):
                raise AssertionError("Scouting history must iterate a SQL-limited cursor, not fetchall()")

        class Connection:
            @property
            def in_transaction(self):
                return db.in_transaction

            def rollback(self):
                db.rollback()

            def execute(self, sql, parameters=()):
                normalized = " ".join(sql.upper().split())
                if "FROM PARTICIPANTS" not in normalized:
                    return db.execute(sql, parameters)
                test.assertRegex(normalized, r"\bLIMIT \?$")
                test.assertEqual(parameters, ("player", 420, 50))
                test.assertEqual(normalized.count("SELECT"), 1, "No correlated history subqueries")
                raw = db.execute(sql, parameters)
                test.assertEqual([column[0] for column in raw.description],
                                 ["match_id", "game_start", "champion_id", "position", "win"])
                cursor = Cursor(raw)
                cursors.append(cursor)
                return cursor

        with patch.object(stats, "player_games", side_effect=AssertionError("Full history must not be loaded")):
            tracemalloc.start()
            try:
                result = scouting.report(Connection(), self.team, [self.member("player", "TOP")])
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
        self.assertEqual(len(cursors), 1)
        self.assertEqual(cursors[0].rows_read, 50)
        self.assertEqual(result["members"][0]["cached_games"], 50)
        self.assertEqual(result["members"][0]["pool"][0]["games"], 50)
        self.assertLess(peak, 256 * 1024, "Scouting must not allocate the full cached history")
        history_sql = [" ".join(sql.upper().split()) for sql in statements if "FROM PARTICIPANTS" in sql.upper()]
        self.assertEqual(len(history_sql), 1)
        self.assertRegex(history_sql[0], r"\bLIMIT 50$")
        self.assertFalse(db.in_transaction)

    def test_recent_history_has_stable_timestamp_ties_and_minimal_rows(self):
        for champion in range(1, 61):
            self.game("player", champion, "TOP")
        self.db.execute("UPDATE matches SET game_start = 1000")
        expected = sorted(f"FIXTURE_{i}" for i in range(1, 61))[-50:]
        games = scouting._recent_games(self.db, "player")
        self.assertEqual([game["match_id"] for game in games], expected)
        self.assertEqual(games, scouting._recent_games(self.db, "player"))
        self.assertTrue(all(set(game) == {"match_id", "game_start", "champion_id", "position", "win"}
                            for game in games))

    def test_queue_remake_and_member_filters_apply_before_limit(self):
        for _ in range(60):
            self.game("player", 1, "TOP")
        for _ in range(60):
            self.game("player", 8, "TOP", queue=440)
            self.game("player", 9, "TOP", remake=1)
            self.game("other-player", 10, "TOP")
        result = scouting.report(self.db, self.team, [self.member("player", "TOP")])
        member = result["members"][0]
        self.assertEqual(member["cached_games"], 50)
        self.assertEqual([(row["champion_id"], row["games"]) for row in member["pool"]], [(1, 50)])

    def test_old_role_games_do_not_fill_an_empty_recent_role_pool(self):
        self.game("player", 99, "MIDDLE")
        for _ in range(50):
            self.game("player", 7, "TOP")
        result = scouting.report(self.db, self.team, [self.member("player", "MIDDLE")])
        self.assertEqual(result["members"][0]["cached_games"], 50)
        self.assertEqual(result["members"][0]["pool"], [])
        self.assertTrue(result["members"][0]["pending"])
        self.assertEqual(result["bans"], [])

    def test_other_queues_and_remakes_do_not_count(self):
        self.game("player", 1, "TOP")
        self.game("player", 8, "TOP", queue=440)
        self.game("player", 9, "TOP", queue=450)
        self.game("player", 10, "TOP", remake=1)
        result = scouting.report(self.db, self.team, [self.member("player", "TOP")])
        self.assertEqual(result["members"][0]["cached_games"], 1)
        self.assertEqual([(row["champion_id"], row["games"]) for row in result["bans"]], [(1, 1)])

    def test_mastery_pockets_are_separate_non_predictions_and_never_bans(self):
        self.game("player", 1, "MIDDLE")
        self.game("player", 9, "JUNGLE")
        self.mastery("player", [(99, 900000), (1, 200000), (9, 100000), (55, 50000)])
        result = scouting.report(self.db, self.team, [self.member("player", "MIDDLE")])
        member = result["members"][0]
        self.assertEqual([row["champion_id"] for row in member["pockets"]], [99, 55])
        self.assertEqual(member["pockets"][0], {"champion_id": 99, "level": 10, "points": 900000,
                                               "last_play": 12345, "predicted": False})
        self.assertTrue(all(not row["predicted"] and "share" not in row for row in member["pockets"]))
        self.assertEqual([row["champion_id"] for row in result["bans"]], [1])
        self.assertIn("not role/pick predictions", result["note"])

    def test_mastery_only_member_remains_pending_without_a_pool(self):
        self.mastery("player", [(champion, 100000 - champion) for champion in range(1, 10)])
        result = scouting.report(self.db, self.team, [self.member("player", "TOP", "UNRANKED")])
        member = result["members"][0]
        self.assertEqual(member["cached_games"], 0)
        self.assertEqual(member["pool"], [])
        self.assertEqual(len(member["pockets"]), 6)
        self.assertTrue(member["pending"])
        self.assertEqual(result["bans"], [])
        self.assertEqual(member["tier"], "UNRANKED")

    def test_bans_deduplicate_champions_and_weight_actual_role_games(self):
        for _ in range(9):
            self.game("a", 77, "TOP")
        self.game("a", 1, "TOP")
        self.game("b", 77, "JUNGLE")
        self.game("b", 2, "JUNGLE")
        self.game("b", 888, "BOTTOM")  # neither numerator nor denominator includes off-role games
        result = scouting.report(self.db, self.team, [self.member("a", "TOP"), self.member("b", "JUNGLE")])
        self.assertEqual([row["champion_id"] for row in result["bans"]], [77, 1, 2])
        ban = result["bans"][0]
        self.assertEqual(set(ban), {"champion_id", "games", "share", "players"})
        self.assertEqual(ban["games"], 10)
        self.assertAlmostEqual(ban["share"], 10 / 12)
        self.assertEqual(ban["players"], [
            {"puuid": "a", "riot_id": "a#TEST", "role": "TOP", "games": 9, "share": 0.9},
            {"puuid": "b", "riot_id": "b#TEST", "role": "JUNGLE", "games": 1, "share": 0.5},
        ])
        self.assertGreater(sum(player["share"] for player in ban["players"]), 1)
        self.assertTrue(all(0 <= row["share"] <= 1 for row in result["bans"]))
        self.assertAlmostEqual(sum(row["share"] for row in result["bans"]), 1)

    def test_complete_mixed_roles_and_optional_league_data(self):
        members = []
        for i, (assigned, cached) in enumerate(zip(("TOP", "JUNGLE", "MID", "ADC", "SUPPORT"), stats.ROLES)):
            puuid = f"player-{i}"
            self.game(puuid, 77, cached)
            member = self.member(puuid, assigned, "UNRANKED" if i == 0 else None)
            if i == 1:
                for key in ("tier", "division", "lp"):
                    member.pop(key)
            members.append(member)
        result = scouting.report(self.db, self.team, members)
        self.assertFalse(result["pending"])
        self.assertTrue(all(not member["pending"] for member in result["members"]))
        self.assertEqual([member["role"] for member in result["members"]], stats.ROLES)
        self.assertEqual([member["tier"] for member in result["members"]], ["UNRANKED", None, None, None, None])
        self.assertEqual(len(result["bans"]), 1)
        self.assertEqual((result["bans"][0]["games"], result["bans"][0]["share"]), (5, 1))
        self.assertEqual(len(result["bans"][0]["players"]), 5)

    def test_legacy_summoner_id_is_never_treated_as_a_puuid(self):
        self.game("modern-puuid", 1, "JUNGLE")
        self.game("legacy-id", 99, "TOP")
        self.mastery("legacy-id", [(55, 900000)])
        team = {**self.team, "players": [{"puuid": "modern-puuid", "position": "JUNGLE"},
                                        {"summonerId": "legacy-id", "position": "TOP"}]}
        members = [self.member("modern-puuid", "JUNGLE"), {**self.member(None, "TOP"), "summonerId": "legacy-id"}]
        with patch.object(scouting, "_recent_games", wraps=scouting._recent_games) as games, patch.object(stats, "mastery", wraps=stats.mastery) as mastery:
            result = scouting.report(self.db, team, members)
        games.assert_called_once_with(self.db, "modern-puuid")
        mastery.assert_called_once()
        self.assertEqual(mastery.call_args.args[1], "modern-puuid")
        unresolved = result["members"][1]
        self.assertIsNone(unresolved["puuid"])
        self.assertIsNone(unresolved["riot_id"])
        self.assertEqual(unresolved["cached_games"], 0)
        self.assertEqual(unresolved["pool"], [])
        self.assertEqual(unresolved["pockets"], [])
        self.assertTrue(unresolved["pending"])
        self.assertTrue(result["pending"])
        self.assertEqual([row["champion_id"] for row in result["bans"]], [1])
        self.assertIn("legacy summonerId", result["note"])

    def test_unknown_assigned_roles_are_not_inferred_from_history_or_team(self):
        self.game("player", 1, "TOP")
        team = {**self.team, "players": [{"puuid": "player", "position": "TOP"}]}
        for role in (None, "FILL", "UNSELECTED", "future-role"):
            with self.subTest(role=role):
                result = scouting.report(self.db, team, [self.member("player", role)])
                member = result["members"][0]
                self.assertEqual(member["role"], "UNKNOWN")
                self.assertEqual(member["cached_games"], 1)
                self.assertEqual(member["pool"], [])
                self.assertTrue(member["pending"])
                self.assertEqual(result["bans"], [])
                self.assertIn("stay UNKNOWN", result["note"])

    def test_incomplete_rosters_never_invent_members(self):
        team = {**self.team, "players": [{"puuid": f"player-{i}"} for i in range(5)]}
        result = scouting.report(self.db, team, [])
        self.assertEqual(result["members"], [])
        self.assertEqual(result["bans"], [])
        self.assertTrue(result["pending"])
        self.assertIn("Incomplete roster", result["note"])
        self.assertEqual(scouting.report(self.db, {"id": "id", "tag": "TAG"}, [])["team"],
                         {"id": "id", "name": None, "tag": "TAG", "tier": None})

    def test_duplicate_member_does_not_multiply_ban_games(self):
        self.game("player", 1, "TOP")
        member = self.member("player", "TOP")
        result = scouting.report(self.db, self.team, [member, member])
        self.assertEqual(result["bans"][0]["games"], 1)
        self.assertEqual(result["bans"][0]["share"], 1)
        self.assertEqual(len(result["bans"][0]["players"]), 1)
        self.assertTrue(result["members"][1]["pending"])
        self.assertIn("only once", result["note"])

    def test_read_only_snapshot_does_not_modify_or_leave_a_transaction(self):
        self.game("player", 1, "TOP")
        self.db.commit()
        self.db.execute("PRAGMA query_only=ON")
        changes = self.db.total_changes
        statements = []
        self.db.set_trace_callback(statements.append)
        scouting.report(self.db, self.team, [self.member("player", "TOP")])
        self.assertEqual(self.db.total_changes, changes)
        self.assertFalse(self.db.in_transaction)
        self.assertEqual(statements.count("BEGIN"), 1)
        self.assertEqual(statements.count("ROLLBACK"), 1)

    def test_report_preserves_caller_owned_uncommitted_writes(self):
        self.game("player", 1, "TOP")
        changes = self.db.total_changes
        self.assertTrue(self.db.in_transaction)
        result = scouting.report(self.db, self.team, [self.member("player", "TOP")])
        self.assertEqual(result["members"][0]["cached_games"], 1)
        self.assertTrue(self.db.in_transaction)
        self.assertEqual(self.db.total_changes, changes)
        self.db.rollback()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM matches").fetchone()[0], 0)

    def test_failed_report_releases_only_its_own_snapshot(self):
        for owned in (False, True):
            with self.subTest(owned=owned):
                self.db.rollback()
                if not owned:
                    self.db.execute("BEGIN")
                with patch.object(scouting, "_recent_games", side_effect=ValueError("fixture failure")):
                    with self.assertRaisesRegex(ValueError, "fixture failure"):
                        scouting.report(self.db, self.team, [self.member("player", "TOP")])
                self.assertEqual(self.db.in_transaction, not owned)
