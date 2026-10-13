"""Thin async Riot API client with a sliding-window rate limiter."""
import asyncio
import copy
import os
import time
from collections import deque
from urllib.parse import quote

import httpx

from config import load_env

load_env()

# platform -> regional routing for match-v5 / account-v1
PLATFORMS = {
    "euw1": "europe", "eun1": "europe", "tr1": "europe", "ru": "europe", "me1": "europe",
    "na1": "americas", "br1": "americas", "la1": "americas", "la2": "americas",
    "kr": "asia", "jp1": "asia",
    "oc1": "sea", "sg2": "sea", "tw2": "sea", "vn2": "sea",
}


RIOT_HOSTS = frozenset(PLATFORMS) | frozenset(PLATFORMS.values())


class RiotError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


MARGIN = 0.9  # stay a little under Riot's limits (clock skew, in-flight requests)


class Bucket:
    """One rate-limited thing: an app limit on a host, or a method limit on a host.

    Each (count, seconds) window keeps its own deque of request times, so a check
    is O(windows) even when a window allows tens of thousands of calls.
    """

    def __init__(self, limits=()):
        self.windows = []  # [count, seconds, deque of monotonic timestamps]
        self.set_limits(limits)

    def set_limits(self, limits):
        limits = sorted(limits, key=lambda w: w[1])
        if [(c, p) for c, p, _ in self.windows] == limits:
            return
        old = {p: dq for _, p, dq in self.windows}
        longest = max(self.windows, key=lambda w: w[1])[2] if self.windows else deque()
        now = time.monotonic()
        self.windows = [[c, p, old.get(p) or deque(t for t in longest if now - t < p)] for c, p in limits]

    def sync_counts(self, counts, now):
        """Riot reports how many calls it has counted; never believe we made fewer."""
        for c, p, dq in self.windows:
            n = counts.get(p)
            while n is not None and len(dq) < n:
                dq.append(now)

    def wait(self, share, now):
        wait = 0.0
        for count, per, dq in self.windows:
            while dq and now - dq[0] >= per:
                dq.popleft()
            cap = max(1, int(count * MARGIN * share))
            if len(dq) >= cap:
                wait = max(wait, dq[len(dq) - cap] + per - now)
        return wait

    def take(self, now):
        for _, _, dq in self.windows:
            dq.append(now)


class RateLimiter:
    """App limit per routing host + method limit per (host, endpoint), learned from headers.

    Riot sends X-App-Rate-Limit / X-Method-Rate-Limit (and their -Count) on every
    response, so whatever key is configured, the limiter converges on its real
    limits after the first call. Until then the app bucket uses RIOT_RATE_LIMITS.

    `share` lets background work use only part of each window, so a player lookup
    never queues behind history syncs or the patch sampler.
    """

    def __init__(self, default_app_limits):
        self.default_app = default_app_limits
        self.buckets = {}

    def bucket(self, key):
        if key not in self.buckets:
            self.buckets[key] = Bucket(self.default_app if key[0] == "app" else ())
        return self.buckets[key]

    async def acquire(self, keys, share=1.0):
        buckets = [self.bucket(k) for k in keys]
        # check-and-take has no await in between, so no lock is needed
        while True:
            now = time.monotonic()
            wait = max(b.wait(share, now) for b in buckets)
            if wait <= 0:
                for b in buckets:
                    b.take(now)
                return
            await asyncio.sleep(wait + 0.01)

    def observe(self, host, method, headers):
        now = time.monotonic()
        for kind, key in (("App", ("app", host)), ("Method", ("method", host, method))):
            limits = headers.get(f"X-{kind}-Rate-Limit")
            if limits:
                b = self.bucket(key)
                b.set_limits(_parse_limits(limits))
                counts = headers.get(f"X-{kind}-Rate-Limit-Count")
                if counts:
                    b.sync_counts({p: c for c, p in _parse_limits(counts)}, now)


def _parse_limits(s):
    return [tuple(int(x) for x in part.split(":")) for part in s.split(",") if part]


