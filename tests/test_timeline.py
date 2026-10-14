import copy
import json
import sqlite3
import unittest
import zlib

import store
import test_data
import timeline


def event(t, kind, **fields):
    return {"timestamp": t * 1000, "type": kind, **fields}


def rich_timeline(match, minutes=26):
    """A timeline with the events a digest keeps: purchases (one undone), skills, kills with
    positions, four blue dragons (soul), Baron, voidgrubs, buildings and the game end."""
    people = match["info"]["participants"]
    frames = []
    for m in range(minutes):
        frames.append({"timestamp": m * 60000, "events": [], "participantFrames": {
            str(i + 1): {"totalGold": 500 + m * (420 if i < 5 else 380), "xp": m * 400, "minionsKilled": m * 7,
                         "jungleMinionsKilled": 0, "position": {"x": 1000 + i * 100, "y": 1000 + m * 300}}
            for i in range(10)}})
    frames[2]["participantFrames"]["2"]["position"] = {"x": 7700, "y": 4100}
    frames[2]["participantFrames"]["7"]["position"] = {"x": 7100, "y": 10800}
    events = [
        event(2, "ITEM_PURCHASED", participantId=1, itemId=1055), event(3, "ITEM_PURCHASED", participantId=1, itemId=2003),
        event(4, "ITEM_PURCHASED", participantId=1, itemId=3340), event(5, "ITEM_PURCHASED", participantId=1, itemId=2003),
        event(6, "ITEM_UNDO", participantId=1, beforeId=2003, afterId=0, goldGain=50),
        event(600, "ITEM_PURCHASED", participantId=1, itemId=3031), event(900, "ITEM_PURCHASED", participantId=1, itemId=3072),
        *[event(10 + k * 60, "SKILL_LEVEL_UP", participantId=1, skillSlot=slot, levelUpType="NORMAL")
          for k, slot in enumerate([1, 2, 3, 1, 1, 4, 1, 3, 1])],
        event(70, "SKILL_LEVEL_UP", participantId=1, skillSlot=2, levelUpType="EVOLVE"),
        event(200, "CHAMPION_KILL", killerId=2, victimId=8, assistingParticipantIds=[4], position={"x": 1500, "y": 9000}),
        event(250, "CHAMPION_KILL", killerId=7, victimId=1, assistingParticipantIds=[], position={"x": 5000, "y": 10400}),
        event(300, "CHAMPION_KILL", killerId=0, victimId=1, position={"x": 13500, "y": 13500}),
        *[event(400 + k * 240, "ELITE_MONSTER_KILL", killerTeamId=100, monsterType="DRAGON", monsterSubType="FIRE_DRAGON")
          for k in range(4)],
        *[event(480 + k * 5, "ELITE_MONSTER_KILL", killerTeamId=200, monsterType="HORDE") for k in range(3)],
        event(1300, "ELITE_MONSTER_KILL", killerTeamId=100, monsterType="BARON_NASHOR"),
        event(700, "BUILDING_KILL", teamId=200, buildingType="TOWER_BUILDING", laneType="TOP_LANE", towerType="OUTER_TURRET"),
        event(1400, "BUILDING_KILL", teamId=200, buildingType="INHIBITOR_BUILDING", laneType="MID_LANE"),
        event(650, "TURRET_PLATE_DESTROYED", teamId=200, laneType="TOP_LANE"),
        event(1530, "GAME_END", winningTeam=100),
    ]
    for e in events:
        frames[min(minutes - 1, e["timestamp"] // 60000 + 1)]["events"].append(e)
    return {"metadata": {"participants": [p["puuid"] for p in people]},
            "info": {"mapId": 11, "gameMode": "CLASSIC",
                     "participants": [{"participantId": i + 1, "puuid": p["puuid"], "teamId": p["teamId"]}
                                      for i, p in enumerate(people)], "frames": frames}}


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.match = test_data.match_fixture("TL1")
        self.dg, self.orders = timeline.extract(rich_timeline(self.match))

    def test_digest_keeps_minutes_and_story_events(self):
        dg = self.dg
        self.assertEqual((len(dg["gold"]), len(dg["gold"][0]), len(dg["pos"][0])), (26, 10, 20))
        self.assertEqual(dg["kills"][0], [200, 2, 8, 1500, 9000, [4]])
        self.assertEqual([m[2] for m in dg["monsters"]].count("DRAGON"), 4)
        self.assertEqual((dg["end"], dg["winner"]), (1530, 100))
        self.assertLess(len(zlib.compress(json.dumps(dg).encode())), 6000)

    def test_purchases_drop_undone_buys_and_wards_and_skills_skip_evolutions(self):
        items, skills = self.orders["fixture-player"]
        self.assertEqual(timeline.parse_items(items), [(2, 1055), (3, 2003), (600, 3031), (900, 3072)])
        self.assertEqual(skills, "123114131")

    def test_frames_without_positions_or_events_still_extract(self):
        dg, orders = timeline.extract(test_data.timeline_fixture(self.match))
        self.assertEqual((dg["kills"], dg["pos"][0][:2]), ([], [None, None]))
        self.assertEqual(orders["fixture-player"], ("", ""))


class StateTests(unittest.TestCase):
    def setUp(self):
        self.dg, _ = timeline.extract(rich_timeline(test_data.match_fixture("TL2")))
        self.states = timeline.states(self.dg)

    def test_counts_are_cumulative_and_executions_are_separate(self):
        at = {s["m"]: s for s in self.states}
        self.assertEqual(at[4]["kills"], [1, 0], "A kill at 4:10 isn't in the 4:00 frame")
        self.assertEqual(at[5]["kills"], [1, 1], "An execution awards neither team a kill")
        self.assertEqual(at[5]["executions"], [1, 0])
        self.assertEqual(at[12]["towers"], [1, 0])
        self.assertEqual(at[9]["grubs"], [0, 3])

    def test_soul_buffs_and_inhibitors_last_as_long_as_they_do(self):
        at = {s["m"]: s for s in self.states}
        self.assertIsNone(at[17]["soul"])
        self.assertEqual((at[19]["dragons"], at[19]["soul"]), ([4, 0], 0))
        self.assertEqual(at[22]["baron"], [1, 0])
        self.assertEqual(at[25]["baron"], [0, 0], "Baron lasts three minutes")
        self.assertEqual(at[24]["inhibs"], [1, 0])

    def test_gold_lead_is_blue_minus_red(self):
        self.assertEqual(self.states[10]["gold"], 5 * (500 + 4200) - 5 * (500 + 3800))


class MapTests(unittest.TestCase):
    def test_zones_are_seen_from_the_players_team(self):
        cases = [((500, 500), 100, "base"), ((500, 500), 200, "enemy_base"), ((1500, 9000), 100, "top"),
                 ((13500, 6000), 100, "bot"), ((7400, 7300), 100, "mid"), ((9866, 4414), 100, "river"),
                 ((3800, 7900), 100, "jungle"), ((3800, 7900), 200, "enemy_jungle"), ((None, 5), 100, None)]
        for (x, y), team, want in cases:
            with self.subTest(x=x, y=y, team=team):
                self.assertEqual(timeline.zone(x, y, team), want)


class StoryTests(unittest.TestCase):
    def setUp(self):
        self.dg, _ = timeline.extract(rich_timeline(test_data.match_fixture("TL3")))

    def test_events_are_from_the_teams_side_and_grubs_merge(self):
        red = timeline.story_events(self.dg, 200)
        monsters = [(e["label"], e["side"]) for e in red if e["kind"] == "monster"]
        self.assertIn(("Voidgrub", "us"), monsters)  # 8:00 belongs to the 8:00 snapshot
        self.assertIn(("Voidgrubs ×2", "us"), monsters)  # 8:05 and 8:10 are in the next interval
        self.assertIn(("Fire Dragon", "them"), monsters)
        self.assertIn(("Top outer turret", "them"), [(e["label"], e["side"]) for e in red if e["kind"] == "building"])

    def _grub_events(self):
        return [e for e in timeline.story_events(self.dg, 200) if e.get("monster") == "HORDE"]

    def _assert_grubs_match_each_actual_cutoff(self):
        events = self._grub_events()
        for state in timeline.states(self.dg):
            visible = [e for e in events if e["t"] <= state["t"]]
            self.assertEqual(sum(e["count"] for e in visible), state["grubs"][1])
            self.assertTrue(all(e["end_t"] <= state["t"] for e in visible))
            self.assertTrue(all(t <= state["t"] for e in visible for t in e["times"]))

    def test_grubs_in_one_actual_interval_stay_grouped_with_original_times(self):
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (491.125, 481, 486)]
        groups = self._grub_events()
        self.assertEqual(len(groups), 1)
        self.assertEqual((groups[0]["label"], groups[0]["count"]), ("Voidgrubs ×3", 3))
        self.assertEqual((groups[0]["t"], groups[0]["end_t"], groups[0]["times"]), (481, 491.125, [481, 486, 491.125]))
        self._assert_grubs_match_each_actual_cutoff()

    def test_grubs_across_minute_boundary_do_not_leak_into_table_or_turning(self):
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (599, 601, 605)]
        groups = self._grub_events()
        self.assertEqual([e["times"] for e in groups], [[599], [601, 605]])
        self.assertEqual(sum(e["count"] for e in groups if e["t"] <= 600), 1)
        turning = timeline.story(self.dg, 200, chance=lambda s: 0.5 + 0.25 * min(s["grubs"][1], 1))["turning"]
        self.assertEqual(turning["minute"], 10)
        self.assertEqual([e["times"] for e in turning["events"]], [[599]])
        self._assert_grubs_match_each_actual_cutoff()

    def test_grubs_across_irregular_frame_boundary_do_not_leak_future_events(self):
        self.dg["ts"][10] = 610  # the actual cutoff is 10:10, not frame-index 10:00
        self.dg["ts"][11] = 640
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (608, 612, 616)]
        groups = self._grub_events()
        self.assertEqual([e["times"] for e in groups], [[608], [612, 616]])
        self.assertEqual(sum(e["count"] for e in groups if e["t"] <= 610), 1)
        turning = timeline.story(self.dg, 200, chance=lambda s: 0.5 + 0.25 * min(s["grubs"][1], 1))["turning"]
        self.assertEqual(turning["minute"], 610 / 60)
        self.assertEqual([e["times"] for e in turning["events"]], [[608]])
        self._assert_grubs_match_each_actual_cutoff()

    def test_grubs_crossing_nominal_minute_merge_if_no_actual_cutoff_exists(self):
        self.dg["ts"][10] = 610
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (599, 601, 605)]
        groups = self._grub_events()
        self.assertEqual(len(groups), 1, "10:00 is not a cutoff when the actual snapshot is 10:10")
        self.assertEqual((groups[0]["label"], groups[0]["times"]), ("Voidgrubs ×3", [599, 601, 605]))
        self._assert_grubs_match_each_actual_cutoff()

    def test_grub_exactly_at_snapshot_is_not_merged_with_next_interval(self):
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (600, 600.001, 601)]
        self.assertEqual([e["times"] for e in self._grub_events()], [[600], [600.001, 601]])
        self._assert_grubs_match_each_actual_cutoff()

    def test_grubs_do_not_merge_across_display_only_game_end(self):
        self.dg["end"] = 610
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (609, 612, 616)]
        groups = self._grub_events()
        final = timeline.story(self.dg, 200)["minutes"][-1]
        self.assertEqual(final["t"], 610)
        self.assertEqual([e["times"] for e in groups if e["t"] <= final["t"]], [[609]])
        self._assert_grubs_match_each_actual_cutoff()

    def test_grubs_without_a_bounded_actual_interval_remain_individual(self):
        self.dg["ts"] = [None] * len(self.dg["ts"])
        self.dg["valid"] = [False] * len(self.dg["valid"])
        self.dg["winner"] = None
        self.dg["end"] = None
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (599, 601, 605)]
        self.assertEqual([e["times"] for e in self._grub_events()], [[599], [601], [605]])
        self.assertEqual(sum(e["count"] for e in self._grub_events() if e["t"] <= 600), 1)

    def test_grubs_after_last_actual_snapshot_remain_individual(self):
        self.dg["winner"] = None
        self.dg["monsters"] = [[t, 200, "HORDE", ""] for t in (1499, 1501, 1505)]
        self.assertEqual([e["times"] for e in self._grub_events()], [[1499], [1501], [1505]])
        self._assert_grubs_match_each_actual_cutoff()

    def test_story_flips_leads_for_red_and_finds_the_turning_point(self):
        chance = lambda s: 0.5 + max(-0.45, min(0.45, s["gold"] / 20000))
        blue = timeline.story(self.dg, 100, me=1, chance=chance)
        red = timeline.story(self.dg, 200, chance=chance)
        self.assertEqual(blue["minutes"][10]["gold"], -red["minutes"][10]["gold"])
        self.assertAlmostEqual(blue["minutes"][10]["chance"], 1 - red["minutes"][10]["chance"])
        self.assertEqual((blue["minutes"][-1]["chance"], red["minutes"][-1]["chance"]), (1.0, 0.0), "The game's end is certain")
        self.assertEqual(len(blue["deaths"]), 2)
        self.assertIsNotNone(blue["turning"])

    def test_missing_and_nonfinite_predictions_do_not_crash_turning_points(self):
        for value in (None, float("nan"), float("inf"), 1.5):
            with self.subTest(value=value):
                story = timeline.story(self.dg, 100, chance=lambda state: value)
                self.assertIsNone(story["turning"])
                self.assertTrue(all(m["chance"] is None for m in story["minutes"]))

    def test_without_a_model_there_is_no_chance_or_turning_point(self):
        s = timeline.story(self.dg, 100)
        self.assertIsNone(s["turning"])
        self.assertTrue(all(m["chance"] is None for m in s["minutes"]))


