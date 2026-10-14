"""Isolated ASGI contracts for feature integration; never use live databases or Riot.

Run with: .venv/bin/python -m unittest discover -s tests -p test_feature_endpoints.py -v
"""
import asyncio
import copy
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import zlib
from collections import OrderedDict
from contextlib import ExitStack, closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
import test_data

import config

with patch.object(config, "load_env"), patch.dict(os.environ, {"SAMPLER": "0", "SESSION_COOKIE_SECURE": "auto"}):
    import main


PUUID = "fixture-player"
START = 10_000_000


def mapped_story_fixture(mid="STORY"):
    """Team IDs deliberately disagree with legacy participant-ID arithmetic."""
    match = test_data.match_fixture(mid, PUUID)
    ids = [42, 7, 99, 11, 23, 3, 1, 88, 2, 6]
    for person, pid in zip(match["info"]["participants"], ids):
        person["participantId"] = pid
    match["info"].update(mapId=11, gameMode="CLASSIC", gameStartTimestamp=START)
    raw = test_data.timeline_fixture(match)
    raw["info"]["participants"].reverse()
    raw["metadata"]["participants"].reverse()
    for frame in raw["info"]["frames"]:
        if frame["timestamp"]:
            frame["timestamp"] += 250  # retain actual timestamps, not synthetic minute indices
    events = [
        {"timestamp": 2000, "type": "ITEM_PURCHASED", "participantId": 42, "itemId": 1055},
        {"timestamp": 90000, "type": "ITEM_PURCHASED", "participantId": 42, "itemId": 3031},
        {"timestamp": 95000, "type": "ITEM_PURCHASED", "participantId": 42, "itemId": 3031},
        {"timestamp": 10000, "type": "SKILL_LEVEL_UP", "participantId": 42, "skillSlot": 1, "levelUpType": "NORMAL"},
        {"timestamp": 70000, "type": "SKILL_LEVEL_UP", "participantId": 42, "skillSlot": 2, "levelUpType": "NORMAL"},
        {"timestamp": 200000, "type": "CHAMPION_KILL", "killerId": 3, "victimId": 42,
         "assistingParticipantIds": [1], "position": {"x": 1500, "y": 9000}},
        {"timestamp": 300000, "type": "CHAMPION_KILL", "killerId": 7, "victimId": 1,
         "assistingParticipantIds": [42], "position": {"x": 13500, "y": 6000}},
        {"timestamp": 450000, "type": "CHAMPION_KILL", "killerId": 0, "victimId": 42,
         "position": {"x": 5000, "y": 5000}},
        {"timestamp": 930000, "type": "GAME_END", "winningTeam": 100},
    ]
    for event in events:
        raw["info"]["frames"][min(15, event["timestamp"] // 60000 + 1)]["events"].append(event)
    match["info"]["participants"].reverse()
    return match, raw


def spectator_fixture(hidden=False):
    players = [{"teamId": 100 if i < 5 else 200, "championId": i + 1,
                "puuid": PUUID if i == 0 else f"live-{i}", "riotId": f"Live{i}#TEST"}
               for i in range(10)]
    if hidden:
        players[-1].pop("puuid")
        players[-1]["riotId"] = "DoNotResolve#TEST"
        players[-1]["summonerId"] = "not-a-puuid"
    return {"gameId": 1234, "gameQueueConfigId": 420, "gameStartTime": START,
            "gameMode": "CLASSIC", "participants": players, "bannedChampions": []}


def role_body(game):
    return {"roles": [{"team": p["teamId"], "champion_id": p["championId"], "role": main.stats.ROLES[i % 5]}
                      for i, p in enumerate(game["participants"])]}


def model_fixture(name):
    """Small persisted artifacts, not an expensive training run or mocked loader."""
    features = main.model.INGAME_FEATURES if name == "ingame" else main.model.PREGAME_FEATURES
    params = {"version": main.model.MODEL_VERSION, "validated": True, "features": list(features),
              "weights": [0.0, 0.2, *([0.0] * (len(features) - 1))],
              "training_data_end": 100, "training_before": 200, "validation_data_end": 300}
    if name == "pregame":
        params.update(player_weights=None, training_match_ids=["TRAIN"], training_since=0,
                      player_min_games=3, history_window_days=30,
                      champion_counts=[["16.1", role, i + 1, 20, 12] for i, role in enumerate(main.stats.ROLES)] +
                                      [["16.1", role, i + 6, 20, 8] for i, role in enumerate(main.stats.ROLES)],
                      matchup_counts=[])
    report = {"ready": True, "status": "ready", "reason": "Fixture chronological holdout",
              "overall": {"accuracy": 0.75, "games": 20, "samples": 40}, "test_games": 20}
    return params, report


class FeatureFixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.cache_path = Path(directory) / "fixture-cache.sqlite"
        self.auth_path = Path(directory) / "fixture-members.sqlite"
        self.opened = []
        self.connection_threads = {}
        sqlite_connect = sqlite3.connect

        def fixture_only_connect(database, *args, **kwargs):
            self.assertIn(Path(database), (self.cache_path, self.auth_path), "Unexpected database access")
            return sqlite_connect(database, *args, **kwargs)

        self.stack.enter_context(patch.object(sqlite3, "connect", side_effect=fixture_only_connect))
        self.stack.enter_context(patch.object(main.store, "DB_PATH", self.cache_path))
        self.stack.enter_context(patch.object(main.auth, "DB_PATH", self.auth_path))
        self.connect_mock = self.stack.enter_context(patch.object(main.store, "connect", side_effect=self.connect))
        self.stack.enter_context(patch.object(main.model, "_loaded", OrderedDict()))
        self.stack.enter_context(patch.object(main, "LIVE_ODDS_ENABLED", True))
        self.stack.enter_context(patch.dict(main._seen, {}, clear=True))
        self.stack.enter_context(patch.object(main, "track"))
        self.stack.enter_context(patch.object(httpx.AsyncHTTPTransport, "handle_async_request",
                                             side_effect=AssertionError("Real network is forbidden")))
        self.stack.enter_context(patch.object(httpx.HTTPTransport, "handle_request",
                                             side_effect=AssertionError("Real network is forbidden")))
        names = ("active_game", "timeline", "match", "match_ids", "clash_team", "account_by_puuid",
                 "league_entries", "mastery", "account", "summoner")
        self.riot = SimpleNamespace(**{name: AsyncMock(side_effect=AssertionError(f"Unexpected Riot call: {name}"))
                                       for name in names})
        self.background = object()
        self.riot.background = Mock(return_value=self.background)
        self.starts = self.stack.enter_context(patch.object(main.history, "start"))
        self.stack.enter_context(patch.object(main.history, "status", return_value=None))
        self.stack.enter_context(patch.object(main.history, "_fetch_slots", None))
        self.stack.enter_context(patch.dict(main.state, {"riot": self.riot, "live": {}, "last_activity": 0,
                                                       "ddragon": "16.1.1", "items": {3031: {"completed": True}}}, clear=True))
        with closing(self.connect()) as db:
            main.store.save_player(db, PUUID, "Fixture", "ONE", "euw1", {"tier": "GOLD", "rank": "II"})
            main.store.save_player(db, "bob-puuid", "Bob", "TWO", "euw1", {"tier": "SILVER"})
            db.commit()
        with closing(main.auth.connect()) as db:
            db.executemany("INSERT INTO users (username, password_hash, created) VALUES (?, 'unused-fixture', 0)",
                           [("alice",), ("bob",), ("unlinked",)])
            db.executemany("INSERT INTO sessions VALUES (?, ?, ?)",
                           [(main.auth._token_hash(f"{user}-session"), user, 10 ** 12)
                            for user in ("alice", "bob", "unlinked")])
            db.commit()
        main.auth.set_account("alice", "euw1", "Fixture", "ONE", PUUID)
        main.auth.set_account("bob", "euw1", "Bob", "TWO", "bob-puuid")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://fixture",
                                        cookies={main.auth.COOKIE: "alice-session"})
        self.addAsyncCleanup(self.client.aclose)

    def connect(self):
        db = test_data.fixture_db(str(self.cache_path))
        self.opened.append(db)
        self.connection_threads[db] = threading.get_ident()
        return db

    async def asyncTearDown(self):
        self.assertTrue(all(db.closed for db in self.opened), "Feature endpoint leaked a fixture connection")

    async def request(self, method, path, status=200, **kwargs):
        response = await self.client.request(method, path, **kwargs)
        self.assertEqual(response.status_code, status, f"{method} {path}: {response.text}")
        return response.json()

    def user(self, username):
        self.client.cookies.clear()
        if username:
            self.client.cookies.set(main.auth.COOKIE, f"{username}-session")

    def save_match(self, match, raw_timeline=None):
        mid = match["metadata"]["matchId"]
        with closing(self.connect()) as db:
            main.store.save_match(db, "euw1", match)
            main.store.tag_tier(db, mid, "GOLD")
            if raw_timeline is not None:
                main.store.save_timeline(db, mid, raw_timeline)
            db.commit()
        return mid

    def add_games(self, count=25, start=START, step=1000, role="TOP", puuid=PUUID):
        with closing(self.connect()) as db:
            for i in range(count):
                match = test_data.match_fixture(f"GAME_{i:03}", puuid)
                match["info"]["gameStartTimestamp"] = start + i * step
                match["info"]["participants"][0]["teamPosition"] = role
                main.store.save_match(db, "euw1", match)
                main.store.tag_tier(db, match["metadata"]["matchId"], "GOLD")
            db.commit()

    def live_cache(self, game=None, age=0):
        game = spectator_fixture() if game is None else game
        main.state["live"][PUUID] = {"at": main.time.time() - age, "game": game, "extra": {}}
        return game

    def put_model(self, name, result=None, stamp=123):
        with closing(self.connect()) as db:
            main.model.save(db, name, model_fixture(name) if result is None else result, now=stamp)

    def timeline_rows(self, mid):
        with closing(self.connect()) as db:
            return {table: [tuple(row) for row in db.execute(f"SELECT * FROM {table} WHERE match_id = ? ORDER BY rowid", (mid,))]
                    for table in ("timelines", "timeline_digest", "frames", "purchases")}


class AuthenticationContracts(FeatureFixture):
    async def test_every_feature_route_requires_a_real_fixture_session_before_work(self):
        self.user(None)
        self.connect_mock.reset_mock()
        routes = [("GET", f"/api/player/{PUUID}/draft?role=TOP"),
                  ("GET", f"/api/player/{PUUID}/coaching"),
                  ("POST", f"/api/player/{PUUID}/goals"), ("DELETE", f"/api/player/{PUUID}/goals"),
                  ("GET", "/api/match/UNKNOWN/story"), ("POST", "/api/match/UNKNOWN/timeline"),
                  ("GET", "/api/odds"), ("POST", f"/api/live/{PUUID}/odds"),
                  ("GET", "/api/clash/euw1/fixture-team?sync=1")]
        for method, path in routes:
            with self.subTest(method=method, path=path):
                self.assertEqual(await self.request(method, path, 401), {"detail": "Not logged in"})
        self.connect_mock.assert_not_called()
        self.starts.assert_not_called()
        self.riot.clash_team.assert_not_awaited()
        self.riot.timeline.assert_not_awaited()

    async def test_expired_and_revoked_sessions_are_not_authorized(self):
        with closing(main.auth.connect()) as db:
            db.execute("UPDATE sessions SET expires = 0 WHERE username = 'alice'")
            db.commit()
        await self.request("GET", "/api/odds", 401)
        with closing(main.auth.connect()) as db:
            db.execute("DELETE FROM users WHERE username = 'bob'")
            db.commit()
        self.user("bob")
        await self.request("GET", f"/api/player/{PUUID}/coaching", 401)


class DraftEndpoints(FeatureFixture):
    async def test_draft_passes_role_opponent_shown_patch_population_and_selected_range(self):
        self.add_games()
        with (patch.object(main, "shown_patch", return_value=("16.2", 1, "16.1")) as shown,
              patch.object(main.stats, "tier_population", return_value=None) as population,
              patch.object(main.insights, "draft", return_value={"contract": "draft"}) as draft):
            result = await self.request("GET", f"/api/player/{PUUID}/draft?role=MIDDLE&opp=77&range=20")
        self.assertEqual(result, {"contract": "draft"})
        args = draft.call_args.args
        self.assertEqual([g["match_id"] for g in args[1]], [f"GAME_{i:03}" for i in range(5, 25)])
        self.assertEqual(args[2:], (PUUID, None, "16.1", "MIDDLE", 77))
        self.assertTrue(args[0].closed)
        shown.assert_called_once_with(args[0])
        population.assert_called_once_with(args[0], "GOLD", "16.1")
        self.starts.assert_not_called()

    async def test_draft_default_and_unknown_ranges_use_default_without_an_opponent(self):
        self.add_games(105)
        with patch.object(main.insights, "draft", return_value={}) as draft:
            for suffix in ("", "&range=not-a-range"):
                with self.subTest(suffix=suffix):
                    await self.request("GET", f"/api/player/{PUUID}/draft?role=TOP{suffix}")
                    args = draft.call_args.args
                    self.assertEqual(len(args[1]), 100)
                    self.assertEqual(args[1][0]["match_id"], "GAME_005")
                    self.assertEqual(args[-1], None)

    async def test_draft_date_range_filters_actual_game_starts(self):
        now = 2_000_000_000
        self.add_games(3, start=(now - 31 * 86400) * 1000, step=86400 * 1000)
        with patch.object(main.time, "time", return_value=now), patch.object(main.insights, "draft", return_value={}) as draft:
            await self.request("GET", f"/api/player/{PUUID}/draft?role=TOP&range=30d")
        self.assertEqual([g["match_id"] for g in draft.call_args.args[1]], ["GAME_001", "GAME_002"])

    async def test_draft_rejects_missing_invalid_role_and_nonpositive_or_noninteger_opponent(self):
        self.connect_mock.reset_mock()
        cases = [("", 422), ("?role=SUPPORT", 400), ("?role=top", 400), ("?role=UNKNOWN", 400),
                 ("?role=TOP&opp=0", 422), ("?role=TOP&opp=-1", 422), ("?role=TOP&opp=NaN", 422),
                 ("?role=TOP&opp=1.5", 422)]
        for query, expected in cases:
            with self.subTest(query=query):
                await self.request("GET", f"/api/player/{PUUID}/draft{query}", expected)
        self.connect_mock.assert_not_called()

    async def test_draft_unknown_player_is_404_and_closes_snapshot(self):
        await self.request("GET", "/api/player/unknown/draft?role=TOP", 404)
        self.assertTrue(self.opened[-1].closed)

    async def test_real_draft_on_empty_cache_is_honest_and_does_not_sync(self):
        result = await self.request("GET", f"/api/player/{PUUID}/draft?role=TOP&opp=7")
        self.assertEqual({k: result[k] for k in ("patch", "role", "opponent", "matchups", "counters")},
                         {"patch": "16.1", "role": "TOP", "opponent": 7, "matchups": [], "counters": []})
        self.starts.assert_not_called()


class CoachingAndGoalsEndpoints(FeatureFixture):
    async def set_goal(self, target: object = 6, role="TOP", metric="cs_min", puuid=PUUID, status=200, **extra):
        return await self.request("POST", f"/api/player/{puuid}/goals", status,
                                  json={"role": role, "metric": metric, "target": target, **extra})

    async def test_coaching_owner_sees_only_private_goals_and_other_profiles_are_read_only(self):
        main.auth.set_goal("alice", PUUID, "TOP", "cs_min", 6)
        main.auth.set_goal("bob", "bob-puuid", "TOP", "cs_min", 8)
        mine = await self.request("GET", f"/api/player/{PUUID}/coaching")
        self.assertTrue(mine["can_edit"])
        self.assertEqual(len(mine["goals"]), 1)
        self.assertEqual(mine["goals"][0]["target"], 6)
        self.assertEqual(mine["goals"][0]["progress"], {"games": 0, "value": None})
        other = await self.request("GET", "/api/player/bob-puuid/coaching")
        self.assertFalse(other["can_edit"])
        self.assertEqual(other["goals"], [])
        self.assertNotIn("username", json.dumps(other))
        self.user("bob")
        reverse = await self.request("GET", f"/api/player/{PUUID}/coaching")
        self.assertFalse(reverse["can_edit"])
        self.assertEqual(reverse["goals"], [])
        self.starts.assert_not_called()

    async def test_coaching_unlinked_member_and_unknown_profile(self):
        self.user("unlinked")
        result = await self.request("GET", f"/api/player/{PUUID}/coaching")
        self.assertFalse(result["can_edit"])
        self.assertEqual(result["goals"], [])
        await self.request("GET", "/api/player/unknown/coaching", 404)

    async def test_coaching_range_and_rank_forecast_use_cached_player_inputs(self):
        self.add_games()
        with (patch.object(main.insights, "coaching", return_value={"roles": []}) as coaching,
              patch.object(main.insights, "rank_forecast", return_value={"available": False}) as forecast,
              patch.object(main.store, "rank_history", return_value=[{"tier": "GOLD"}]) as ranks):
            result = await self.request("GET", f"/api/player/{PUUID}/coaching?range=20")
        args = coaching.call_args.args
        self.assertEqual([g["match_id"] for g in args[1]], [f"GAME_{i:03}" for i in range(5, 25)])
        self.assertEqual(args[2:], (PUUID, "GOLD", "16.1"))
        ranks.assert_called_once_with(args[0], PUUID, main.history.SEASON_TS)
        self.assertEqual(forecast.call_args.args[0], [{"tier": "GOLD"}])
        self.assertEqual(forecast.call_args.args[1]["puuid"], PUUID)
        self.assertEqual(result["forecast"], {"available": False})

    async def test_goal_post_upserts_without_resetting_created_and_delete_is_specific_idempotent(self):
        with patch.object(main.auth.time, "time", return_value=100):
            first = (await self.set_goal())["goals"][0]
        self.assertEqual(first, {"puuid": PUUID, "role": "TOP", "metric": "cs_min", "target": 6.0, "created": 100})
        with patch.object(main.auth.time, "time", return_value=200):
            updated = (await self.set_goal(7))["goals"][0]
        self.assertEqual(updated, {**first, "target": 7.0})
        await self.set_goal(4, metric="deaths")
        await self.set_goal(5, role="MIDDLE")
        result = await self.request("DELETE", f"/api/player/{PUUID}/goals?role=TOP&metric=cs_min")
        self.assertEqual([(g["role"], g["metric"]) for g in result["goals"]], [("MIDDLE", "cs_min"), ("TOP", "deaths")])
        again = await self.request("DELETE", f"/api/player/{PUUID}/goals?role=TOP&metric=cs_min")
        self.assertEqual(again, result)

    async def test_goal_writes_require_the_session_members_current_link(self):
        for username, target in (("alice", "bob-puuid"), ("unlinked", PUUID), ("bob", PUUID)):
            self.user(username)
            with self.subTest(username=username):
                await self.set_goal(puuid=target, status=403)
                await self.request("DELETE", f"/api/player/{target}/goals?role=TOP&metric=cs_min", 403)
        self.assertEqual(main.auth.get_goals("alice", PUUID), [])
        self.assertEqual(main.auth.get_goals("bob", "bob-puuid"), [])

    async def test_two_members_sharing_one_link_still_cannot_read_or_delete_each_others_goals(self):
        main.auth.set_account("bob", "euw1", "Fixture", "ONE", PUUID)
        await self.set_goal(6)
        self.user("bob")
        self.assertEqual((await self.request("GET", f"/api/player/{PUUID}/coaching"))["goals"], [])
        await self.set_goal(8)
        self.assertEqual((await self.request("GET", f"/api/player/{PUUID}/coaching"))["goals"][0]["target"], 8)
        await self.request("DELETE", f"/api/player/{PUUID}/goals?role=TOP&metric=cs_min")
        self.assertEqual(main.auth.get_goals("alice", PUUID)[0]["target"], 6)
        self.assertEqual(main.auth.get_goals("bob", PUUID), [])

    async def test_goal_identity_fields_in_the_body_cannot_override_the_session_or_path(self):
        result = await self.set_goal(username="bob", puuid_override="bob-puuid")
        self.assertEqual(result["goals"][0]["puuid"], PUUID)
        self.assertEqual(main.auth.get_goals("bob", "bob-puuid"), [])
        response = await self.request("POST", f"/api/player/{PUUID}/goals",
                                      json={"username": "bob", "puuid": "bob-puuid", "role": "TOP", "metric": "deaths", "target": 3})
        self.assertEqual({g["puuid"] for g in response["goals"]}, {PUUID})

    async def test_unlink_and_relink_do_not_resurrect_old_goals(self):
        await self.set_goal()
        main.auth.clear_account("alice")
        await self.set_goal(status=403)
        await self.request("DELETE", f"/api/player/{PUUID}/goals?role=TOP&metric=cs_min", 403)
        result = await self.request("GET", f"/api/player/{PUUID}/coaching")
        self.assertFalse(result["can_edit"])
        self.assertEqual(result["goals"], [])
        main.auth.set_account("alice", "euw1", "Fixture", "ONE", PUUID)
        self.assertEqual((await self.request("GET", f"/api/player/{PUUID}/coaching"))["goals"], [])

    async def test_account_replacement_forbids_writes_to_previous_link(self):
        await self.set_goal()
        main.auth.set_account("alice", "euw1", "Bob", "TWO", "bob-puuid")
        await self.set_goal(status=403)
        await self.request("DELETE", f"/api/player/{PUUID}/goals?role=TOP&metric=cs_min", 403)
        self.assertEqual((await self.set_goal(7, puuid="bob-puuid"))["goals"][0]["puuid"], "bob-puuid")

    async def test_goal_role_and_metric_must_be_actionable_and_applicable(self):
        cases = [("SUPPORT", "deaths"), ("top", "cs_min"), ("UNKNOWN", "cs_min"), ("TOP", "missing"),
                 ("TOP", "jungle_cs10"), ("UTILITY", "cs_min"), ("TOP", "gold_min"), ("TOP", "dmg_share")]
        for role, metric in cases:
            with self.subTest(role=role, metric=metric):
                await self.set_goal(role=role, metric=metric, status=400)
        self.assertEqual(main.auth.get_goals("alice", PUUID), [])

    async def test_goal_rejects_negative_out_of_bounds_and_nonfinite_targets_before_writing(self):
        for target in (-1, 10001, "NaN", "Infinity", "-Infinity", None, "not-a-number"):
            with self.subTest(target=target):
                await self.set_goal(target, status=422)
        await self.set_goal(1.01, metric="kp", status=400)
        self.assertEqual(main.auth.get_goals("alice", PUUID), [])

    async def test_goal_json_boolean_is_not_a_numeric_target(self):
        await self.set_goal(True, status=422)
        self.assertEqual(main.auth.get_goals("alice", PUUID), [])

    async def test_goal_numeric_strings_cannot_bypass_the_private_backends_numeric_type_validation(self):
        await self.set_goal("6", status=422)
        self.assertEqual(main.auth.get_goals("alice", PUUID), [])

    async def test_goal_overflowing_json_number_returns_validation_error_not_server_error(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
                                      base_url="http://fixture", cookies={main.auth.COOKIE: "alice-session"}) as client:
            response = await client.post(f"/api/player/{PUUID}/goals",
                                         content='{"role":"TOP","metric":"cs_min","target":1e999}',
                                         headers={"content-type": "application/json"})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(main.auth.get_goals("alice", PUUID), [])

    async def test_goal_finite_numeric_boundaries_and_fraction_units_are_preserved(self):
        for metric, target in (("cs_min", 0), ("cs_min", 10000), ("kp", 0), ("kp", 1)):
            with self.subTest(metric=metric, target=target):
                result = await self.set_goal(target, metric=metric)
                self.assertEqual(next(g for g in result["goals"] if g["metric"] == metric)["target"], target)

    async def test_goal_missing_fields_and_delete_query_fields_are_422(self):
        for body in ({}, {"role": "TOP", "metric": "cs_min"}, {"metric": "cs_min", "target": 6},
                     {"role": "TOP", "target": 6}):
            with self.subTest(body=body):
                await self.request("POST", f"/api/player/{PUUID}/goals", 422, json=body)
        for query in ("", "?role=TOP", "?metric=cs_min"):
            await self.request("DELETE", f"/api/player/{PUUID}/goals{query}", 422)
        self.assertEqual(main.auth.get_goals("alice", PUUID), [])

    async def test_goal_progress_uses_newest_ten_role_starts_not_range_queue_end_or_finite_count(self):
        created = 100
        with patch.object(main.auth.time, "time", return_value=created):
            await self.set_goal()
        with closing(self.connect()) as db:
            # Twelve qualifying starts: the oldest two must never fill a missing recent metric.
            for i in range(12):
                match = test_data.match_fixture(f"PROGRESS_{i:02}", PUUID)
                match["info"]["gameStartTimestamp"] = created * 1000 + (i + 1) * 1000
                main.store.save_match(db, "euw1", match)
                db.execute("UPDATE perf SET cs_min = ? WHERE match_id = ? AND puuid = ?",
                           (None if i == 11 else i, f"PROGRESS_{i:02}", PUUID))
            for mid, start, role, queue, duration in (("BEFORE", 99_000, "TOP", 420, 1800),
                    ("EQUAL", 100_000, "TOP", 420, 1800), ("OFFROLE", 999_000, "MIDDLE", 420, 1800),
                    ("FLEX", 999_000, "TOP", 440, 1800), ("REMAKE", 999_000, "TOP", 420, 120)):
                match = test_data.match_fixture(mid, PUUID)
                match["info"].update(gameStartTimestamp=start, queueId=queue, gameDuration=duration)
                match["info"]["participants"][0]["teamPosition"] = role
                main.store.save_match(db, "euw1", match)
                db.execute("UPDATE perf SET cs_min = 999 WHERE match_id = ? AND puuid = ?", (mid, PUUID))
            db.execute("UPDATE perf SET cs_min = ? WHERE match_id = 'PROGRESS_10' AND puuid = ?", (float("inf"), PUUID))
            db.commit()
        result = await self.request("GET", f"/api/player/{PUUID}/coaching?range=season")
        self.assertEqual(result["roles"], [], "Fixture games predate the selected season")
        self.assertEqual(result["goals"][0]["progress"], {"games": 8, "value": 5.5})
        self.assertNotIn("progress", main.auth.get_goals("alice", PUUID)[0])


class StoryAndTimelineEndpoints(FeatureFixture):
    def story_match(self, mid="STORY", cached=True):
        match, raw = mapped_story_fixture(mid)
        self.save_match(match, raw if cached else None)
        return match, raw

    async def test_story_maps_real_noncanonical_ids_champions_teams_and_player_events(self):
        match, _ = self.story_match()
        result = await self.request("GET", f"/api/match/STORY/story?puuid={PUUID}")
        self.assertTrue(result["available"])
        self.assertEqual((result["team"], result["me"]), (100, 42))
        self.assertEqual({p["participant_id"]: (p["champion_id"], p["team"], p["position"]) for p in result["players"]},
                         {p["participantId"]: (p["championId"], p["teamId"], p["teamPosition"]) for p in match["info"]["participants"]})
        self.assertEqual([(e["killer"], e["victim"], e["side"]) for e in result["events"] if e["kind"] == "kill"],
                         [(3, 42, "them"), (7, 1, "us")])
        self.assertEqual([(e["kind"], e["victim"]) for e in result["deaths"]], [("kill", 42), ("execution", 42)])
        self.assertEqual(result["start"], [[2, 1055]])
        self.assertEqual(result["build"], [[90, 3031]])
        self.assertEqual(result["skills"], "12")
        self.assertIsNone(result["model"])
        self.assertIsNone(result["turning"])
        self.assertTrue(all(m["chance"] is None for m in result["minutes"]))
        self.assertIn(60.25, [m["t"] for m in result["minutes"]])
        self.riot.timeline.assert_not_awaited()

    async def test_story_red_view_flips_gold_and_events_without_id_arithmetic(self):
        self.story_match()
        red = await self.request("GET", "/api/match/STORY/story?puuid=STORY-player-5")
        blue = await self.request("GET", "/api/match/STORY/story")
        self.assertEqual((red["team"], red["me"]), (200, 3))
        self.assertEqual((blue["team"], blue["me"]), (100, None))
        self.assertEqual(red["minutes"][0]["gold"], -blue["minutes"][0]["gold"])
        self.assertEqual(red["kills"][0]["killer"], 3)
        self.assertEqual(red["events"][0]["side"], "us")
        self.assertEqual(red["start"], [])
        self.assertEqual(red["skills"], "")

    async def test_story_validated_model_reports_retrospective_label_and_terminal_certainty(self):
        self.story_match()
        self.put_model("ingame")
        blue = await self.request("GET", f"/api/match/STORY/story?puuid={PUUID}")
        red = await self.request("GET", "/api/match/STORY/story?puuid=STORY-player-5")
        self.assertEqual(blue["model"], {"trained_at": 123, "label": main.model.INGAME_LABEL, "accuracy": 0.75})
        self.assertAlmostEqual(blue["minutes"][0]["chance"], 1 - red["minutes"][0]["chance"])
        self.assertEqual((blue["minutes"][-1]["chance"], red["minutes"][-1]["chance"]), (1, 0))
        self.assertTrue(blue["minutes"][-1]["final"])
        self.assertLess(blue["turning"]["minute"], 930 / 60)

    async def test_non_solo_rift_stories_keep_gold_events_but_never_use_a_ready_solo_model(self):
        self.story_match()
        self.put_model("ingame")
        solo = await self.request("GET", f"/api/match/STORY/story?puuid={PUUID}")
        self.assertIsNotNone(solo["model"])
        self.assertTrue(any(row["chance"] is not None for row in solo["minutes"]))
        for queue in (400, 440, 700, 830):
            mid = f"NONSOLO_{queue}"
            match, raw = mapped_story_fixture(mid)
            match["info"]["queueId"] = queue
            raw["info"]["queueId"] = queue
            self.save_match(match, raw)
            with self.subTest(queue=queue), patch.object(main.model, "ingame_chance", wraps=main.model.ingame_chance) as chance:
                result = await self.request("GET", f"/api/match/{mid}/story?puuid={PUUID}")
                self.assertTrue(result["available"])
                self.assertIsNone(result["model"])
                self.assertIsNone(result["turning"])
                self.assertTrue(all(row["chance"] is None for row in result["minutes"]))
                self.assertEqual([row["gold"] for row in result["minutes"]], [row["gold"] for row in solo["minutes"]])
                self.assertEqual(result["events"], solo["events"])
                self.assertEqual(result["deaths"], solo["deaths"])
                self.assertEqual((result["start"], result["build"], result["skills"]), (solo["start"], solo["build"], solo["skills"]))
                chance.assert_called_once_with(None)
        self.assertTrue((await self.request("GET", "/api/odds"))["ingame"]["ready"])
        self.riot.timeline.assert_not_awaited()

    async def test_story_unknown_match_and_nonparticipant_are_client_errors(self):
        await self.request("GET", "/api/match/UNKNOWN/story", 404)
        self.story_match()
        await self.request("GET", "/api/match/STORY/story?puuid=not-a-participant", 400)
        self.riot.timeline.assert_not_awaited()

    async def test_retired_missing_corrupt_and_future_digests_stay_unavailable_without_network_or_writes(self):
        self.story_match()
        with closing(self.connect()) as db:
            current = main.store.digest(db, "STORY")
        assert isinstance(current, dict), "Expected a current fixture digest before retirement"
        blobs = [None, b"not-zlib", zlib.compress(json.dumps({**current, "v": 1}).encode()),
                 zlib.compress(json.dumps({**current, "v": 999}).encode()),
                 zlib.compress(json.dumps({**current, "map_id": 12}).encode())]
        for blob in blobs:
            with self.subTest(blob=repr(blob)[:50]):
                with closing(self.connect()) as db:
                    db.execute("UPDATE timeline_digest SET data = ? WHERE match_id = 'STORY'", (blob,))
                    db.commit()
                before = self.timeline_rows("STORY")
                result = await self.request("GET", "/api/match/STORY/story")
                self.assertEqual(result["available"], False)
                self.assertTrue(result["can_fetch"])
                self.assertIn("digest", result["reason"])
                self.assertEqual(self.timeline_rows("STORY"), before)
        self.riot.timeline.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_fetched_legacy_marker_without_digest_is_not_automatic_permission_to_fetch(self):
        self.story_match(cached=False)
        with closing(self.connect()) as db:
            db.execute("INSERT INTO timelines VALUES ('STORY')")
            db.commit()
        for _ in range(2):
            self.assertFalse((await self.request("GET", "/api/match/STORY/story"))["available"])
        self.riot.timeline.assert_not_awaited()
        with closing(self.connect()) as db:
            self.assertTrue(main.store.has_timeline(db, "STORY"))
            self.assertEqual(main.store.digest_status(db, "STORY"), "legacy")

    async def test_nonrift_story_is_unavailable_and_explicit_fetch_rejected_without_riot(self):
        match = test_data.match_fixture("ARAM", PUUID)
        match["info"].update(queueId=450, mapId=12, gameMode="ARAM")
        self.save_match(match)
        result = await self.request("GET", "/api/match/ARAM/story")
        self.assertFalse(result["available"])
        self.assertFalse(result["can_fetch"])
        await self.request("POST", "/api/match/ARAM/timeline", 400)
        await self.request("POST", "/api/match/UNKNOWN/timeline", 404)
        self.riot.timeline.assert_not_awaited()

    async def test_explicit_timeline_post_upgrades_only_requested_cache_and_story_then_reads_it(self):
        _, raw = self.story_match(cached=False)
        self.story_match("OTHER")
        other_before = self.timeline_rows("OTHER")
        self.assertFalse((await self.request("GET", "/api/match/STORY/story"))["available"])
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = raw
        result = await self.request("POST", "/api/match/STORY/timeline")
        self.assertEqual(result, {"available": True})
        self.riot.timeline.assert_awaited_once_with("euw1", "STORY")
        self.assertTrue((await self.request("GET", "/api/match/STORY/story"))["available"])
        self.assertEqual(self.timeline_rows("OTHER"), other_before)
        with closing(self.connect()) as db:
            self.assertEqual(main.store.digest_status(db, "STORY"), "available")
            digest = main.store.digest(db, "STORY")
            assert isinstance(digest, dict), "Explicit upgrade must persist a current digest"
            self.assertEqual(digest["v"], 2)
        self.starts.assert_not_called()

    async def test_explicit_refresh_replaces_old_frames_purchases_and_digest_without_duplicate_rows(self):
        _, raw = self.story_match()
        before = self.timeline_rows("STORY")
        for frame in raw["info"]["frames"]:
            for person in frame["participantFrames"].values():
                person["totalGold"] += 123
            frame["events"] = [e for e in frame["events"] if e["type"] != "ITEM_PURCHASED"]
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = raw
        await self.request("POST", "/api/match/STORY/timeline")
        after = self.timeline_rows("STORY")
        self.assertNotEqual(after["timeline_digest"], before["timeline_digest"])
        self.assertEqual(len(after["frames"]), len(before["frames"]))
        self.assertEqual(len(after["purchases"]), 10)
        self.assertEqual(after["timelines"], before["timelines"])
        old_gold = {(r[1], r[2]): r[3] for r in before["frames"]}
        self.assertTrue(all(r[3] == old_gold[(r[1], r[2])] + 123 for r in after["frames"]))
        story = await self.request("GET", f"/api/match/STORY/story?puuid={PUUID}")
        self.assertEqual(story["start"], [])
        self.assertEqual(story["build"], [])
        self.assertEqual(story["skills"], "12")

    async def test_real_timeline_save_failure_after_derived_deletes_restores_previous_rows(self):
        _, raw = self.story_match()
        before = self.timeline_rows("STORY")
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = raw
        connections = []

        def connect():
            db = self.connect()
            connections.append(db)

            def fail_frame_insert(sql, parameters):
                if sql.startswith("INSERT INTO frames"):
                    raise sqlite3.OperationalError("fixture frame insert failure")

            db.before_execute = fail_frame_insert
            return db

        with (patch.object(main.store, "connect", side_effect=connect),
              self.assertRaisesRegex(sqlite3.OperationalError, "frame insert failure")):
            await self.client.post("/api/match/STORY/timeline")
        self.assertEqual(connections[-1].rollback_count, 1)
        self.assertTrue(connections[-1].closed)
        self.assertTrue(any(sql.startswith("ROLLBACK TO SAVEPOINT") for sql, _ in connections[-1].queries))
        self.assertEqual(self.timeline_rows("STORY"), before)

    async def test_timeline_commit_failure_rolls_back_successful_derived_writes(self):
        _, raw = self.story_match()
        before = self.timeline_rows("STORY")
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = raw
        connections = []

        def connect():
            db = self.connect()
            db.commit = Mock(side_effect=sqlite3.OperationalError("fixture commit failure"))
            connections.append(db)
            return db

        with (patch.object(main.store, "connect", side_effect=connect),
              self.assertRaisesRegex(sqlite3.OperationalError, "commit failure")):
            await self.client.post("/api/match/STORY/timeline")
        connections[-1].commit.assert_called_once()
        self.assertEqual(connections[-1].rollback_count, 1)
        self.assertTrue(connections[-1].closed)
        self.assertEqual(self.timeline_rows("STORY"), before)

    async def test_explicit_timeline_uses_mock_transport_and_does_not_hold_sqlite_during_network(self):
        _, raw = self.story_match(cached=False)
        calls = []

        def respond(request):
            self.assertTrue(all(db.closed for db in self.opened), "Do not pin a DB connection during network waits")
            calls.append((request.method, str(request.url)))
            return httpx.Response(200, json=raw)

        http = httpx.AsyncClient(transport=httpx.MockTransport(respond), headers={"X-Riot-Token": "fixture-only"})
        self.addAsyncCleanup(http.aclose)
        riot = object.__new__(main.Riot)
        riot.http = http
        riot.share = 1
        self.stack.enter_context(patch.object(riot, "limiter", SimpleNamespace(acquire=AsyncMock(), observe=Mock()), create=True))
        main.state["riot"] = riot
        await self.request("POST", "/api/match/STORY/timeline")
        self.assertEqual(calls, [("GET", "https://europe.api.riotgames.com/lol/match/v5/matches/STORY/timeline")])

    async def test_explicit_timeline_request_cancellation_closes_reads_and_preserves_cached_rows(self):
        self.story_match()
        before = self.timeline_rows("STORY")
        fetching, cancelled = asyncio.Event(), asyncio.Event()
        slots = main.history.fetch_slots()
        self.connect_mock.reset_mock()

        async def wait_for_cancellation(platform, match_id):
            self.assertEqual((platform, match_id), ("euw1", "STORY"))
            self.assertTrue(all(db.closed for db in self.opened), "Database must close before the Riot wait")
            fetching.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        self.riot.timeline.side_effect = wait_for_cancellation
        with patch.object(main.store, "save_timeline", wraps=main.store.save_timeline) as save:
            request = asyncio.create_task(self.client.post("/api/match/STORY/timeline"))
            try:
                await asyncio.wait_for(fetching.wait(), timeout=1)
                request.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(request, timeout=1)
                await asyncio.wait_for(cancelled.wait(), timeout=1)
            finally:
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)
            save.assert_not_called()
        self.connect_mock.assert_called_once_with()
        self.riot.timeline.assert_awaited_once_with("euw1", "STORY")
        self.assertEqual(self.timeline_rows("STORY"), before)
        acquired = 0
        try:
            for _ in range(main.history.FETCH_BATCHES):
                await asyncio.wait_for(slots.acquire(), timeout=1)
                acquired += 1
        finally:
            for _ in range(acquired):
                slots.release()
        self.starts.assert_not_called()

    async def test_explicit_timeline_and_history_downloads_share_bounded_slots_through_cache_writes(self):
        capacity = main.history.FETCH_BATCHES
        slots = main.history.fetch_slots()
        payloads = {mid: self.story_match(mid, cached=False)[1]
                    for mid in ["HISTORY", *[f"EXPLICIT_{i}" for i in range(capacity + 2)]]}
        entered, attempts = asyncio.Queue(), asyncio.Queue()
        finish = asyncio.Event()
        active = peak = 0
        leases = set()
        original_acquire, original_release = slots.acquire, slots.release
        original_save = main.store.save_timeline

        async def acquire():
            attempts.put_nowait(None)
            result = await original_acquire()
            leases.add(asyncio.current_task())
            return result

        def release():
            leases.remove(asyncio.current_task())
            original_release()

        def save(db, mid, raw):
            self.assertIn(asyncio.current_task(), leases, "Keep the shared download slot until the timeline is stored")
            return original_save(db, mid, raw)

        async def download(platform, mid):
            nonlocal active, peak
            self.assertEqual(platform, "euw1")
            active += 1
            peak = max(peak, active)
            entered.put_nowait(mid)
            try:
                await finish.wait()
                return payloads[mid]
            finally:
                active -= 1

        self.riot.timeline.side_effect = download
        with (closing(self.connect()) as history_db,
              patch.object(slots, "acquire", side_effect=acquire),
              patch.object(slots, "release", side_effect=release),
              patch.object(main.history, "fetch_slots", wraps=main.history.fetch_slots) as shared,
              patch.object(main.store, "save_timeline", side_effect=save)):
            tasks = [asyncio.create_task(main.history.fetch_chunk(self.riot, history_db, "euw1", ["HISTORY"], "GOLD"))]
            try:
                self.assertEqual(await asyncio.wait_for(entered.get(), timeout=2), "HISTORY")
                tasks.extend(asyncio.create_task(self.client.post(f"/api/match/{mid}/timeline"))
                             for mid in payloads if mid != "HISTORY")
                for _ in tasks:
                    await asyncio.wait_for(attempts.get(), timeout=2)
                self.assertEqual(active, capacity)
                self.assertEqual(self.riot.timeline.await_count, capacity)
                self.assertEqual(shared.call_count, len(tasks))
                self.assertTrue(all(db.closed for db in self.opened if db is not history_db),
                                "Explicit requests must not hold databases while queued or fetching")
                self.assertTrue(all(not task.done() for task in tasks))
                finish.set()
                results = await asyncio.wait_for(asyncio.gather(*tasks), timeout=3)
                for response in results[1:]:
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json(), {"available": True})
                self.assertEqual(peak, capacity)
                self.assertEqual(active, 0)
                self.assertEqual(leases, set())
                self.assertFalse(slots.locked())
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), timeout=3)
        self.assertEqual(self.riot.timeline.await_count, len(payloads))
        with closing(self.connect()) as db:
            self.assertTrue(all(main.store.digest_status(db, mid) == "available" for mid in payloads))
        self.riot.match.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_cancelling_timeline_queued_for_shared_slots_does_not_fetch_write_or_release_anothers_permit(self):
        _, raw = self.story_match()
        before = self.timeline_rows("STORY")
        slots = main.history.fetch_slots()
        for _ in range(main.history.FETCH_BATCHES):
            await asyncio.wait_for(slots.acquire(), timeout=1)
        queued = asyncio.Event()
        original_acquire = slots.acquire

        async def acquire():
            queued.set()
            return await original_acquire()

        request = None
        try:
            with (patch.object(slots, "acquire", side_effect=acquire),
                  patch.object(main.store, "save_timeline", wraps=main.store.save_timeline) as save):
                request = asyncio.create_task(self.client.post("/api/match/STORY/timeline"))
                await asyncio.wait_for(queued.wait(), timeout=2)
                self.assertTrue(all(db.closed for db in self.opened), "Queued requests must close the cache read first")
                self.assertTrue(slots.locked())
                self.riot.timeline.assert_not_awaited()
                request.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(request, timeout=2)
                self.assertTrue(slots.locked(), "Cancelling a waiter must not release an occupied slot")
                save.assert_not_called()
        finally:
            if request is not None:
                request.cancel()
                await asyncio.wait_for(asyncio.gather(request, return_exceptions=True), timeout=2)
            for _ in range(main.history.FETCH_BATCHES):
                slots.release()
        self.riot.timeline.assert_not_awaited()
        self.assertEqual(self.timeline_rows("STORY"), before)
        self.assertFalse(slots.locked())
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = raw
        self.assertEqual(await self.request("POST", "/api/match/STORY/timeline"), {"available": True})
        self.riot.timeline.assert_awaited_once_with("euw1", "STORY")
        self.starts.assert_not_called()

    async def test_timeline_upstream_and_cache_errors_release_shared_slot_for_the_next_request(self):
        _, raw = self.story_match()
        before = self.timeline_rows("STORY")
        slots = asyncio.Semaphore(1)
        with patch.object(main.history, "_fetch_slots", slots):
            self.riot.timeline.side_effect = main.RiotError(503, "fixture upstream failure")
            await self.request("POST", "/api/match/STORY/timeline", 502)
            self.assertFalse(slots.locked())
            self.riot.timeline.side_effect = None
            self.riot.timeline.return_value = raw
            with (patch.object(main.store, "save_timeline", side_effect=sqlite3.OperationalError("fixture write failure")),
                  self.assertRaisesRegex(sqlite3.OperationalError, "fixture write failure")):
                await self.client.post("/api/match/STORY/timeline")
            self.assertFalse(slots.locked())
            self.assertEqual(self.timeline_rows("STORY"), before)
            self.assertEqual(await self.request("POST", "/api/match/STORY/timeline"), {"available": True})
            self.assertFalse(slots.locked())
        self.riot.timeline.assert_awaited_with("euw1", "STORY")
        self.assertEqual(self.riot.timeline.await_count, 3)

    async def test_timeline_upstream_errors_preserve_all_old_derived_rows(self):
        self.story_match()
        before = self.timeline_rows("STORY")
        for upstream, expected in ((401, 502), (403, 502), (404, 404), (429, 502), (503, 502)):
            self.riot.timeline.side_effect = main.RiotError(upstream, "fixture failure")
            with self.subTest(upstream=upstream):
                await self.request("POST", "/api/match/STORY/timeline", expected)
                self.assertEqual(self.timeline_rows("STORY"), before)

    async def test_timeline_partial_write_exception_rolls_back_the_outer_transaction(self):
        self.story_match()
        before = self.timeline_rows("STORY")
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = {}
        writes = []

        def fail_after_write(db, mid, raw):
            self.assertTrue(db.in_transaction)
            writes.append(db)
            db.execute("DELETE FROM timeline_digest WHERE match_id = ?", (mid,))
            db.execute("DELETE FROM frames WHERE match_id = ?", (mid,))
            db.execute("UPDATE purchases SET skills = 'BROKEN' WHERE match_id = ?", (mid,))
            raise sqlite3.OperationalError("fixture interrupted write")

        with (patch.object(main.store, "save_timeline", side_effect=fail_after_write),
              self.assertRaisesRegex(sqlite3.OperationalError, "interrupted write")):
            await self.client.post("/api/match/STORY/timeline")
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0].rollback_count, 1)
        self.assertTrue(writes[0].closed)
        self.assertEqual(self.timeline_rows("STORY"), before)

    async def test_mismatched_or_malformed_timeline_payload_cannot_retire_previous_data(self):
        self.story_match()
        before = self.timeline_rows("STORY")
        self.riot.timeline.side_effect = None
        for raw in ([], {"metadata": {"matchId": "OTHER"}, "info": {"frames": []}}):
            with self.subTest(raw=raw):
                self.riot.timeline.return_value = raw
                with self.assertRaises(ValueError):
                    await self.client.post("/api/match/STORY/timeline")
                self.assertEqual(self.timeline_rows("STORY"), before)

    async def test_explicit_missing_timeline_returns_unavailable_and_remembers_fetch(self):
        self.story_match(cached=False)
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = None
        self.assertEqual(await self.request("POST", "/api/match/STORY/timeline"), {"available": False})
        with closing(self.connect()) as db:
            self.assertTrue(main.store.has_timeline(db, "STORY"))
            self.assertIsNone(main.store.digest(db, "STORY"))

    async def test_explicit_missing_timeline_keeps_an_earlier_fetchs_legacy_rows(self):
        self.story_match(cached=False)
        with closing(self.connect()) as db:  # a v1-era fetch: marker and gold frames, no current digest
            db.execute("INSERT INTO timelines VALUES ('STORY')")
            db.execute(f"INSERT INTO frames VALUES ('STORY', '{PUUID}', 15, 5000, 6000, 120)")
            db.commit()
        before = self.timeline_rows("STORY")
        self.riot.timeline.side_effect = None
        self.riot.timeline.return_value = None
        self.assertEqual(await self.request("POST", "/api/match/STORY/timeline"), {"available": False})
        self.riot.timeline.assert_awaited_once_with("euw1", "STORY")
        self.assertEqual(self.timeline_rows("STORY"), before)
        self.assertEqual(len(before["frames"]), 1)


