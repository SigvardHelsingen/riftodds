// Optional browser regression checks. All requests are fixtures; no running backend is needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const playwright = require("playwright");

const root = path.resolve(__dirname, "..");
const winrate = (games = 20, wins = 12) => ({ games, wins, wr: games ? wins / games : null, lo: 0.38, hi: 0.79 });
const champions = {
  1: { name: "Aurelion Sol", icon: "https://images.test/1.png" },
  2: { name: "Nunu & Willump", icon: "https://images.test/2.png" },
  3: { name: "Miss Fortune", icon: "https://images.test/3.png" },
};
const meta = {
  champions, spells: { 4: "https://images.test/flash.png" }, ddragon: "16.20.1",
  platforms: ["euw1", "na1"], tiers: ["EMERALD", "DIAMOND"], roles: ["MIDDLE", "BOTTOM"],
  items: { 3031: "Infinity Edge", 3072: "Bloodthirster", 3036: "Lord Dominik's Regards", 3046: "Phantom Dancer",
    6672: "Kraken Slayer", 3033: "Mortal Reminder", 3006: "Berserker's Greaves", 3877: "Bloodsong" },
  runes: { 8000: { name: "Precision", icon: "https://images.test/precision.png" }, 8010: { name: "Conqueror", icon: "https://images.test/conqueror.png" },
    8400: { name: "Resolve", icon: "https://images.test/resolve.png" } },
  queues: [["420", "Ranked Solo"], ["440", "Ranked Flex"], ["400", "Normal Draft"], ["480", "Swiftplay"]].map(([key, label]) => ({ key, label })),
  default_range: "20", ranges: [
    { key: "20", label: "Last 20 games", kind: "count" },
    { key: "season", label: "Whole season", kind: "time" },
  ],
};
const randomBuild = (index) => {
  const champion_id = index % 2 + 1;
  return { champion_id, champion: champions[champion_id], role: meta.roles[index % 2], version: meta.ddragon,
    items: [3006, 3031, 3072, 3036, 3046, 6672].map((id) => ({ id, name: meta.items[id], icon: `https://images.test/items/${id}.png`, boots: id === 3006 })) };
};
const me = { username: "a-very-long-member-username", account: {
  puuid: "player", platform: "euw1", game_name: "LongPlayerName", tag_line: "EUW12",
} };
const now = Date.now();
const rateRows = ["Early", "Late"].map((label) => ({ ...winrate(), label }));
const leads = {
  games_with_timeline: 20, rank_games: 100, lane: { ahead_share: 0.6, avg_diff: 420 },
  comeback: { you: winrate(), rank: winrate(100, 40) },
  close_out: { you: winrate(), rank: winrate(100, 60) },
  curve: ["1k–3k behind", "About even", "1k–3k ahead"].map((label) => ({ label, share: 0.3, you: winrate(), rank: winrate(100, 55) })),
};
// 30 games for the form chart; every 4th has no timeline (no lane gold)
const series = Array.from({ length: 30 }, (_, i) => ({
  match_id: `EUW1_${200 + i}`, position: "MIDDLE", game_start: now - (30 - i) * 7200000, win: i % 3 !== 0, champion_id: (i % 3) + 1, kills: 3 + (i % 5), deaths: 1 + (i % 4),
  assists: 5 + (i % 6), cs: 180 + i * 2, gold: 11000 + i * 50, damage: 20000 + i * 300, vision: 18 + (i % 7),
  duration: 1800 + (i % 5) * 60, team_kills: 25, lane_diff15: i % 4 === 0 ? null : i % 2 ? 600 : -400, team_diff15: null,
}));
const adminData = { days: 30, users: [
  { username: me.username, role: "admin", created: now / 1000 - 40 * 86400, last_seen: now / 1000 - 60, sessions: 2,
    account: "LongPlayerName#EUW12", counts: { login: 4, lookup: 12 } },
  { username: "bob", role: "member", created: now / 1000 - 9 * 86400, last_seen: null, sessions: 0, account: null, counts: {} },
], events: [
  { username: "bob", at: now / 1000 - 3600, kind: "lookup", detail: "AVeryLongRiotIdName#EUW12 (euw1) · This season (since 2026-01-08)" },
  { username: me.username, at: now / 1000 - 7200, kind: "login", detail: "" },
  { username: "bob", at: now / 1000 - 9000, kind: "login", detail: "" },
] };
const build = {
  champion_id: 1, role: "MIDDLE", patch: "16.20", tier: null, ...winrate(120, 66),
  core: [{ items: [3031, 3072, 3036], ...winrate(60, 36), share: 0.5 }, { items: [3031, 3046, 6672], ...winrate(20, 9), share: 0.17 }],
  boots: [{ item: 3006, ...winrate(80, 46), share: 0.67 }],
  support: [{ item: 3877, ...winrate(30, 17), share: 0.25 }],
  runes: [{ keystone: 8010, primary: 8000, secondary: 8400, ...winrate(90, 50), share: 0.75 }],
  spells: [{ spells: [4, 4], ...winrate(100, 56), share: 0.83 }],
  situational: [3046, 6672, 3033].map((item) => ({ item, ...winrate(15, 8), share: 0.12 })),
};
const picks = { patch: "16.20", tier: "EMERALD", roles: [{ role: "MIDDLE", share: 1, games: 2400, average: 0.5,
  picks: [1, 2, 3].map((champion_id) => ({ champion_id, ...winrate(120, 66), pick_share: 0.05, score: 0.54,
    you: champion_id === 1 ? winrate(6, 4) : winrate(0, 0), build: { ...build, champion_id } })) }] };
// recorded ranks: one from before the range (carried in), three inside it, ending at the current rank
const ranks = [["III", 70, 100], ["III", 95, 40], ["II", 18, 20], ["II", 42, 3]].map(([division, lp, hoursAgo], i) => ({
  at: Math.round((now - hoursAgo * 3600000) / 1000), tier: "EMERALD", division, lp, wins: 100 + i, losses: 80 }));
const data = {
  puuid: "player", series, ranks, profile: {
    name: "LongPlayerName", tag: "EUW12", platform: "euw1", tier: "EMERALD", division: "II",
    lp: 42, season_wins: 100, season_losses: 80, level: 250, icon: "https://images.test/profile.png", rank_checked: Math.round(now / 1000) - 300,
  },
  first_game: series[0].game_start, last_game: series.at(-1).game_start, games_analyzed: 30,
  sync: { running: false, phase: "done", error: null },
  overview: {
    record: winrate(), roles: [{ role: "MIDDLE", games: 20, share: 1, wr: 0.6, pool: { effective_pool: 2.5, top: [{ champion_id: 1 }] } }],
    momentum: {
      after_win: winrate(), after_loss: winrate(), after_2_losses: winrate(4, 2),
      sessions: 5, avg_session_len: 4, by_game_in_session: rateRows,
      swap_after_loss: { p: 0.4 }, swap_after_win: { p: 0.2 },
    },
    time_of_day: rateRows, duration: rateRows,
    conversion: [{ label: "First tower", yes: winrate(), no: winrate(8, 3) }],
  },
  vs_rank: { tier: "EMERALD", sample_matches: 100, rows: [1, 2, 3].map((champion_id) => ({
    champion_id, player: winrate(), baseline: winrate(100, 55), delta: 0.05, p_better: 0.7,
  })) },
  mastery: { by_champion: { 1: { points: 100000, level: 10 } }, pockets: [{ champion_id: 2, points: 20000, level: 4, last_play: now }] },
  leads,
  live: { queue: "Ranked Solo", champion_id: 1, started: now - 300000 },
};
const patch = {
  patch: "16.20", current_patch: "16.20", matches: 200, current_patch_games: 200,
  tiers: [{ tier: "EMERALD", matches: 200 }], blue_side: winrate(200, 110), avg_duration: 1900,
  objectives: [{ ...winrate(200, 140), label: "First tower" }, { ...winrate(200, 120), label: "First dragon" }],
  champions: [1, 2, 3].map((champion_id) => ({
    ...winrate(50, 30), champion_id, pick_rate: 0.25, ban_rate: 0.2, role: "MIDDLE", role_share: 1,
  })),
  leads: { games: 100, curve: rateRows.map((row) => ({ ...row, share: 0.5 })) },
  sampler: { status: "sampling", platform: "euw1", tier: "EMERALD", matches: 200, target: 10000 },
};
const pick = {
  role: "MIDDLE", games: 20, opp: null, games_vs_opp: 0,
  opponents: [{ champion_id: 2, games: 4 }],
  rows: [1, 2, 3].map((champion_id) => ({ champion_id, p_role: 1 / 3, p_vs: 1 / 3, games: 6, games_vs: 0, wr: winrate(), wr_vs: winrate(0, 0) })),
};
const matchRow = {
  match_id: "EUW1_123", champion_id: 1, spells: [4, 4], win: true, kills: 12, deaths: 3, assists: 9,
  kill_participation: 0.7, cs: 220, duration: 1900, gold: 14000, damage: 30000, vision: 20,
  opp_champ: 2, items: [1001, 1002, 1003, 1004, 1005, 1006, 1007], position: "MIDDLE", level: 18,
  lane_diff15: 1200, team_diff15: 2300, game_start: now - 3600000, queue: "Ranked Solo", placement: null,
};
// 20 games in one session, then one from days earlier on the second page
const soloRows = [matchRow, ...Array.from({ length: 19 }, (_, i) => ({ ...matchRow, match_id: `EUW1_1${i + 30}`, game_start: matchRow.game_start - (i + 1) * 2400000 })),
  { ...matchRow, match_id: "EUW1_122", win: false, game_start: now - 3 * 86400000 }];
