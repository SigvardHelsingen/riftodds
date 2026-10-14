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
  ...Object.fromEntries(["Ahri", "Ashe", "Braum", "Garen", "Lux", "Vi", "Zed"].map((name, i) =>
    [i + 4, { name, icon: `https://images.test/${i + 4}.png` }])),
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
// Optional timeline evidence deliberately disagrees with the final-inventory core order.
const buildOrder = {
  games: 24, timing_resolution_seconds: 1,
  core: [{ items: [3072, 3031, 3036], minutes: [13, 21, 29], ...winrate(24, 15), share: 1 }],
  first: [{ item: 3072, minute: 13, ...winrate(24, 15), share: 1 }],
  start: [{ items: [3006], ...winrate(24, 15), share: 1 }],
  skills: [{ order: "QEW", first: "QWE", observed_order: "Q", inferred_order: "EW", unknown: "",
    estimated: true, label: "Estimated priority after observed Q max (partial skill sequence)", ...winrate(24, 15), share: 1 }],
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
    [key, [{ ...matchRow, match_id: `EUW1_14${i}`, queue, champion_id: key === "400" ? 6 : matchRow.champion_id }]])),
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
      participant_id: i + (team_id === 100 ? 1 : 6),
      puuid: team_id === 100 && i === 2 ? "player" : `other-${team_id}-${i}`,
      champion_id: [2, 3, 1, 4, 5, 7, 8, 6, 9, 10][i + (team_id === 100 ? 0 : 5)],
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
const matchDetails = { [aramRow.match_id]: aramDetail, [mayhemRow.match_id]: mayhemDetail, [arenaRow.match_id]: arenaDetail,
  [normalRow.match_id]: { ...detail, teams: detail.teams.map((team) => ({ ...team, win: team.team_id === 200,
    players: team.players.map((player, i) => ({ ...player,
      puuid: team.team_id === 200 && i === 2 ? "player" : `red-${team.team_id}-${i}` })) })) },
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const live = {
  in_game: true, game_id: 987654321, pending: 0, without_history: 0, form_games: 10, queue: "Ranked Solo", started: now,
  bans: [100, 200].flatMap((team) => [1, 2, 3].map((champion_id) => ({ team, champion_id }))),
  players: [100, 200].flatMap((team) => Array.from({ length: 5 }, (_, i) => ({
    team, champion_id: i + (team === 100 ? 1 : 6), riot_id: `LongPlayerName${i}#EUW12`, tier: "EMERALD", division: "II", lp: 42,
    is_me: team === 100 && i === 0, mastery_points: 100000, mastery_level: 10, form: winrate(),
    on_champ: winrate(), cached_games: 20, loading: false,
  }))),
};

const unsafeText = '<img src=x onerror="window.fixtureXss=1">';
const clone = (value) => JSON.parse(JSON.stringify(value));
const gameStory = (team = 100, withChance = true) => {
  const me = team === 100 ? 3 : 8, opponent = team === 100 ? 7 : 2;
  const events = [
    { t: 600, kind: "kill", side: "us", killer: me, victim: opponent, x: 3000, y: 6000 },
    { t: 660, kind: "kill", side: "them", killer: opponent, victim: me, x: 9000, y: 12000 },
    { t: 690, kind: "monster", side: "us", label: "Dragon", killer: me, x: 9800, y: 4400 },
  ];
  const players = detail.teams.flatMap((side) => side.players.map((player) => ({
    participant_id: player.participant_id, champion_id: player.champion_id, team: side.team_id, position: "MIDDLE",
  }))).reverse(); // Participant IDs are neither array offsets nor champion IDs.
  const minutes = [
    { m: 0, gold: 0, kills: [0, 0], chance: 0.5 },
    { m: 10, gold: 1200, kills: [1, 0], chance: 0.55 },
    { m: 11, gold: -800, kills: [1, 1], chance: 0.42 },
    { m: 12, gold: 2100, kills: [1, 1], chance: 0.68 },
    { m: 31, gold: 7000, kills: [30, 20], chance: 1, final: true },
  ].map((minute) => ({ ...minute, t: minute.m * 60, xp: minute.gold / 2,
    chance: withChance ? minute.chance : null }));
  return { available: true, team, me, players, minutes, events,
    turning: withChance ? { minute: 12, from: 0.42, to: 0.68, events: [events[2]] } : null,
    kills: [events[0]], deaths: [events[1]], start: [[0, 3006]],
    build: [[780, 3072], [1260, 3031], [1740, 3036]], skills: "123114131",
    model: withChance ? { label: "Fixture held-out model", trained_at: now / 1000 } : null };
};
const stories = { [normalRow.match_id]: gameStory(200) };
const matchup = { champion_id: 1, opponent_id: 3, ...winrate(24, 15), score: 0.57,
  gold10: { mean: 150, games: 20 }, gold15: { mean: null, games: 2 },
  you: { ...winrate(3, 2), gold10: { mean: -20, games: 3 }, gold15: { mean: null, games: 0 } } };
const draftInsights = { patch: "16.20", tier: "EMERALD", role: "MIDDLE", opponent: null, matchups: [matchup],
  counters: [{ ...matchup, pool_games: 3, reason: `Selected-range own pool ${unsafeText}` },
    { ...matchup, champion_id: 2, pool_games: 2 }, { ...matchup, champion_id: 3, games: 14, pool_games: 4 },
    { ...matchup, champion_id: 4, opponent_id: 2, pool_games: 4 }], note: `Same patch, role and tier only. ${unsafeText}` };
const practiceMetric = (key, label, you = 4, unit = "{:.1f}", better = 1) => ({
  key, label, unit, better, you, current: you + better, next: you + 2 * better,
  percentile: 35, games: 8, baseline_games: 30, next_games: 25,
  recent: { value: you + 0.2 * better, games: 4 }, previous: { value: you, games: 4 },
  target: you + 0.5 * better, target_tier: "DIAMOND", advice: `Review decisions, not just counts. ${unsafeText}`,
});
const coachingMetrics = [practiceMetric("cs_min", "CS per minute"), practiceMetric("deaths", "Deaths per game", 4, "{:.1f}", -1)];
const coachingInsights = { patch: "16.20", tier: "EMERALD", next_tier: "DIAMOND", can_edit: true, goals: [], roles: [
  { role: "MIDDLE", games: 12, metrics: coachingMetrics, focus: coachingMetrics,
    fingerprint: [{ key: "farming", label: "Farming", percentile: 35 }, { key: "safety", label: "Death frequency", percentile: null }],
    takeaway: `Role-specific samples; missing is not zero. ${unsafeText}` },
  { role: "JUNGLE", games: 6, metrics: [practiceMetric("jungle_cs10", "Jungle CS at 10 minutes")], focus: [],
    fingerprint: [{ key: "farming", label: "Jungle farming", percentile: 0 }], takeaway: "Jungle-specific comparisons only." },
], forecast: { available: false, reason: "insufficient_observations", observations: 1, games: 0 } };
const modelReport = { ready: true, validation: { passed: true }, train_games: 80, train_samples: 480,
  test_games: 20, test_samples: 120, overall: { games: 20, samples: 120, accuracy: 0.97,
    brier: 0.21, log_loss: 0.61, coin_brier: 0.25, coin_log_loss: Math.log(2),
    baseline: { brier: 0.24, log_loss: 0.68 }, calibration: [
      { lo: 0.5, hi: 0.6, predicted: 0.55, observed: 0.5, samples: 60, games: 12 },
      { lo: 0.6, hi: 0.7, predicted: 0.65, observed: 0.75, samples: 60, games: 15 },
    ] }, split: { method: "Chronological match holdout; train completed before test", excluded_overlapping_games: 2 },
  features: ["gold_diff", "draft_strength"], limitations: [`Correlated minute samples. ${unsafeText}`] };
const oddsInsights = { pregame: { ready: true, trained_at: now / 1000, report: modelReport },
  ingame: { ready: false, reason: "Held-out scores failed the baseline", report: modelReport } };
const livePrediction = { ready: true, blue: 0.62, red: 0.38,
  coverage: { draft: { supported_slots: 7, known_slots: 10 }, matchups: { supported_roles: 3 }, players: { eligible: 4 } } };
const clashInsights = { team: { name: `Team ${unsafeText}`, tag: "TEST", tier: 2 },
  members: [{ riot_id: `Scout ${unsafeText}`, role: "MIDDLE", tier: null, pending: true,
    pool: [{ champion_id: 1, ...winrate(10, 6) }], pockets: [{ champion_id: 2, points: 30000 }] }],
  bans: [{ champion_id: 1, games: 10, share: 0.5 }], pending: true,
  note: "Cached pools, not a predicted Clash pick probability." };

async function fixturePage(browser, width, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: options.reducedMotion || "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => { errors.push(err.message); if (process.env.DEBUG) console.error(err); });
  const state = { authenticated: options.authenticated !== false, liveRequests: 0, pickAlphas: [], buildQueries: [], matchQueues: [], matchRequests: [], randomRequests: [],
    storyRequests: [], timelineRequests: [], insightRequests: [], analysisRequests: [], picksRequests: [], pickQueries: [], liveSnapshots: [], goals: clone(options.goals || []) };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.host !== "rift.test" || url.pathname === "/favicon.ico" || /^\/static\/(favicon|apple-touch-icon)/.test(url.pathname)) {
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>' });
    }
    const files = { "/": ["static/index.html", "text/html"], "/static/app.js": ["static/app.js", "text/javascript"], "/static/style.css": ["static/style.css", "text/css"],
      "/static/insights.js": ["static/insights.js", "text/javascript"], "/static/insights.css": ["static/insights.css", "text/css"] };
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
    else if (url.pathname === "/api/player") body = options.data || data;
    else if (url.pathname.endsWith("/analysis")) {
      const request = { index: state.analysisRequests.length, path: url.pathname, query: Object.fromEntries(url.searchParams) };
      state.analysisRequests.push(request);
      const response = await options.analysisResponder?.(request, state);
      status = response?.status ?? 200;
      body = response?.body ?? options.data ?? data;
    }
    else if (url.pathname.startsWith("/api/builds/")) {
      state.buildQueries.push(url.search);
      body = { ...build, ...(options.buildOrder ? { order: options.buildOrder } : {}), champion_id: +url.pathname.split("/").pop() };
    }
    else if (url.pathname.endsWith("/picks")) {
      const request = { index: state.picksRequests.length, path: url.pathname, query: Object.fromEntries(url.searchParams) };
      state.picksRequests.push(request);
      const response = await options.picksResponder?.(request, state);
      status = response?.status ?? 200;
      body = response?.body ?? { ...picks, roles: picks.roles.map((role) => ({ ...role,
        picks: role.picks.map((pick) => ({ ...pick, build: { ...pick.build, ...(options.buildOrder ? { order: options.buildOrder } : {}) } })) })) };
    }
    else if (/^\/api\/player\/[^/]+\/(draft|coaching|goals)$/.test(url.pathname)
      || url.pathname === "/api/odds" || url.pathname.startsWith("/api/clash/") || /^\/api\/live\/[^/]+\/odds$/.test(url.pathname)) {
      const request = { index: state.insightRequests.length, path: url.pathname, method: route.request().method(),
        query: Object.fromEntries(url.searchParams), body: route.request().postDataJSON() };
      state.insightRequests.push(request);
      const response = await options.insightResponder?.(request, state);
      status = response?.status ?? 200;
      if (response) body = response.body;
      else if (url.pathname.endsWith("/draft")) body = { ...draftInsights, role: request.query.role,
        opponent: request.query.opp ? +request.query.opp : null };
      else if (url.pathname.endsWith("/coaching")) body = { ...coachingInsights, can_edit: options.canEdit !== false, goals: state.goals };
      else if (url.pathname.endsWith("/goals")) {
        if (options.canEdit === false) { status = 403; body = { detail: "Goal editing is only available for your linked account." }; }
        else {
          if (request.method === "POST") state.goals = [...state.goals.filter((goal) => goal.role !== request.body.role || goal.metric !== request.body.metric),
            { ...request.body, puuid: url.pathname.split("/")[3], created: Math.floor(now / 1000) }];
          else if (request.method === "DELETE") state.goals = state.goals.filter((goal) => goal.role !== request.query.role || goal.metric !== request.query.metric);
          else throw new Error(`Unexpected goal method: ${request.method}`);
          body = { goals: state.goals };
        }
      } else if (url.pathname === "/api/odds") body = oddsInsights;
      else if (url.pathname.startsWith("/api/clash/")) body = clashInsights;
      else {
        assert.equal(request.method, "POST", "Live odds are requested explicitly");
        body = livePrediction;
      }
    }
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
    // Specific subresources must precede the generic match-detail route.
    else if (/^\/api\/match\/[^/]+\/story$/.test(url.pathname)) {
      const request = { index: state.storyRequests.length, mid: decodeURIComponent(url.pathname.split("/")[3]),
        puuid: url.searchParams.get("puuid"), method: route.request().method() };
      state.storyRequests.push(request);
      assert.equal(request.method, "GET");
      const response = await options.storyResponder?.(request, state);
      status = response?.status ?? 200;
      body = response?.body ?? stories[request.mid] ?? gameStory();
    }
    else if (/^\/api\/match\/[^/]+\/timeline$/.test(url.pathname)) {
      const request = { mid: decodeURIComponent(url.pathname.split("/")[3]), method: route.request().method(), body: route.request().postDataJSON() };
      state.timelineRequests.push(request);
      assert.equal(request.method, "POST", "Timeline upgrades are explicit POSTs only");
      assert(options.timelineResponder, "Timeline fetching requires an explicit optional fixture");
      const response = await options.timelineResponder(request, state);
      status = response.status ?? 200;
      body = response.body;
    }
    else if (url.pathname.startsWith("/api/match/")) {
      const mid = url.pathname.split("/").pop();
      body = await options.detailResponder?.(mid, state) ?? matchDetails[mid] ?? detail;
    }
    else if (url.pathname.startsWith("/api/live/")) {
      const request = { index: state.liveRequests++, path: url.pathname, query: Object.fromEntries(url.searchParams) };
      const response = await options.liveResponder?.(request, state);
      status = response?.status ?? 200;
      body = response?.body ?? live;
      state.liveSnapshots.push(clone(body));
    }
    else if (url.pathname === "/api/pick") {
      if (options.pickDelay) await new Promise((resolve) => setTimeout(resolve, options.pickDelay));
      if (options.pickError) return route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ detail: [{ msg: "Smoothing must be nonnegative" }] }) });
      state.pickAlphas.push(url.searchParams.get("alpha"));
      state.pickQueries.push(Object.fromEntries(url.searchParams));
      body = { ...pick, role: url.searchParams.get("role") || pick.role,
        opp: url.searchParams.has("opp") ? +url.searchParams.get("opp") : null };
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
      return (box.right + scrollX > innerWidth + 1 || box.left + scrollX < -1) && !el.closest(".table-scroll, .tabs");
    }).slice(0, 8).map((el) => ({ tag: el.tagName, class: el.className, text: el.textContent.slice(0, 60), right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width }))));
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

