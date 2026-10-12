import copy
import random
import unittest
from unittest.mock import patch

import randomizer


def item(name, *, boots=False, eligible=True):
    return {"name": name, "boots": boots, "completed": not boots, "support": False, "random_eligible": eligible}


def catalog():
    items = {3006: item("Greaves", boots=True), 3047: item("Steelcaps", boots=True)}
    for family in randomizer.ITEM_FAMILIES:
        for item_id in family:
            items[item_id] = item(f"Item {item_id}")
    items.update({i: item(f"Wildcard {i}") for i in range(9000, 9010)})
    items[9991] = item("Removed item", eligible=False)
    items[9992] = {**item("Support quest item"), "support": True}
    items[9993] = {**item("Component"), "completed": False}
    return items


class RandomizerTests(unittest.TestCase):
    def setUp(self):
        self.items = catalog()
        self.random = patch.object(randomizer, "random", random.Random(42))
        self.random.start()
        self.addCleanup(self.random.stop)

    def test_rolls_have_six_distinct_items_one_boot_and_no_shared_exclusions(self):
        champions = {1: {"name": "Annie"}, 2: {"name": "Olaf"}, 3: {"name": "Galio"}}
        rolled = set()
        for _ in range(300):
            champion, ids = randomizer.roll(champions, self.items)
            rolled.add(champion)
            self.assertIn(champion, champions)
            self.assertEqual((len(ids), len(set(ids))), (6, 6))
            self.assertEqual(sum(self.items[i]["boots"] for i in ids), 1)
            self.assertTrue(all(self.items[i]["random_eligible"] for i in ids))
            self.assertTrue(all(i not in ids for i in (9991, 9992, 9993)))
            for family in randomizer.ITEM_FAMILIES:
                self.assertLessEqual(len(set(ids) & family), 1)
        self.assertEqual(rolled, set(champions))

    def test_cassiopeia_receives_six_finished_items_without_boots(self):
        champion, ids = randomizer.roll({69: {"name": "Cassiopeia"}}, self.items)
        self.assertEqual(champion, 69)
        self.assertEqual(len(ids), 6)
        self.assertTrue(all(self.items[i]["completed"] and not self.items[i]["boots"] for i in ids))

    def test_missing_metadata_or_incompatible_pool_fails_without_looping(self):
        normal = {1: {"name": "Annie"}}
        for champions, items in (
            ({}, self.items), (normal, {}),
            (normal, {i: it for i, it in self.items.items() if not it["boots"]}),
            (normal, {3006: item("Greaves", boots=True), 3033: item("Mortal"), 3036: item("Dominik"), 6694: item("Serylda")}),
        ):
            with self.subTest(items=list(items)), self.assertRaises(ValueError):
                randomizer.roll(champions, items)

    def test_same_named_variants_are_not_selected_together(self):
        self.items[9011] = item("Wildcard 9000")
        for _ in range(100):
            _, ids = randomizer.roll({1: {}}, self.items)
            names = [self.items[i]["name"] for i in ids]
            self.assertEqual(len(names), len(set(names)))

    def test_roll_does_not_mutate_or_accumulate_catalog_data(self):
        before = copy.deepcopy(self.items)
        champions = {1: {"name": "Annie"}}
        for _ in range(100):
            randomizer.roll(champions, self.items)
        self.assertEqual(self.items, before)
        self.assertEqual(champions, {1: {"name": "Annie"}})


if __name__ == "__main__":
    unittest.main()