const aramRow = { ...matchRow, match_id: "EUW1_124", queue: "ARAM", position: "", opp_champ: null, lane_diff15: null, team_diff15: null };
const arenaRow = { ...aramRow, match_id: "EUW1_125", queue: "Arena", placement: 3, cs: 0, kill_participation: null, duration: 1000, game_start: now - 900000 };
const mayhemRow = { ...aramRow, match_id: "EUW1_126", queue: "ARAM: Mayhem", win: false, game_start: now - 1800000 };
const historyRows = {
  "420": soloRows, "450": [aramRow], "1700": [arenaRow], "1710": [], "2400": [mayhemRow],
  all: [arenaRow, mayhemRow, aramRow, matchRow],
  ...Object.fromEntries([["440", "Ranked Flex"], ["400", "Normal Draft"], ["480", "Swiftplay"]].map(([key, queue], i) =>
    [key, [{ ...matchRow, match_id: `EUW1_14${i}`, queue }]])),
};
const [normalRow] = historyRows["400"], [swiftplayRow] = historyRows["480"], [flexRow] = historyRows["440"];
const historyPage = (queue, rows, next = null, error = null) => ({ queue, rows, total: null, next, error });
const matchPage = (q) => {
  const queue = q.get("queue"), rows = historyRows[queue] || [];
  const offset = +q.get("offset"), end = offset + +q.get("limit");
  return { ...historyPage(queue, rows.slice(offset, end), end < rows.length ? end : null), total: queue === "420" ? rows.length : null };
};
const detail = {
  platform: "euw1", teams: [100, 200].map((team_id) => ({
    team_id, win: team_id === 100, kills: 30, towers: 8, dragons: 3, barons: 1, gold15: 25000, bans: [1, 2, 3],
    players: Array.from({ length: 5 }, (_, i) => ({
      puuid: i === 0 ? "player" : `other-${team_id}-${i}`, champion_id: i % 3 + 1,
      riot_id: `LongPlayerName${i}#EUW12`, kills: 10, deaths: 3, assists: 8, cs: 220,
      damage: 30000, gold15: 5000, items: matchRow.items,
    })),
  })),
};
const aramDetail = {
  ...detail, queue: "ARAM", teams: detail.teams.map((team) => ({ ...team, towers: null, dragons: null, barons: null, gold15: null,
    bans: [], players: team.players.map((player, i) => ({ ...player, gold15: null,
      puuid: team.team_id === 100 && i === 0 ? "player" : `aram-${team.team_id}-${i}` })) })),
};
const mayhemDetail = { ...aramDetail, queue: "ARAM: Mayhem", teams: aramDetail.teams.map((team) => ({ ...team,
  players: team.players.map((player, i) => ({ ...player, puuid: team.team_id === 200 && i === 0 ? "player" : `mayhem-${team.team_id}-${i}` })) })) };
const arenaDetail = {
  platform: "euw1", queue: "Arena", teams: Array.from({ length: 8 }, (_, i) => ({
    team_id: i + 1, placement: i + 1, win: i < 4, kills: 20, towers: null, dragons: null, barons: null, gold15: null, bans: [],
    players: Array.from({ length: 2 }, (_, j) => ({
      ...detail.teams[0].players[j], puuid: i === 2 && j === 0 ? "player" : `arena-${i}-${j}`,
      riot_id: `ArenaPlayer${i}${j}#EUW`, cs: 0, gold15: null,
    })),
  })),
};
const matchDetails = { [aramRow.match_id]: aramDetail, [mayhemRow.match_id]: mayhemDetail, [arenaRow.match_id]: arenaDetail };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const live = {
  in_game: true, pending: 0, without_history: 0, form_games: 10, queue: "Ranked Solo", started: now,
  bans: [100, 200].flatMap((team) => [1, 2, 3].map((champion_id) => ({ team, champion_id }))),
  players: [100, 200].flatMap((team) => Array.from({ length: 5 }, (_, i) => ({
    team, champion_id: i % 3 + 1, riot_id: `LongPlayerName${i}#EUW12`, tier: "EMERALD", division: "II", lp: 42,
    is_me: team === 100 && i === 0, mastery_points: 100000, mastery_level: 10, form: winrate(),
    on_champ: winrate(), cached_games: 20, loading: false,
  }))),
};

async function fixturePage(browser, width, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: options.reducedMotion || "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => { errors.push(err.message); if (process.env.DEBUG) console.error(err); });
  const state = { authenticated: options.authenticated !== false, liveRequests: 0, pickAlphas: [], buildQueries: [], matchQueues: [], matchRequests: [], randomRequests: [] };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.host !== "rift.test" || url.pathname === "/favicon.ico" || /^\/static\/(favicon|apple-touch-icon)/.test(url.pathname)) {
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>' });
    }
    const files = { "/": ["static/index.html", "text/html"], "/static/app.js": ["static/app.js", "text/javascript"], "/static/style.css": ["static/style.css", "text/css"] };
    if (files[url.pathname]) {
      const [file, contentType] = files[url.pathname];
      return route.fulfill({ contentType, body: fs.readFileSync(path.join(root, file)) });
    }
    let body;
    let status = 200;
    if (url.pathname === "/api/login") { state.authenticated = true; body = { username: me.username }; }
    else if (url.pathname === "/api/logout") { state.authenticated = false; body = { ok: true }; }
    else if (!state.authenticated) { status = 401; body = { detail: "Not logged in" }; }
    else if (url.pathname === "/api/me") body = options.admin ? { ...me, role: "admin" } : { ...me, role: "member" };
    else if (url.pathname === "/api/admin/activity") {
      if (!options.admin) return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ detail: "Admins only." }) });
      body = adminData;
    }
    else if (url.pathname === "/api/meta") body = meta;
    else if (url.pathname === "/api/random-build") {
      const request = { index: state.randomRequests.length, method: route.request().method(), body: route.request().postDataJSON() };
      state.randomRequests.push(request);
      if (options.randomDelay) await new Promise((resolve) => setTimeout(resolve, options.randomDelay));
      const response = await options.randomResponder?.(request, state);
      status = response?.status ?? (options.randomError ? 503 : 200);
      body = response?.body ?? (options.randomError ? { detail: "Champion and item metadata is temporarily unavailable." } : randomBuild(request.index));
    }
    else if (url.pathname === "/api/patch") {
      if (options.patchDelay) await new Promise((resolve) => setTimeout(resolve, options.patchDelay));
      status = options.patchError ? 502 : 200;
      body = options.patchError ? { detail: "Upstream unavailable" } : options.patch || patch;
    }
    else if (url.pathname === "/api/player" || url.pathname.endsWith("/analysis")) body = options.data || data;
    else if (url.pathname.startsWith("/api/builds/")) {
      state.buildQueries.push(url.search);
      body = { ...build, champion_id: +url.pathname.split("/").pop() };
    }
    else if (url.pathname.endsWith("/picks")) body = picks;
    else if (url.pathname.endsWith("/matches")) {
      const q = url.searchParams;
      const request = { index: state.matchRequests.length, puuid: url.pathname.split("/")[3], queue: q.get("queue"),
        range: q.get("range"), offset: +q.get("offset"), limit: +q.get("limit") };
      state.matchQueues.push(request.queue);
      state.matchRequests.push(request);
      const response = await options.matchResponder?.(request, state);
      status = response?.status ?? 200;
      body = response?.body ?? matchPage(q);
    }
    else if (url.pathname.startsWith("/api/match/")) {
      const mid = url.pathname.split("/").pop();
      body = await options.detailResponder?.(mid, state) ?? matchDetails[mid] ?? detail;
    }
    else if (url.pathname.startsWith("/api/live/")) { state.liveRequests++; body = live; }
    else if (url.pathname === "/api/pick") {
      if (options.pickDelay) await new Promise((resolve) => setTimeout(resolve, options.pickDelay));
      if (options.pickError) return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: [{ msg: "Smoothing must be nonnegative" }] }) });
      state.pickAlphas.push(url.searchParams.get("alpha"));
      body = { ...pick, opp: url.searchParams.has("opp") ? +url.searchParams.get("opp") : null };
    }
    else if (url.pathname.startsWith("/api/sync/")) body = (options.data || data).sync;
    else throw new Error(`Unexpected fixture request: ${url.pathname}`);
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { context, page, errors, state };
}

