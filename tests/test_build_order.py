"""Purchase chronology, bounded build aggregation and honest skill evidence."""
import copy
import tracemalloc
import unittest
from types import SimpleNamespace
from unittest import mock

import stats
import store
import test_data
import timeline


FULL_QEW = "123114131" + "333" + "2222" + "44"
FULL_QWE = "123114131" + "2222" + "333" + "44"
FULL_WQE = "213224242" + "1111" + "3333" + "4"


class SkillOrderTests(unittest.TestCase):
    def test_observed_order_follows_fifth_points_not_first_points(self):
        skills = "123" + "2222" + "1111" + "3333" + "444"
        self.assertEqual(stats.skill_order(skills), "WQE")
        evidence = stats.skill_order(skills, details=True)
        self.assertEqual(evidence["observed_order"], "WQE")
        self.assertEqual(evidence["inferred_order"], "")
        self.assertEqual(evidence["unknown"], "")
        self.assertFalse(evidence["estimated"])
        self.assertIn("Observed", evidence["label"])

    def test_partial_points_are_estimates_not_observed_maxes(self):
        evidence = stats.skill_order("123114131", details=True)
        self.assertEqual((evidence["order"], evidence["observed_order"], evidence["inferred_order"]), ("QEW", "Q", "EW"))
        self.assertTrue(evidence["estimated"])
        self.assertIn("Estimated", evidence["label"])
        no_max = stats.skill_order("123123124", details=True)
        self.assertEqual(no_max["observed_order"], "")
        self.assertTrue(no_max["estimated"], "Nine points alone do not establish any maxed skill")

    def test_unlearned_skills_are_unknown_not_inferred(self):
        evidence = stats.skill_order("11111", details=True)
        self.assertEqual(evidence["observed_order"], "Q")
        self.assertEqual(evidence["inferred_order"], "")
        self.assertEqual(evidence["unknown"], "WE")
        self.assertTrue(evidence["estimated"])

    def test_nonstandard_rank_counts_do_not_claim_normal_maxes(self):
        for skills in ("111111222223333344", "1111122222333334444"):
            with self.subTest(skills=skills):
                evidence = stats.skill_order(skills, details=True)
                self.assertFalse(evidence["standard_ranks"])
                self.assertTrue(evidence["estimated"])
                self.assertEqual(evidence["observed_order"], "")
                self.assertIn("nonstandard", evidence["label"])

    def test_invalid_or_empty_order_does_not_invent_a_priority(self):
        for skills in (None, "", "12312312x", "123123120", 123):
            with self.subTest(skills=skills):
                self.assertEqual(stats.skill_order(skills), "")
                self.assertEqual(stats.skill_order(skills, details=True)["observed_order"], "")