async function assertSafeText(page) {
  assert.equal(await page.locator('.story script, .story img[src="x"], .insight script, .insight img[src="x"]').count(), 0, "Server text must not become executable HTML");
  assert.equal(await page.evaluate(() => window.fixtureXss), undefined);
}

async function assertInsightTargets(page, width) {
  const targets = await page.locator(".insight button, .insight summary, .insight select, .insight input, .insight a").evaluateAll((elements) =>
    elements.filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
      .map((el) => ({ text: el.textContent.slice(0, 45), height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width })));
  for (const target of targets) assert(target.height >= 44 && target.width >= 44, `${width}px insight target: ${JSON.stringify(target)}`);
  await assertSafeText(page);
  await noPageOverflow(page, `expanded insights ${width}`);
}

function assertLiveRolesRequest(request, game) {
  const roles = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
  const expected = { roles: game.players.map((player, i) => ({ team: player.team, champion_id: player.champion_id, role: roles[i % 5] })) };
  if (Object.hasOwn(request.body, "game_id")) expected.game_id = game.game_id;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/live/player/odds");
  assert.deepEqual(request.body, expected, "Real lineup roles and optional current game_id, with no synthetic slots");
}

async function assertOrderedBuild(slot) {
  const first = slot.locator(".build-line").first();
  assert.equal(await first.locator(".build-label").textContent(), "Buy order");
  assert.equal(await first.locator("img").count(), 3, "Timeline order preserves the three-item core layout");
  assert.deepEqual(await first.locator("img").evaluateAll((images) => images.map((image) => image.alt)),
    buildOrder.core[0].items.map((id) => meta.items[id]), "Purchase chronology, not final-inventory item slots");
  assert.deepEqual(await first.locator(".build-step small").allTextContents(), ["13 min", "21 min", "29 min"]);
  const skills = slot.locator(".build-line").filter({ has: slot.page().locator(".skill-order") });
  assert.match(await skills.textContent(), /Estimated.*partial skill sequence/);
  assert.deepEqual(await skills.locator("kbd").allTextContents(), ["Q", "E", "W"]);
}