async function noPageOverflow(page, label) {
  const size = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  if (size.content > size.viewport + 1) {
    console.error(await page.locator("body *").evaluateAll((elements) => elements.filter((el) => {
      const box = el.getBoundingClientRect();
      return (box.right > innerWidth + 1 || box.left < -1) && !el.closest(".table-scroll, .tabs");
    }).map((el) => ({ tag: el.tagName, class: el.className, text: el.textContent.slice(0, 60), right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width }))));
  }
  assert(size.content <= size.viewport + 1, `${label}: content ${size.content}px exceeds viewport ${size.viewport}px`);
}

async function assertRandomResult(page, index) {
  const result = randomBuild(index);
  assert.equal(await page.locator(".random-champion h3").textContent(), result.champion.name);
  assert.equal(await page.locator(".random-lane").textContent(), { MIDDLE: "Mid", BOTTOM: "Bot" }[result.role]);
  assert.equal(await page.locator(".random-champion > img").getAttribute("src"), result.champion.icon);
  assert.equal(await page.locator(".random-champion > img").getAttribute("alt"), `${result.champion.name} portrait`);
  assert.equal(await page.locator(".random-items > li").count(), 6, "Exactly six items, not an accumulating roll history");
  assert.deepEqual(await page.locator(".random-items > li > span").evaluateAll((names) => names.map((name) => name.firstChild.textContent)), result.items.map((item) => item.name));
  assert.deepEqual(await page.locator(".random-items img").evaluateAll((images) => images.map((image) => image.getAttribute("src"))), result.items.map((item) => item.icon));
  assert.equal(await page.locator(".random-items small").textContent(), "Boots");
  assert.equal(await page.locator("#random-roll > span").textContent(), "Reroll");
  assert.equal(await page.locator("#random-build").getAttribute("aria-busy"), "false");
  assert.equal(await page.locator("#random-status").getAttribute("role"), "status");
  assert.equal(await page.locator("#random-status").getAttribute("aria-live"), "polite");
  assert.equal(await page.locator("#random-note").count(), 0);
}

async function assertHistoryQueues(page) {
  assert.deepEqual(await page.locator(".mh-queues .chip").evaluateAll((chips) => chips.map((chip) => ({ key: chip.dataset.q, label: chip.textContent }))), meta.queues);
  assert.equal(await page.locator('.mh-queues .chip[data-q="all"], .mh-queues .chip[data-q="450"], .mh-queues .chip[data-q="2400"], .mh-queues .chip[data-q="1700"], .mh-queues .chip[data-q="1710"]').count(), 0, "Unsupported modes and All are removed");
}

