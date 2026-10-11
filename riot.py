"""Thin async Riot API client with a sliding-window rate limiter."""
import asyncio
import copy
import os
import time
from collections import deque
from pathlib import Path
from urllib.parse import quote

import httpx

# platform -> regional routing for match-v5 / account-v1
PLATFORMS = {
    "euw1": "europe", "eun1": "europe", "tr1": "europe", "ru": "europe", "me1": "europe",
    "na1": "americas", "br1": "americas", "la1": "americas", "la2": "americas",
    "kr": "asia", "jp1": "asia",
    "oc1": "sea", "sg2": "sea", "tw2": "sea", "vn2": "sea",
}


def _load_env():
    env = Path(__file__).with_name(".env")
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()


class RiotError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


class RateLimiter:
    """Enforces several (count, seconds) windows at once. Defaults match a dev key.

    `share` lets background work use only part of each window, so a player
    lookup never queues behind the patch sampler.
    """

    def __init__(self, limits):
        self.limits = limits
        self.calls = deque()

    def _wait(self, share):
        now = time.monotonic()
        longest = max(per for _, per in self.limits)
        while self.calls and now - self.calls[0] >= longest:
            self.calls.popleft()
        wait = 0.0
        for count, per in self.limits:
            cap = max(1, int(count * share))
            window = [t for t in self.calls if now - t < per]
            if len(window) >= cap:
                wait = max(wait, window[len(window) - cap] + per - now)
        return wait

    async def acquire(self, share=1.0):
        # check-and-append has no await in between, so no lock is needed
        while (wait := self._wait(share)) > 0:
            await asyncio.sleep(wait + 0.05)
        self.calls.append(time.monotonic())


def _parse_limits(s):
    return [tuple(int(x) for x in part.split(":")) for part in s.split(",")]


class Riot:
    def __init__(self):
        key = os.environ.get("RIOT_API_KEY")
        if not key:
            raise RuntimeError("RIOT_API_KEY is not set (env or .env)")
        self.http = httpx.AsyncClient(headers={"X-Riot-Token": key}, timeout=20)
        self.limiter = RateLimiter(_parse_limits(os.environ.get("RIOT_RATE_LIMITS", "20:1,100:120")))
        self.share = 1.0

    def background(self, share=0.6):
        """A view of this client that only uses `share` of the rate limit."""
        bg = copy.copy(self)
        bg.share = share
        return bg

    async def get(self, host, path, params=None):
        url = f"https://{host}.api.riotgames.com{path}"
        for attempt in range(5):
            await self.limiter.acquire(self.share)
            r = await self.http.get(url, params=params)
            if r.status_code == 429:
                await asyncio.sleep(float(r.headers.get("Retry-After", 5)))
                continue
            if r.status_code >= 500:
                await asyncio.sleep(1 + attempt)
                continue
            if r.status_code != 200:
                raise RiotError(r.status_code, f"Riot API {r.status_code} on {path}")
            return r.json()
        raise RiotError(503, f"Riot API kept failing on {path}")

    # --- endpoints -------------------------------------------------------
    async def account(self, platform, name, tag):
        region = PLATFORMS[platform]
        host = "asia" if region == "sea" else region  # account-v1 has no sea host
        return await self.get(host, f"/riot/account/v1/accounts/by-riot-id/{quote(name)}/{quote(tag)}")

    async def league_entries(self, platform, puuid):
        return await self.get(platform, f"/lol/league/v4/entries/by-puuid/{puuid}")

    async def match_ids(self, platform, puuid, queue, count, start=0, start_time=None):
        params = {"queue": queue, "start": start, "count": count}
        if start_time:
            params["startTime"] = int(start_time)  # epoch seconds
        return await self.get(PLATFORMS[platform], f"/lol/match/v5/matches/by-puuid/{puuid}/ids", params)

    async def match(self, platform, match_id):
        return await self.get(PLATFORMS[platform], f"/lol/match/v5/matches/{match_id}")

    async def tier_players(self, platform, tier, division, page=1):
        """PUUIDs of players currently in a given solo-queue tier/division."""
        if tier in ("MASTER", "GRANDMASTER", "CHALLENGER"):
            data = await self.get(platform, f"/lol/league/v4/{tier.lower()}leagues/by-queue/RANKED_SOLO_5x5")
            entries = data.get("entries", [])
        else:
            entries = await self.get(platform, f"/lol/league/v4/entries/RANKED_SOLO_5x5/{tier}/{division}",
                                     {"page": page})
        return [e["puuid"] for e in entries if e.get("puuid")]


DDRAGON = "https://ddragon.leagueoflegends.com"


async def load_champions():
    """(ddragon version, {championId: {name, icon}}) from Data Dragon."""
    async with httpx.AsyncClient(timeout=20) as c:
        version = (await c.get(f"{DDRAGON}/api/versions.json")).json()[0]
        data = (await c.get(f"{DDRAGON}/cdn/{version}/data/en_US/champion.json")).json()["data"]
    return version, {
        int(ch["key"]): {"name": ch["name"], "icon": f"{DDRAGON}/cdn/{version}/img/champion/{ch['id']}.png"}
        for ch in data.values()
    }