class JungleTests(unittest.TestCase):
    def test_early_jungle_proxy_and_first_lane_takedown(self):
        dg, _ = timeline.extract(rich_timeline(test_data.match_fixture("TL4")))
        blue = timeline.jungle_habits([(dg, 2)])
        self.assertEqual(blue["start"], {"red": 1, "blue": 0})
        self.assertEqual(blue["first_gank"]["lanes"], {"top": 1, "mid": 0, "bot": 0})
        self.assertEqual(blue["first_gank"]["median_t"], 200)
        red = timeline.jungle_habits([(dg, 7)])
        self.assertEqual(red["start"], {"red": 1, "blue": 0}, "Red's red buff is on the top side")
        self.assertEqual(red["first_gank"]["games"], 0, "A kill in the river isn't a gank")


class StoreTimelineTests(unittest.TestCase):
    def setUp(self):
        self.db = test_data.fixture_db()
        self.addCleanup(self.db.close)

    def test_save_timeline_keeps_digest_purchases_and_frames(self):
        match = test_data.match_fixture("S1")
        store.save_match(self.db, "euw1", match)
        store.save_timeline(self.db, "S1", rich_timeline(match))
        self.assertEqual(store.digest(self.db, "S1")["winner"], 100)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM purchases WHERE match_id = 'S1'").fetchone()[0], 10)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM frames WHERE match_id = 'S1'").fetchone()[0], 20)
        self.assertTrue(store.has_timeline(self.db, "S1"))

    def test_missing_timeline_is_remembered_without_a_digest(self):
        store.save_match(self.db, "euw1", test_data.match_fixture("S2"))
        store.save_timeline(self.db, "S2", None)
        self.assertTrue(store.has_timeline(self.db, "S2"))
        self.assertIsNone(store.digest(self.db, "S2"))

    def test_upgrade_preserves_timelines_fetched_before_digests(self):
        db = self.db
        store.save_match(db, "euw1", test_data.match_fixture("OLD"))
        store.save_match(db, "euw1", test_data.match_fixture("NEW"))
        store.save_timeline(db, "NEW", rich_timeline(test_data.match_fixture("NEW")))
        db.execute("INSERT INTO timelines VALUES ('OLD')")
        db.execute("PRAGMA user_version = 0")
        db.commit()
        store.init(db)
        self.assertEqual((store.has_timeline(db, "OLD"), store.has_timeline(db, "NEW")), (True, True))
        self.assertEqual(store.digest_status(db, "OLD"), "legacy")
        self.assertIsNone(store.digest(db, "OLD"))
        store.init(db)
        self.assertTrue(store.has_timeline(db, "OLD"), "Repeated init does not schedule a re-download")

    def test_perf_is_saved_with_the_match_and_backfilled(self):
        match = test_data.match_fixture("P1")
        match["info"]["participants"][0]["challenges"] = {"visionScorePerMinute": 1.5, "killParticipation": 0.6,
                                                          "laningPhaseGoldExpAdvantage": 1}
        store.save_match(self.db, "euw1", match)
        row = self.db.execute("SELECT cs_min, vision_min, kp, lane_lead, deaths FROM perf WHERE puuid = 'fixture-player'").fetchone()
        self.assertEqual(tuple(row), (110 / 30, 1.5, 0.6, 1.0, 1.0))
        self.db.execute("DELETE FROM perf")
        self.db.commit()
        self.assertEqual(store.backfill_perf(self.db), "P1")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM perf").fetchone()[0], 10)
        self.assertIsNone(store.backfill_perf(self.db, "P1"))