async function checkWidth(browser, width) {
  const { context, page, errors, state } = await fixturePage(browser, width);
  try {
    await page.goto("http://rift.test/#/");
    await page.waitForSelector(".board");
    await noPageOverflow(page, `landing ${width}`);
    assert(await page.locator("#random-build").evaluate((card) => card.previousElementSibling.matches(".hero") && card.nextElementSibling.id === "patch-body"), "The dice card is after the hero and outside patch updates");
    assert.equal(await page.locator("#random-roll > span").textContent(), "Roll champion + build");
    await page.locator("#random-roll").click();
    await page.waitForSelector("#random-result:not([hidden])");
    await assertRandomResult(page, 0);
    await noPageOverflow(page, `random build ${width}`);
    await page.locator("#random-roll").click();
    await page.waitForFunction(() => document.querySelector(".random-champion h3")?.textContent === "Nunu & Willump" && !document.querySelector("#random-roll").disabled);
    await assertRandomResult(page, 1);
    assert.deepEqual(state.randomRequests, [{ index: 0, method: "POST", body: {} }, { index: 1, method: "POST", body: {} }]);
    await noPageOverflow(page, `random reroll ${width}`);
    await page.evaluate(() => { window.diceCard = document.querySelector("#random-build"); return loadPatch(); });
    assert(await page.locator("#random-build").evaluate((card) => card === window.diceCard), "Patch polling does not replace the dice card");
    await assertRandomResult(page, 1);
    assert.equal(state.randomRequests.length, 2);
    if (width <= 640) assert((await page.locator("#random-roll").boundingBox()).height >= 44, "The dice button has a usable tap target");
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.locator("#random-build").screenshot({ path: path.join(process.env.SCREENSHOTS, `random-build-${width}.png`) });
    }
    // a champion in the patch table opens its build underneath
    await page.locator(".champ-btn").first().click();
    await page.waitForSelector(".build-row .build-line");
    assert.equal(await page.locator(".champ-btn").first().getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".build-row .build-line").first().locator("img").count(), 3, "Core build shows three items");
    const fits = await page.locator(".build-slot").evaluate((el) => {
      const view = el.closest(".table-scroll").getBoundingClientRect();
      return [...el.querySelectorAll("*")].every((child) => child.getBoundingClientRect().right <= view.right + 1);
    });
    assert(fits, "The build stays inside the visible part of the scrolling table");
    await noPageOverflow(page, `landing build ${width}`);
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.locator(".build-row").screenshot({ path: path.join(process.env.SCREENSHOTS, `landing-build-${width}.png`) });
    }
    await page.locator(".champ-btn").first().click();
    assert.equal(await page.locator(".build-row").count(), 0, "Clicking again closes the build");
    // the champion search filters the table as you type, ignoring case and punctuation
    const champNames = () => page.locator("#champ-table .champ > span").evaluateAll((spans) => spans.map((span) => span.firstChild.textContent));
    await page.locator("#champ-search").fill("FORTUNE");
    assert.deepEqual(await champNames(), ["Miss Fortune"]);
    assert.equal(await page.locator("#champ-found").textContent(), "1 champion found");
    assert.equal(await page.locator("#show-all").count(), 0);
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.locator("#champ-table").locator("xpath=..").screenshot({ path: path.join(process.env.SCREENSHOTS, `champion-search-${width}.png`) });
    }
    await page.locator("#champ-search").fill("nunuwill");
    assert.deepEqual(await champNames(), ["Nunu & Willump"]);
    await page.evaluate(() => loadPatch());  // the 30 s refresh redraws the page
    assert(await page.locator("#champ-search").evaluate((input) => input === document.activeElement && input.selectionStart === 8), "Typing survives a refresh");
    assert.deepEqual(await champNames(), ["Nunu & Willump"]);
    await page.locator("#champ-search").pressSequentially("x");
    assert.match(await page.locator("#champ-table .empty").textContent(), /No champion matching “nunuwillx” has games/);
    await page.locator("#champ-search").fill("");
    assert.equal(await page.locator("#champ-table .champ-btn").count(), 3);
    await noPageOverflow(page, `champion search ${width}`);
    await page.locator(".search.big input").fill("LongPlayerName#EUW12");
    await page.locator(".search.big button").click();
    await page.waitForSelector(".player-head");
    await noPageOverflow(page, `champions ${width}`);
    assert.equal(await page.locator("#admin-link").isVisible(), false, "Members don't see the admin link");
    const hover = async (at) => {
      await page.locator(".trend-hit").scrollIntoViewIfNeeded();
      const box = await page.locator(".trend-hit").boundingBox();
      await page.mouse.move(box.x + box.width * at, box.y + box.height / 2);
    };
    // rank is the default view: recorded ranks as points, games along the bottom
    assert.equal(await page.locator(".trend-stats .chip.active").getAttribute("data-stat"), "rank");
    assert.equal(await page.locator("#trend .rank-dot").count(), 3, "Ranks recorded inside the range");
    assert.equal(await page.locator("#trend .dot").count(), 30, "Every game in the range sits along the bottom");
    // Emerald III 70 going into the range -> Emerald II 42 now: 30 to finish the division, then 42
    assert.match(await page.locator("#trend-figures").textContent(), /Current rankEmerald II42 LP.*\+72 LP/s);
    await hover(0.99);
    await page.waitForSelector(".trend-tip:not([hidden])");
    assert.match(await page.locator(".trend-tip").textContent(), /Emerald II · 42 LP.*\+24 LP since the last change/s);
    await noPageOverflow(page, `rank chart ${width}`);
    await page.locator("#trend-view").click();
    assert.equal(await page.locator("#trend .trend-table tbody tr").count(), 4);
    await page.locator("#trend-view").click();
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.waitForTimeout(1400);
      await hover(0.99);
      await page.locator("#trend").screenshot({ path: path.join(process.env.SCREENSHOTS, `rank-${width}.png`) });
    }
    // the per-game views are unchanged
    await page.locator('.trend-stats .chip[data-stat="kda"]').click();
    assert.equal(await page.locator("#trend .dot").count(), 30);
    await hover(0.5);
    await page.waitForSelector(".trend-tip:not([hidden])");
    assert.match(await page.locator(".trend-tip b").textContent(), /^\d+\.\d · \d+\/\d+\/\d+$/);
    await noPageOverflow(page, `chart ${width}`);
    await page.locator('.trend-stats .chip[data-stat="lane"]').click();
    assert.equal(await page.locator("#trend .dot").count(), 22, "Games without a timeline have no lane gold");
    await page.locator("#trend-view").click();
    assert.equal(await page.locator("#trend .trend-table tbody tr").count(), 22);
    await noPageOverflow(page, `chart table ${width}`);
    await page.locator("#trend-view").click();
    await page.waitForSelector("#trend svg");

    // clicking a game folds out its details: beside the chart on wide screens, below it on narrow ones
    const before = await page.locator("#trend-plot").evaluate((el) => el.clientWidth);
    await hover(0.5);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForSelector("#trend-body.open #tg-more .tg-team");
    await page.waitForTimeout(700);  // let the panel finish sliding
    assert.equal(await page.locator('#trend-game [data-keys="lane"]').getAttribute("class"), "tg-stat current", "The charted stat is highlighted");
    assert.equal(await page.locator("#trend .sel-dot").count(), 1, "The open game is marked in the chart");
    const after = await page.locator("#trend-plot").evaluate((el) => el.clientWidth);
    if (width >= 1000) assert(after < before - 300, `The chart should make room for the panel (${before}px -> ${after}px)`);
    else assert.equal(after, before, "On narrow screens the panel opens below the chart");
    await noPageOverflow(page, `game panel ${width}`);
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.locator("#trend").screenshot({ path: path.join(process.env.SCREENSHOTS, `trend-open-${width}.png`) });
    }
    await page.locator("#tg-close").click();
    await page.waitForFunction(() => !document.querySelector("#trend-body").classList.contains("open"));
    assert.equal(await page.locator("#trend .sel-dot").count(), 0);
    await page.keyboard.press("Enter");  // focus went back to the chart: Enter opens the game under the cursor
    await page.waitForSelector("#trend-body.open");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#trend-body").classList.contains("open"));
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.locator('.trend-stats .chip[data-stat="cs"]').click();
      await page.waitForTimeout(1400);
      await hover(0.7);
      await page.locator("#trend").screenshot({ path: path.join(process.env.SCREENSHOTS, `trend-${width}.png`) });
    }
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.screenshot({ path: path.join(process.env.SCREENSHOTS, `profile-${width}.png`), fullPage: true });
    }
    if (width <= 640) {
      assert.equal(await page.locator("#top-search button").textContent(), "Go");
      const targets = await page.locator("#range, #refresh, #link, #unlink, .tabs button, #top-search input").evaluateAll((elements) => elements.map((el) => ({ label: el.id || el.textContent, height: el.getBoundingClientRect().height })));
      for (const target of targets) assert(target.height >= 44, `${target.label}: tap target is ${target.height}px`);
      const table = page.locator("#tab-body .table-scroll").first();
      const scroll = await table.evaluate((el) => { el.scrollLeft = 100; return { left: el.scrollLeft, width: el.scrollWidth, client: el.clientWidth }; });
      assert(scroll.width > scroll.client && scroll.left > 0, "Wide champion table should scroll inside its card");
    }
    for (const tab of ["picks", "matches", "draft", "habits", "wincons", "live"]) {
      await page.locator(`.tabs button[data-tab="${tab}"]`).click();
      if (tab === "picks") {
        await page.waitForSelector(".pick-card .build-line");
        assert.equal(await page.locator(".pick-card").count(), 3);
        assert.match(await page.locator(".pick-card").first().textContent(), /You: 4W 2L/);
        assert.match(await page.locator(".pick-card").nth(1).textContent(), /New to you/);
        assert.equal(await page.locator('.pick-card').first().locator('img[alt="Bloodsong"]').count(), 1, "Support items show in builds");
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.locator(".pick-card").first().screenshot({ path: path.join(process.env.SCREENSHOTS, `pick-${width}.png`) });
        }
      } else if (tab === "matches") {
        await page.waitForSelector(".mh-row");
        await noPageOverflow(page, `matches ${width}`);
        await page.locator(".mh-row").first().click();
        await page.waitForSelector(".mh-detail table");
        assert.equal(await page.locator(".mh-row").first().getAttribute("aria-expanded"), "true");
        await page.locator("#mh-more").click();
        await page.waitForSelector('.mh-row[data-mid="EUW1_122"]');
        assert.equal(await page.locator(".mh-session").count(), 2, "Games days apart are separate sessions");
        await assertHistoryQueues(page);
        for (const queue of ["400", "480", "440"]) {
          await page.locator(`.mh-queues .chip[data-q="${queue}"]`).click();
          await page.waitForSelector("#mh-refresh:not([disabled])");
          assert.equal(state.matchQueues.at(-1), queue);
          assert.deepEqual(await historyIds(page), historyRows[queue].map((row) => row.match_id));
          assert.match(await page.locator(".mh-champ small").textContent(), new RegExp(meta.queues.find((type) => type.key === queue).label));
          assert.equal(await page.locator(`.mh-queues .chip[data-q="${queue}"]`).getAttribute("aria-pressed"), "true");
          await noPageOverflow(page, `${queue} matches ${width}`);
        }
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.screenshot({ path: path.join(process.env.SCREENSHOTS, `matches-${width}.png`) });
        }
        await page.locator('.mh-queues .chip[data-q="420"]').click();
        await page.waitForSelector('.mh-row[data-mid="EUW1_123"]');
      } else if (tab === "draft") {
        await page.waitForSelector("#pick-out table");
        await page.locator("#pick-alpha").fill("0");
        await page.locator("#pick-alpha").dispatchEvent("change");
        await page.waitForFunction(() => document.querySelector("#pick-out .callout"));
        await page.locator("#pick-opp").selectOption("3");
        await page.waitForFunction(() => document.querySelector("#pick-out .callout")?.textContent.includes("Miss Fortune"));
        assert(state.pickAlphas.includes("0"), "Zero smoothing must remain selectable");
        // a predicted champion folds out its build: the player's tier, or every tier while it's thinly sampled
        await page.locator("#pick-out .champ-btn").first().click();
        await page.waitForSelector("#pick-out .build-row .build-line");
        assert.equal(await page.locator("#pick-out .champ-btn").first().getAttribute("aria-expanded"), "true");
        assert(await page.locator("#pick-out .champ-btn").first().evaluate((b) => b === document.activeElement), "Focus stays on the toggle");
        assert.match(state.buildQueries.at(-1), /role=MIDDLE&tier=EMERALD&fallback=1/);
        const draftFits = await page.locator("#pick-out .build-slot").evaluate((el) => {
          const view = el.closest(".table-scroll").getBoundingClientRect();
          return [...el.querySelectorAll("*")].every((child) => child.getBoundingClientRect().right <= view.right + 1);
        });
        assert(draftFits, "The draft build stays inside the visible part of the scrolling table");
        await noPageOverflow(page, `draft build ${width}`);
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.locator("#pick-out").screenshot({ path: path.join(process.env.SCREENSHOTS, `draft-build-${width}.png`) });
        }
        await page.locator("#pick-out .champ-btn").first().click();
        assert.equal(await page.locator("#pick-out .build-row").count(), 0, "Clicking again closes the build");
      } else if (tab === "live") {
        await page.waitForSelector(".live-team table");
      }
      await noPageOverflow(page, `${tab} ${width}`);
      const unwrapped = await page.locator("#tab-body table").evaluateAll((tables) => tables.filter((table) => !table.parentElement.classList.contains("table-scroll")).length);
      assert.equal(unwrapped, 0, `${tab}: every table should have its own scroll container`);
    }
    await page.locator(".wordmark").click();
    await page.waitForSelector(".board");
    await assertRandomResult(page, 1);
    assert.equal(state.randomRequests.length, 2, "Returning to the landing remembers only the last roll and does not auto-roll");
    const requests = state.liveRequests;
    await page.waitForTimeout(5200);
    assert.equal(state.liveRequests, requests, "Live polling should stop after leaving the live view");
    assert.deepEqual(errors, [], `Browser errors at ${width}px`);
    console.log(`PASS: landing, profile and all tabs at ${width}px`);
  } finally { await context.close(); }
}

