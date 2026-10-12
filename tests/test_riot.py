import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

import config

with patch.object(config, "load_env"):
    import riot

HTTP_CLIENT = httpx.AsyncClient
DUMMY_KEY = "test-only-not-a-real-key"


class RiotTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.status = 200

        def respond(request):
            self.requests.append(request)
            return httpx.Response(self.status, json={"ok": True})

        self.http = HTTP_CLIENT(transport=httpx.MockTransport(respond), headers={"X-Riot-Token": DUMMY_KEY}, trust_env=False)
        with patch.dict(os.environ, {"RIOT_API_KEY": DUMMY_KEY, "RIOT_RATE_LIMITS": "20:1,100:120"}), patch.object(riot.httpx, "AsyncClient", return_value=self.http):
            self.client = riot.Riot()

    async def asyncTearDown(self):
        await self.http.aclose()

    async def test_invalid_hosts_are_rejected_before_limiter_and_transport(self):
        self.client.limiter.acquire = AsyncMock()
        for host in ("attacker.invalid/", "euw1/", "euw1@attacker.invalid/", "127.0.0.1:8443/", "euw1.attacker.invalid", "EUW1", "unknown"):
            with self.subTest(host=host), self.assertRaises(riot.RiotError) as error:
                await self.client.get(host, "/test", "test")
            self.assertEqual(error.exception.status, 400)
        self.client.limiter.acquire.assert_not_awaited()
        self.assertEqual(self.requests, [])

    async def test_paths_cannot_change_the_allowed_host(self):
        self.client.limiter.acquire = AsyncMock()
        for path in ("@attacker.invalid/", ":8443/", "https://attacker.invalid/", ""):
            with self.subTest(path=path), self.assertRaises(riot.RiotError) as error:
                await self.client.get("euw1", path, "test")
            self.assertEqual(error.exception.status, 400)
        self.client.limiter.acquire.assert_not_awaited()
        self.assertEqual(self.requests, [])

    async def test_all_platform_and_regional_hosts_are_allowed(self):
        for host in sorted(set(riot.PLATFORMS) | set(riot.PLATFORMS.values())):
            self.assertEqual(await self.client.get(host, "/test", "test"), {"ok": True})
            request = self.requests[-1]
            self.assertEqual(request.url.host, f"{host}.api.riotgames.com")
            self.assertEqual(request.headers["X-Riot-Token"], DUMMY_KEY)

    async def test_key_rejection_is_not_retried(self):
        self.status = 403
        with self.assertRaises(riot.RiotError) as error:
            await self.client.get("euw1", "/test", "test")
        self.assertEqual(error.exception.status, 403)
        self.assertEqual(len(self.requests), 1)

    async def test_optional_404_returns_none(self):
        self.status = 404
        self.assertIsNone(await self.client.get("euw1", "/test", "test", allow_404=True))