class OddsEndpoints(FeatureFixture):
    async def test_scorecards_without_models_are_unavailable_not_placeholder_probabilities(self):
        result = await self.request("GET", "/api/odds")
        self.assertEqual(result, {name: {"ready": False, "reason": None, "trained_at": None,
                                        "report": None, "features": None} for name in ("ingame", "pregame")})
        self.starts.assert_not_called()

    async def test_scorecards_preserve_independent_readiness_features_report_and_timestamps(self):
        self.put_model("ingame")
        with closing(self.connect()) as db:
            main.model.save(db, "pregame", None, now=456)
        result = await self.request("GET", "/api/odds")
        self.assertTrue(result["ingame"]["ready"])
        self.assertEqual(result["ingame"]["trained_at"], 123)
        self.assertEqual(result["ingame"]["features"], main.model.INGAME_FEATURES)
        self.assertEqual(result["ingame"]["report"]["overall"], model_fixture("ingame")[1]["overall"])
        self.assertFalse(result["pregame"]["ready"])
        self.assertEqual(result["pregame"]["trained_at"], 456)
        self.assertIsNone(result["pregame"]["features"])
        self.assertIn("Insufficient", result["pregame"]["reason"])
        self.assertEqual(result["ingame"]["report"]["interpretation"]["historical_prediction"], False)

    async def test_scorecards_retire_legacy_and_corrupt_claimed_ready_models(self):
        with closing(self.connect()) as db:
            db.executemany("INSERT INTO models VALUES (?, ?, ?, ?)", [
                ("ingame", 111, json.dumps({"weights": [0, 1]}), json.dumps({"ready": True})),
                ("pregame", 222, "{broken-json", json.dumps({"ready": True}))])
            db.commit()
        result = await self.request("GET", "/api/odds")
        for name in ("ingame", "pregame"):
            self.assertFalse(result[name]["ready"])
            self.assertIsNone(result[name]["features"])
        self.assertIn("retraining", result["ingame"]["reason"])
        self.assertIn("Invalid stored model", result["pregame"]["reason"])
        self.assertEqual(result["pregame"]["trained_at"], 222)