async function checkAdmin(browser, width) {
  const { context, page, errors } = await fixturePage(browser, width, { admin: true });
  try {
    await page.goto("http://rift.test/#/");
    await page.waitForSelector(".board");
    await noPageOverflow(page, `admin topbar ${width}`);
    await page.locator("#admin-link").click();
    await page.waitForSelector("#admin");
    await noPageOverflow(page, `admin ${width}`);
    const activityRows = () => page.locator(".card:last-of-type tbody tr").count();
    assert.equal(await activityRows(), 3);
    await page.locator('[data-user="bob"]').click();
    assert.equal(await activityRows(), 2, "Selecting a member filters the activity");
    assert.match(await page.locator(".card:last-of-type h2").textContent(), /bob/);
    await page.locator("#admin-everyone").click();
    assert.equal(await activityRows(), 3);
    if (process.env.SCREENSHOTS) await page.screenshot({ path: path.join(process.env.SCREENSHOTS, `admin-${width}.png`), fullPage: true });
    assert.deepEqual(errors, [], `Browser errors on the admin page at ${width}px`);
  } finally { await context.close(); }
}

async function checkRankStates(browser) {
  for (const [label, override, stat, points] of [
    ["new ranked player", { ranks: [], series: [], overview: null, first_game: null }, "rank", 0],
    ["first rank observation", { ranks: ranks.slice(-1), series: [], overview: null, first_game: null }, "rank", 1],
    ["unranked player", { ranks: [], profile: { ...data.profile, tier: "UNRANKED" } }, "wr", 0],
  ]) {
    const fixture = await fixturePage(browser, 320, { data: { ...data, ...override } });
    try {
      await fixture.page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
      await fixture.page.waitForSelector("#trend");
      assert.equal(await fixture.page.locator(".trend-stats .chip.active").getAttribute("data-stat"), stat, label);
      assert.equal(await fixture.page.locator("#trend .rank-dot").count(), points, label);
      await noPageOverflow(fixture.page, label);
      assert.deepEqual(fixture.errors, [], label);
    } finally { await fixture.context.close(); }
  }
  console.log("PASS: rank chart with no games, one observation, and unranked fallback");
}

const historyIds = (page) => page.locator(".mh-row").evaluateAll((rows) => rows.map((row) => row.dataset.mid));
const historyRequest = (page, queue, offset) => page.waitForRequest((request) => {
  const url = new URL(request.url());
  return url.pathname.endsWith("/matches") && url.searchParams.get("queue") === queue && +url.searchParams.get("offset") === offset;
});
async function openHistory(page) {
  await page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
  await page.locator('.tabs button[data-tab="matches"]').click();
  await page.waitForSelector("#mh-refresh:not([disabled])");
}
// Completion barriers let the race assertions run after the obsolete handlers have actually returned.
async function watchHistory(page) {
  await page.evaluate(() => {
    window.historyFinished = { load: 0, more: 0 };
    const load = tabMatches, more = moreMatches;
    tabMatches = async (...args) => { try { return await load(...args); } finally { window.historyFinished.load++; } };
    moreMatches = async (...args) => { try { return await more(...args); } finally { window.historyFinished.more++; } };
  });
}

