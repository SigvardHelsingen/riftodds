import math
import unittest

import perf
import store
import test_data


class PerformanceTests(unittest.TestCase):
    def test_missing_is_not_zero_but_observed_zero_is_kept(self):
        self.assertTrue(all(value is None for value in perf.values({}, 30).values()))
        p = {"totalMinionsKilled": 0, "neutralMinionsKilled": 0, "deaths": 0, "timeCCingOthers": 0,
             "visionScore": 0, "goldEarned": 0, "detectorWardsPlaced": 0, "wardsKilled": 0,
             "challenges": {"soloKills": 0, "laneMinionsFirst10Minutes": 0, "laningPhaseGoldExpAdvantage": False}}
        values = perf.values(p, 30)
        for key in ("cs_min", "deaths", "cc_min", "vision_min", "gold_min", "control_wards", "ward_kills", "solo_kills", "cs10", "lane_lead"):
            self.assertEqual(values[key], 0, key)
        self.assertIsNone(values["kp"])
        self.assertIsNone(perf.values({"totalMinionsKilled": 50}, 30)["cs_min"])
        self.assertIsNone(perf.values({"neutralMinionsKilled": 50}, 30)["cs_min"])

    def test_nonfinite_nonnumeric_negative_and_boolean_counters_are_rejected(self):
        for invalid in (math.nan, math.inf, -math.inf, "12", {}, True, -1, 10 ** 1000):
            with self.subTest(invalid=str(invalid)[:30]):
                p = {"deaths": invalid, "timeCCingOthers": invalid,
                     "totalMinionsKilled": invalid, "neutralMinionsKilled": 0,
                     "challenges": {"killParticipation": invalid, "soloKills": invalid}}
                values = perf.values(p, 30)
                self.assertTrue(all(values[k] is None for k in ("deaths", "cc_min", "cs_min", "kp", "solo_kills")))
                self.assertTrue(all(v is None or math.isfinite(v) for v in values.values()))
        self.assertEqual(perf.values({"challenges": {"laningPhaseGoldExpAdvantage": True}}, 30)["lane_lead"], 1)

    def test_invalid_duration_does_not_produce_rates(self):
        p = {"totalMinionsKilled": 100, "neutralMinionsKilled": 10, "timeCCingOthers": 10,
             "goldEarned": 10000, "visionScore": 30, "deaths": 2}
        for minutes in (0, -1, math.inf, math.nan, None, "30", True):
            with self.subTest(minutes=minutes):
                values = perf.values(p, minutes)
                for key in ("cs_min", "cc_min", "gold_min", "vision_min"):
                    self.assertIsNone(values[key])
                self.assertEqual(values["deaths"], 2)

    def test_raw_rate_and_ward_fallbacks_do_not_override_valid_challenges(self):
        p = {"goldEarned": 9000, "visionScore": 30, "detectorWardsPlaced": 3, "wardsKilled": 4}
        values = perf.values(p, 30)
        self.assertEqual((values["gold_min"], values["vision_min"], values["control_wards"], values["ward_kills"]), (300, 1, 3, 4))
        p["challenges"] = {"goldPerMinute": 400, "visionScorePerMinute": 2, "controlWardsPlaced": 0, "wardTakedowns": 1}
        values = perf.values(p, 30)
        self.assertEqual((values["gold_min"], values["vision_min"], values["control_wards"], values["ward_kills"]), (400, 2, 0, 1))
        p["challenges"]["goldPerMinute"] = math.inf
        self.assertEqual(perf.values(p, 30)["gold_min"], 300)
        p["challenges"] = ["malformed"]
        self.assertEqual(perf.values(p, 30)["gold_min"], 300)

    def test_objective_sum_requires_all_counters_not_assumed_zeros(self):
        p = {"challenges": {"dragonTakedowns": 2}}
        self.assertIsNone(perf.values(p, 30)["objectives"])
        p["challenges"].update(baronTakedowns=0, riftHeraldTakedowns=1)
        self.assertEqual(perf.values(p, 30)["objectives"], 3)
        p["challenges"]["baronTakedowns"] = math.nan
        self.assertIsNone(perf.values(p, 30)["objectives"])

    def test_kp_fallback_uses_explicit_team_totals_not_order(self):
        me = {"puuid": "me", "participantId": 40, "teamId": 200, "kills": 2, "assists": 3,
              "totalDamageDealtToChampions": 1000}
        ally = {"puuid": "ally", "participantId": 1, "teamId": 200, "kills": 8,
                "totalDamageDealtToChampions": 3000}
        opponent = {"puuid": "enemy", "participantId": 2, "teamId": 100, "kills": 100,
                    "totalDamageDealtToChampions": 100000}
        people = [opponent, ally, me]
        values = perf.values(me, 30, people)
        self.assertEqual((values["kp"], values["dmg_share"]), (0.5, 0.25))
        self.assertIsNone(perf.values(me, 30)["kp"], "No guessing without match participants")
        me["challenges"] = {"killParticipation": 0.7}
        self.assertEqual(perf.values(me, 30, people)["kp"], 0.7)
        me["challenges"]["killParticipation"] = math.nan
        self.assertEqual(perf.values(me, 30, people)["kp"], 0.5)
        del ally["kills"]
        self.assertIsNone(perf.values(me, 30, people)["kp"])
        del me["teamId"]
        self.assertIsNone(perf.values(me, 30, people)["kp"])

    def test_unknown_totals_or_assists_are_missing_but_zero_kill_game_is_zero(self):
        me = {"puuid": "me", "teamId": 100, "kills": 0, "assists": 0}
        ally = {"teamId": 100, "kills": 0}
        self.assertEqual(perf.values(me, 30, [me, ally])["kp"], 0)
        ally["kills"] = math.inf
        self.assertIsNone(perf.values(me, 30, [me, ally])["kp"])
        ally["kills"] = 5
        del me["assists"]
        self.assertIsNone(perf.values(me, 30, [me, ally])["kp"])
        me["assists"] = 10
        self.assertIsNone(perf.values(me, 30, [me, ally])["kp"], "Inconsistent numerator is not clamped")
        me["challenges"] = {"killParticipation": 1.1, "teamDamagePercentage": 2, "laningPhaseGoldExpAdvantage": 3}
        values = perf.values(me, 30)
        self.assertTrue(all(values[k] is None for k in ("kp", "dmg_share", "lane_lead")))

    def test_store_and_backfill_supply_participants_for_kp(self):
        db = test_data.fixture_db()
        self.addCleanup(db.close)
        match = test_data.match_fixture("KP")
        store.save_match(db, "euw1", match)
        self.assertEqual(db.execute("SELECT kp FROM perf WHERE puuid = 'fixture-player'").fetchone()[0], 0.5)
        db.execute("DELETE FROM perf")
        db.commit()
        self.assertEqual(store.backfill_perf(db), "KP")
        self.assertEqual(db.execute("SELECT kp FROM perf WHERE puuid = 'fixture-player'").fetchone()[0], 0.5)


if __name__ == "__main__":
    unittest.main()