class LiveOddsEndpoints(FeatureFixture):
    async def test_disabled_live_odds_explains_review_gate_before_cache_network_or_model_work(self):
        game = spectator_fixture()
        entries = [None, {"at": main.time.time(), "game": game, "extra": {}},
                   {"at": main.time.time() - main.LIVE_TTL - 1, "game": game, "extra": {}}]
        self.connect_mock.reset_mock()
        with (patch.object(main, "LIVE_ODDS_ENABLED", False),
              patch.object(main, "_live_cached", side_effect=AssertionError("Disabled odds must not touch spectator cache")) as cached,
              patch.object(main, "live", AsyncMock(side_effect=AssertionError("Disabled odds must not renew spectator data"))) as refresh,
              patch.object(main.model, "pregame_prediction", side_effect=AssertionError("Disabled odds must not infer")) as predict):
            for entry in entries:
                main.state["live"].clear()
                if entry:
                    main.state["live"][PUUID] = entry
                before = copy.deepcopy(main.state["live"])
                with self.subTest(cache=entry):
                    result = await self.request("POST", f"/api/live/{PUUID}/odds",
                                                json={**role_body(game), "game_id": game["gameId"] + 1})
                    self.assertEqual(set(result), {"ready", "reason"})
                    self.assertIs(result["ready"], False)
                    self.assertIn("disabled", result["reason"].lower())
                    self.assertIn("riot", result["reason"].lower())
                    self.assertIn("review", result["reason"].lower())
                    self.assertEqual(main.state["live"], before)
            cached.assert_not_called()
            refresh.assert_not_awaited()
            predict.assert_not_called()
        self.connect_mock.assert_not_called()
        for name, method in vars(self.riot).items():
            if name != "background":
                method.assert_not_awaited()
        self.riot.background.assert_not_called()
        self.starts.assert_not_called()

    async def test_disabled_live_odds_still_requires_authentication_before_gate_or_body_validation(self):
        with closing(main.auth.connect()) as db:
            db.execute("UPDATE sessions SET expires = 0 WHERE username = 'alice'")
            db.execute("DELETE FROM users WHERE username = 'bob'")
            db.commit()
        self.connect_mock.reset_mock()
        with (patch.object(main, "LIVE_ODDS_ENABLED", False),
              patch.object(main, "_live_cached") as cached,
              patch.object(main, "live", AsyncMock()) as refresh,
              patch.object(main.model, "pregame_prediction") as predict):
            for username in (None, "unknown", "alice", "bob"):
                self.user(username)
                for body in ({}, role_body(spectator_fixture())):
                    with self.subTest(username=username, valid_body=bool(body)):
                        result = await self.request("POST", f"/api/live/{PUUID}/odds", 401, json=body)
                        self.assertEqual(result, {"detail": "Not logged in"})
            cached.assert_not_called()
            refresh.assert_not_awaited()
            predict.assert_not_called()
        self.connect_mock.assert_not_called()
        self.riot.active_game.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_live_payload_reports_boolean_odds_gate_without_hiding_actual_roster(self):
        game = self.live_cache(spectator_fixture(hidden=True))
        with patch.object(main.model, "pregame_prediction") as predict:
            for enabled in (False, True):
                with self.subTest(enabled=enabled), patch.object(main, "LIVE_ODDS_ENABLED", enabled):
                    result = await self.request("GET", f"/api/live/{PUUID}")
                    self.assertTrue(result["in_game"])
                    self.assertIs(result["odds_enabled"], enabled)
                    self.assertEqual(result["game_id"], game["gameId"])
                    self.assertEqual(len(result["players"]), 10)
                    self.assertEqual({(p["team"], p["champion_id"]) for p in result["players"]},
                                     {(p["teamId"], p["championId"]) for p in game["participants"]})
                    self.assertEqual(sum(bool(p.get("hidden")) for p in result["players"]), 1)
            predict.assert_not_called()
        self.riot.active_game.assert_not_awaited()
        self.riot.league_entries.assert_not_awaited()
        self.riot.mastery.assert_not_awaited()
        self.starts.assert_not_called()

    def renew_spectator(self, game):
        self.riot.active_game.side_effect = None
        self.riot.active_game.return_value = game
        for name in ("league_entries", "mastery"):
            method = getattr(self.riot, name)
            method.side_effect = None
            method.return_value = []

    async def test_live_roles_use_exact_cached_spectator_lineup_and_start_not_supplied_identities(self):
        game = self.live_cache(spectator_fixture(hidden=True))
        body = role_body(game)
        body["roles"].reverse()
        for role in body["roles"]:
            role.update(puuid="fabricated", riot_id="fabricated#ID", rank="CHALLENGER")
        before = copy.deepcopy(game)
        loop_thread = threading.get_ident()
        inference_threads = []

        def prediction(db, players, patch, **kwargs):
            owner = threading.get_ident()
            inference_threads.append(owner)
            self.assertNotEqual(owner, loop_thread, "Model/SQLite work must not block the ASGI loop")
            self.assertEqual(self.connection_threads[db], owner, "The inference worker must own its SQLite connection")
            self.assertTrue(db.in_transaction, "Inference inputs must share one worker-owned snapshot")
            return {"ready": True, "blue": 0.6, "red": 0.4}

        with patch.object(main.model, "pregame_prediction", side_effect=prediction) as predict:
            result = await self.request("POST", f"/api/live/{PUUID}/odds", json=body)
        self.assertEqual(result, {"ready": True, "blue": 0.6, "red": 0.4})
        self.assertEqual(len(inference_threads), 1)
        self.assertTrue(predict.call_args.args[0].closed)
        args, kwargs = predict.call_args
        self.assertEqual(args[2], "16.1")
        self.assertEqual(kwargs, {"start_cutoff": START})
        slots = {(p["teamId"], p["championId"]): p.get("puuid") for p in game["participants"]}
        self.assertEqual({(p["team_id"], p["champion_id"]): p["puuid"] for p in args[1]}, slots)
        self.assertEqual({(p["team_id"], p["champion_id"]): p["position"] for p in args[1]},
                         {(r["team"], r["champion_id"]): r["role"] for r in body["roles"]})
        self.assertTrue(all(set(p) == {"team_id", "champion_id", "position", "puuid"} for p in args[1]))
        self.assertEqual(game, before)
        self.riot.active_game.assert_not_awaited()
        self.riot.account_by_puuid.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_live_odds_real_model_counts_only_nine_identified_players(self):
        game = self.live_cache(spectator_fixture(hidden=True))
        self.put_model("pregame")
        result = await self.request("POST", f"/api/live/{PUUID}/odds", json=role_body(game))
        self.assertTrue(result["ready"], result["reason"])
        self.assertEqual(result["coverage"]["draft"]["known_slots"], 10)
        self.assertEqual(result["coverage"]["players"]["identified"], 9)
        self.assertEqual(result["coverage"]["players"]["with_cached_history"], 0)
        self.assertEqual(result["features"]["excluded"]["hidden_identities"], "never inferred")
        self.assertAlmostEqual(result["blue"] + result["red"], 1)
        self.riot.account_by_puuid.assert_not_awaited()

    async def test_valid_roles_without_a_validated_model_do_not_fabricate_fifty_fifty_odds(self):
        game = self.live_cache()
        result = await self.request("POST", f"/api/live/{PUUID}/odds", json=role_body(game))
        self.assertFalse(result["ready"])
        self.assertIsNone(result["blue"])
        self.assertIsNone(result["red"])
        self.assertIn("validated", result["reason"])

    async def test_missing_idle_expired_or_fresh_no_game_cache_still_requires_explicit_refresh(self):
        game = spectator_fixture()
        entries = [None, {"at": main.time.time() - main.LIVE_CACHE_TTL - 1, "game": game, "extra": {}},
                   {"at": main.time.time(), "game": None, "extra": {}}]
        with patch.object(main.model, "pregame_prediction") as predict, patch.object(main, "live", AsyncMock()) as refresh:
            for entry in entries:
                main.state["live"].clear()
                if entry:
                    main.state["live"][PUUID] = entry
                with self.subTest(entry=entry):
                    await self.request("POST", f"/api/live/{PUUID}/odds", 409, json=role_body(game))
            predict.assert_not_called()
            refresh.assert_not_awaited()
        self.riot.active_game.assert_not_awaited()

    async def test_stale_cache_renews_spectator_without_form_sync_and_predicts_only_fresh_identities(self):
        old = self.live_cache(spectator_fixture(hidden=True), age=main.LIVE_TTL + 1)
        fresh = copy.deepcopy(old)
        fresh["participants"][1]["puuid"] = "renewed-identity"
        self.renew_spectator(fresh)
        with (patch.object(main, "live", AsyncMock(wraps=main.live)) as refresh,
              patch.object(main.model, "pregame_prediction", return_value={"ready": True}) as predict):
            result = await self.request("POST", f"/api/live/{PUUID}/odds", json=role_body(old))
        self.assertEqual(result, {"ready": True})
        refresh.assert_awaited_once_with(PUUID, form=False)
        self.riot.active_game.assert_awaited_once_with("euw1", PUUID)
        players = predict.call_args.args[1]
        self.assertEqual({(p["team_id"], p["champion_id"]): p["puuid"] for p in players},
                         {(p["teamId"], p["championId"]): p.get("puuid") for p in fresh["participants"]})
        self.assertEqual(predict.call_args.kwargs, {"start_cutoff": START})
        self.assertLess(main.time.time() - main.state["live"][PUUID]["at"], main.LIVE_TTL)
        self.riot.league_entries.assert_not_awaited()
        self.riot.mastery.assert_not_awaited()
        self.riot.account_by_puuid.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_renewal_new_game_revalidates_submitted_champions_against_new_lineup(self):
        old = self.live_cache(age=main.LIVE_TTL + 1)
        fresh = copy.deepcopy(old)
        fresh["gameId"] += 1
        fresh["participants"][0]["championId"] = 77
        self.renew_spectator(fresh)
        with patch.object(main.model, "pregame_prediction") as predict:
            await self.request("POST", f"/api/live/{PUUID}/odds", 400, json=role_body(old))
            predict.assert_not_called()
        self.assertEqual(main.state["live"][PUUID]["game"], fresh)
        self.riot.active_game.assert_awaited_once_with("euw1", PUUID)
        self.starts.assert_not_called()

    async def test_renewal_same_champions_in_new_game_rejects_old_explicit_game_id(self):
        old = self.live_cache(age=main.LIVE_TTL + 1)
        fresh = copy.deepcopy(old)
        fresh["gameId"] += 1
        fresh["gameStartTime"] += 86400 * 1000
        self.renew_spectator(fresh)
        body = {**role_body(old), "game_id": old["gameId"]}
        with patch.object(main.model, "pregame_prediction") as predict:
            result = await self.request("POST", f"/api/live/{PUUID}/odds", 409, json=body)
            predict.assert_not_called()
        self.assertIn("game changed", result["detail"].lower())
        self.assertEqual(main.state["live"][PUUID]["game"], fresh)
        self.riot.active_game.assert_awaited_once_with("euw1", PUUID)
        self.starts.assert_not_called()

    async def test_fresh_cache_accepts_matching_game_id_and_rejects_wrong_game_id_without_renewal(self):
        game = self.live_cache()
        with (patch.object(main, "live", AsyncMock()) as refresh,
              patch.object(main.model, "pregame_prediction", return_value={"ready": True}) as predict):
            await self.request("POST", f"/api/live/{PUUID}/odds", 409,
                               json={**role_body(game), "game_id": game["gameId"] + 1})
            predict.assert_not_called()
            await self.request("POST", f"/api/live/{PUUID}/odds",
                               json={**role_body(game), "game_id": game["gameId"]})
            predict.assert_called_once()
            refresh.assert_not_awaited()
        self.riot.active_game.assert_not_awaited()

    async def test_stale_cache_with_matching_game_id_can_renew_and_return_real_model_odds(self):
        old = self.live_cache(age=main.LIVE_TTL + 1)
        self.renew_spectator(copy.deepcopy(old))
        self.put_model("pregame")
        result = await self.request("POST", f"/api/live/{PUUID}/odds",
                                    json={**role_body(old), "game_id": old["gameId"]})
        self.assertTrue(result["ready"], result["reason"])
        self.assertEqual(result["features"]["start_cutoff"], START)
        self.assertEqual(result["coverage"]["draft"]["known_slots"], 10)
        self.riot.active_game.assert_awaited_once_with("euw1", PUUID)
        self.starts.assert_not_called()

    async def test_renewal_ended_game_is_409_and_never_falls_back_to_old_roster(self):
        old = self.live_cache(age=main.LIVE_TTL + 1)
        self.renew_spectator(None)
        with patch.object(main.model, "pregame_prediction") as predict:
            await self.request("POST", f"/api/live/{PUUID}/odds", 409, json=role_body(old))
            predict.assert_not_called()
        self.assertIsNone(main.state["live"][PUUID]["game"])
        self.riot.active_game.assert_awaited_once_with("euw1", PUUID)
        self.starts.assert_not_called()

    async def test_renewal_non_solo_game_is_unavailable_despite_previous_solo_roster(self):
        old = self.live_cache(age=main.LIVE_TTL + 1)
        fresh = copy.deepcopy(old)
        fresh.update(gameId=old["gameId"] + 1, gameQueueConfigId=440)
        self.renew_spectator(fresh)
        with patch.object(main.model, "pregame_prediction") as predict:
            result = await self.request("POST", f"/api/live/{PUUID}/odds", json=role_body(old))
            self.assertFalse(result["ready"])
            self.assertIn("solo", result["reason"])
            predict.assert_not_called()
        self.starts.assert_not_called()

    async def test_renewal_riot_failure_does_not_predict_from_stale_cache(self):
        old = self.live_cache(age=main.LIVE_TTL + 1)
        self.riot.active_game.side_effect = main.RiotError(503, "fixture spectator unavailable")
        with patch.object(main.model, "pregame_prediction") as predict:
            await self.request("POST", f"/api/live/{PUUID}/odds", 502, json=role_body(old))
            predict.assert_not_called()
        self.starts.assert_not_called()

    async def test_non_solo_live_queues_never_call_the_model(self):
        with patch.object(main.model, "pregame_prediction") as predict:
            for queue in (440, 400, 450, 1700, None):
                game = spectator_fixture()
                game["gameQueueConfigId"] = queue
                self.live_cache(game)
                with self.subTest(queue=queue):
                    result = await self.request("POST", f"/api/live/{PUUID}/odds", json=role_body(game))
                    self.assertFalse(result["ready"])
                    self.assertIn("solo", result["reason"])
            predict.assert_not_called()

    async def test_request_must_be_roles_contract_with_exactly_ten_complete_slots(self):
        game = self.live_cache()
        valid = role_body(game)
        cases = [{}, {"players": valid["roles"]}, {"roles": []}, {"roles": valid["roles"][:9]},
                 {"roles": valid["roles"] + [valid["roles"][0]]}, {"roles": [{}] * 10}]
        for body in cases:
            with self.subTest(body=body):
                await self.request("POST", f"/api/live/{PUUID}/odds", 422, json=body)

    async def test_fabricated_champion_wrong_team_and_duplicate_lineup_slots_are_rejected(self):
        game = self.live_cache()
        cases = []
        for key, value in (("champion_id", 99999), ("team", 999), ("team", 200)):
            body = role_body(game)
            body["roles"][0][key] = value
            cases.append(body)
        duplicate = role_body(game)
        duplicate["roles"][1] = duplicate["roles"][0].copy()
        cases.append(duplicate)
        with patch.object(main.model, "pregame_prediction") as predict:
            for body in cases:
                with self.subTest(body=body):
                    await self.request("POST", f"/api/live/{PUUID}/odds", 400, json=body)
            predict.assert_not_called()

    async def test_each_team_requires_each_canonical_role_exactly_once(self):
        game = self.live_cache()
        with patch.object(main.model, "pregame_prediction") as predict:
            for role in ("TOP", "SUPPORT", "MID", "UNKNOWN", "jungle", ""):
                body = role_body(game)
                body["roles"][1]["role"] = role
                with self.subTest(role=role):
                    await self.request("POST", f"/api/live/{PUUID}/odds", 400, json=body)
            predict.assert_not_called()

    async def test_zero_negative_and_noninteger_champions_are_validation_errors(self):
        game = self.live_cache()
        for champion in (0, -1, 1.5, None, "NaN"):
            body = role_body(game)
            body["roles"][0]["champion_id"] = champion
            with self.subTest(champion=champion):
                await self.request("POST", f"/api/live/{PUUID}/odds", 422, json=body)

    async def test_duplicate_or_incomplete_actual_spectator_lineup_cannot_be_filled_from_body(self):
        game = spectator_fixture()
        valid = role_body(game)
        duplicate = copy.deepcopy(game)
        duplicate["participants"][1] = duplicate["participants"][0].copy()
        incomplete = copy.deepcopy(game)
        incomplete["participants"].pop()
        with patch.object(main.model, "pregame_prediction") as predict:
            for cached in (duplicate, incomplete):
                self.live_cache(cached)
                await self.request("POST", f"/api/live/{PUUID}/odds", 400, json=valid)
            predict.assert_not_called()

    async def test_extra_spectator_participant_is_not_silently_deduplicated_into_a_ten_player_roster(self):
        game = spectator_fixture()
        body = role_body(game)
        game["participants"].append(game["participants"][0].copy())
        self.live_cache(game)
        with patch.object(main.model, "pregame_prediction", return_value={"ready": True}) as predict:
            await self.request("POST", f"/api/live/{PUUID}/odds", 400, json=body)
            predict.assert_not_called()

    async def test_same_champion_on_opposing_teams_is_not_a_duplicate_identity(self):
        game = spectator_fixture()
        game["participants"][5]["championId"] = game["participants"][0]["championId"]
        self.live_cache(game)
        with patch.object(main.model, "pregame_prediction", return_value={"ready": False}) as predict:
            await self.request("POST", f"/api/live/{PUUID}/odds", json=role_body(game))
        self.assertEqual(len(predict.call_args.args[1]), 10)