class Riot:
    def __init__(self):
        key = os.environ.get("RIOT_API_KEY")
        if not key:
            raise RuntimeError("RIOT_API_KEY is not set (env or .env)")
        self.limiter = RateLimiter(_parse_limits(os.environ.get("RIOT_RATE_LIMITS", "20:1,100:120")))
        self.http = httpx.AsyncClient(headers={"X-Riot-Token": key}, timeout=20,
                                      limits=httpx.Limits(max_connections=60))
        self.share = 1.0

    def background(self, share=0.6):
        """A view of this client that only uses `share` of the rate limits."""
        bg = copy.copy(self)
        bg.share = share
        return bg

    async def get(self, host, path, method, params=None, allow_404=False):
        if host not in RIOT_HOSTS:
            raise RiotError(400, "Unknown Riot routing host")
        if not path.startswith("/"):
            raise RiotError(400, "Riot paths must start with /")
        url = f"https://{host}.api.riotgames.com{path}"
        for attempt in range(6):
            await self.limiter.acquire([("app", host), ("method", host, method)], self.share)
            try:
                r = await self.http.get(url, params=params)
            except httpx.TransportError:
                await asyncio.sleep(1 + attempt)
                continue
            self.limiter.observe(host, method, r.headers)
            if r.status_code == 429:
                await asyncio.sleep(float(r.headers.get("Retry-After", 1 + attempt)))
                continue
            if r.status_code >= 500:
                await asyncio.sleep(1 + attempt)
                continue
            if r.status_code == 404 and allow_404:
                return None
            if r.status_code != 200:
                raise RiotError(r.status_code, f"Riot API {r.status_code} on {path}")
            return r.json()
        raise RiotError(503, f"Riot API kept failing on {path}")

    # --- endpoints -------------------------------------------------------
    @staticmethod
    def _account_host(platform):
        region = PLATFORMS[platform]
        return "asia" if region == "sea" else region  # account-v1 has no sea host

    async def account(self, platform, name, tag):
        return await self.get(self._account_host(platform),
                              f"/riot/account/v1/accounts/by-riot-id/{quote(name)}/{quote(tag)}", "account-by-riot-id")

    async def account_by_puuid(self, platform, puuid):
        return await self.get(self._account_host(platform), f"/riot/account/v1/accounts/by-puuid/{puuid}",
                              "account-by-puuid")

    async def summoner(self, platform, puuid):
        """Profile icon + summoner level."""
        return await self.get(platform, f"/lol/summoner/v4/summoners/by-puuid/{puuid}", "summoner")

    async def league_entries(self, platform, puuid):
        return await self.get(platform, f"/lol/league/v4/entries/by-puuid/{puuid}", "league-by-puuid")

    async def mastery(self, platform, puuid):
        return await self.get(platform, f"/lol/champion-mastery/v4/champion-masteries/by-puuid/{puuid}", "mastery")

    async def active_game(self, platform, puuid):
        """The live game the player is in, or None."""
        return await self.get(platform, f"/lol/spectator/v5/active-games/by-summoner/{puuid}", "spectator",
                              allow_404=True)

    async def match_ids(self, platform, puuid, queue, count, start=0, start_time=None):
        """Newest-first match IDs; queue=None lists every queue."""
        params = {"start": start, "count": count}
        if queue is not None:
            params["queue"] = queue
        if start_time:
            params["startTime"] = int(start_time)  # epoch seconds
        return await self.get(PLATFORMS[platform], f"/lol/match/v5/matches/by-puuid/{puuid}/ids", "match-ids", params)

    async def match(self, platform, match_id):
        return await self.get(PLATFORMS[platform], f"/lol/match/v5/matches/{match_id}", "match")

    async def timeline(self, platform, match_id):
        return await self.get(PLATFORMS[platform], f"/lol/match/v5/matches/{match_id}/timeline", "timeline",
                              allow_404=True)

    async def tier_players(self, platform, tier, division, page=1):
        """PUUIDs of players in a solo-queue tier/division. league-exp covers apex tiers too (division I)."""
        if tier in ("MASTER", "GRANDMASTER", "CHALLENGER"):
            division = "I"
        entries = await self.get(platform, f"/lol/league-exp/v4/entries/RANKED_SOLO_5x5/{tier}/{division}",
                                 "league-exp", {"page": page})
        return [e["puuid"] for e in entries if e.get("puuid")]


DDRAGON = "https://ddragon.leagueoflegends.com"
DDRAGON_ATTEMPTS = 3