def noncanonical_fixture(mid="MAPPING"):
    match = test_data.match_fixture(mid)
    raw = rich_timeline(match)
    mapping = {i + 1: 30 + (9 - i) * 3 for i in range(10)}
    for i, person in enumerate(match["info"]["participants"]):
        person["participantId"] = mapping[i + 1]
    for person in raw["info"]["participants"]:
        person["participantId"] = mapping[person["participantId"]]
    for frame in raw["info"]["frames"]:
        frame["participantFrames"] = {str(mapping[int(pid)]): value for pid, value in frame["participantFrames"].items()}
        for e in frame["events"]:
            for key in ("participantId", "killerId", "victimId"):
                if e.get(key) in mapping:
                    e[key] = mapping[e[key]]
            if "assistingParticipantIds" in e:
                e["assistingParticipantIds"] = [mapping[pid] for pid in e["assistingParticipantIds"]]
    raw["info"]["participants"].reverse()
    raw["metadata"]["participants"].reverse()
    match["info"]["participants"] = match["info"]["participants"][5:] + match["info"]["participants"][:5]
    return match, raw, mapping


class TimestampTests(unittest.TestCase):
    def setUp(self):
        self.raw = rich_timeline(test_data.match_fixture("TIMES"))

    def test_short_final_frame_does_not_create_a_25_minute_state(self):
        self.raw["info"]["frames"][-1]["timestamp"] = 1480000  # 24:40, not frame-index 25:00
        for frame in self.raw["info"]["frames"]:
            frame["events"] = [e for e in frame["events"] if e["type"] != "GAME_END"]
        self.raw["info"]["frames"][-1]["events"] += [
            event(1470, "CHAMPION_KILL", killerId=1, victimId=6),
            event(1490, "CHAMPION_KILL", killerId=1, victimId=6)]
        dg, _ = timeline.extract(self.raw)
        s = timeline.states(dg)[-1]
        self.assertEqual(dg["ts"][-1], 1480)
        self.assertEqual(s["m"], 1480 / 60)
        self.assertEqual(s["kills"], [2, 1], "No post-frame kill at 24:50 leaks into 24:40")
        self.assertNotIn(25, [s["m"] for s in timeline.states(dg)])

    def test_outcome_is_display_only_and_uses_actual_terminal_gold(self):
        frame = self.raw["info"]["frames"][-1]
        frame["timestamp"] = 1480000
        frame["events"] = [e for e in frame["events"] if e["type"] != "GAME_END"]
        frame["events"].append(event(1480, "GAME_END", winningTeam=100))
        dg, _ = timeline.extract(self.raw)
        seen = []
        def chance(s):
            seen.append(s)
            return 0.6
        story = timeline.story(dg, 100, chance=chance)
        self.assertTrue(all(s["t"] < 1480 for s in seen))
        self.assertTrue(all(not set(s) & {"end", "winner", "final", "win"} for s in seen))
        final = story["minutes"][-1]
        self.assertEqual((final["m"], final["snapshot_t"], final["gold"], final["chance"]), (1480 / 60, 1480, 5000, 1.0))
        no_model = timeline.story(dg, 100)["minutes"][-1]
        self.assertEqual(no_model["t"], 1480)
        self.assertIsNone(no_model["chance"])

    def test_missing_players_and_timestamps_never_generate_zero_leads(self):
        del self.raw["info"]["frames"][10]["participantFrames"]["1"]
        del self.raw["info"]["frames"][11]["timestamp"]
        dg, _ = timeline.extract(self.raw)
        index = dg["ts"].index(600)
        self.assertIsNone(dg["gold"][index][0])
        self.assertFalse(dg["valid"][index])
        self.assertFalse(dg["valid"][-1], "An untimed frame remains visibly invalid")
        self.assertNotIn(10, [s["m"] for s in timeline.states(dg)])
        self.assertNotIn(11, [s["m"] for s in timeline.states(dg)])
        self.assertEqual(next(s for s in timeline.states(dg) if s["m"] == 12)["kills"], [1, 1])

    def test_frames_and_selected_events_are_sorted_and_ms_are_preserved(self):
        self.raw["info"]["frames"].reverse()
        self.raw["info"]["frames"][0]["events"].append(event(1100.125, "ITEM_PURCHASED", participantId=1, itemId=3006))
        dg, orders = timeline.extract(self.raw)
        self.assertEqual(dg["ts"], sorted(dg["ts"]))
        self.assertEqual(timeline.parse_items(orders["fixture-player"][0])[-1], (1100.125, 3006))


    def test_duplicate_timestamps_produce_one_state_and_prefer_complete_snapshot(self):
        duplicate = copy.deepcopy(self.raw["info"]["frames"][10])
        self.raw["info"]["frames"].insert(11, duplicate)
        del duplicate["participantFrames"]["1"]
        dg, _ = timeline.extract(self.raw)
        self.assertEqual([s["m"] for s in timeline.states(dg)].count(10), 1)
        index = timeline.nearest_frame(dg, 600)
        self.assertTrue(dg["valid"][index])
        self.assertEqual(dg["gold"][index][0], 4700)


