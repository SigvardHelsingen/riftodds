import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

import config

with patch.object(config, "load_env"):
    import riot

HTTP_CLIENT = httpx.AsyncClient
DUMMY_KEY = "test-only-not-a-real-key"


class ClashClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.status = 200
        self.payload = {"id": "team-id", "players": [{"puuid": "modern-puuid"}, {"summonerId": "legacy-id"}]}

        def respond(request):
            self.requests.append(request)
            return httpx.Response(self.status, json=self.payload)

        self.http = HTTP_CLIENT(transport=httpx.MockTransport(respond),
                                headers={"X-Riot-Token": DUMMY_KEY}, trust_env=False)
        with patch.dict(os.environ, {"RIOT_API_KEY": DUMMY_KEY, "RIOT_RATE_LIMITS": "20:1,100:120"}), patch.object(riot.httpx, "AsyncClient", return_value=self.http):
            self.client = riot.Riot()

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_team_id_is_quoted_as_one_path_segment(self):
        with patch.object(self.client, "get", new_callable=AsyncMock, return_value=self.payload) as get:
            for team_id, encoded in (("team/id?# %é", "team%2Fid%3F%23%20%25%C3%A9"), (123, "123")):
                with self.subTest(team_id=team_id):
                    self.assertIs(await self.client.clash_team("euw1", team_id), self.payload)
                    get.assert_awaited_with("euw1", f"/lol/clash/v1/teams/{encoded}", "clash-team")

    async def test_players_uses_modern_by_puuid_and_quotes_the_id(self):
        payload = [{"puuid": "puu/id?# %é", "teamId": "team-id", "position": "MIDDLE"}]
        with patch.object(self.client, "get", new_callable=AsyncMock, return_value=payload) as get:
            self.assertIs(await self.client.clash_players("na1", "puu/id?# %é"), payload)
            get.assert_awaited_once_with("na1", "/lol/clash/v1/players/by-puuid/puu%2Fid%3F%23%20%25%C3%A9", "clash-players")

    async def test_platform_routing_auth_and_unmodified_dtos(self):
        self.assertEqual(await self.client.clash_team("na1", "team-id"), self.payload)
        request = self.requests[-1]
        self.assertEqual(request.url.host, "na1.api.riotgames.com")
        self.assertEqual(request.url.path, "/lol/clash/v1/teams/team-id")
        self.assertEqual(request.headers["X-Riot-Token"], DUMMY_KEY)
        self.payload = [{"puuid": "modern-puuid", "teamId": "team-id", "position": "MIDDLE"}]
        self.assertEqual(await self.client.clash_players("na1", "modern-puuid"), self.payload)
        request = self.requests[-1]
        self.assertEqual(request.url.host, "na1.api.riotgames.com")
        self.assertEqual(request.url.path, "/lol/clash/v1/players/by-puuid/modern-puuid")

    async def test_quoted_ids_cannot_add_query_fragment_or_path_segments(self):
        await self.client.clash_team("euw1", "team/id?# %é")
        await self.client.clash_players("euw1", "puu/id?# %é")
        self.assertEqual([request.url.raw_path for request in self.requests], [
            b"/lol/clash/v1/teams/team%2Fid%3F%23%20%25%C3%A9",
            b"/lol/clash/v1/players/by-puuid/puu%2Fid%3F%23%20%25%C3%A9",
        ])
        self.assertTrue(all(request.url.host == "euw1.api.riotgames.com" and not request.url.query
                            and not request.url.fragment for request in self.requests))

    async def test_clash_methods_use_existing_limiter_with_distinct_endpoint_keys(self):
        self.client.limiter.acquire = AsyncMock()
        await self.client.clash_team("euw1", "team-id")
        await self.client.clash_players("euw1", "modern-puuid")
        self.assertEqual(self.client.limiter.acquire.await_count, 2)
        self.client.limiter.acquire.assert_any_await([("app", "euw1"), ("method", "euw1", "clash-team")], 1.0)
        self.client.limiter.acquire.assert_any_await([("app", "euw1"), ("method", "euw1", "clash-players")], 1.0)

    async def test_invalid_host_is_rejected_before_transport_or_limiter(self):
        self.client.limiter.acquire = AsyncMock()
        for method, identifier in ((self.client.clash_team, "team-id"), (self.client.clash_players, "modern-puuid")):
            with self.assertRaises(riot.RiotError) as error:
                await method("euw1@attacker.invalid", identifier)
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.requests, [])
        self.client.limiter.acquire.assert_not_awaited()

    async def test_errors_are_left_to_the_request_handler(self):
        self.status = 404
        for method, identifier in ((self.client.clash_team, "missing-team"), (self.client.clash_players, "missing-puuid")):
            with self.assertRaises(riot.RiotError) as error:
                await method("euw1", identifier)
            self.assertEqual(error.exception.status, 404)
        self.assertEqual(len(self.requests), 2)