class DataDragonTests(unittest.IsolatedAsyncioTestCase):
    def client_factory(self, handler):
        def factory(**kwargs):
            return HTTP_CLIENT(transport=httpx.MockTransport(handler), trust_env=False, **kwargs)
        return factory

    async def test_champions_retry_transient_status_and_parse_success(self):
        requests = []
        versions_calls = 0

        def respond(request):
            nonlocal versions_calls
            requests.append(request)
            if request.url.path == "/api/versions.json":
                versions_calls += 1
                if versions_calls < 3:
                    return httpx.Response(503, text="not JSON")
                return httpx.Response(200, json=["26.20.1"])
            return httpx.Response(200, json={"data": {"Annie": {"key": "1", "name": "Annie", "id": "Annie"}}})

        with patch.object(riot.httpx, "AsyncClient", side_effect=self.client_factory(respond)), patch.object(riot.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            version, champions = await riot.load_champions()
        self.assertEqual(version, "26.20.1")
        self.assertEqual(champions[1]["name"], "Annie")
        self.assertEqual(len(requests), 4)
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [1, 2])
        self.assertTrue(all("X-Riot-Token" not in request.headers for request in requests))

    async def test_persistent_failure_has_bounded_retries(self):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(503, text="not JSON")

        with patch.object(riot.httpx, "AsyncClient", side_effect=self.client_factory(respond)), patch.object(riot.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            with self.assertRaises(httpx.HTTPStatusError) as error:
                await riot.load_spells("26.20.1")
        self.assertEqual(error.exception.response.status_code, 503)
        self.assertEqual(len(requests), riot.DDRAGON_ATTEMPTS)
        self.assertEqual(sleep.await_count, riot.DDRAGON_ATTEMPTS - 1)

    async def test_nonretryable_status_raises_before_json_parsing(self):
        requests = []

        def respond(request):
            requests.append(request)
            return httpx.Response(404, text="not JSON")

        with patch.object(riot.httpx, "AsyncClient", side_effect=self.client_factory(respond)), patch.object(riot.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            with self.assertRaises(httpx.HTTPStatusError) as error:
                await riot.load_champions()
        self.assertEqual(error.exception.response.status_code, 404)
        self.assertEqual(len(requests), 1)
        sleep.assert_not_awaited()

    async def ddragon(self, payload, load):
        with patch.object(riot.httpx, "AsyncClient", side_effect=self.client_factory(lambda request: httpx.Response(200, json=payload))):
            return await load("26.20.1")

    async def test_items_are_classified_for_builds(self):
        sr = {"11": True}
        items = await self.ddragon({"data": {
            "1001": {"name": "Boots", "tags": ["Boots"], "gold": {"total": 300}, "into": ["3006"], "maps": sr},
            "3006": {"name": "Berserker's Greaves", "tags": ["Boots", "AttackSpeed"], "gold": {"total": 1100}, "maps": sr},
            "3031": {"name": "Infinity Edge", "tags": ["Damage"], "gold": {"total": 3450}, "maps": sr},
            "1038": {"name": "B. F. Sword", "tags": ["Damage"], "gold": {"total": 1300}, "into": ["3031"], "maps": sr},
            "1055": {"name": "Doran's Blade", "tags": ["Damage"], "gold": {"total": 450}, "maps": sr},
            "2003": {"name": "Health Potion", "tags": ["Consumable"], "gold": {"total": 50}, "maps": sr},
            "2055": {"name": "Control Ward", "tags": ["Consumable", "Vision"], "gold": {"total": 1075}, "maps": sr},
            "3340": {"name": "Stealth Ward", "tags": ["Trinket"], "gold": {"total": 0}, "maps": sr},
            "3867": {"name": "Bounty of Worlds", "tags": ["GoldPer"], "gold": {"total": 400}, "into": ["3877"], "maps": sr},
            "3877": {"name": "Bloodsong", "tags": ["GoldPer", "Health"], "gold": {"total": 400}, "maps": sr},
            "447100": {"name": "Arena-only", "tags": [], "gold": {"total": 3000}, "maps": {"11": False, "30": True}},
        }}, riot.load_items)
        self.assertEqual({i for i, it in items.items() if it["completed"]}, {3031})
        self.assertEqual({i for i, it in items.items() if it["boots"]}, {3006})
        self.assertEqual({i for i, it in items.items() if it["support"]}, {3877})  # priced 400, but a finished item
        self.assertNotIn(447100, items)
        self.assertEqual(items[3031]["name"], "Infinity Edge")

    async def test_runes_flatten_trees_and_keystones(self):
        runes = await self.ddragon([{"id": 8000, "name": "Precision", "icon": "perk-images/Styles/7201_Precision.png", "slots": [
            {"runes": [{"id": 8010, "name": "Conqueror", "icon": "perk-images/Styles/Precision/Conqueror/Conqueror.png"}]},
            {"runes": [{"id": 9111, "name": "Triumph", "icon": "perk-images/Styles/Precision/Triumph.png"}]}]}], riot.load_runes)
        self.assertEqual(set(runes), {8000, 8010, 9111})
        self.assertEqual(runes[8010], {"name": "Conqueror",
                                       "icon": f"{riot.DDRAGON}/cdn/img/perk-images/Styles/Precision/Conqueror/Conqueror.png"})

    async def test_spells_retry_transport_failure(self):
        requests = []

        def respond(request):
            requests.append(request)
            if len(requests) == 1:
                raise httpx.ConnectError("simulated outage", request=request)
            return httpx.Response(200, json={"data": {"Flash": {"key": "4", "image": {"full": "SummonerFlash.png"}}}})

        with patch.object(riot.httpx, "AsyncClient", side_effect=self.client_factory(respond)), patch.object(riot.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            spells = await riot.load_spells("26.20.1")
        self.assertEqual(spells[4], f"{riot.DDRAGON}/cdn/26.20.1/img/spell/SummonerFlash.png")
        self.assertEqual(len(requests), 2)
        sleep.assert_awaited_once_with(1)