class LiveJungleHistoryEndpoints(FeatureFixture):
    def jungle_game(self, mid, start, role="JUNGLE", queue=420, duration=1800, cached=True, legacy=False):
        match = test_data.match_fixture(mid, PUUID)
        match["info"].update(gameStartTimestamp=start, queueId=queue, gameDuration=duration)
        match["info"]["participants"][0].update(teamPosition=role, participantId=42)
        raw = test_data.timeline_fixture(match)
        raw["info"]["frames"][2]["participantFrames"]["42"]["position"] = {"x": 7700, "y": 4100}
        self.save_match(match, raw if cached else None)
        if legacy:
            with closing(self.connect()) as db:
                dg = main.store.digest(db, mid)
                assert isinstance(dg, dict), "Expected a fixture digest before retiring it"
                db.execute("UPDATE timeline_digest SET data = ? WHERE match_id = ?",
                           (zlib.compress(json.dumps({**dg, "v": 1}).encode()), mid))
                db.commit()

    async def live_result(self):
        game = self.live_cache(spectator_fixture(hidden=True))
        # Champion/history is deliberately suggestive, but never a current-role assertion.
        game["participants"][0].update(spell1Id=11, spell2Id=4)
        return await self.request("GET", f"/api/live/{PUUID}")

    async def test_two_cached_jungle_games_are_not_enough(self):
        for i in range(2):
            self.jungle_game(f"PAST{i}", START - 1000 * (i + 1))
        result = await self.live_result()
        me = next(p for p in result["players"] if p["puuid"] == PUUID)
        self.assertIsNone(me["jungle"])
        self.assertNotIn("role", me)
        self.assertNotIn("position", me)
        self.riot.timeline.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_only_three_past_cached_solo_nonremake_jungle_games_contribute(self):
        for i in range(3):
            self.jungle_game(f"PAST{i}", START - 1000 * (i + 1))
        self.jungle_game("EQUAL", START)
        self.jungle_game("FUTURE", START + 1000)
        self.jungle_game("OFFROLE", START - 1000, role="TOP")
        self.jungle_game("FLEX", START - 1000, queue=440)
        self.jungle_game("REMAKE", START - 1000, duration=120)
        self.jungle_game("UNCACHED", START - 1000, cached=False)
        self.jungle_game("LEGACY", START - 1000, legacy=True)
        result = await self.live_result()
        me = next(p for p in result["players"] if p["puuid"] == PUUID)
        self.assertEqual(me["jungle"]["games"], 3)
        self.assertEqual(me["jungle"]["early_jungle_proxy"]["observed"], 3)
        self.assertEqual(me["jungle"]["start"], {"red": 3, "blue": 0})
        self.assertIn("proxy", me["jungle"]["early_jungle_proxy"]["label"])
        self.assertTrue(all("role" not in p and "position" not in p for p in result["players"]))
        hidden = next(p for p in result["players"] if p.get("hidden"))
        self.assertIsNone(hidden["puuid"])
        self.assertNotIn("jungle", hidden)
        self.riot.mastery.assert_not_awaited()
        self.riot.account_by_puuid.assert_not_awaited()
        self.riot.timeline.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_jungle_history_is_bounded_to_ten_latest_prior_role_games(self):
        for i in range(12):
            self.jungle_game(f"PAST{i:02}", START - 1000 * (i + 1))
        result = await self.live_result()
        self.assertEqual(next(p for p in result["players"] if p["puuid"] == PUUID)["jungle"]["games"], 10)

    async def test_missing_live_start_uses_now_not_future_cached_games(self):
        now = START / 1000
        for i in range(3):
            self.jungle_game(f"PAST{i}", START - 1000 * (i + 1))
        self.jungle_game("FUTURE", START + 1000)
        game = spectator_fixture()
        game["gameStartTime"] = 0
        with patch.object(main.time, "time", return_value=now):
            self.live_cache(game)
            result = await self.request("GET", f"/api/live/{PUUID}")
        self.assertEqual(next(p for p in result["players"] if p["puuid"] == PUUID)["jungle"]["games"], 3)