class BuildOrderTests(unittest.TestCase):
    def setUp(self):
        self.db = test_data.fixture_db()
        self.addCleanup(self.db.close)

    def add(self, mid, bought=(), *, skills="", win=True, champion=901, role="MIDDLE", patch="16.1", tier=None, purchases=True):
        final = [] if isinstance(bought, str) else [item for _, item in bought]
        match = test_data.build_match(mid, champion, final, win, subject=f"p-{mid}", position=role, patch=patch)
        store.save_match(self.db, "FIXTURE", match)
        if tier:
            store.tag_tier(self.db, mid, tier)
        if purchases:
            text = bought if isinstance(bought, str) else ",".join(f"{item}:{seconds}" for seconds, item in bought)
            self.db.execute("INSERT INTO purchases VALUES (?, ?, ?, ?)", (mid, f"p-{mid}", text, skills))
        return match

    def build(self, *, champion=901, role="MIDDLE", patch="16.1", tier=None, items=None):
        where, args = stats._population(patch, tier, 420)
        return stats.build_order(self.db, where, args, champion, role, test_data.ITEMS if items is None else items)

    def test_purchase_chronology_not_item_ids_final_slots_or_row_order(self):
        self.add("CHRONO", [(1800, 3036), (900, 3072), (1200, 3031)])
        result = self.build()
        self.assertEqual(result["core"][0]["items"], [3072, 3031, 3036])
        self.assertEqual(result["core"][0]["minutes"], [15, 20, 30])
        self.assertEqual((result["first"][0]["item"], result["first"][0]["minute"]), (3072, 15))
        self.assertEqual((result["core"][0]["games"], result["core"][0]["wins"]), (1, 1))

    def test_actual_timeline_events_integrate_with_build_order(self):
        match = self.add("EVENTS", purchases=False)
        raw = test_data.timeline_fixture(match)
        raw["info"]["frames"][-1]["events"] = [
            {"timestamp": seconds * 1000, "type": "ITEM_PURCHASED", "participantId": 1, "itemId": item}
            for seconds, item in ((850, 3036), (600, 3072), (700, 3031))]
        store.save_timeline(self.db, "EVENTS", raw)
        self.assertEqual(self.build()["core"][0]["items"], [3072, 3031, 3036])
        self.assertEqual(self.build()["core"][0]["minutes"], [10, 12, 14])

    def test_same_timestamp_keeps_transaction_order(self):
        self.add("TIED", [(600, 3072), (600, 3031), (1200, 3036)])
        self.assertEqual(self.build()["core"][0]["items"], [3072, 3031, 3036])

    def test_boots_and_support_do_not_consume_first_or_core_slots(self):
        items = copy.deepcopy(test_data.ITEMS)
        items[3006]["completed"] = True
        items[3877]["completed"] = True
        self.add("EXCLUDE", [(2, 1055), (300, 3006), (400, 3877), (450, 1036),
                             (600, 3072), (900, 3031), (1200, 3036), (1500, 6672)])
        result = self.build(items=items)
        self.assertEqual(result["core"][0]["items"], [3072, 3031, 3036])
        self.assertEqual(result["first"][0]["item"], 3072)
        self.assertNotIn(6672, result["core"][0]["items"], "Core is the first three, not all combinations")

    def test_duplicate_completed_purchases_count_once_and_use_earliest_buy(self):
        self.add("REBUY", [(900, 3031), (600, 3031), (1080, 3072), (1500, 3036), (1740, 3031)])
        result = self.build()
        self.assertEqual(result["core"][0]["items"], [3031, 3072, 3036])
        self.assertEqual(result["core"][0]["minutes"], [10, 18, 25])
        self.assertEqual(result["first"][0]["games"], 1)

    def test_starters_keep_real_duplicate_consumables_but_exclude_wards(self):
        self.add("START", [(2, 1055), (3, 2003), (4, 2003), (5, 3340), (6, 2055), (59.9, 3865), (60, 1036)])
        result = self.build()
        self.assertEqual(result["start"][0]["items"], [1055, 2003, 2003, 3865])
        self.assertEqual(result["start"][0]["games"], 1)
        self.assertEqual(result["core"], [])

    def test_first_shop_is_later_than_starters_and_ignores_wards_and_trinkets(self):
        self.add("SHOP", [(700, 3031), (2, 1055), (50, 2003), (60, 2055), (90, 3340),
                          (100, 3363), (120, 3364), (180, 1036), (240, 3006), (300, 3877)])
        result = self.build()
        self.assertEqual(result["first_shop"], {
            "minute": 3, "games": 1,
            "label": "First later shop purchase (not necessarily first recall)",
        })
        self.assertEqual(result["start"][0]["items"], [1055, 2003])
        self.assertEqual((result["first"][0]["item"], result["first"][0]["minute"]), (3031, 12))

    def test_first_shop_can_be_boots_support_consumables_or_rebought_starter(self):
        for i, item in enumerate((3006, 3877, 2003, 1055)):
            with self.subTest(item=item):
                champion = 910 + i
                self.add(f"SHOP_TYPE{i}", [(2, 1055), (180, item), (600, 3031)], champion=champion)
                result = self.build(champion=champion)
                self.assertEqual((result["first_shop"]["minute"], result["first_shop"]["games"]), (3, 1))
                self.assertEqual(result["first"][0]["item"], 3031)

    def test_first_shop_median_counts_one_first_purchase_per_observed_game(self):
        for i, first_time in enumerate((120, 300, 420)):
            self.add(f"SHOP_MEDIAN{i}", [(2, 1055), (first_time, 1036), (600, 1036),
                                        (2000, 3031), (2100, 3072), (2200, 3036)], win=i == 0)
        self.add("SHOP_UNOBSERVED", [(2, 1055)])
        result = self.build()
        self.assertEqual(result["games"], 4)
        self.assertEqual((result["first_shop"]["minute"], result["first_shop"]["games"]), (5, 3))
        self.assertEqual(set(result["first_shop"]), {"minute", "games", "label"}, "No recall claim or win-rate association")

    def test_first_shop_uses_retained_purchase_order_after_undo(self):
        for champion, keep_later in ((901, True), (902, False)):
            with self.subTest(keep_later=keep_later):
                match = self.add(f"SHOP_UNDO{champion}", champion=champion, purchases=False)
                raw = test_data.timeline_fixture(match)
                events = [
                    {"timestamp": 2000, "type": "ITEM_PURCHASED", "participantId": 1, "itemId": 1055},
                    {"timestamp": 120000, "type": "ITEM_PURCHASED", "participantId": 1, "itemId": 1036},
                    {"timestamp": 121000, "type": "ITEM_UNDO", "participantId": 1, "beforeId": 1036, "afterId": 0},
                    {"timestamp": 300000, "type": "ITEM_PURCHASED", "participantId": 1, "itemId": 2055},
                ]
                if keep_later:
                    events.append({"timestamp": 420000, "type": "ITEM_PURCHASED", "participantId": 1, "itemId": 3006})
                for e in events:
                    raw["info"]["frames"][e["timestamp"] // 60000 + 1]["events"].append(e)
                store.save_timeline(self.db, match["metadata"]["matchId"], raw)
                text = self.db.execute("SELECT items FROM purchases WHERE puuid = ?", (f"p-SHOP_UNDO{champion}",)).fetchone()[0]
                self.assertNotIn(1036, [item for _, item in timeline.parse_items(text)])
                shop = self.build(champion=champion)["first_shop"]
                if keep_later:
                    self.assertEqual((shop["minute"], shop["games"]), (7, 1))
                else:
                    self.assertIsNone(shop, "A canceled later buy is not an observed shop purchase")

    def test_first_shop_is_none_when_no_later_purchase_is_observed(self):
        self.assertIsNone(self.build()["first_shop"])
        self.add("SHOP_EMPTY")
        self.add("SHOP_START_ONLY", [(0, 1055), (59.999, 2003)])
        self.add("SHOP_WARDS_ONLY", [(2, 1055), (60, 2055), (120, 3340), (180, 3363), (240, 3364)])
        self.add("SHOP_MISSING")
        self.db.execute("UPDATE purchases SET items = NULL WHERE match_id = 'SHOP_MISSING'")
        self.add("SHOP_MISSING_TIME", "1055:2,1036:")
        self.add("SHOP_NO_TIMELINE", [(180, 1036)], purchases=False)
        result = self.build()
        self.assertEqual(result["games"], 5)
        self.assertIsNone(result["first_shop"], "Missing observations must not become a zero-minute shop")

    def test_first_shop_threshold_uses_actual_seconds_before_histogram_rounding(self):
        self.add("SHOP_BEFORE", [(59.999, 1036)])
        self.assertIsNone(self.build()["first_shop"])
        self.add("SHOP_AT", [(60, 3006)])
        self.add("SHOP_AFTER", [(60.001, 1036)])
        result = self.build()
        self.assertEqual((result["first_shop"]["minute"], result["first_shop"]["games"]), (1, 2))

    def test_first_shop_overflow_is_unknown_not_capped_or_absent(self):
        for i, (seconds, expected) in enumerate(((10800, 180), (10800.001, None), (1e200, None))):
            with self.subTest(seconds=seconds):
                champion = 920 + i
                self.add(f"SHOP_BOUND{i}", [(seconds, 1036)], champion=champion)
                shop = self.build(champion=champion)["first_shop"]
                self.assertEqual(shop["games"], 1)
                self.assertEqual(shop["minute"], expected)
        self.add("SHOP_MIXED0", [(300, 1036)], champion=930)
        self.add("SHOP_MIXED1", [(1e200, 1036)], champion=930)
        self.assertEqual(self.build(champion=930)["first_shop"]["games"], 2)
        self.assertIsNone(self.build(champion=930)["first_shop"]["minute"])

    def test_first_shop_invalid_timestamps_keep_existing_parse_and_snapshot_semantics(self):
        self.add("SHOP_INVALID")
        self.db.commit()
        for seconds in ("nan", "inf", "-inf", "-1"):
            with self.subTest(seconds=seconds):
                self.db.execute("UPDATE purchases SET items = ? WHERE match_id = 'SHOP_INVALID'", (f"1036:{seconds}",))
                self.db.commit()
                with self.assertRaisesRegex(ValueError, "Invalid purchase"):
                    self.build()
                self.assertFalse(self.db.in_transaction)

    def test_first_shop_does_not_change_existing_build_order_arrays(self):
        self.add("SHOP_CONTRACT", [(600, 3031), (900, 3072), (1200, 3036)], skills=FULL_QEW)
        before = self.build()
        self.db.execute("UPDATE purchases SET items = '1036:180,3031:600,3072:900,3036:1200' WHERE match_id = 'SHOP_CONTRACT'")
        after = self.build()
        for key in ("games", "core", "first", "start", "skills", "timing_resolution_seconds"):
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(before["first_shop"]["minute"], 10)
        self.assertEqual(after["first_shop"]["minute"], 3)

    def test_weighted_histogram_medians_not_averages(self):
        for i, times in enumerate(((600, 900, 1200), (660, 960, 1260), (3600, 4500, 5400))):
            self.add(f"MEDIAN{i}", list(zip(times, (3031, 3072, 3036))), win=i != 2)
        result = self.build()
        self.assertEqual(result["core"][0]["minutes"], [11, 16, 21])
        self.assertEqual(result["first"][0]["minute"], 11)
        self.assertEqual((result["core"][0]["games"], result["core"][0]["wins"]), (3, 2))
        self.assertEqual(result["timing_resolution_seconds"], 1)

    def test_even_histogram_median_and_fractional_seconds(self):
        self.add("EVEN0", [(600.125, 3031), (900, 3072), (1200, 3036)])
        self.add("EVEN1", [(720.125, 3031), (1020, 3072), (1320, 3036)])
        result = self.build()
        self.assertEqual(result["first"][0]["minute"], 11)
        self.assertEqual(result["core"][0]["minutes"], [11, 16, 21])

    def test_extreme_times_are_unknown_not_capped_fake_medians(self):
        for i in range(3):
            self.add(f"LONG{i}", [(20000 + i, 3031), (21000 + i, 3072), (22000 + i, 3036)])
        result = self.build()
        self.assertIsNone(result["first"][0]["minute"])
        self.assertEqual(result["core"][0]["minutes"], [None, None, None])
        self.assertEqual(result["core"][0]["games"], 3)

    def test_thin_high_win_option_does_not_outrank_qualified_option(self):
        for i in range(10):
            self.add(f"COMMON{i}", [(600, 3031), (900, 3072), (1200, 3036)], win=i < 5)
        for i in range(4):
            self.add(f"THIN{i}", [(600, 3046), (900, 6672), (1200, 3031)], win=True)
        result = self.build()
        self.assertEqual([core["items"] for core in result["core"]], [[3031, 3072, 3036]])
        self.assertEqual(result["first"][0]["item"], 3031)
        self.assertAlmostEqual(result["core"][0]["share"], 10 / 14)

    def test_thin_fallback_is_most_observed_not_a_small_perfect_winrate(self):
        for i in range(4):
            self.add(f"POPULAR{i}", [(600, 3031), (900, 3072), (1200, 3036)], win=False)
        self.add("PERFECT", [(600, 3046), (900, 6672), (1200, 3031)])
        result = self.build()
        self.assertEqual(len(result["core"]), 1)
        self.assertEqual(result["core"][0]["items"], [3031, 3072, 3036])
        self.assertEqual(result["core"][0]["wr"], 0)

    def test_skill_start_is_conditional_on_selected_observed_max_order(self):
        for i in range(6):
            self.add(f"QWE{i}", skills=FULL_QWE, win=True)
        for i in range(8):
            self.add(f"WQE{i}", skills=FULL_WQE, win=False)
        selected = self.build()["skills"][0]
        self.assertEqual(selected["order"], "QWE")
        self.assertEqual(selected["first"], "QWE", "Global WQE starter is unrelated to this winning order")
        self.assertEqual(selected["observed_order"], "QWE")
        self.assertFalse(selected["estimated"])
        self.assertEqual(selected["games"], 6)

    def test_partial_and_observed_orders_are_not_pooled_as_confirmed_maxes(self):
        for i in range(6):
            self.add(f"OBSERVED{i}", skills=FULL_QWE, win=True)
        for i in range(8):
            self.add(f"PARTIAL{i}", skills="211312124", win=False)  # same QWE priority, different first skills
        selected = self.build()["skills"][0]
        self.assertEqual(selected["order"], "QWE")
        self.assertEqual(selected["observed_order"], "QWE")
        self.assertEqual(selected["games"], 6, "Eight estimated priorities must not inflate observed sample")
        self.assertEqual(selected["first"], "QWE")
        self.assertFalse(selected["estimated"])

    def test_nine_points_without_any_max_are_explicitly_estimated(self):
        self.add("NO_MAX", skills="123123124")
        selected = self.build()["skills"][0]
        self.assertEqual(selected["observed_order"], "")
        self.assertTrue(selected["estimated"])
        self.assertIn("Estimated", selected["label"])
        self.add("INVALID", skills="12312312x")
        self.add("SHORT", skills="123")
        self.assertEqual(self.build()["skills"][0]["games"], 1)

    def test_partially_completed_max_order_has_only_its_observed_prefix(self):
        self.add("PARTIAL_MAX", skills="123114131")
        selected = self.build()["skills"][0]
        self.assertEqual((selected["order"], selected["observed_order"]), ("QEW", "Q"))
        self.assertTrue(selected["estimated"])
        self.assertEqual(selected["first"], "QWE")

    def test_only_matching_population_with_purchase_rows_counts(self):
        bought = [(600, 3031), (900, 3072), (1200, 3036)]
        self.add("SELECTED", bought, tier="GOLD")
        self.add("OTHER_TIER", bought, tier="SILVER")
        self.add("OTHER_ROLE", bought, role="TOP", tier="GOLD")
        self.add("OTHER_CHAMP", bought, champion=902, tier="GOLD")
        self.add("OTHER_PATCH", bought, patch="16.2", tier="GOLD")
        self.add("NO_TIMELINE", bought, tier="GOLD", purchases=False)
        self.assertEqual(self.build(tier="GOLD")["games"], 1)
        self.assertEqual(self.build()["games"], 2)

    def test_empty_responses_retain_existing_contract(self):
        result = self.build()
        for key in ("core", "first", "start", "skills"):
            self.assertEqual(result[key], [])
        self.assertEqual(result["games"], 0)
        self.add("EMPTY")
        self.assertEqual(self.build()["games"], 1, "An observed empty order is different from no purchase row")
        self.assertEqual(self.build()["first"], [])

    def test_owned_snapshot_is_released_without_committing(self):
        self.add("SNAPSHOT", [(600, 3031)])
        self.db.commit()
        self.db.queries.clear()
        before = self.db.rollback_count
        result = self.build()
        self.assertEqual(result["games"], 1)
        self.assertFalse(self.db.in_transaction)
        self.assertEqual(sum(sql == "BEGIN" for sql, _ in self.db.queries), 1)
        self.assertEqual(self.db.rollback_count, before + 1)

    def test_caller_transaction_and_writes_are_preserved(self):
        self.add("PENDING", [(600, 3031)])
        before = self.db.rollback_count
        self.db.queries.clear()
        self.assertEqual(self.build()["games"], 1)
        self.assertTrue(self.db.in_transaction)
        self.assertEqual(self.db.rollback_count, before)
        self.assertNotIn(("BEGIN", ()), self.db.queries)
        self.db.rollback()
        self.assertEqual(self.build()["games"], 0)

    def test_owned_snapshot_releases_on_error_but_caller_snapshot_is_kept(self):
        self.add("ERROR", [(600, 3031)])
        self.db.commit()
        with mock.patch.object(stats.timeline, "parse_items", side_effect=ValueError("fixture parse error")):
            with self.assertRaisesRegex(ValueError, "fixture parse error"):
                self.build()
            self.assertFalse(self.db.in_transaction)
            self.add("PENDING")
            before = self.db.rollback_count
            with self.assertRaisesRegex(ValueError, "fixture parse error"):
                self.build()
            self.assertTrue(self.db.in_transaction)
            self.assertEqual(self.db.rollback_count, before)
            self.assertTrue(store.has_match(self.db, "PENDING"))

    def test_nested_champion_build_owns_only_one_snapshot(self):
        self.add("NESTED", [(600, 3031), (900, 3072), (1200, 3036)])
        self.db.commit()
        self.db.queries.clear()
        before = self.db.rollback_count
        result = stats.champion_build(self.db, 901, "MIDDLE", "16.1", test_data.ITEMS)
        self.assertEqual(result["order"]["games"], 1)
        self.assertEqual(sum(sql == "BEGIN" for sql, _ in self.db.queries), 1)
        self.assertEqual(self.db.rollback_count, before + 1)


class BuildOrderMemoryTests(unittest.TestCase):
    def test_one_pass_fractional_timings_do_not_retain_population_samples(self):
        calls = []
        def rows():
            for i in range(100_000):
                fraction = i / 100_000
                yield f"3031:{600 + fraction},3072:{900 + fraction},3036:{1200 + fraction}", FULL_QEW, i % 2
        def execute(sql, args):
            calls.append((sql, args))
            return rows()
        db = SimpleNamespace(in_transaction=True, execute=execute)
        tracemalloc.start()
        try:
            result = stats.build_order(db, "m.patch = ?", ["16.1"], 901, "MIDDLE", test_data.ITEMS)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(len(calls), 1, "One streaming aggregate query, no fetch-all or second population scan")
        self.assertEqual(result["games"], 100_000)
        self.assertEqual(result["core"][0]["games"], 100_000)
        self.assertEqual(result["core"][0]["wins"], 50_000)
        self.assertEqual(result["core"][0]["minutes"], [10, 15, 20])
        self.assertEqual((result["first_shop"]["minute"], result["first_shop"]["games"]), (10, 100_000))
        self.assertLess(peak, 512 * 1024, "Fractional timestamps must become bounded bins, not one key/sample")


class TimelineFixtureTests(unittest.TestCase):
    def test_fixture_has_real_timestamps_mapping_and_rift_metadata(self):
        match = test_data.match_fixture("FIXTURE_TIMES")
        raw = test_data.timeline_fixture(match)
        self.assertEqual([frame["timestamp"] for frame in raw["info"]["frames"]], [minute * 60000 for minute in range(16)])
        dg, _ = timeline.extract(raw, match["info"])
        self.assertEqual(dg["map_id"], 11)
        self.assertEqual(dg["ts"], list(range(0, 960, 60)))
        self.assertTrue(all(dg["valid"]))

    def test_fixture_respects_explicit_noncanonical_ids_and_shuffled_teams(self):
        match = test_data.match_fixture("FIXTURE_IDS")
        for i, p in enumerate(match["info"]["participants"]):
            p["participantId"] = 30 + i * 3
        match["info"]["participants"].reverse()
        raw = test_data.timeline_fixture(match)
        dg, _ = timeline.extract(raw, match["info"])
        self.assertEqual(dg["pids"], list(range(30, 60, 3)))
        self.assertEqual(timeline.team_of(30, dg), 100)
        self.assertEqual(timeline.team_of(57, dg), 200)
        self.assertEqual(timeline.states(dg)[15]["gold"], 5000)

    def test_fixture_timestamps_do_not_relax_missing_timestamp_validation(self):
        match = test_data.match_fixture("MISSING_TIMES")
        raw = test_data.timeline_fixture(match)
        for frame in raw["info"]["frames"]:
            del frame["timestamp"]
        dg, _ = timeline.extract(raw, match["info"])
        self.assertFalse(any(dg["valid"]))
        self.assertEqual(timeline.states(dg), [])


if __name__ == "__main__":
    unittest.main()