class IdentityTests(unittest.TestCase):
    def test_noncanonical_ids_shuffled_people_and_explicit_teams(self):
        match, raw, ids = noncanonical_fixture()
        # Real timelines usually omit teamId. The cached match is authoritative by puuid.
        for p in raw["info"]["participants"]:
            del p["teamId"]
        dg, orders = timeline.extract(raw, match["info"])
        self.assertEqual(timeline.team_of(ids[1], dg), 100)
        self.assertIsNone(timeline.team_of(999, dg))
        self.assertEqual(timeline.states(dg)[10]["gold"], 2000)
        self.assertEqual(timeline.parse_items(orders["fixture-player"][0])[0], (2, 1055))
        result = timeline.story(dg, 200, me=ids[1])  # repair a legacy caller's wrong team inference
        self.assertEqual(result["team"], 100)
        self.assertEqual(len(result["deaths"]), 2)
        self.assertEqual(timeline.jungle_habits([(dg, ids[2])])["start"], {"red": 1, "blue": 0})

    def test_explicit_match_ids_take_precedence_over_metadata_order(self):
        match, raw, ids = noncanonical_fixture()
        raw["info"]["participants"] = []
        dg, _ = timeline.extract(raw, match["info"])
        self.assertEqual(dg["pids"], sorted(ids.values()))
        self.assertEqual(timeline.states(dg)[10]["gold"], 2000)

    def test_conflicting_or_duplicate_identity_is_rejected(self):
        match, raw, _ = noncanonical_fixture()
        raw["info"]["participants"][0]["participantId"] += 1
        with self.assertRaisesRegex(ValueError, "participantId"):
            timeline.extract(raw, match["info"])
        raw = rich_timeline(test_data.match_fixture("DUP"))
        raw["info"]["participants"].append(raw["info"]["participants"][0].copy())
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            timeline.extract(raw)