async def _ddragon_json(client, path):
    for attempt in range(DDRAGON_ATTEMPTS):
        try:
            response = await client.get(f"{DDRAGON}{path}")
            response.raise_for_status()
            return response.json()
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500 and e.response.status_code != 429:
                raise
            if attempt == DDRAGON_ATTEMPTS - 1:
                raise
            await asyncio.sleep(attempt + 1)
    raise RuntimeError("Data Dragon retry attempts must be positive")


async def load_champions():
    """(ddragon version, {championId: {name, icon}}) from Data Dragon."""
    async with httpx.AsyncClient(timeout=20) as c:
        version = (await _ddragon_json(c, "/api/versions.json"))[0]
        data = (await _ddragon_json(c, f"/cdn/{version}/data/en_US/champion.json"))["data"]
    return version, {
        int(ch["key"]): {"name": ch["name"], "icon": f"{DDRAGON}/cdn/{version}/img/champion/{ch['id']}.png"}
        for ch in data.values()
    }


async def load_spells(version):
    """{summonerSpellId: icon url} from Data Dragon."""
    async with httpx.AsyncClient(timeout=20) as c:
        data = (await _ddragon_json(c, f"/cdn/{version}/data/en_US/summoner.json"))["data"]
    return {int(sp["key"]): f"{DDRAGON}/cdn/{version}/img/spell/{sp['image']['full']}" for sp in data.values()}


LEGENDARY_GOLD = 1000  # finished items cost more than this; starters, potions and components less (or build into more)
# Rift items have 4-digit IDs. Other modes' items and copies (Arena's 66xxxx prismatics, 32xxxx, 77xxxx…) have six,
# and Data Dragon flags some of them as on the Rift (map 11) anyway.
RIFT_ITEM_IDS = range(1, 10000)


async def load_items(version):
    """Names and classification for Rift builds, plus purchase availability for the dice box.

    `completed`: a finished, non-boots item (nothing builds out of it). `boots`: upgraded boots (tier 3 too,
    e.g. Gunmetal Greaves, which Data Dragon doesn't tag as boots).
    `support`: a finished support quest item, e.g. Bloodsong (Data Dragon prices those at 400)."""
    async with httpx.AsyncClient(timeout=20) as c:
        data = (await _ddragon_json(c, f"/cdn/{version}/data/en_US/item.json"))["data"]
    gold_income = lambda it: "GoldPer" in it.get("tags", [])
    tagged_boots = {k for k, it in data.items() if "Boots" in it.get("tags", [])}
    support = {int(k) for parent in data.values() if gold_income(parent) for k in parent.get("into") or []
               if k in data and gold_income(data[k]) and not data[k].get("into")}
    items = {}
    for key, it in data.items():
        if not it.get("maps", {}).get("11"):
            continue
        tags = set(it.get("tags", []))
        gold = it.get("gold", {}).get("total", 0)
        boots = ("Boots" in tags or bool(tagged_boots & set(it.get("from", [])))) and gold > 300  # not plain Boots
        completed = (not boots and not it.get("into") and gold >= LEGENDARY_GOLD
                     and not tags & {"Consumable", "Trinket", "Jungle"})
        buyable = (it.get("gold", {}).get("purchasable", False) and it.get("inStore", True)
                   and not it.get("hideFromAll") and not it.get("requiredChampion") and not it.get("requiredAlly"))
        items[int(key)] = {"name": it["name"], "boots": boots, "support": int(key) in support, "completed": completed,
                           "random_eligible": bool(buyable and (boots or completed) and int(key) not in support
                                                   and int(key) in RIFT_ITEM_IDS)}
    return items


async def load_runes(version):
    """{id: {name, icon}} for every rune tree and rune (keystones included)."""
    async with httpx.AsyncClient(timeout=20) as c:
        trees = await _ddragon_json(c, f"/cdn/{version}/data/en_US/runesReforged.json")
    runes = {}
    for tree in trees:
        runes[tree["id"]] = {"name": tree["name"], "icon": f"{DDRAGON}/cdn/img/{tree['icon']}"}
        for slot in tree["slots"]:
            for rune in slot["runes"]:
                runes[rune["id"]] = {"name": rune["name"], "icon": f"{DDRAGON}/cdn/img/{rune['icon']}"}
    return runes


def profile_icon(version, icon_id):
    return f"{DDRAGON}/cdn/{version}/img/profileicon/{icon_id}.png"