async function checkUnrankedHistory(browser) {
  for (const width of [320, 1280]) {
    const fixture = await fixturePage(browser, width, {
      data: { ...data, overview: null, series: [], first_game: null, last_game: null, games_analyzed: 0,
        profile: width === 320 ? { ...data.profile, tier: "UNRANKED", division: "", lp: 0, season_wins: 0, season_losses: 0 } : data.profile,
        ranks: width === 320 ? [] : data.ranks,
        sync: width === 1280 ? { running: true, phase: "matches", total: 0, done: 0, error: null } : data.sync },
      matchResponder: (request) => request.queue === "420" ? { body: historyPage("420", []) }
        : request.queue === "440" ? { body: historyPage("440", []) } : undefined,
    });
    const { page, state } = fixture;
    try {
      await page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
      await page.waitForSelector("#mh-refresh:not([disabled])");
      assert.equal(await page.locator('.tabs button[data-tab="matches"]').getAttribute("aria-pressed"), "true");
      assert.deepEqual(await page.locator(".tabs button").evaluateAll((buttons) => buttons.map((button) => button.dataset.tab)), ["live", "matches"]);
      assert.equal(await page.locator("#trend").count(), 1, "Rank remains accessible without ranked games");
      await page.locator('.trend-stats .chip[data-stat="rank"]').click();
      assert.equal(await page.locator(".trend-stats .chip.active").getAttribute("data-stat"), "rank");
      assert.equal(await page.locator(".mh-row").count(), 0, "Ranked history really is empty in this fixture");
      await assertHistoryQueues(page);
      await page.evaluate(() => { view.player.queue = "all"; return tabMatches(); });
      assert.equal(state.matchQueues.at(-1), "420", "An obsolete selected queue resets to ranked solo before fetching");
      assert.equal(await page.locator('.mh-queues .chip[data-q="420"]').getAttribute("aria-pressed"), "true");
      for (const [queue, rows, teams] of [["400", [normalRow], 2], ["480", [swiftplayRow], 2], ["440", [], 0]]) {
        await page.locator(`.mh-queues .chip[data-q="${queue}"]`).click();
        await page.waitForSelector("#mh-refresh:not([disabled])");
        assert.equal(state.matchQueues.at(-1), queue);
        assert.equal(await page.locator(`.mh-queues .chip[data-q="${queue}"]`).textContent(), meta.queues.find((type) => type.key === queue).label);
        assert.deepEqual(await historyIds(page), rows.map((row) => row.match_id), "Only the selected mode's matches are shown");
        for (const row of rows) assert((await page.locator(`.mh-row[data-mid="${row.match_id}"] .mh-champ small`).textContent()).includes(row.queue));
        if (teams) {
          await page.locator(".mh-row").first().click();
          await page.waitForSelector(".mh-detail table");
          assert.equal(await page.locator(".mh-team").count(), teams);
          assert.equal(await page.locator(".mh-team tbody tr").count(), 10);
        }
        await noPageOverflow(page, `no-ranked ${queue} ${width}`);
      }
      await page.locator('.tabs button[data-tab="live"]').click();
      await page.waitForSelector(".live-team table");
      assert.equal(await page.locator(".live-team").count(), 2, "Live navigation works without ranked analysis");
      assert.equal(await page.locator("#trend").count(), 1);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
  }
  console.log("PASS: no-ranked Normal, Swiftplay, empty Flex, removed queues and live navigation at 320px and 1280px");
}

async function checkHistoryPaginationRace(browser) {
  const more = deferred(), swiftplay = deferred();
  const lateNormal = { ...normalRow, match_id: "EUW1_224", game_start: normalRow.game_start - 60000 };
  const fixture = await fixturePage(browser, 375, { matchResponder: async ({ queue, offset }) => {
    if (queue === "400") {
      if (offset === 0) return { body: historyPage(queue, [normalRow], 20) };
      await more.promise;
      return { body: historyPage(queue, [lateNormal], 40) };
    }
    if (queue === "480") { await swiftplay.promise; return { body: historyPage(queue, [swiftplayRow]) }; }
  } });
  const { page, state } = fixture;
  try {
    await openHistory(page);
    await watchHistory(page);
    await page.locator('.mh-queues .chip[data-q="400"]').click();
    await page.waitForSelector("#mh-more:not([disabled])");
    const pendingMore = historyRequest(page, "400", 20);
    await page.locator("#mh-more").click();
    await pendingMore;
    await page.evaluate(() => renderPlayer());
    assert(await page.locator("#mh-more").isDisabled(), "Pagination stays busy across analysis re-renders");
    assert(await page.locator("#mh-refresh").isDisabled());
    await page.evaluate(() => moreMatches());
    assert.equal(state.matchRequests.filter((request) => request.queue === "400" && request.offset === 20).length, 1);
    const finished = await page.evaluate(() => window.historyFinished.more);
    const pendingSwiftplay = historyRequest(page, "480", 0);
    await page.locator('.mh-queues .chip[data-q="480"]').click();
    await pendingSwiftplay;
    more.resolve();
    await page.waitForFunction((before) => window.historyFinished.more > before, finished);
    assert.deepEqual(await historyIds(page), [], "Old pagination must not replace the new mode's loading panel");
    assert.equal(await page.locator("#mh-more").count(), 0, "The old mode's cursor must not become clickable");
    assert.equal(await page.locator('.mh-queues .chip[data-q="480"]').getAttribute("aria-pressed"), "true");
    swiftplay.resolve();
    await page.waitForSelector("#mh-refresh:not([disabled])");
    assert.deepEqual(await historyIds(page), [swiftplayRow.match_id]);
    await page.locator('.mh-queues .chip[data-q="400"]').click();
    await page.waitForSelector("#mh-refresh:not([disabled])");
    assert.deepEqual(await historyIds(page), [normalRow.match_id]);
    assert.deepEqual(state.matchRequests.filter((request) => request.queue === "400").map((request) => request.offset), [0, 20, 0]);
    assert.deepEqual(fixture.errors, []);
  } finally { more.resolve(); swiftplay.resolve(); await fixture.context.close(); }
  console.log("PASS: busy pagination and mode-switch response/cursor isolation");
}

async function checkHistoryInitialRace(browser) {
  const flex = deferred(), swiftplay = deferred();
  const newerFlex = { ...flexRow, match_id: "EUW1_225" };
  let flexCalls = 0;
  const fixture = await fixturePage(browser, 375, { matchResponder: async ({ queue }) => {
    if (queue === "440") {
      if (++flexCalls === 1) {
        await flex.promise;
        return { body: historyPage(queue, [flexRow], 5) };
      }
      return { body: historyPage(queue, [newerFlex]) };
    }
    if (queue === "480") { await swiftplay.promise; return { body: historyPage(queue, [swiftplayRow]) }; }
  } });
  const { page, state } = fixture;
  try {
    await openHistory(page);
    await watchHistory(page);
    const firstFlex = historyRequest(page, "440", 0);
    await page.locator('.mh-queues .chip[data-q="440"]').click();
    await firstFlex;
    const firstSwiftplay = historyRequest(page, "480", 0);
    await page.locator('.mh-queues .chip[data-q="480"]').click();
    await firstSwiftplay;
    await page.locator('.mh-queues .chip[data-q="440"]').click();
    await page.waitForSelector(`.mh-row[data-mid="${newerFlex.match_id}"]`);
    await page.waitForFunction(() => window.historyFinished.load === 1);
    flex.resolve();
    await page.waitForFunction(() => window.historyFinished.load === 2);
    assert.deepEqual(await historyIds(page), [newerFlex.match_id], "The first A request cannot overwrite the second A request");
    assert.equal(await page.locator("#mh-more").count(), 0);
    assert.equal(state.matchRequests.filter((request) => request.queue === "440").length, 2, "Obsolete multi-page fetches stop instead of continuing");
    swiftplay.resolve();
    await page.waitForFunction(() => window.historyFinished.load === 3);
    assert.deepEqual(await historyIds(page), [newerFlex.match_id], "Late B also cannot overwrite the active A");
    assert.deepEqual(fixture.errors, []);
  } finally { flex.resolve(); swiftplay.resolve(); await fixture.context.close(); }
  console.log("PASS: A-B-A latest-request ordering and obsolete fetch cancellation");
}

async function checkHistoryRetries(browser) {
  let flexLoads = 0;
  const refreshedFlex = { ...flexRow, match_id: "EUW1_226" };
  const empty = await fixturePage(browser, 320, { matchResponder: ({ queue, offset }) => {
    if (queue !== "440") return;
    if (offset === 20) return { body: historyPage(queue, [flexRow]) };
    flexLoads++;
    return { body: flexLoads === 1 ? historyPage(queue, [], 20, "Some Ranked Flex matches are temporarily unavailable.")
      : flexLoads === 2 ? historyPage(queue, [], 20) : historyPage(queue, [refreshedFlex]) };
  } });
  try {
    await openHistory(empty.page);
    await empty.page.locator('.mh-queues .chip[data-q="440"]').click();
    await empty.page.waitForSelector("#mh-retry:not([disabled])");
    assert.match(await empty.page.locator("#tab-body .error").textContent(), /temporarily unavailable/);
    assert.equal(await empty.page.locator(".mh-row").count(), 0);
    assert(await empty.page.locator("#mh-more").isVisible(), "Empty error pages retain continuation");
    await noPageOverflow(empty.page, "empty-page error controls 320");
    await empty.page.locator("#mh-retry").click();
    await empty.page.waitForSelector("#mh-refresh:not([disabled])");
    assert.equal(flexLoads, 2, "Retry bypasses the non-solo cache");
    assert.equal(await empty.page.locator("#tab-body .error").count(), 0);
    assert.equal(await empty.page.locator(".mh-row").count(), 0);
    assert(await empty.page.locator("#mh-more").isVisible(), "Empty successful pages also retain continuation");
    await empty.page.locator("#mh-more").click();
    await empty.page.waitForSelector(`.mh-row[data-mid="${flexRow.match_id}"]`);
    await empty.page.locator("#mh-refresh").click();
    await empty.page.waitForSelector(`.mh-row[data-mid="${refreshedFlex.match_id}"]`);
    assert.equal(flexLoads, 3, "Explicit history refresh bypasses a successful non-solo cache too");
    assert.deepEqual(await historyIds(empty.page), [refreshedFlex.match_id]);
    await noPageOverflow(empty.page, "empty-page retry 320");
    assert.deepEqual(empty.errors, []);
  } finally { await empty.context.close(); }

  const partialNormal = { ...normalRow, match_id: "EUW1_227", game_start: normalRow.game_start - 60000 };
  const finalNormal = { ...normalRow, match_id: "EUW1_228", game_start: normalRow.game_start - 120000 };
  const freshNormal = { ...normalRow, match_id: "EUW1_229", game_start: normalRow.game_start + 60000 };
  let normalLoads = 0, secondPageCalls = 0;
  const partial = await fixturePage(browser, 320, { matchResponder: ({ queue, offset }) => {
    if (queue !== "400") return;
    if (offset === 20) return { body: ++secondPageCalls === 1 ? historyPage(queue, [partialNormal], 40, "failed")
      : historyPage(queue, [partialNormal, finalNormal]) };
    if (offset === 5) return { status: 502, body: { detail: "History page unavailable" } };
    normalLoads++;
    return { body: normalLoads === 1 ? historyPage(queue, [normalRow], 20)
      : normalLoads === 2 ? historyPage(queue, [freshNormal], 5) : historyPage(queue, [freshNormal, normalRow, partialNormal, finalNormal]) };
  } });
  try {
    await openHistory(partial.page);
    await partial.page.locator('.mh-queues .chip[data-q="400"]').click();
    await partial.page.waitForSelector("#mh-more:not([disabled])");
    await partial.page.locator("#mh-more").click();
    await partial.page.waitForSelector("#mh-retry:not([disabled])");
    assert.deepEqual(await historyIds(partial.page), [normalRow.match_id, partialNormal.match_id], "Good rows in a partially failed page are retained");
    assert.equal(await partial.page.locator("#tab-body .error").textContent(), "failed");
    assert.equal(await partial.page.evaluate(() => view.player.mh.next), 20, "An error's forward cursor must not skip the failed page");
    await partial.page.locator("#mh-retry").click();
    await partial.page.waitForSelector(`.mh-row[data-mid="${finalNormal.match_id}"]`);
    assert.deepEqual(await historyIds(partial.page), [normalRow.match_id, partialNormal.match_id, finalNormal.match_id], "Retry preserves prior rows and deduplicates the repeated partial row");
    assert.deepEqual(partial.state.matchRequests.filter((request) => request.queue === "400").map((request) => request.offset), [0, 20, 20], "Retry must reissue the failed second page, not offset 40");
    assert.equal(await partial.page.locator("#tab-body .error").count(), 0);
    await partial.page.locator("#mh-refresh").click();
    await partial.page.waitForSelector("#mh-retry:not([disabled])");
    assert.equal(await partial.page.locator("#tab-body .error").textContent(), "History page unavailable");
    assert.deepEqual(await historyIds(partial.page), [freshNormal.match_id, normalRow.match_id, partialNormal.match_id, finalNormal.match_id],
      "A later HTTP failure preserves both the successful refresh page and previously loaded rows");
    await partial.page.locator("#mh-retry").click();
    await partial.page.waitForSelector("#mh-refresh:not([disabled])");
    assert.equal(await partial.page.locator("#tab-body .error").count(), 0);
    assert.deepEqual(await historyIds(partial.page), [freshNormal.match_id, normalRow.match_id, partialNormal.match_id, finalNormal.match_id]);
    assert.deepEqual(partial.state.matchRequests.filter((request) => request.queue === "400").map((request) => request.offset), [0, 20, 20, 0, 5, 0]);
    assert.deepEqual(partial.errors, []);
  } finally { await partial.context.close(); }

  for (const [label, next] of [["unchanged", 0], ["backwards", -1], ["invalid", "bad"], ["HTTP failure", null]]) {
    let calls = 0;
    const stuck = await fixturePage(browser, 320, { matchResponder: ({ queue }) => {
      if (queue !== "480") return;
      if (++calls > 1) return { body: historyPage(queue, [swiftplayRow]) };
      return next == null ? { status: 502, body: { detail: "History unavailable" } } : { body: historyPage(queue, [], next) };
    } });
    try {
      await openHistory(stuck.page);
      await stuck.page.locator('.mh-queues .chip[data-q="480"]').click();
      await stuck.page.waitForSelector("#mh-retry:not([disabled])");
      assert.match(await stuck.page.locator("#tab-body .error").textContent(), next == null ? /History unavailable/ : /cursor did not advance/);
      assert.equal(calls, 1, `${label}: bad cursors and HTTP errors must not spin in a request loop`);
      await stuck.page.locator("#mh-retry").click();
      await stuck.page.waitForSelector(`.mh-row[data-mid="${swiftplayRow.match_id}"]`);
      assert.equal(calls, 2);
      assert.equal(await stuck.page.locator("#tab-body .error").count(), 0);
      assert.deepEqual(stuck.errors, []);
    } finally { await stuck.context.close(); }
  }
  console.log("PASS: empty continuation, explicit refresh/retry, partial-row preservation and cursor guards");
}

async function watchRandomBuild(page) {
  await page.evaluate(() => {
    window.randomFinished = 0;
    const roll = rollRandomBuild;
    document.querySelector("#random-roll").removeEventListener("click", roll);
    rollRandomBuild = async (...args) => { try { return await roll(...args); } finally { window.randomFinished++; } };
    document.querySelector("#random-roll").addEventListener("click", rollRandomBuild);
  });
}

const randomRequest = (page) => page.waitForRequest((request) => new URL(request.url()).pathname === "/api/random-build");

async function checkRandomBuildStates(browser) {
  const gate = deferred();
  const options = { randomDelay: 60, randomError: true, randomResponder: async ({ index }) => { if (index === 0) await gate.promise; } };
  const fixture = await fixturePage(browser, 320, options);
  const { page, state } = fixture;
  try {
    await page.goto("http://rift.test/#/");
    await page.waitForSelector("#random-roll");
    await watchRandomBuild(page);
    const pending = randomRequest(page);
    await page.evaluate(() => { const button = document.querySelector("#random-roll"); button.click(); button.click(); button.click(); });
    await pending;
    assert(await page.locator("#random-roll").isDisabled());
    assert.equal(await page.locator("#random-roll > span").textContent(), "Rolling…");
    assert.equal(await page.locator("#random-build").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator(".random-dice").evaluate((dice) => getComputedStyle(dice).animationName), "none", "Reduced motion disables the dice wiggle");
    assert.deepEqual(state.randomRequests, [{ index: 0, method: "POST", body: {} }], "Rapid clicks make only one authenticated JSON POST");
    await page.evaluate(() => loadPatch());
    assert(await page.locator("#random-roll").isDisabled(), "Patch polling cannot clear an in-flight roll");
    gate.resolve();
    await page.waitForFunction(() => window.randomFinished === 1);
    assert.match(await page.locator("#random-status.error").textContent(), /metadata is temporarily unavailable/);
    assert.equal(await page.locator("#random-roll").isDisabled(), false, "A 503 re-enables the first-roll button");
    assert.equal(await page.locator("#random-roll > span").textContent(), "Roll champion + build");
    assert.equal(await page.locator("#random-result").isVisible(), false);
    await noPageOverflow(page, "first-roll error 320");
    options.randomError = false;
    await page.locator("#random-roll").click();
    await page.waitForFunction(() => window.randomFinished === 2);
    await assertRandomResult(page, 1);
    options.randomError = true;
    await page.locator("#random-roll").click();
    await page.waitForFunction(() => window.randomFinished === 3);
    assert.match(await page.locator("#random-status.error").textContent(), /Your last roll is still here/);
    await assertRandomResult(page, 1);
    assert.equal(await page.locator("#random-roll").isDisabled(), false, "A failed reroll is retryable");
    options.randomError = false;
    await page.locator("#random-roll").click();
    await page.waitForFunction(() => window.randomFinished === 4);
    await assertRandomResult(page, 3);
    assert.equal(await page.locator("#random-status.error").count(), 0, "A successful retry clears the old error");
    assert.equal(await page.locator("#random-result").evaluate((result) => getComputedStyle(result).animationName), "none", "Reduced motion also disables the reveal");
    await page.locator("#logout").click();
    await page.waitForSelector("#login-form");
    await page.locator('[name="username"]').fill("member");
    await page.locator('[name="password"]').fill("password123");
    await page.locator("#login-form button").click();
    await page.waitForSelector("#random-roll");
    assert.equal(await page.locator("#random-result").isVisible(), false, "Logout clears the last successful roll");
    assert.deepEqual(fixture.errors, []);
  } finally { gate.resolve(); await fixture.context.close(); }

  const animated = await fixturePage(browser, 375, { reducedMotion: "no-preference" });
  try {
    await animated.page.goto("http://rift.test/#/");
    await animated.page.waitForSelector("#random-roll");
    const timing = await animated.page.evaluate(async () => {
      const started = performance.now();
      const pending = rollRandomBuild();
      const animation = getComputedStyle(document.querySelector(".random-dice")).animationName;
      await pending;
      return { elapsed: performance.now() - started, animation };
    });
    assert(timing.elapsed >= 390, "The normal-motion roll has a short 400ms minimum reveal delay");
    assert.equal(timing.animation, "dice-wiggle");
    await assertRandomResult(animated.page, 0);
    assert.deepEqual(animated.errors, []);
  } finally { await animated.context.close(); }

  for (const width of [320, 1280]) {
    for (const label of ["error", "empty", "loading"]) {
      const options = label === "error" ? { patchError: true } : label === "empty" ? { patch: { ...patch, matches: 0 } } : { patchDelay: 200 };
      const independent = await fixturePage(browser, width, options);
      try {
        await independent.page.goto("http://rift.test/#/");
        await independent.page.waitForSelector("#random-roll");
        await independent.page.locator("#random-roll").click();
        await independent.page.waitForSelector("#random-result:not([hidden])");
        await assertRandomResult(independent.page, 0);
        if (label === "loading") await independent.page.waitForSelector(".board");
        else await independent.page.waitForSelector(label === "error" ? "#patch-body .error" : "#patch-body .empty");
        await independent.page.evaluate(() => { window.diceCard = document.querySelector("#random-build"); return loadPatch(); });
        assert(await independent.page.locator("#random-build").evaluate((card) => card === window.diceCard));
        await assertRandomResult(independent.page, 0);
        assert.equal(independent.state.randomRequests.length, 1, "Patch updates never roll again");
        await noPageOverflow(independent.page, `random build with ${label} patch ${width}`);
        assert.deepEqual(independent.errors, []);
      } finally { await independent.context.close(); }
    }
  }

  const expired = await fixturePage(browser, 320, { randomResponder: (_, state) => {
    state.authenticated = false;
    return { status: 401, body: { detail: "Not logged in" } };
  } });
  try {
    await expired.page.goto("http://rift.test/#/");
    await expired.page.locator("#random-roll").click();
    await expired.page.waitForSelector("#login-form");
    assert.equal(await expired.page.locator("#random-build").count(), 0, "Random rolls use the shared session-expiry handling");
    assert.deepEqual(expired.errors, []);
  } finally { await expired.context.close(); }
  console.log("PASS: random-build busy guard, 503 retry, last-result preservation, auth, motion and patch independence");
}

async function checkRandomBuildStaleResponses(browser) {
  for (const destination of ["navigation", "logout"]) {
    for (const status of [200, 503, 401]) {
      const gate = deferred();
      const fixture = await fixturePage(browser, 375, { randomResponder: async ({ index }) => {
        if (index !== 0) return;
        await gate.promise;
        return status === 200 ? { body: randomBuild(index) } : { status, body: { detail: status === 401 ? "Not logged in" : "Late metadata error" } };
      } });
      const { page } = fixture;
      try {
        await page.goto("http://rift.test/#/");
        await page.waitForSelector("#random-roll");
        await watchRandomBuild(page);
        const pending = randomRequest(page);
        await page.locator("#random-roll").click();
        await pending;
        if (destination === "navigation") {
          await page.locator(".search.big input").fill("LongPlayerName#EUW12");
          await page.locator(".search.big button").click();
          await page.waitForSelector(".player-head");
          assert.equal(await page.locator("#random-build").count(), 0);
          await page.locator(".wordmark").click();
          await page.waitForSelector("#random-roll:not([disabled])");
          assert.equal(await page.locator("#random-result").isVisible(), false, "A pending roll does not get cached after leaving");
          await page.locator("#random-roll").click();
          await page.waitForFunction(() => window.randomFinished === 1);
          await assertRandomResult(page, 1);
          gate.resolve();
          await page.waitForFunction(() => window.randomFinished === 2);
          await assertRandomResult(page, 1);
          assert.equal(await page.locator("#random-status.error").count(), 0, "An obsolete success or error cannot overwrite the newer landing roll");
        } else {
          await page.locator("#logout").click();
          await page.waitForSelector("#login-form");
          gate.resolve();
          await page.waitForFunction(() => window.randomFinished === 1);
          assert.equal(await page.locator("#login-form").count(), 1, "Late rolls cannot leave the logged-out view");
          await page.locator('[name="username"]').fill("member");
          await page.locator('[name="password"]').fill("password123");
          await page.locator("#login-form button").click();
          await page.waitForSelector("#random-roll:not([disabled])");
          assert.equal(await page.locator("#random-result").isVisible(), false, "A late roll is not retained across logout");
          assert.equal(await page.locator("#random-status.error").count(), 0);
        }
        assert.deepEqual(fixture.errors, [], `${destination}: late HTTP ${status}`);
      } finally { gate.resolve(); await fixture.context.close(); }
    }
  }
  console.log("PASS: random-build navigation A-B-A ordering and logout stale-success/error guards");
}

async function checkStates(browser) {
  const login = await fixturePage(browser, 320, { authenticated: false });
  try {
    await login.page.goto("http://rift.test/#/");
    await login.page.waitForSelector("#login-form");
    await noPageOverflow(login.page, "login 320");
    assert.match(await login.page.locator("footer.legal").textContent(), /^Rift Odds isn't endorsed by Riot Games/, "Riot's legal notice is required on every page");
    assert(await login.page.locator("footer.legal").isVisible());
    if (process.env.SCREENSHOTS) await login.page.screenshot({ path: path.join(process.env.SCREENSHOTS, "login-320.png"), fullPage: true });
    await login.page.locator('[name="username"]').fill("member");
    await login.page.locator('[name="password"]').fill("password123");
    await login.page.locator("#login-form button").click();
    await login.page.waitForSelector(".board");
    await login.page.locator("#logout").click();
    await login.page.waitForSelector("#login-form");
    await login.page.evaluate(() => { location.hash = "#/p/euw1/Someone%23EUW/20"; });
    await login.page.waitForTimeout(100);
    assert.equal(await login.page.locator("#login-form").count(), 1, "Hash navigation must not leave the logged-out view");
    assert.deepEqual(login.errors, []);
  } finally { await login.context.close(); }

  for (const sync of [
    { phase: "timelines", running: true, total: 100, done: 30, error: null },
    { phase: "matches", running: false, total: 100, done: 30, error: "Riot API unavailable. Please retry the missing games." },
  ]) {
    const fixture = await fixturePage(browser, 320, { data: { ...data, sync } });
    try {
      await fixture.page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
      await fixture.page.waitForSelector("#sync:not([hidden])");
      await noPageOverflow(fixture.page, `sync ${sync.phase}`);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.context.close(); }
  }

  const stale = await fixturePage(browser, 375, { patchDelay: 150, patchError: true });
  try {
    await stale.page.goto("http://rift.test/#/");
    await stale.page.waitForSelector(".hero");
    await stale.page.evaluate(() => { location.hash = "#/p/euw1/LongPlayerName%23EUW12/20"; });
    await stale.page.waitForSelector(".player-head");
    await stale.page.waitForTimeout(250);
    assert.deepEqual(stale.errors, [], "Late patch errors must not overwrite the new route or touch removed elements");
  } finally { await stale.context.close(); }
  const draft = await fixturePage(browser, 375, { pickDelay: 150 });
  try {
    await draft.page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
    await draft.page.waitForSelector(".player-head");
    await draft.page.locator('.tabs button[data-tab="draft"]').click();
    await draft.page.waitForSelector("#pick-out");
    await draft.page.locator('.tabs button[data-tab="habits"]').click();
    await draft.page.waitForTimeout(250);
    assert.deepEqual(draft.errors, [], "Late pick responses must not write into a removed draft panel");
  } finally { await draft.context.close(); }

  const invalid = await fixturePage(browser, 375, { pickError: true });
  try {
    await invalid.page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
    await invalid.page.waitForSelector(".player-head");
    await invalid.page.locator('.tabs button[data-tab="draft"]').click();
    await invalid.page.waitForSelector("#pick-out .error");
    assert.equal(await invalid.page.locator("#pick-out .error").textContent(), "Smoothing must be nonnegative");
    assert.deepEqual(invalid.errors, []);
  } finally { await invalid.context.close(); }
  console.log("PASS: login/logout, sync states, validation errors and stale-response handling");
}

(async () => {
  const browserType = playwright[process.env.BROWSER || "chromium"];
  const browser = await browserType.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  try {
    for (const width of [320, 375, 390, 768, 1280]) await checkWidth(browser, width);
    for (const width of [320, 1280]) await checkAdmin(browser, width);
    console.log("PASS: admin page at 320px and 1280px");
    await checkRankStates(browser);
    await checkUnrankedHistory(browser);
    await checkHistoryPaginationRace(browser);
    await checkHistoryInitialRace(browser);
    await checkHistoryRetries(browser);
    await checkRandomBuildStates(browser);
    await checkRandomBuildStaleResponses(browser);
    await checkStates(browser);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