async function assertStory(page, selector, story, width, compact = false) {
  const slot = page.locator(selector);
  await slot.locator(".story-hit").waitFor();
  assert.equal(await slot.locator(".trend-hit").count(), 0, "Story sliders do not collide with existing form-chart locators");
  assert.equal(await slot.getAttribute("aria-label"), "How the game went");
  assert.equal(await slot.locator(".story-grid.compact").count(), compact ? 1 : 0);
  const hasChance = story.minutes.some((minute) => minute.chance != null);
  assert.match(await slot.locator(".story-head").textContent(), hasChance ? /Your win chance, minute by minute/ : /Your team's gold lead, minute by minute/);
  if (hasChance) assert.match(await slot.locator(".story-swing").textContent(), /42%.*68%.*not which event caused the change/s);
  else assert.match(await slot.locator(".story-note").textContent(), /only after a model passes its held-out evaluation/);
  const hit = slot.locator(".story-hit");
  await page.mouse.move(0, 0); // Keep pointer events from replacing the keyboard-selected minute as the panel scrolls.
  await hit.focus();
  await hit.press("Home");
  assert.equal(await hit.getAttribute("aria-valuenow"), "0");
  assert.match(await hit.getAttribute("aria-valuetext"), hasChance ? /50% win chance.*0:00/ : /±0 gold.*0:00/);
  await hit.press("ArrowRight");
  assert.equal(await hit.getAttribute("aria-valuenow"), "1");
  const victim = champions[story.players.find((player) => player.participant_id === story.kills[0].victim).champion_id].name;
  assert((await hit.getAttribute("aria-valuetext")).includes(`killed ${victim}`), "Events resolve participant IDs, not champion IDs or array positions");
  await hit.press("End");
  assert.equal(await hit.getAttribute("aria-valuenow"), String(story.minutes.length - 1));
  assert.match(await hit.getAttribute("aria-valuetext"), hasChance ? /Victory/ : /\+7\.0k gold/);
  await hit.press("Escape");
  assert.equal(await slot.locator(".trend-tip").isHidden(), true);
  if (compact) {
    assert.equal(await slot.locator(".story-map, .story-build").count(), 0, "Compact trend story does not duplicate the full scoreboard");
    assert((await slot.locator("svg").boundingBox()).height <= 160, "Trend-panel story stays compact");
  } else {
    const map = slot.locator(".rift-map");
    assert.equal(await map.getAttribute("role"), "img");
    assert.match(await map.getAttribute("aria-label"), /2 marked events/);
    const killer = champions[story.players.find((player) => player.participant_id === story.deaths[0].killer).champion_id].name;
    for (const [kind, event, label] of [["kill", story.kills[0], `10:00 · you killed ${victim}`], ["death", story.deaths[0], `11:00 · killed by ${killer}`]]) {
      const point = map.locator(`.map-pt.${kind}`);
      assert.equal(await point.getAttribute("tabindex"), "0");
      assert.equal(await point.getAttribute("aria-label"), label);
      await point.focus();
      assert(await point.evaluate((el) => el === document.activeElement), "Map events expose their labels to keyboard users");
      const mark = point.locator(".mark");
      const x = story.team === 200 ? 15000 - event.x : event.x;
      const y = story.team === 200 ? 15000 - event.y : event.y;
      assert.equal(await mark.getAttribute("cx"), (x * 220 / 15000).toFixed(1), "Red-side x coordinates mirror into player-base orientation");
      assert.equal(await mark.getAttribute("cy"), (220 - y * 220 / 15000).toFixed(1), "Red-side y coordinates mirror into player-base orientation");
      const target = await point.locator(".hit").boundingBox();
      assert(target.width >= 24 && target.height >= 24, `${width}px ${kind} map hit target is ${target.width}×${target.height}px; minimum 24px`);
    }
    assert.deepEqual(await slot.locator(".story-build .build-step img").evaluateAll((images) => images.map((image) => image.alt)), ["Bloodthirster", "Infinity Edge", "Lord Dominik's Regards"]);
    assert.deepEqual(await slot.locator(".story-build .build-step small").allTextContents(), ["13 min", "21 min", "29 min"]);
    assert.match(await slot.locator(".story-build").textContent(), /Partial ability priority/);
    assert.equal(await slot.locator(".skill-seq > span").count(), story.skills.length);
  }
  await noPageOverflow(page, `${compact ? "compact" : story.team === 200 ? "red-side" : "scoreboard"} story chart ${width}`);
  const toggle = slot.locator(".story-toggle");
  await toggle.focus();
  await toggle.press("Enter");
  await slot.locator(".trend-table").waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await slot.locator("tbody tr").count(), story.minutes.length, "Every minute is readable without hover");
  assert.deepEqual(await slot.locator("thead th").allTextContents(), ["Minute", ...(hasChance ? ["Win chance"] : []), "Gold", "Kills", "What happened"]);
  assert((await slot.locator("tbody tr").nth(1).textContent()).includes(victim));
  assert.match(await slot.locator("tbody tr").last().textContent(), /31:00 · result.*\+7\.0k/s);
  assert.equal(await slot.locator("table").evaluate((table) => table.parentElement.classList.contains("table-scroll")), true);
  assert(await toggle.evaluate((el) => el === document.activeElement), "Switching chart/table preserves keyboard focus");
  await noPageOverflow(page, `story table ${width}`);
  await toggle.press("Enter");
  await slot.locator(".story-hit").waitFor();
  await assertSafeText(page);
}

async function checkWidth(browser, width) {
  const { context, page, errors, state } = await fixturePage(browser, width, { buildOrder });
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
    await assertOrderedBuild(page.locator(".build-slot"));
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
    assert.deepEqual(await page.locator(".tabs button").evaluateAll((buttons) => buttons.map((button) => button.dataset.tab)),
      ["live", "champions", "picks", "matches", "draft", "habits", "wincons"], "Insights integrate into existing tabs, not extra profile tabs");
    assert.equal(await page.locator('.tabs [data-tab="habits"]').textContent(), "Coaching & habits");
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
    await assertStory(page, "#tg-more .story", gameStory(), width, true);
    assert.equal(state.storyRequests.at(-1).puuid, "player");
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
        await assertOrderedBuild(page.locator(".pick-card").first());
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.locator(".pick-card").first().screenshot({ path: path.join(process.env.SCREENSHOTS, `pick-${width}.png`) });
        }
      } else if (tab === "matches") {
        await page.waitForSelector(".mh-row");
        await noPageOverflow(page, `matches ${width}`);
        await page.locator(".mh-row").first().click();
        await page.waitForSelector(".mh-detail table");
        assert.equal(await page.locator(".mh-row").first().getAttribute("aria-expanded"), "true");
        await assertStory(page, '#d-EUW1_123 .story', gameStory(), width);
        assert.equal(state.storyRequests.at(-1).mid, matchRow.match_id);
        assert.equal(await page.locator('#d-EUW1_123 > .story').count(), 1, "Story loads inside the match scoreboard fold-out");
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.locator("#d-EUW1_123").screenshot({ path: path.join(process.env.SCREENSHOTS, `story-${width}.png`) });
        }
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
          if (queue === "400") {
            await page.locator(".mh-row").first().click();
            await assertStory(page, `#d-${normalRow.match_id} .story`, gameStory(200), width);
          }
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
        await page.waitForFunction(() => document.querySelector(".insight-draft[aria-busy=false] .insight-grid .insight-box"));
        const draftRequest = state.insightRequests.filter((request) => request.path.endsWith("/draft")).at(-1);
        assert.equal(draftRequest.path, "/api/player/player/draft");
        assert.deepEqual(draftRequest.query, { role: "MIDDLE", range: "20", opp: "3" });
        assert.equal(await page.locator(".insight-draft > .insight-content > .insight-grid .insight-box").count(), 1, "Only sufficiently sampled own-pool counters for opp=3");
        assert.match(await page.locator(".insight-draft").textContent(), /3 games in your pool/);
        assert.match(await page.locator(".insight-draft").textContent(), /not proof of a counter/);
        assert.match(await page.locator(".insight-draft").textContent(), /Shrunk comparison score: 57\.0% — not the observed WR/);
        const matchupRow = page.locator(".insight-draft .insight-table tbody tr");
        assert.match(await matchupRow.locator("td").nth(1).textContent(), /Miss Fortune/);
        assert.match(await matchupRow.locator("td").nth(4).textContent(), /–.*n=2/);
        assert.match(await matchupRow.locator("td").nth(5).textContent(), /2W 1L.*n=0/s);
        assert.equal(state.insightRequests.filter((request) => request.path.startsWith("/api/clash/")).length, 0, "Clash lookup never auto-fetches");
        await page.locator(".insight-draft details").evaluateAll((disclosures) => disclosures.forEach((el) => { el.open = true; }));
        assert((await page.locator(".insight-draft").textContent()).includes(unsafeText));
        const teamInput = page.locator('.insight-clash-form [name="team_id"]');
        await teamInput.fill("fixture-team");
        await page.locator('.insight-clash-form [type="submit"]').click();
        await page.locator(".insight-clash-result h3").waitFor();
        assert.equal(state.insightRequests.at(-1).path, "/api/clash/euw1/fixture-team");
        assert.deepEqual(state.insightRequests.at(-1).query, { sync: "0" });
        assert.match(await page.locator(".insight-clash-result").textContent(), /Rank unavailable.*Pocket picks/s);
        assert.equal(await teamInput.inputValue(), "fixture-team");
        await page.locator(".insight-clash-form [data-sync]").click();
        await page.waitForFunction(() => !document.querySelector(".insight-clash-form [data-sync]").disabled);
        assert.deepEqual(state.insightRequests.at(-1).query, { sync: "1" }, "Only the explicit fetch requests missing team histories");
        await page.locator(".insight-draft details").evaluateAll((disclosures) => disclosures.forEach((el) => { el.open = true; }));
        await assertInsightTargets(page, width);
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.locator(".insight-draft").screenshot({ path: path.join(process.env.SCREENSHOTS, `draft-insights-${width}.png`) });
        }
        // a predicted champion folds out its build: the player's tier, or every tier while it's thinly sampled
        await page.locator("#pick-out .champ-btn").first().click();
        await page.waitForSelector("#pick-out .build-row .build-line");
        assert.equal(await page.locator("#pick-out .champ-btn").first().getAttribute("aria-expanded"), "true");
        assert(await page.locator("#pick-out .champ-btn").first().evaluate((b) => b === document.activeElement), "Focus stays on the toggle");
        assert.match(state.buildQueries.at(-1), /role=MIDDLE&tier=EMERALD&fallback=1/);
        await assertOrderedBuild(page.locator("#pick-out .build-slot"));
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
      } else if (tab === "habits") {
        await page.locator('.insight-coaching[aria-busy="false"] h2').waitFor();
        const request = state.insightRequests.filter((request) => request.path.endsWith("/coaching")).at(-1);
        assert.equal(request.path, "/api/player/player/coaching");
        assert.deepEqual(request.query, { range: "20" });
        assert.equal(await page.locator('[data-goal-action="start"]').count(), 2);
        assert.equal(await page.locator('.insight-percentile[role="meter"]').getAttribute("aria-valuenow"), "35");
        assert.equal(await page.locator(".insight-percentile").count(), 2, "Missing percentiles are not fabricated as zero");
        await page.locator('[data-goal-action="start"]').first().click();
        await page.locator(".insight-goal").waitFor();
        const goalRequest = state.insightRequests.filter((entry) => entry.path.endsWith("/goals")).at(-1);
        assert.equal(goalRequest.method, "POST");
        assert.deepEqual(goalRequest.body, { role: "MIDDLE", metric: "cs_min", target: 4.5 });
        assert.match(await page.locator(".insight-goal").textContent(), /not progress since this goal began/);
        assert.equal(await page.locator('[data-goal-action="start"]').first().isDisabled(), true);
        await page.locator('[data-goal-action="delete"]').click();
        await page.waitForFunction(() => !document.querySelector(".insight-goal"));
        const deleteRequest = state.insightRequests.filter((entry) => entry.path.endsWith("/goals")).at(-1);
        assert.equal(deleteRequest.method, "DELETE");
        assert.deepEqual(deleteRequest.query, { role: "MIDDLE", metric: "cs_min" });
        const metricsSummary = page.locator(".insight-coaching summary").filter({ hasText: "Metric comparisons and sample counts" });
        await metricsSummary.focus();
        await metricsSummary.press("Enter");
        assert.match(await page.locator(".insight-coaching table").textContent(), /CS per minute.*n=8.*n=30.*n=25/s);
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.locator(".insight-coaching").screenshot({ path: path.join(process.env.SCREENSHOTS, `coaching-insights-${width}.png`) });
        }
        await page.locator('[aria-label="Coaching role"]').selectOption("JUNGLE");
        assert.equal(await page.locator('[aria-label="Coaching role"]').inputValue(), "JUNGLE");
        assert.match(await page.locator(".insight-role-content").textContent(), /Jungle CS at 10 minutes/);
        assert(!(await page.locator(".insight-role-content").textContent()).includes("CS per minute"), "Role comparison does not reuse lane metrics for jungle");
        assert.equal(await page.locator('[role="meter"]').getAttribute("aria-valuenow"), "0", "A real zero percentile is retained");
        await page.locator(".insight-coaching details").evaluateAll((disclosures) => disclosures.forEach((el) => { el.open = true; }));
        await assertInsightTargets(page, width);
        assert.match(await page.locator('#tab-body > details > summary').textContent(), /Session habits and win-rate patterns/);
      } else if (tab === "live") {
        await page.waitForSelector(".live-team table");
        await page.locator(".insight-live h2").waitFor();
        assert.equal(await page.locator(".insight-live select").count(), 10);
        assert.deepEqual(await page.locator(".insight-live select").evaluateAll((selects) => selects.map((select) => select.value)), Array(10).fill(""), "Live roles are not inferred");
        assert.equal(state.insightRequests.filter((entry) => /^\/api\/live\/.+\/odds$/.test(entry.path)).length, 0);
        await page.locator(".insight-live summary").click();
        const roles = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
        for (let i = 0; i < 10; i++) await page.locator(".insight-live select").nth(i).selectOption(roles[i % 5]);
        await page.locator('.insight-live-form > [type="submit"]').click();
        await page.waitForFunction(() => document.querySelector(".insight-live-odds").textContent.includes("62.0%"));
        const assigned = state.insightRequests.filter((entry) => /^\/api\/live\/.+\/odds$/.test(entry.path)).at(-1);
        assert.equal(assigned.path, "/api/live/player/odds");
        assert.equal(assigned.method, "POST");
        assertLiveRolesRequest(assigned, live);
        await page.evaluate(() => tabLive()); // A real same-game polling update must preserve assignments and focus.
        assert.deepEqual(await page.locator(".insight-live select").evaluateAll((selects) => selects.map((select) => select.value)), [...roles, ...roles]);
        await page.locator(".insight-live details").evaluateAll((disclosures) => disclosures.forEach((el) => { el.open = true; }));
        await assertInsightTargets(page, width);
        if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
          await page.locator(".insight-live").screenshot({ path: path.join(process.env.SCREENSHOTS, `live-insights-${width}.png`) });
        }
      }
      await noPageOverflow(page, `${tab} ${width}`);
      const unwrapped = await page.locator("#tab-body table").evaluateAll((tables) => tables.filter((table) => !table.parentElement.classList.contains("table-scroll")).length);
      assert.equal(unwrapped, 0, `${tab}: every table should have its own scroll container`);
    }
    await page.locator('.insight-live a[href="#/odds"]').click();
    await page.locator('.insight-odds[aria-busy="false"] h1').waitFor();
    assert.equal(await page.evaluate(() => location.hash), "#/odds", "Model evidence is reachable through the integrated router");
    assert.equal(await page.locator(".insight-scorecard").count(), 2);
    assert.match(await page.locator(".insight-readiness").first().textContent(), /Ready · held-out validation passed/);
    assert.match(await page.locator(".insight-readiness").nth(1).textContent(), /Unavailable · no usable validated model/);
    assert.match(await page.locator(".insight-scorecards").textContent(), /0\.2100.*55\.0%/s);
    assert(!(await page.locator(".insight-scorecards").textContent()).includes("97%"), "Accuracy is not promoted as a guaranteed chance");
    await page.locator(".insight-odds details").evaluateAll((disclosures) => disclosures.forEach((el) => { el.open = true; }));
    await assertInsightTargets(page, width);
    if (process.env.SCREENSHOTS && [375, 1280].includes(width)) {
      await page.locator(".insight-odds").screenshot({ path: path.join(process.env.SCREENSHOTS, `odds-${width}.png`) });
    }
    assert.equal(state.timelineRequests.length, 0, "Normal profile, chart and tab navigation never fetches a Riot timeline");
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