class ClashEndpoints(FeatureFixture):
    def clash_team(self, players=None):
        team = {"id": "fixture-team", "name": "Fixture Team", "abbreviation": "FIX", "tier": 2,
                "players": players if players is not None else [{"puuid": PUUID, "position": "MID"}]}
        self.riot.clash_team.side_effect = None
        self.riot.clash_team.return_value = team
        return team

    def configure_profile(self):
        self.riot.account_by_puuid.side_effect = None
        self.riot.account_by_puuid.return_value = {"gameName": "Fresh", "tagLine": "TEST"}
        self.riot.league_entries.side_effect = None
        self.riot.league_entries.return_value = [
            {"queueType": "RANKED_FLEX_SR", "tier": "CHALLENGER"},
            {"queueType": "RANKED_SOLO_5x5", "tier": "PLATINUM", "rank": "III", "leaguePoints": 42}]
        self.riot.mastery.side_effect = None
        self.riot.mastery.return_value = [{"championId": 77, "championLevel": 10, "championPoints": 12345, "lastPlayTime": 123}]

    async def test_default_clash_uses_cached_profiles_and_does_not_sync_history_or_mastery(self):
        self.clash_team()
        result = await self.request("GET", "/api/clash/euw1/fixture-team")
        self.assertEqual(result["team"], {"id": "fixture-team", "name": "Fixture Team", "tag": "FIX", "tier": 2})
        self.assertEqual(result["members"][0]["riot_id"], "Fixture#ONE")
        self.assertEqual(result["members"][0]["role"], "MIDDLE")
        self.assertTrue(result["pending"])
        self.riot.clash_team.assert_awaited_once_with("euw1", "fixture-team")
        self.riot.account_by_puuid.assert_not_awaited()
        self.riot.mastery.assert_not_awaited()
        self.riot.background.assert_not_called()
        self.starts.assert_not_called()

    async def test_explicit_sync_refreshes_real_roster_mastery_and_starts_bounded_match_only_history(self):
        self.clash_team()
        self.configure_profile()
        result = await self.request("GET", "/api/clash/euw1/fixture-team?sync=1")
        self.riot.account_by_puuid.assert_awaited_once_with("euw1", PUUID)
        self.riot.league_entries.assert_awaited_once_with("euw1", PUUID)
        self.riot.mastery.assert_awaited_once_with("euw1", PUUID)
        self.riot.background.assert_called_once_with(main.HISTORY_SHARE)
        self.starts.assert_called_once_with(self.background, "euw1", PUUID, "PLATINUM",
                                           main.history.last_n(main.scouting.RECENT_GAMES), replace=False, timelines=False)
        self.assertEqual(result["members"][0]["riot_id"], "Fresh#TEST")
        self.assertEqual(result["members"][0]["tier"], "PLATINUM")
        with closing(self.connect()) as db:
            player = main.store.get_player(db, PUUID)
            self.assertEqual((player["game_name"], player["tier"], player["lp"]), ("Fresh", "PLATINUM", 42))
            self.assertEqual(db.execute("SELECT champion_id, points FROM mastery WHERE puuid = ?", (PUUID,)).fetchone()[:], (77, 12345))
        self.riot.timeline.assert_not_awaited()

    async def test_sync_false_with_uncached_member_resolves_display_only_without_cache_writes(self):
        self.clash_team([{"puuid": "uncached", "position": "ADC"}])
        self.configure_profile()
        result = await self.request("GET", "/api/clash/euw1/fixture-team?sync=0")
        self.assertEqual(result["members"][0]["role"], "BOTTOM")
        self.assertEqual(result["members"][0]["riot_id"], "Fresh#TEST")
        with closing(self.connect()) as db:
            self.assertIsNone(main.store.get_player(db, "uncached"))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mastery").fetchone()[0], 0)
        self.riot.mastery.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_explicit_sync_for_five_members_uses_only_their_actual_puuids(self):
        who = [PUUID, "clash-1", "clash-2", "clash-3", "clash-4"]
        self.clash_team([{"puuid": p, "position": r} for p, r in zip(who, main.stats.ROLES)])
        self.configure_profile()
        await self.request("GET", "/api/clash/euw1/fixture-team?sync=1")
        self.assertEqual(self.riot.mastery.await_count, 5)
        self.assertEqual(self.starts.call_count, 5)
        self.assertEqual([c.args[2] for c in self.starts.call_args_list], who)
        self.assertTrue(all(c.kwargs == {"replace": False, "timelines": False} for c in self.starts.call_args_list))

    async def test_incomplete_legacy_roster_is_unresolved_not_a_fabricated_puuid_or_history(self):
        self.clash_team([{"puuid": PUUID, "position": "JUNGLE"},
                         {"summonerId": "legacy-summoner", "position": "SUPPORT"}, {"position": "FILL"}])
        self.configure_profile()
        result = await self.request("GET", "/api/clash/euw1/fixture-team?sync=1")
        self.assertEqual(len(result["members"]), 3)
        self.assertTrue(result["pending"])
        self.assertEqual([m["role"] for m in result["members"]], ["JUNGLE", "UTILITY", "UNKNOWN"])
        for member in result["members"][1:]:
            self.assertIsNone(member["puuid"])
            self.assertEqual((member["cached_games"], member["pool"], member["pockets"]), (0, [], []))
            self.assertTrue(member["pending"])
        self.starts.assert_called_once()
        self.assertEqual(self.starts.call_args.args[2], PUUID)
        self.riot.account_by_puuid.assert_awaited_once_with("euw1", PUUID)

    async def test_empty_or_missing_roster_returns_graceful_pending_report(self):
        for players in ([], None):
            team = self.clash_team([])
            if players is None:
                team.pop("players")
            with self.subTest(players=players):
                result = await self.request("GET", "/api/clash/euw1/fixture-team")
                self.assertEqual(result["members"], [])
                self.assertEqual(result["bans"], [])
                self.assertTrue(result["pending"])
        self.starts.assert_not_called()

    async def test_clash_invalid_platform_oversized_team_and_sync_value_fail_before_outbound_calls(self):
        for path, expected in (("/api/clash/invalid/fixture-team?sync=1", 400),
                               ("/api/clash/euw1/" + "x" * 129, 400),
                               ("/api/clash/euw1/fixture-team?sync=maybe", 422)):
            with self.subTest(path=path):
                await self.request("GET", path, expected)
        self.riot.clash_team.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_clash_rejects_oversized_riot_roster_instead_of_syncing_it(self):
        self.clash_team([{"puuid": f"member-{i}"} for i in range(6)])
        await self.request("GET", "/api/clash/euw1/fixture-team?sync=1", 502)
        self.riot.account_by_puuid.assert_not_awaited()
        self.starts.assert_not_called()

    async def test_clash_team_upstream_errors_are_not_session_authentication_errors(self):
        for upstream, expected in ((401, 502), (403, 502), (404, 404), (503, 502)):
            self.riot.clash_team.side_effect = main.RiotError(upstream, "fixture Riot failure")
            with self.subTest(upstream=upstream):
                await self.request("GET", "/api/clash/euw1/fixture-team", expected)
        self.starts.assert_not_called()

    async def test_clash_member_failure_is_graceful_but_rejected_api_keys_are_propagated(self):
        self.clash_team([{"puuid": "uncached", "position": "TOP"}])
        for upstream in (404, 503):
            self.riot.account_by_puuid.side_effect = main.RiotError(upstream, "fixture member failure")
            result = await self.request("GET", "/api/clash/euw1/fixture-team?sync=1")
            self.assertEqual(result["members"][0]["puuid"], "uncached")
            self.assertEqual(result["members"][0]["riot_id"], "Name unavailable")
            self.assertTrue(result["pending"])
        for upstream in (401, 403):
            self.riot.account_by_puuid.side_effect = main.RiotError(upstream, "fixture key rejected")
            await self.request("GET", "/api/clash/euw1/fixture-team?sync=1", 502)
        self.riot.mastery.assert_not_awaited()
        self.starts.assert_not_called()