class TransactionEventTests(unittest.TestCase):
    def raw(self, events):
        raw = rich_timeline(test_data.match_fixture("EVENTS"))
        for frame in raw["info"]["frames"]:
            frame["events"] = []
        raw["info"]["frames"][1]["events"] = events
        return raw

    def test_sale_undo_restores_inventory_without_inventing_a_buy(self):
        raw = self.raw([event(2, "ITEM_PURCHASED", participantId=1, itemId=1055),
                        event(50, "ITEM_SOLD", participantId=1, itemId=1055),
                        event(51, "ITEM_UNDO", participantId=1, beforeId=0, afterId=1055)])
        _, orders = timeline.extract(raw)
        self.assertEqual(timeline.parse_items(orders["fixture-player"][0]), [(2, 1055)])
        raw["info"]["frames"][1]["events"].append(event(52, "ITEM_UNDO", participantId=1, beforeId=1055, afterId=0))
        _, orders = timeline.extract(raw)
        self.assertEqual(orders["fixture-player"][0], "")

    def test_change_undo_keeps_component_purchase_and_removes_upgrade(self):
        _, orders = timeline.extract(self.raw([
            event(2, "ITEM_PURCHASED", participantId=1, itemId=1036),
            event(100, "ITEM_DESTROYED", participantId=1, itemId=1036),
            event(100, "ITEM_PURCHASED", participantId=1, itemId=3004),
            event(101, "ITEM_UNDO", participantId=1, beforeId=3004, afterId=1036),
            event(200, "ITEM_PURCHASED", participantId=1, itemId=3004)]))
        self.assertEqual(timeline.parse_items(orders["fixture-player"][0]), [(2, 1036), (200, 3004)])

    def test_overlap_dedup_and_real_multiple_same_ms_buys(self):
        buy = event(2, "ITEM_PURCHASED", participantId=1, itemId=2003)
        undo = event(3, "ITEM_UNDO", participantId=1, beforeId=2003, afterId=0)
        kill = event(4, "CHAMPION_KILL", killerId=1, victimId=6)
        skill = event(5, "SKILL_LEVEL_UP", participantId=1, skillSlot=1)
        raw = self.raw([undo, buy, buy.copy(), kill, kill.copy(), skill])
        raw["info"]["frames"][2]["events"] = [buy.copy(), undo.copy(),
                                                   {**kill, "victimDamageReceived": [{"ignored": "payload"}]}, skill.copy()]
        dg, orders = timeline.extract(raw)
        self.assertEqual(timeline.parse_items(orders["fixture-player"][0]), [(2, 2003)])
        self.assertEqual(orders["fixture-player"][1], "1")
        self.assertEqual(len(dg["kills"]), 1)

    def test_ward_events_are_compact_and_execution_is_not_a_kill(self):
        raw = self.raw([event(120, "WARD_PLACED", creatorId=1, wardType="YELLOW_TRINKET"),
                        event(121, "WARD_KILL", killerId=6, wardType="YELLOW_TRINKET"),
                        event(122, "CHAMPION_KILL", killerId=0, victimId=1, assistingParticipantIds=[6],
                              position={"x": 4000, "y": 4000}, victimDamageReceived=[{"large": "ignored"}])])
        dg, _ = timeline.extract(raw)
        self.assertEqual(dg["wards"][0], [120, "placed", 1, "YELLOW_TRINKET", None, None])
        execution = timeline.story(dg, 100, me=1)["deaths"][0]
        self.assertEqual((execution["kind"], execution["side"]), ("execution", None))
        self.assertEqual(timeline.states(dg)[3]["kills"], [0, 0])
        self.assertNotIn("victimDamageReceived", json.dumps(dg))