async function fixtureUntil(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < deadline, "Expected fixture request did not arrive within five seconds");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function settleResponse(response) {
  await (await response).finished();
}
async function flushUI(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function checkStoryStates(browser, width) {
  const initial = deferred();
  const goldStory = gameStory(100, false);
  const escapedStory = gameStory();
  escapedStory.events[2].label = `Dragon ${unsafeText}`;
  let upgraded = false, otherCalls = 0;
  const fixture = await fixturePage(browser, width, {
    storyResponder: async ({ mid }, state) => {
      if (mid === matchRow.match_id) {
        if (state.storyRequests.length === 1) await initial.promise;
        return { body: upgraded ? goldStory : { available: false, can_fetch: true,
          reason: `A current timeline digest is not cached. ${unsafeText}` } };
      }
      return ++otherCalls === 1 ? { status: 503, body: { detail: `Story service unavailable. ${unsafeText}` } } : { body: escapedStory };
    },
    timelineResponder: (_request, state) => {
      if (state.timelineRequests.length === 1) return { status: 502, body: { detail: `Riot timeline unavailable. ${unsafeText}` } };
      upgraded = true;
      return { body: { ok: true } };
    },
  });
  const { page, state, errors } = fixture;
  try {
    await openHistory(page);
    await page.locator(".mh-row").first().click();
    await fixtureUntil(() => state.storyRequests.length === 1);
    assert(await page.locator("#d-EUW1_123 .story .loading").isVisible(), "Story has an explicit loading state inside the scoreboard");
    assert.equal(state.timelineRequests.length, 0);
    initial.resolve();
    const first = page.locator("#d-EUW1_123 .story");
    await first.locator(".story-fetch").waitFor();
    assert((await first.textContent()).includes(`A current timeline digest is not cached. ${unsafeText}`));
    assert.equal(await first.locator(".story-fetch").textContent(), "Load game story · 1 Riot request");
    assert.equal(await first.locator("svg, table").count(), 0, "Unavailable story is not an empty or zero chart");
    assert.equal(state.timelineRequests.length, 0, "Offering a story never silently fetches a timeline");
    await first.locator(".story-fetch").click();
    await page.waitForFunction(() => document.querySelector("#d-EUW1_123 .story [role=status]")?.textContent.includes("Riot timeline unavailable"));
    assert.deepEqual(state.timelineRequests, [{ mid: matchRow.match_id, method: "POST", body: {} }]);
    assert.equal(await first.locator(".story-fetch").isEnabled(), true, "Timeline failures leave an explicit retry action");
    assert((await first.locator("[role=status]").textContent()).includes(unsafeText));
    await assertSafeText(page);
    await noPageOverflow(page, `unavailable story ${width}`);
    await first.locator(".story-fetch").click();
    await first.locator(".story-hit").waitFor();
    assert.equal(state.timelineRequests.length, 2);
    assert.equal(state.storyRequests.length, 2, "Explicit upgrade reloads the cached story once");
    assert.equal(await first.locator(".story-swing").count(), 0, "No validated model means no fabricated win chances or estimated swing");
    await page.locator(".mh-row").first().click();
    const secondRow = page.locator(".mh-row").nth(1);
    const secondMid = await secondRow.getAttribute("data-mid");
    await secondRow.click();
    const second = page.locator(`#d-${secondMid} .story`);
    await second.locator(".error").waitFor();
    assert.equal(await second.locator(".error").textContent(), `Story service unavailable. ${unsafeText}`);
    assert.equal(await second.locator(".story-fetch").textContent(), "Retry story");
    await second.locator(".story-fetch").click();
    await second.locator(".story-hit").waitFor();
    assert.equal(state.timelineRequests.length, 2, "Retrying a failed cached GET does not issue a Riot timeline POST");
    assert((await second.locator(".story-swing").textContent()).includes(unsafeText.toLowerCase()), "Story event text is visibly escaped");
    await assertSafeText(page);
    await noPageOverflow(page, `escaped story retry ${width}`);
    await secondRow.click();
    await page.locator(".mh-row").first().click();
    await assertStory(page, "#d-EUW1_123 .story", goldStory, width);
    assert.deepEqual(errors, []);
    console.log(`PASS: story loading, explicit optional timeline, error/retry, escaped events and gold fallback at ${width}px`);
  } finally { initial.resolve(); await fixture.context.close(); }
}

async function checkInsightStates(browser, width) {
  const readOnly = await fixturePage(browser, width, { canEdit: false,
    data: { ...data, puuid: "other", profile: { ...data.profile, name: "OtherPlayer" } } });
  try {
    await readOnly.page.goto("http://rift.test/#/");
    await readOnly.page.locator(".champ-btn").first().click();
    await readOnly.page.locator(".build-row .build-line").first().waitFor();
    assert.equal(await readOnly.page.locator(".build-row .build-label").first().textContent(), "Core items");
    assert.equal(await readOnly.page.locator(".build-row .build-line").first().locator("img").count(), 3, "Legacy fixtures without build.order keep the core assertion");
    assert.equal(await readOnly.page.locator(".build-row .build-step, .build-row .skill-order").count(), 0, "Missing timeline evidence does not invent order, times or skills");
    await noPageOverflow(readOnly.page, `legacy build ${width}`);
    await readOnly.page.goto("http://rift.test/#/p/euw1/OtherPlayer%23EUW12/20");
    await readOnly.page.locator('.tabs [data-tab="habits"]').click();
    await readOnly.page.locator('.insight-coaching[aria-busy="false"] h2').waitFor();
    assert.match(await readOnly.page.locator(".insight-goals").textContent(), /Goal editing is only available for your linked account/);
    assert.equal(await readOnly.page.locator("[data-goal-action]").count(), 0, "can_edit=false is read-only even with practice targets");
    assert.equal(await readOnly.page.locator(".insight-goal").count(), 0, "Another profile must not expose private member goals");
    assert.equal(readOnly.state.insightRequests.filter((request) => request.path.endsWith("/goals")).length, 0);
    await readOnly.page.locator(".insight details").evaluateAll((disclosures) => disclosures.forEach((el) => { el.open = true; }));
    await assertInsightTargets(readOnly.page, width);
    assert.deepEqual(readOnly.errors, []);
  } finally { await readOnly.context.close(); }

  let draftCalls = 0, goalCalls = 0;
  const retries = await fixturePage(browser, width, {
    goals: [{ role: "MIDDLE", metric: "deaths", target: 3.5, created: Math.floor(now / 1000), progress: { value: 3.2, games: 2 } }],
    insightResponder: ({ path }) => {
      if (path.endsWith("/draft") && ++draftCalls === 1) return { status: 503, body: { detail: `Draft service unavailable. ${unsafeText}` } };
      if (path.endsWith("/goals") && ++goalCalls === 1) return { status: 503, body: { detail: `Goal save failed. ${unsafeText}` } };
    },
  });
  const { page, state, errors } = retries;
  try {
    await page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
    await page.locator('.tabs [data-tab="draft"]').click();
    const retry = page.locator(".insight-draft > .insight-status .insight-visible");
    await retry.waitFor();
    assert((await page.locator(".insight-draft > .insight-status").textContent()).includes(unsafeText));
    await retry.focus();
    await retry.press("Enter");
    await page.locator('.insight-draft[aria-busy="false"] h2').waitFor();
    assert.equal(draftCalls, 2, "Draft error has an explicit keyboard-operable retry");
    await page.locator('.tabs [data-tab="habits"]').click();
    await page.locator('.insight-coaching[aria-busy="false"] h2').waitFor();
    assert.match(await page.locator(".insight-goal").textContent(), /Backend progress since this goal began: 3\.2 · 2 valid samples/);
    const start = page.locator('[data-goal-action="start"]').first();
    await start.click();
    await page.waitForFunction(() => document.querySelector('[data-goal-action="start"]')?.textContent === "Retry start goal");
    assert.equal(await start.isEnabled(), true);
    assert((await page.locator(".insight-action-status").first().textContent()).includes(unsafeText));
    assert.equal(state.goals.length, 1, "Failed save leaves existing goals unchanged");
    await start.click();
    await page.waitForFunction(() => document.querySelectorAll(".insight-goal").length === 2);
    assert.equal(goalCalls, 2);
    await page.locator(".insight details").evaluateAll((disclosures) => disclosures.forEach((el) => { el.open = true; }));
    await assertInsightTargets(page, width);
    assert.deepEqual(errors, []);
    console.log(`PASS: optional build evidence, read-only coaching, goal progress and escaped retries at ${width}px`);
  } finally { await retries.context.close(); }
}

async function checkInsightStaleResponses(browser, width) {
  const storyGate = deferred(), draftGate = deferred(), goalGate = deferred(), oddsGate = deferred();
  const fixture = await fixturePage(browser, width, {
    storyResponder: async () => { await storyGate.promise; return { status: 401, body: { detail: "OBSOLETE STORY ERROR" } }; },
    insightResponder: async ({ path, query, method }) => {
      if (path.endsWith("/draft") && query.opp === "3") {
        await draftGate.promise;
        return { status: 401, body: { detail: "OBSOLETE DRAFT ERROR" } };
      }
      if (path.endsWith("/draft") && query.opp === "2") return { body: { ...draftInsights, opponent: 2, role: query.role, note: "LATEST MATCHUP NOTE" } };
      if (path.endsWith("/goals") && method === "POST") {
        await goalGate.promise;
        return { status: 401, body: { detail: "OBSOLETE GOAL ERROR" } };
      }
      if (path === "/api/odds") { await oddsGate.promise; return { status: 401, body: { detail: "OBSOLETE ODDS ERROR" } }; }
    },
  });
  const { page, state, errors } = fixture;
  try {
    await openHistory(page);
    const oldStory = page.waitForResponse((response) => response.url().includes(`/api/match/${matchRow.match_id}/story`));
    await page.locator(".mh-row").first().click();
    await fixtureUntil(() => state.storyRequests.length === 1);
    await page.locator('.tabs [data-tab="draft"]').click();
    await page.locator("#pick-out table").waitFor();
    const oldDraft = page.waitForResponse((response) => response.url().includes("/draft?") && new URL(response.url()).searchParams.get("opp") === "3");
    await page.locator("#pick-opp").focus();
    await page.locator("#pick-opp").selectOption("3");
    await fixtureUntil(() => state.insightRequests.some((request) => request.path.endsWith("/draft") && request.query.opp === "3"));
    assert.equal(await page.locator(".insight-draft").getAttribute("aria-busy"), "true");
    await page.locator("#pick-opp").selectOption("2");
    await page.waitForFunction(() => document.querySelector(".insight-draft").textContent.includes("LATEST MATCHUP NOTE"));
    storyGate.resolve(); draftGate.resolve();
    await Promise.all([settleResponse(oldStory), settleResponse(oldDraft)]);
    await flushUI(page);
    assert.equal(await page.locator("#pick-opp").inputValue(), "2");
    assert(await page.locator("#pick-opp").evaluate((el) => el === document.activeElement), "Stale responses preserve opponent focus and current selection");
    assert(!(await page.locator("body").textContent()).includes("OBSOLETE"));
    assert.equal(await page.locator("#login-form").count(), 0, "Stale story/draft 401s must not log out the current view");
    await page.locator('.tabs [data-tab="habits"]').click();
    await page.locator('[data-goal-action="start"]').first().waitFor();
    const oldGoal = page.waitForResponse((response) => response.url().includes("/goals") && response.request().method() === "POST");
    await page.locator('[data-goal-action="start"]').first().click();
    await fixtureUntil(() => state.insightRequests.some((request) => request.path.endsWith("/goals")));
    await page.locator('[aria-label="Coaching role"]').selectOption("JUNGLE");
    goalGate.resolve();
    await settleResponse(oldGoal);
    await flushUI(page);
    assert.equal(await page.locator('[aria-label="Coaching role"]').inputValue(), "JUNGLE");
    assert.equal(await page.locator(".insight-goal").count(), 0, "A stale goal mutation cannot insert another role's goals");
    assert(!(await page.locator("body").textContent()).includes("OBSOLETE"));
    const oldOdds = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/odds");
    await page.evaluate(() => { location.hash = "#/odds"; });
    await fixtureUntil(() => state.insightRequests.some((request) => request.path === "/api/odds"));
    await page.locator(".wordmark").click();
    await page.locator(".board").waitFor();
    oddsGate.resolve();
    await settleResponse(oldOdds);
    await flushUI(page);
    assert.equal(await page.locator("#login-form").count(), 0, "Late model-evidence 401 cannot invalidate the new route");
    assert.equal(await page.locator(".insight-odds").count(), 0);
    assert(!(await page.locator("body").textContent()).includes("OBSOLETE"));
    assert.equal(state.timelineRequests.length, 0);
    await noPageOverflow(page, `stale insights ${width}`);
    assert.deepEqual(errors, []);
    console.log(`PASS: integrated stale story, opponent, role-goal and odds responses at ${width}px`);
  } finally {
    storyGate.resolve(); draftGate.resolve(); goalGate.resolve(); oddsGate.resolve();
    await fixture.context.close();
  }
}

async function checkLivePolling(browser, width) {
  const firstOdds = deferred(), obsoleteOdds = deferred();
  let game = 1, oddsCalls = 0;
  const fixture = await fixturePage(browser, width, {
    liveResponder: ({ index }) => ({ body: { ...clone(live), game_id: live.game_id + game,
      started: now - (game === 1 ? 120000 : 60000), pending: 1,
      players: live.players.map((player) => ({ ...player, lp: 42 + index })) } }),
    insightResponder: async ({ path }) => {
      if (path !== "/api/live/player/odds") return;
      if (++oddsCalls === 1) { await firstOdds.promise; return { body: livePrediction }; }
      if (oddsCalls === 2) { await obsoleteOdds.promise; return { body: { ...livePrediction, blue: 0.99, red: 0.01 } }; }
      return { body: { ...livePrediction, blue: 0.73, red: 0.27 } };
    },
  });
  const { page, state, errors } = fixture;
  const nextPoll = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/live/player"
    && response.request().method() === "GET", { timeout: 15000 });
  const nextOdds = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/live/player/odds");
  const assign = async () => {
    const roles = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
    for (let i = 0; i < 10; i++) await page.locator(".insight-live select").nth(i).selectOption(roles[i % 5]);
  };
  try {
    await page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
    await page.locator('.tabs [data-tab="live"]').click();
    await page.locator(".insight-live summary").click();
    await assign();
    await page.locator(".insight-live select").first().focus();
    await page.evaluate(() => {
      window.liveRefs = { slot: document.querySelector("#live-insights"), host: document.querySelector(".insight-live"),
        form: document.querySelector(".insight-live-form"), select: document.querySelector(".insight-live select") };
    });
    // Use the real five-second interval, not a direct module mount or synthetic render.
    await settleResponse(nextPoll());
    await page.waitForFunction(() => document.querySelector(".live-team tbody tr td:nth-child(2)").textContent.includes("43 LP"));
    assert(await page.evaluate(() => document.querySelector("#live-insights") === liveRefs.slot
      && document.querySelector(".insight-live") === liveRefs.host && document.querySelector(".insight-live-form") === liveRefs.form
      && document.querySelector(".insight-live select") === liveRefs.select && document.activeElement === liveRefs.select),
    "Same-game polling retains the actual insights slot, form, role select and keyboard focus");
    assert.deepEqual(await page.locator(".insight-live select").evaluateAll((selects) => selects.map((select) => select.value)),
      ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"]);
    assert.equal(oddsCalls, 0, "Polling does not calculate pregame odds automatically");
    const pending = nextOdds();
    await page.locator('.insight-live-form > [type="submit"]').click();
    await fixtureUntil(() => oddsCalls === 1);
    assertLiveRolesRequest(state.insightRequests.at(-1), state.liveSnapshots.at(-1));
    const pendingPoll = nextPoll();
    await settleResponse(pendingPoll);
    await flushUI(page);
    assert(await page.evaluate(() => document.querySelector("#live-insights") === liveRefs.slot
      && document.querySelector(".insight-live-form") === liveRefs.form && liveRefs.form.isConnected),
    "Polling cannot detach the form that owns an in-flight pregame request");
    assert.equal(await page.locator('.insight-live-form > [type="submit"]').isDisabled(), true);
    assert.match(await page.locator(".insight-live-form .insight-status").textContent(), /Calculating pregame odds/);
    assert.equal(oddsCalls, 1);
    firstOdds.resolve();
    await settleResponse(pending);
    await page.waitForFunction(() => document.querySelector(".insight-live-odds").textContent.includes("62.0%"));
    assert.equal(await page.locator('.insight-live-form > [type="submit"]').isEnabled(), true);
    assert.equal(await page.locator(".insight-live select:disabled").count(), 0);
    assert(await page.locator(".insight-live-form").evaluate((form) => form.closest("details").open), "Role-assignment disclosure stays open through same-game polling and odds completion");
    const stale = nextOdds();
    await page.locator('.insight-live-form > [type="submit"]').click();
    await fixtureUntil(() => oddsCalls === 2);
    assertLiveRolesRequest(state.insightRequests.at(-1), state.liveSnapshots.at(-1));
    const changed = nextPoll();
    game = 2;
    await settleResponse(changed);
    await page.waitForFunction(() => document.querySelector("#live-insights") !== liveRefs.slot);
    assert(await page.evaluate(() => !liveRefs.slot.isConnected && !liveRefs.form.isConnected), "A new game invalidates the old form and its request guard");
    assert.deepEqual(await page.locator(".insight-live select").evaluateAll((selects) => selects.map((select) => select.value)), Array(10).fill(""), "New game requires fresh explicit role assignments");
    assert(!(await page.locator(".insight-live-odds").textContent()).includes("62.0%"), "Previous game's probability is cleared");
    obsoleteOdds.resolve();
    await settleResponse(stale);
    await flushUI(page);
    assert(!(await page.locator(".insight-live-odds").textContent()).includes("99.0%"), "Late pregame success for the previous game must not apply");
    assert.equal(await page.locator("#login-form").count(), 0);
    assert.equal(await page.locator('.insight-live-form > [type="submit"]').isEnabled(), true);
    await page.locator(".insight-live summary").click();
    await assign();
    await page.locator('.insight-live-form > [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector(".insight-live-odds").textContent.includes("73.0%"));
    assert.equal(oddsCalls, 3, "New-game odds are only requested after explicit reassignment");
    assertLiveRolesRequest(state.insightRequests.at(-1), state.liveSnapshots.at(-1));
    await noPageOverflow(page, `live polling ${width}`);
    assert.deepEqual(errors, []);
    console.log(`PASS: real same-game polling retains DOM/focus and gated odds; new game cancels stale odds at ${width}px`);
  } finally { firstOdds.resolve(); obsoleteOdds.resolve(); await fixture.context.close(); }
}

async function checkProfileRefresh(browser, width) {
  const coachingGate = deferred();
  let revision = 0, holdCoaching = false;
  const initial = clone(data);
  initial.overview.roles.push({ ...clone(initial.overview.roles[0]), role: "BOTTOM", games: 8, share: 0.3 });
  const updatedAnalysis = () => {
    const fresh = clone(initial);
    fresh.overview.record = winrate(40 + revision, 30);
    fresh.vs_rank.rows[0].player = winrate(40 + revision, 20 + revision);
    fresh.overview.momentum.after_win = winrate(30 + revision, 20 + revision);
    fresh.overview.time_of_day = [{ label: `Updated morning ${revision}`, ...winrate(10 + revision, 8) }];
    fresh.overview.duration = [{ label: `Updated game length ${revision}`, ...winrate(15 + revision, 9) }];
    fresh.overview.conversion[0].label = `Updated first tower ${revision}`;
    return fresh;
  };
  const updatedPicks = () => {
    const fresh = clone(picks);
    const rows = fresh.roles[0].picks;
    fresh.roles[0].picks = [...rows.slice(revision % rows.length), ...rows.slice(0, revision % rows.length)]
      .map((row) => ({ ...row, ...winrate(120 + revision, 66 + revision) }));
    return fresh;
  };
  const fixture = await fixturePage(browser, width, {
    data: initial,
    analysisResponder: () => { revision++; return { body: updatedAnalysis() }; },
    picksResponder: () => ({ body: updatedPicks() }),
    insightResponder: async ({ path }) => {
      if (!path.endsWith("/coaching")) return;
      const fresh = clone(coachingInsights);
      fresh.roles[1].takeaway = `Fresh jungle coaching ${revision}`;
      fresh.roles[1].metrics[0].you = 10 + revision;
      if (holdCoaching) await coachingGate.promise;
      return { body: fresh };
    },
  });
  const { page, state, errors } = fixture;
  const refresh = () => page.evaluate(() => refreshAnalysis());
  const assertSummary = async () => {
    const summary = page.locator("#player-body > .tiles > .tile").first();
    assert.match(await summary.textContent(), new RegExp(`Win rate · ${40 + revision} games`));
    assert((await summary.textContent()).includes(`${Math.round(3000 / (40 + revision))}%`), "Main stat summary uses refreshed DATA, independently of preserved tab frames");
    assert.equal(await page.locator("#live-banner").count(), 1, "Analysis refresh preserves the live flag from the full profile lookup");
  };
  try {
    await page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
    await page.locator("#tab-body tbody tr").first().waitFor();
    assert.equal(await page.locator("#tab-body tbody tr").first().locator("td").nth(2).textContent(), "20");
    await page.evaluate(() => { window.oldChampionTab = document.querySelector("#tab-body"); });
    await refresh();
    assert.equal(revision, 1);
    assert.equal(await page.locator("#tab-body tbody tr").first().locator("td").nth(2).textContent(), "41", "Champion comparison games must refresh, not retain old table markup");
    assert(await page.evaluate(() => document.querySelector("#tab-body") !== oldChampionTab && !oldChampionTab.isConnected));
    await assertSummary();
    await page.locator('.tabs [data-tab="picks"]').click();
    await page.locator(".pick-card .build-line").first().waitFor();
    assert.equal(await page.locator(".pick-head b").first().textContent(), "Nunu & Willump");
    assert.match(await page.locator(".pick-head").first().textContent(), /121 games/);
    await page.evaluate(() => { window.oldPicksTab = document.querySelector("#tab-body"); });
    await refresh();
    await page.waitForFunction(() => document.querySelector(".pick-head b")?.textContent === "Miss Fortune");
    assert.equal(revision, 2);
    assert.equal(state.picksRequests.length, 2, "refreshAnalysis invalidates the range-keyed suggested-picks cache");
    assert.deepEqual(state.picksRequests.map((request) => [request.path, request.query.range]),
      [["/api/player/player/picks", "20"], ["/api/player/player/picks", "20"]]);
    assert.match(await page.locator(".pick-head").first().textContent(), /122 games/);
    assert(await page.evaluate(() => document.querySelector("#tab-body") !== oldPicksTab && !oldPicksTab.isConnected));
    await assertSummary();
    await page.locator('.tabs [data-tab="habits"]').click();
    await page.locator('.insight-coaching[aria-busy="false"] h2').waitFor();
    await page.locator('[aria-label="Coaching role"]').selectOption("JUNGLE");
    await page.locator('#tab-body > details > summary').click();
    const metricDetails = page.locator(".insight-role-content details").filter({ has: page.getByText("Metric comparisons and sample counts", { exact: true }) });
    await metricDetails.locator("summary").click();
    assert.match(await page.locator("#habit-tables").textContent(), /Updated morning 2/);
    await page.locator('[aria-label="Coaching role"]').focus();
    await page.evaluate(() => {
      window.coachingRefs = { tab: document.querySelector("#tab-body"), slot: document.querySelector("#coaching-insights"),
        host: document.querySelector(".insight-coaching"), habits: document.querySelector("#tab-body > details"),
        select: document.querySelector('[aria-label="Coaching role"]') };
    });
    holdCoaching = true;
    await refresh();
    await page.locator('.insight-coaching[aria-busy="true"]').waitFor();
    assert.equal(revision, 3);
    assert(await page.evaluate(() => document.querySelector("#tab-body") === coachingRefs.tab
      && document.querySelector("#coaching-insights") === coachingRefs.slot && document.querySelector(".insight-coaching") === coachingRefs.host
      && document.querySelector("#tab-body > details") === coachingRefs.habits && coachingRefs.habits.open
      && document.activeElement === coachingRefs.select), "Analysis redraw retains the Coaching frame, native habits disclosure and focused role control");
    const afterWin = page.locator("#habit-tables tbody tr").filter({ has: page.getByText("After a win", { exact: true }) });
    assert.equal(await afterWin.locator("td").last().locator(".muted.small").textContent(), "33", "Habits refresh even while the separate coaching API is still pending");
    assert.match(await page.locator("#habit-tables").textContent(), /Updated morning 3.*Updated game length 3/s);
    assert(!(await page.locator("#habit-tables").textContent()).includes("Updated morning 2"));
    await assertSummary();
    coachingGate.resolve(); holdCoaching = false;
    await page.waitForFunction(() => document.querySelector('.insight-coaching[aria-busy="false"]')
      && document.querySelector(".insight-role-content")?.textContent.includes("Fresh jungle coaching 3"));
    assert.equal(await page.locator('[aria-label="Coaching role"]').inputValue(), "JUNGLE");
    assert(await page.locator('[aria-label="Coaching role"]').evaluate((el) => el === document.activeElement), "Successful coaching refresh restores role-control focus");
    assert.equal(await metricDetails.getAttribute("open"), "", "Expanded metric comparisons survive coaching redraw");
    assert.match(await page.locator(".insight-role-content table tbody td").first().textContent(), /13\.0/);
    assert(await page.evaluate(() => document.querySelector(".insight-coaching") === coachingRefs.host));
    await noPageOverflow(page, `refreshed coaching ${width}`);
    await page.locator('.tabs [data-tab="wincons"]').click();
    assert.match(await page.locator("#tab-body").textContent(), /Updated first tower 3/);
    await page.evaluate(() => { window.oldWinconsTab = document.querySelector("#tab-body"); });
    await refresh();
    assert.equal(revision, 4);
    assert.match(await page.locator("#tab-body").textContent(), /Updated first tower 4/);
    assert(!(await page.locator("#tab-body").textContent()).includes("Updated first tower 3"));
    assert(await page.evaluate(() => document.querySelector("#tab-body") !== oldWinconsTab && !oldWinconsTab.isConnected));
    await assertSummary();
    await page.locator('.tabs [data-tab="draft"]').click();
    await page.locator("#pick-out table").waitFor();
    await page.locator('#pick-opp').selectOption("3");
    await page.locator('.role-card[data-role="BOTTOM"]').click();
    await page.waitForFunction(() => document.querySelector('.insight-draft[aria-busy="false"] .insight-eyebrow')?.textContent.startsWith("Bot"));
    assert.equal(await page.locator("#pick-opp").inputValue(), "", "Changing lane resets the lane-opponent context");
    assert.equal(state.pickQueries.at(-1).role, "BOTTOM");
    assert.equal(state.insightRequests.filter((request) => request.path.endsWith("/draft")).at(-1).query.role, "BOTTOM");
    await page.locator("#pick-alpha").fill("0");
    await page.locator("#pick-alpha").dispatchEvent("change");
    await page.locator("#pick-opp").selectOption("3");
    await page.waitForFunction(() => document.querySelector('.insight-draft[aria-busy="false"] .insight-grid'));
    await page.locator(".insight-draft summary").filter({ hasText: "Clash scouting" }).click();
    const teamInput = page.locator('.insight-clash-form [name="team_id"]');
    await teamInput.fill("unfinished-team");
    await teamInput.focus();
    await teamInput.evaluate((el) => el.setSelectionRange(3, 8));
    await page.evaluate(() => { window.draftRefs = { tab: document.querySelector("#tab-body"), host: document.querySelector(".insight-draft") }; });
    await refresh();
    await page.locator('.insight-draft[aria-busy="false"] h2').waitFor();
    assert.equal(revision, 5);
    assert(await page.evaluate(() => document.querySelector("#tab-body") === draftRefs.tab && document.querySelector(".insight-draft") === draftRefs.host), "Draft retains its frame during analysis refresh");
    assert.equal(await page.locator(".role-card.active").getAttribute("data-role"), "BOTTOM");
    assert.equal(await page.locator("#pick-alpha").inputValue(), "0");
    assert.equal(await page.locator("#pick-opp").inputValue(), "3");
    assert.equal(await teamInput.inputValue(), "unfinished-team");
    assert(await teamInput.evaluate((el) => el === document.activeElement && el.selectionStart === 3 && el.selectionEnd === 8), "Draft refresh preserves pending Clash input, focus and caret");
    assert.deepEqual(state.insightRequests.filter((request) => request.path.endsWith("/draft")).at(-1).query, { role: "BOTTOM", range: "20", opp: "3" });
    assert.equal(state.pickQueries.at(-1).role, "BOTTOM");
    assert.equal(state.pickQueries.at(-1).alpha, "0");
    await assertSummary();
    await page.locator('.tabs [data-tab="habits"]').click();
    await page.locator('.insight-coaching[aria-busy="false"] h2').waitFor();
    assert.equal(await page.locator('[aria-label="Coaching role"]').inputValue(), "JUNGLE", "Coaching role persists across tab switches and is independent of Draft lane");
    assert.deepEqual(state.analysisRequests.map((request) => [request.path, request.query.range]), Array.from({ length: 5 }, () => ["/api/player/player/analysis", "20"]));
    await noPageOverflow(page, `profile refresh ${width}`);
    assert.deepEqual(errors, []);
    console.log(`PASS: fresh champion/picks/win-condition tables, retained coaching/habits and Draft lane/input at ${width}px`);
  } finally { coachingGate.resolve(); await fixture.context.close(); }
}

async function checkDraftRoleRefresh(browser, width) {
  const initial = clone(data);
  initial.overview.roles = [{ role: "BOTTOM", games: 8, share: 1, wr: 0.5,
    pool: { effective_pool: 2, top: [{ champion_id: 3 }] } }];
  let revision = 0;
  const fixture = await fixturePage(browser, width, {
    data: initial,
    analysisResponder: () => {
      const fresh = clone(initial);
      revision++;
      fresh.overview.roles = revision === 3 ? [{ ...initial.overview.roles[0], role: "UNKNOWN" }] : [
        { role: "BOTTOM", games: revision === 1 ? 18 : 20, share: revision === 1 ? 0.6 : 0.55,
          wr: revision === 1 ? 2 / 3 : 0.7,
          pool: { effective_pool: revision === 1 ? 3.5 : 4, top: [{ champion_id: 1 }, { champion_id: 3 }] } },
        { role: "JUNGLE", games: revision === 1 ? 12 : 15, share: revision === 1 ? 0.4 : 0.45,
          wr: revision === 1 ? 0.75 : 0.8, pool: { effective_pool: 1.5, top: [{ champion_id: 2 }] } },
      ];
      fresh.mastery.pockets = [{ champion_id: 6, points: 50000, level: 8, last_play: now }];
      return { body: fresh };
    },
  });
  const { page, state, errors } = fixture;
  const teamInput = page.locator('.insight-clash-form [name="team_id"]');
  const waitDraft = () => page.locator('.insight-draft[aria-busy="false"] h2').waitFor();
  const assertRetained = async () => {
    assert(await page.evaluate(() => document.querySelector("#tab-body") === growingDraftRefs.tab
      && document.querySelector("#draft-insights") === growingDraftRefs.slot
      && document.querySelector(".insight-draft") === growingDraftRefs.host
      && document.querySelector("#pick-alpha") === growingDraftRefs.alpha
      && document.querySelector("#pick-opp") === growingDraftRefs.opponent), "Fresh role cards must not replace the Draft frame, insights panel or predictor controls");
    assert.equal(await page.locator("#pick-alpha").inputValue(), "0");
    assert.equal(await teamInput.inputValue(), "unfinished-clash-team");
    assert.equal(await page.locator('.insight-clash-form [name="platform"]').inputValue(), "na1");
    assert(await teamInput.evaluate((el) => el.closest("details").open && el.selectionStart === 3 && el.selectionEnd === 8), "Clash disclosure, input and caret survive role-data refreshes");
    assert.equal(await page.locator(".tabs .active").getAttribute("data-tab"), "draft");
  };
  try {
    await page.goto("http://rift.test/#/p/euw1/LongPlayerName%23EUW12/20");
    await page.locator('.tabs [data-tab="draft"]').click();
    await page.locator("#pick-out table").waitFor();
    await waitDraft();
    assert.deepEqual(await page.locator("#draft-roles .role-card").evaluateAll((cards) => cards.map((card) => card.dataset.role)), ["BOTTOM"]);
    assert.match(await page.locator('#draft-roles [data-role="BOTTOM"] .meta').textContent(), /8 games · 50% WR · plays like 2\.0 champs/);
    assert.equal(await page.locator("#draft-pockets .pocket b").textContent(), "Nunu & Willump");
    assert.match(await page.locator("#pick-role-description").textContent(), /pick in Bot/);
    await page.locator("#pick-alpha").fill("0");
    await page.locator("#pick-alpha").dispatchEvent("change");
    await page.locator("#pick-opp").selectOption("3");
    await page.waitForFunction(() => document.querySelector('.insight-draft[aria-busy="false"] .insight-grid'));
    await page.locator("#pick-out .champ-btn").first().click();
    await page.locator("#pick-out .build-row .build-line").first().waitFor();
    await page.locator(".insight-draft summary").filter({ hasText: "Clash scouting" }).click();
    await teamInput.fill("unfinished-clash-team");
    await page.locator('.insight-clash-form [name="platform"]').selectOption("na1");
    await teamInput.focus();
    await teamInput.evaluate((el) => el.setSelectionRange(3, 8));
    await page.evaluate(() => {
      window.growingDraftRefs = { tab: document.querySelector("#tab-body"), slot: document.querySelector("#draft-insights"),
        host: document.querySelector(".insight-draft"), alpha: document.querySelector("#pick-alpha"),
        opponent: document.querySelector("#pick-opp"), bottom: document.querySelector('#draft-roles [data-role="BOTTOM"]') };
    });
    await page.evaluate(() => refreshAnalysis());
    await waitDraft();
    await page.locator("#pick-out .build-row .build-line").first().waitFor();
    assert.equal(revision, 1);
    await assertRetained();
    assert.deepEqual(await page.locator("#draft-roles .role-card").evaluateAll((cards) => cards.map((card) => card.dataset.role)), ["BOTTOM", "JUNGLE"], "Newly analysed Jungle games expose the role without leaving Draft");
    assert.equal(await page.locator("#draft-roles .active").getAttribute("data-role"), "BOTTOM");
    assert.equal(await page.locator("#draft-roles .active").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('#draft-roles [data-role="BOTTOM"] .share').textContent(), "60%");
    assert.match(await page.locator('#draft-roles [data-role="BOTTOM"] .meta').textContent(), /18 games · 67% WR · plays like 3\.5 champs/);
    assert.deepEqual(await page.locator('#draft-roles [data-role="BOTTOM"] .icons img').evaluateAll((images) => images.map((image) => image.getAttribute("src"))), [champions[1].icon, champions[3].icon]);
    assert.equal(await page.locator('#draft-roles [data-role="JUNGLE"] .share').textContent(), "40%");
    assert.match(await page.locator('#draft-roles [data-role="JUNGLE"] .meta').textContent(), /12 games · 75% WR · plays like 1\.5 champs/);
    assert.equal(await page.locator("#draft-pockets .pocket b").textContent(), "Braum", "Pocket picks are redrawn from refreshed mastery data");
    assert.match(await page.locator("#draft-pockets .pocket").textContent(), /50(?:\.0)?k pts · M8/);
    assert.equal(await page.locator("#pick-opp").inputValue(), "3");
    assert.equal(await page.locator("#pick-out .champ-btn").first().getAttribute("aria-expanded"), "true", "Refreshing evidence for the same role preserves the open build");
    assert(await teamInput.evaluate((el) => el === document.activeElement), "Fresh role/pocket data must not steal Clash-input focus");
    assert(await page.evaluate(() => !growingDraftRefs.bottom.isConnected), "Role cards really redraw rather than showing stale counts");
    assert.deepEqual(state.insightRequests.filter((request) => request.path.endsWith("/draft")).at(-1).query, { role: "BOTTOM", range: "20", opp: "3" });
    await noPageOverflow(page, `new Draft role ${width}`);
    await page.locator('#draft-roles [data-role="BOTTOM"]').focus();
    await page.evaluate(() => refreshAnalysis());
    await waitDraft();
    assert.equal(revision, 2);
    await assertRetained();
    assert.equal(await page.locator("#pick-opp").inputValue(), "3");
    assert.equal(await page.locator('#draft-roles [data-role="BOTTOM"] .share').textContent(), "55%");
    assert.match(await page.locator('#draft-roles [data-role="BOTTOM"] .meta').textContent(), /20 games · 70% WR · plays like 4\.0 champs/);
    assert(await page.locator('#draft-roles [data-role="BOTTOM"]').evaluate((card) => card === document.activeElement), "A focused role card retains keyboard focus when its counts redraw");
    const jungle = page.locator('#draft-roles [data-role="JUNGLE"]');
    await jungle.focus();
    await jungle.press("Enter");
    await page.waitForFunction(() => document.querySelector('.insight-draft[aria-busy="false"] .insight-eyebrow')?.textContent.startsWith("Jungle")
      && document.querySelector("#pick-out table") && !document.querySelector("#pick-out .build-row"));
    await assertRetained();
    assert.equal(await page.locator("#draft-roles .active").getAttribute("data-role"), "JUNGLE");
    assert.equal(await page.locator("#draft-roles .active").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('#draft-roles [data-role="BOTTOM"]').getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#pick-opp").inputValue(), "", "Changing to a newly available role clears its old opponent context");
    assert.equal(await page.locator("#pick-out .build-row").count(), 0);
    assert.equal(await page.locator("#pick-out .champ-btn").first().getAttribute("aria-expanded"), "false", "Old-role build state is cleared");
    assert.match(await page.locator("#pick-role-description").textContent(), /pick in Jungle/);
    assert(await jungle.evaluate((card) => card === document.activeElement), "Keyboard role activation keeps focus on the newly redrawn Jungle card");
    assert.deepEqual(state.insightRequests.filter((request) => request.path.endsWith("/draft")).at(-1).query, { role: "JUNGLE", range: "20" });
    assert.equal(state.pickQueries.at(-1).role, "JUNGLE");
    assert.equal(state.pickQueries.at(-1).opp, undefined);
    assert.equal(state.pickQueries.at(-1).alpha, "0");
    assert.equal(state.insightRequests.filter((request) => request.path.startsWith("/api/clash/")).length, 0, "Preserving unfinished scouting input never fetches Clash automatically");
    await noPageOverflow(page, `switched Draft role ${width}`);
    const insightCalls = state.insightRequests.length, pickCalls = state.pickQueries.length;
    await page.evaluate(() => refreshAnalysis());
    await flushUI(page);
    assert.equal(revision, 3);
    assert.match(await page.locator("#tab-body .empty").textContent(), /No games with a known role/);
    assert.equal(await page.locator("#draft-roles, #draft-pockets, #draft-insights, #pick-opp").count(), 0, "No-known-role refresh returns to the native empty guard");
    assert.equal(state.insightRequests.length, insightCalls);
    assert.equal(state.pickQueries.length, pickCalls, "An empty role set must not request an undefined or UNKNOWN lane");
    assert.deepEqual(errors, []);
    await noPageOverflow(page, `empty Draft roles ${width}`);
    console.log(`PASS: fresh Draft roles/pockets, preserved controls/focus/Clash input, new-role reset and empty guard at ${width}px`);
  } finally { await fixture.context.close(); }
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
    const failures = [];
    const run = async (label, check) => {
      try { await check(); }
      catch (error) { failures.push(label); console.error(`FAIL: ${label}\n${error.stack}`); }
    };
    for (const width of [320, 375, 390, 768, 1280]) {
      await run(`integrated UI ${width}px`, () => checkWidth(browser, width));
      await run(`story states ${width}px`, () => checkStoryStates(browser, width));
      await run(`insight states ${width}px`, () => checkInsightStates(browser, width));
      await run(`stale insights ${width}px`, () => checkInsightStaleResponses(browser, width));
      await run(`live polling ${width}px`, () => checkLivePolling(browser, width));
      await run(`profile refresh ${width}px`, () => checkProfileRefresh(browser, width));
      await run(`Draft role refresh ${width}px`, () => checkDraftRoleRefresh(browser, width));
    }
    for (const width of [320, 1280]) await run(`admin ${width}px`, () => checkAdmin(browser, width));
    for (const check of [checkRankStates, checkUnrankedHistory, checkHistoryPaginationRace, checkHistoryInitialRace,
      checkHistoryRetries, checkRandomBuildStates, checkRandomBuildStaleResponses, checkStates]) {
      await run(check.name, () => check(browser));
    }
    if (failures.length) { console.error(`FAILED ${failures.length} checks: ${failures.join(", ")}`); process.exitCode = 1; }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