class TrainingLifecycleContracts(FeatureFixture):
    async def training_harness(self, communicate=None, recent=False, timeout=False):
        actual_wait_for = asyncio.wait_for
        actual_sleep = asyncio.sleep
        communicating, between_rounds = asyncio.Event(), asyncio.Event()
        process = SimpleNamespace(returncode=None, kill=Mock(), wait=AsyncMock(return_value=-9))

        def kill():
            process.returncode = -9

        process.kill.side_effect = kill

        async def communication():
            communicating.set()
            if communicate == "success":
                process.returncode = 0
                return b"fixture trained", None
            await asyncio.Event().wait()

        process.communicate = AsyncMock(side_effect=communication)
        spawn = self.stack.enter_context(patch.object(main.asyncio, "create_subprocess_exec", AsyncMock(return_value=process)))
        self.stack.enter_context(patch.object(main.model, "load", return_value=(None, None, main.time.time() if recent else 0)))
        timeouts = []

        async def bounded_wait(awaitable, timeout=None):
            if timeout == 300:
                timeouts.append(timeout)
                return await actual_wait_for(awaitable, timeout=0.02 if timeout_test else timeout)
            return await actual_wait_for(awaitable, timeout=timeout)

        timeout_test = timeout
        self.stack.enter_context(patch.object(main.asyncio, "wait_for", side_effect=bounded_wait))

        async def sleep(seconds):
            if seconds == 120:
                await actual_sleep(0)
                return
            self.assertEqual(seconds, 600)
            between_rounds.set()
            await asyncio.Event().wait()

        self.stack.enter_context(patch.object(main.asyncio, "sleep", side_effect=sleep))
        task = asyncio.create_task(main.train_models())

        async def stop():
            task.cancel()
            try:
                await actual_wait_for(task, timeout=1)
            except asyncio.CancelledError:
                pass

        self.addAsyncCleanup(stop)
        await actual_wait_for((between_rounds if recent or communicate == "success" or timeout else communicating).wait(), timeout=1)
        return task, process, spawn, timeouts, actual_wait_for

    async def test_training_is_a_separate_process_using_only_fixture_database_and_bounded_communication(self):
        main.model._loaded["fixture-sentinel"] = (0, None)
        task, process, spawn, timeouts, _ = await self.training_harness(communicate="success")
        spawn.assert_awaited_once_with(main.sys.executable, str(Path(main.__file__).with_name("model.py")),
                                       "train", "--db", str(self.cache_path), stdout=asyncio.subprocess.PIPE,
                                       stderr=asyncio.subprocess.STDOUT)
        self.assertEqual(timeouts, [300])
        self.assertEqual(main.model._loaded, {})
        process.kill.assert_not_called()
        process.wait.assert_not_awaited()
        self.assertFalse(task.done())

    async def test_training_cancellation_kills_and_reaps_child_within_test_deadline(self):
        task, process, _, timeouts, wait_for = await self.training_harness()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await wait_for(task, timeout=1)
        self.assertEqual(timeouts, [300])
        process.kill.assert_called_once()
        process.wait.assert_awaited_once()
        self.assertEqual(process.returncode, -9)

    async def test_training_timeout_kills_and_reaps_child_without_waiting_five_minutes(self):
        with patch.object(main.log, "warning") as warning:
            _, process, _, timeouts, _ = await self.training_harness(timeout=True)
        self.assertEqual(timeouts, [300])
        process.kill.assert_called_once()
        process.wait.assert_awaited_once()
        warning.assert_called_once_with("model training round failed", exc_info=True)

    async def test_recent_models_skip_spawning_a_training_process(self):
        _, process, spawn, timeouts, _ = await self.training_harness(recent=True)
        spawn.assert_not_awaited()
        self.assertEqual(timeouts, [])
        process.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