class ProxyTests(unittest.TestCase):
    def test_one_minute_is_not_a_start_observation_and_uncertain_positions_are_unknown(self):
        raw = rich_timeline(test_data.match_fixture("PROXY"))
        raw["info"]["frames"][1]["participantFrames"]["2"]["position"] = {"x": 7700, "y": 4100}
        raw["info"]["frames"][2]["participantFrames"]["2"]["position"] = {"x": 7500, "y": 7500}
        dg, _ = timeline.extract(raw)
        result = timeline.jungle_habits([(dg, 2)])
        self.assertEqual(result["start"], {"red": 0, "blue": 0})
        self.assertEqual(result["early_jungle_proxy"]["unknown"], 1)
        self.assertIn("proxy", result["early_jungle_proxy"]["label"])
        dg["ts"][2] = 140  # too far from 2:00 even if the location is clear
        dg["pos"][2][2:4] = [7700, 4100]
        self.assertEqual(timeline.jungle_habits([(dg, 2)])["early_jungle_proxy"]["observed"], 0)

    def test_assisted_lane_takedown_is_a_proxy_not_every_gank_or_execution(self):
        raw = rich_timeline(test_data.match_fixture("LANE"))
        raw["info"]["frames"][8]["events"] += [
            event(450, "CHAMPION_KILL", killerId=4, victimId=9, assistingParticipantIds=[2], position={"x": 1400, "y": 9000}),
            event(451, "CHAMPION_KILL", killerId=0, victimId=9, assistingParticipantIds=[2], position={"x": 1400, "y": 9000}),
            event(601, "CHAMPION_KILL", killerId=2, victimId=9, position={"x": 1400, "y": 9000})]
        dg, _ = timeline.extract(raw)
        result = timeline.jungle_habits((entry for entry in [(dg, 2), (dg, 2)]))
        self.assertEqual(result["lane_takedowns_per_game"], 2)
        self.assertEqual(result["first_gank"]["games"], 2)
        self.assertEqual(result["first_gank"]["median_t"], 200)
        self.assertIn("not all ganks", result["first_gank"]["label"])

    def test_lane_takedown_median_is_exact_with_repeated_and_fractional_times(self):
        dg, _ = timeline.extract(rich_timeline(test_data.match_fixture("MEDIAN")))
        dg["kills"] = [[200.125, 2, 8, 1500, 9000, []]]
        second = copy.deepcopy(dg)
        second["kills"][0][0] = 400.125
        self.assertEqual(timeline.jungle_habits([(dg, 2), (second, 2)])["first_gank"]["median_t"], 300.125)
        self.assertEqual(timeline.jungle_habits([(dg, 2), (dg, 2), (second, 2)])["first_gank"]["median_t"], 200.125)

    def test_enemy_camp_proximity_counts_an_observed_invade_not_a_start(self):
        raw = rich_timeline(test_data.match_fixture("INVADE"))
        raw["info"]["frames"][2]["participantFrames"]["2"]["position"] = {"x": 7100, "y": 10800}
        dg, _ = timeline.extract(raw)
        result = timeline.jungle_habits([(dg, 2)])
        self.assertEqual((result["invades"], result["early_jungle_proxy"]["observed"]), (1, 1))


