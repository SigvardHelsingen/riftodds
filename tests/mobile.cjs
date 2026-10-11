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
  queues: [["420", "Ranked Solo"], ["440", "Ranked Flex"], ["400", "Normal Draft"], ["480", "Swiftplay"], ["450", "ARAM"],
    ["2400", "ARAM: Mayhem"], ["1710", "Arena"]].map(([key, label]) => ({ key, label })),
  default_range: "20", ranges: [
    { key: "20", label: "Last 20 games", kind: "count" },
    { key: "season", label: "Whole season", kind: "time" },
  ],
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
const data = {
  puuid: "player", profile: {
    name: "LongPlayerName", tag: "EUW12", platform: "euw1", tier: "EMERALD", division: "II",
    lp: 42, season_wins: 100, season_losses: 80, level: 250, icon: "https://images.test/profile.png",
  },
  first_game: now - 86400000, last_game: now, games_analyzed: 20,
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
const matchPage = (q) => {
  if (q.get("queue") !== "420") return { queue: q.get("queue"), rows: [aramRow, matchRow], total: null, next: null, error: null };
  const offset = +q.get("offset"), end = offset + +q.get("limit");
  return { queue: "420", rows: soloRows.slice(offset, end), total: soloRows.length, next: end < soloRows.length ? end : null, error: null };
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
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const state = { authenticated: options.authenticated !== false, liveRequests: 0, pickAlphas: [], matchQueues: [] };
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
    else if (url.pathname === "/api/me") body = me;
    else if (url.pathname === "/api/meta") body = meta;
    else if (url.pathname === "/api/patch") {
      if (options.patchDelay) await new Promise((resolve) => setTimeout(resolve, options.patchDelay));
      status = options.patchError ? 502 : 200;
      body = options.patchError ? { detail: "Upstream unavailable" } : patch;
    }
    else if (url.pathname === "/api/player" || url.pathname.endsWith("/analysis")) body = options.data || data;
    else if (url.pathname.endsWith("/matches")) { state.matchQueues.push(url.searchParams.get("queue")); body = matchPage(url.searchParams); }
    else if (url.pathname.startsWith("/api/match/")) body = detail;
    else if (url.pathname.startsWith("/api/live/")) { state.liveRequests++; body = live; }
    else if (url.pathname === "/api/pick") {
      if (options.pickDelay) await new Promise((resolve) => setTimeout(resolve, options.pickDelay));
      if (options.pickError) return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: [{ msg: "Smoothing must be nonnegative" }] }) });
      state.pickAlphas.push(url.searchParams.get("alpha"));
      body = { ...pick, opp: url.searchParams.has("opp") ? +url.searchParams.get("opp") : null };
    }
    else if (url.pathname.startsWith("/api/sync/")) body = data.sync;
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

async function checkWidth(browser, width) {
  const { context, page, errors, state } = await fixturePage(browser, width);
  try {
    await page.goto("http://rift.test/#/");
    await page.waitForSelector(".board");
    await noPageOverflow(page, `landing ${width}`);
    await page.locator(".search.big input").fill("LongPlayerName#EUW12");
    await page.locator(".search.big button").click();
    await page.waitForSelector(".player-head");
    await noPageOverflow(page, `champions ${width}`);
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
    for (const tab of ["matches", "draft", "habits", "wincons", "live"]) {
      await page.locator(`.tabs button[data-tab="${tab}"]`).click();
      if (tab === "matches") {
        await page.waitForSelector(".mh-row");
        await noPageOverflow(page, `matches ${width}`);
        await page.locator(".mh-row").first().click();
        await page.waitForSelector(".mh-detail table");
        assert.equal(await page.locator(".mh-row").first().getAttribute("aria-expanded"), "true");
        await page.locator("#mh-more").click();
        await page.waitForSelector('.mh-row[data-mid="EUW1_122"]');
        assert.equal(await page.locator(".mh-session").count(), 2, "Games days apart are separate sessions");
        await page.locator('.mh-queues .chip[data-q="all"]').click();
        await page.waitForSelector('.mh-row[data-mid="EUW1_124"]');
        assert.equal(state.matchQueues.at(-1), "all");
        assert.match(await page.locator('.mh-row[data-mid="EUW1_124"] .mh-champ small').textContent(), /ARAM/);
        assert.equal(await page.locator('.mh-queues .chip[data-q="all"]').getAttribute("aria-pressed"), "true");
        await noPageOverflow(page, `all matches ${width}`);
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
      } else if (tab === "live") {
        await page.waitForSelector(".live-team table");
      }
      await noPageOverflow(page, `${tab} ${width}`);
      const unwrapped = await page.locator("#tab-body table").evaluateAll((tables) => tables.filter((table) => !table.parentElement.classList.contains("table-scroll")).length);
      assert.equal(unwrapped, 0, `${tab}: every table should have its own scroll container`);
    }
    await page.locator(".wordmark").click();
    await page.waitForSelector(".board");
    const requests = state.liveRequests;
    await page.waitForTimeout(5200);
    assert.equal(state.liveRequests, requests, "Live polling should stop after leaving the live view");
    assert.deepEqual(errors, [], `Browser errors at ${width}px`);
    console.log(`PASS: landing, profile and all tabs at ${width}px`);
  } finally { await context.close(); }
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
    await checkStates(browser);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