class RobustStoreTests(unittest.TestCase):
    def setUp(self):
        self.db = test_data.fixture_db()
        self.addCleanup(self.db.close)
        self.match = test_data.match_fixture("STORE")
        store.save_match(self.db, "euw1", self.match)
        self.db.commit()

    def test_gold10_and_gold15_use_nearest_actual_timestamp(self):
        raw = rich_timeline(self.match)
        raw["info"]["frames"] = [raw["info"]["frames"][i] for i in (0, 3, 8)]
        for frame, timestamp in zip(raw["info"]["frames"], (0, 598000, 899000)):
            frame["timestamp"] = timestamp
            frame["events"] = []
        store.save_timeline(self.db, "STORE", raw)
        gold = self.db.execute("SELECT minute, gold FROM frames WHERE puuid = 'fixture-player' ORDER BY minute").fetchall()
        self.assertEqual([tuple(row) for row in gold], [(10, 1760), (15, 3860)])
        self.assertTrue(self.db.in_transaction, "save_timeline never commits the caller's work")
        self.db.rollback()
        self.assertFalse(store.has_timeline(self.db, "STORE"))

    def test_outside_tolerance_and_missing_timestamps_do_not_make_sql_gold(self):
        raw = rich_timeline(self.match)
        raw["info"]["frames"] = [raw["info"]["frames"][10], raw["info"]["frames"][15]]
        raw["info"]["frames"][0]["timestamp"] = 584000
        raw["info"]["frames"][1]["timestamp"] = 880000
        store.save_timeline(self.db, "STORE", raw)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM frames").fetchone()[0], 0)
        raw = test_data.timeline_fixture(self.match)
        for frame in raw["info"]["frames"]:
            del frame["timestamp"]
        store.save_timeline(self.db, "STORE", raw)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM frames").fetchone()[0], 0)
        self.assertEqual(timeline.states(store.digest(self.db, "STORE")), [])

    def test_missing_participant_row_is_absent_not_zero_and_retry_clears_stale_rows(self):
        raw = rich_timeline(self.match)
        store.save_timeline(self.db, "STORE", raw)
        del raw["info"]["frames"][15]["participantFrames"]["1"]
        store.save_timeline(self.db, "STORE", raw)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM frames WHERE minute = 15").fetchone()[0], 9)
        self.assertIsNone(self.db.execute("SELECT gold FROM frames WHERE minute = 15 AND puuid = 'fixture-player'").fetchone())

    def test_malformed_timeline_preserves_existing_and_caller_pending_work(self):
        raw = rich_timeline(self.match)
        store.save_timeline(self.db, "STORE", raw)
        old = store.digest(self.db, "STORE")
        del raw["info"]["frames"][15]["participantFrames"]["2"]["totalGold"]
        store.save_match(self.db, "euw1", test_data.match_fixture("PENDING"))
        with self.assertRaisesRegex(KeyError, "totalGold"):
            store.save_timeline(self.db, "STORE", raw)
        self.assertEqual(store.digest(self.db, "STORE"), old)
        self.assertTrue(store.has_match(self.db, "PENDING"))
        with self.assertRaises((KeyError, ValueError)):
            store.save_timeline(self.db, "BAD", {})
        self.assertFalse(store.has_timeline(self.db, "BAD"))
        self.db.rollback()
        self.assertFalse(store.has_match(self.db, "PENDING"))

    def test_write_failure_rolls_back_marker_and_all_derived_rows_not_caller_writes(self):
        self.db.execute("CREATE TRIGGER fail_purchase BEFORE INSERT ON purchases BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END")
        self.db.commit()
        store.save_match(self.db, "euw1", test_data.match_fixture("PENDING"))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fixture write failure"):
            store.save_timeline(self.db, "STORE", rich_timeline(self.match))
        self.assertFalse(store.has_timeline(self.db, "STORE"))
        self.assertIsNone(store.digest(self.db, "STORE"))
        self.assertTrue(store.has_match(self.db, "PENDING"))
        self.assertTrue(self.db.in_transaction)

    def test_noncanonical_mapping_is_used_for_sql_frames_and_purchases(self):
        match, raw, ids = noncanonical_fixture("NONCANON")
        store.save_match(self.db, "euw1", match)
        store.save_timeline(self.db, "NONCANON", raw)
        dg = store.digest(self.db, "NONCANON")
        self.assertEqual(timeline.team_of(ids[1], dg), 100)
        self.assertEqual(self.db.execute("SELECT gold FROM frames WHERE match_id = 'NONCANON' AND puuid = 'fixture-player' AND minute = 15").fetchone()[0], 6800)

    def test_map_validation_rejects_aram_arena_nonclassic_and_conflicting_metadata(self):
        for info in ({"mapId": 12, "queueId": 450}, {"mapId": 30, "queueId": 1710},
                     {"mapId": 11, "gameMode": "URF"}, {"mapId": 11, "queueId": 900}):
            with self.subTest(info=info):
                match = copy.deepcopy(self.match)
                match["info"].update(info)
                store.save_match(self.db, "euw1", match)
                store.save_timeline(self.db, "STORE", rich_timeline(match))  # raw timeline claims Rift, match overrides
                self.assertIsNone(store.digest(self.db, "STORE"))
                self.assertEqual(store.digest_status(self.db, "STORE"), "not_rift")
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM frames").fetchone()[0], 0)
        raw = rich_timeline(self.match)
        del raw["info"]["mapId"]
        del raw["info"]["gameMode"]
        dg, _ = timeline.extract(raw)
        self.assertEqual(timeline.story_events(dg, 100), [])
        self.assertEqual(timeline.jungle_habits([(dg, 2)])["games"], 0)

    def test_nonfinite_participant_counter_is_rejected_without_partial_rows(self):
        raw = rich_timeline(self.match)
        raw["info"]["frames"][15]["participantFrames"]["2"]["xp"] = float("nan")
        with self.assertRaisesRegex(ValueError, "xp"):
            store.save_timeline(self.db, "STORE", raw)
        self.assertFalse(store.has_timeline(self.db, "STORE"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM frames").fetchone()[0], 0)

    def test_corrupt_current_schema_and_decompression_bombs_are_unavailable(self):
        for data in (zlib.compress(json.dumps({"v": timeline.DIGEST_VERSION, "map_id": 11}).encode()),
                     zlib.compress(b" " * (timeline.MAX_DIGEST_BYTES + 1))):
            self.db.execute("INSERT OR REPLACE INTO timeline_digest VALUES ('STORE', ?)", (data,))
            self.db.execute("INSERT OR IGNORE INTO timelines VALUES ('STORE')")
            self.assertIsNone(store.digest(self.db, "STORE"))
            self.assertEqual(store.digest_status(self.db, "STORE"), "invalid")
            self.assertTrue(store.has_timeline(self.db, "STORE"))

    def test_wrong_match_id_is_rejected_without_a_marker(self):
        raw = rich_timeline(self.match)
        raw["metadata"]["matchId"] = "WRONG"
        with self.assertRaisesRegex(ValueError, "matchId"):
            store.save_timeline(self.db, "STORE", raw)
        self.assertFalse(store.has_timeline(self.db, "STORE"))

    def test_legacy_version_unknown_version_and_corrupt_data_remain_fetched(self):
        store.save_timeline(self.db, "STORE", rich_timeline(self.match))
        original = self.db.execute("SELECT data FROM timeline_digest WHERE match_id = 'STORE'").fetchone()[0]
        frames = [tuple(row) for row in self.db.execute("SELECT * FROM frames")]
        dg = store.digest(self.db, "STORE")
        for version, status in ((1, "legacy"), (999, "unsupported")):
            dg["v"] = version
            blob = zlib.compress(json.dumps(dg).encode())
            self.db.execute("UPDATE timeline_digest SET data = ?", (blob,))
            self.db.execute("PRAGMA user_version = 0")
            self.db.commit()
            store.init(self.db)
            self.assertEqual(store.digest_status(self.db, "STORE"), status)
            self.assertIsNone(store.digest(self.db, "STORE"))
            self.assertEqual(timeline.states(dg), [])
            self.assertTrue(store.has_timeline(self.db, "STORE"))
            self.assertEqual(self.db.execute("SELECT data FROM timeline_digest").fetchone()[0], blob)
            self.assertEqual([tuple(row) for row in self.db.execute("SELECT * FROM frames")], frames)
        self.db.execute("UPDATE timeline_digest SET data = ?", (b"invalid zlib",))
        self.assertEqual(store.digest_status(self.db, "STORE"), "invalid")
        self.assertIsNone(store.digest(self.db, "STORE"))
        self.db.execute("UPDATE timeline_digest SET data = ?", (original,))
        self.assertEqual(store.digest_status(self.db, "STORE"), "available")
        store.save_timeline(self.db, "STORE", None)
        self.assertEqual(store.digest_status(self.db, "STORE"), "missing")
        self.assertEqual(store.digest_status(self.db, "ABSENT"), "not_fetched")


if __name__ == "__main__":
    unittest.main()
