// Standalone optional browser suite; no server, real API calls, or mobile.cjs fixture changes.
// Reuse the existing optional browser tooling: NODE_PATH=.browser-tools/node_modules node tests/insights.cjs
// Supports BROWSER and PLAYWRIGHT_EXECUTABLE_PATH, like tests/mobile.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
// Load the real shared helpers/lexical state, but not the SPA's startup and hashchange footer.
const footer = source.lastIndexOf('\n$("#logout").addEventListener');
assert(footer > 0, 'Update the standalone harness if the app startup footer changes');
const app = source.slice(0, footer);
const insights = fs.readFileSync(path.join(root, 'static/insights.js'), 'utf8');
const css = ['style.css', 'insights.css'].map((file) => fs.readFileSync(path.join(root, 'static', file), 'utf8')).join('\n');
const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const roles = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const meta = { default_range: '40', platforms: ['euw1', 'na1'], champions: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, { name: `Champion ${i + 1}`, icon: pixel }])) };
const wr = (games = 20, wins = 12) => ({ games, wins, wr: games ? wins / games : null, lo: games ? .4 : null, hi: games ? .78 : null });
const matchup = { champion_id: 1, opponent_id: 9, ...wr(), score: .55, gold10: { mean: 150, games: 8 }, gold15: { mean: null, games: 2 }, you: { ...wr(3, 2), gold10: { mean: -20, games: 3 }, gold15: { mean: null, games: 0 } } };
const draft = { patch: '16.20', tier: 'GOLD', role: 'TOP', opponent: 9, matchups: [matchup], counters: [{ ...matchup, pool_games: 3, reason: 'Your selected pool; not proof of a counter.' }, { ...matchup, champion_id: 12, pool_games: 0 }], note: 'Same-patch peer samples. <img src=x onerror=alert(1)> is escaped.' };
const metric = (key, label, you = 4, unit = '{:.1f}', better = 1) => ({ key, label, unit, better, you, current: you + better, next: you + 2 * better, percentile: 35, games: 8, baseline_games: 30, next_games: 25, recent: { value: you + .2 * better, games: 4 }, previous: { value: you, games: 4 }, target: you + .5 * better, target_tier: 'PLATINUM', advice: 'Review decisions, not just the count.' });
const metrics = [metric('cs_min', 'CS per minute'), metric('deaths', 'Deaths per game', 4, '{:.1f}', -1), { ...metric('kp', 'Kill participation', .5, 'pct'), current: .6, next: .7, target: .6 }];
const coaching = { patch: '16.20', tier: 'GOLD', next_tier: 'PLATINUM', can_edit: true, goals: [], roles: [
  { role: 'TOP', games: 12, metrics, focus: metrics, fingerprint: [{ key: 'farming', label: 'Farming', percentile: 35 }, { key: 'safety', label: 'Death frequency (context matters)', percentile: null }], takeaway: 'Five player and twenty peer samples per metric. <script>unsafe()</script>' },
  { role: 'JUNGLE', games: 6, metrics: [metric('jungle_cs10', 'Jungle CS at 10 minutes')], focus: [], fingerprint: [{ key: 'farming', label: 'Farming', percentile: 0 }], takeaway: 'Jungle-specific comparisons only.' },
], forecast: { available: true, reason: 'observed_positive_pace', lp_per_game: 12, observations: 3, games: 12, next_lp: 220, target: { tier: 'PLATINUM', division: 'IV', lp: 0 }, estimated_games: 19, uncertainty: { lp_per_game_lo: -2, lp_per_game_hi: 20, estimated_games_lo: 11, estimated_games_hi: null }, note: 'Conditional displayed LP, not a promise.' } };
const report = { ready: true, validation: { passed: true }, train_games: 16, train_samples: 96, test_games: 4, test_samples: 24, features: ['gold_diff', 'draft_strength'], overall: { games: 4, samples: 24, accuracy: .97, brier: .21, log_loss: .61, coin_brier: .25, coin_log_loss: Math.log(2), baseline: { brier: .24, log_loss: .68 }, calibration: [{ lo: .5, hi: .6, predicted: .55, observed: .5, samples: 12, games: 3 }, { lo: .6, hi: .7, predicted: .65, observed: .75, samples: 12, games: 2 }] }, split: { method: 'chronological matches; TRAIN completed before TEST', train_first_start: 1760000000000, train_last_start: 1760010000000, test_first_start: 1760020000000, test_last_start: 1760030000000, excluded_overlapping_games: 2 }, feature_policy: 'earlier completed games for TRAIN; frozen TRAIN for TEST', fit_policy: 'TRAIN only; no holdout refit', limitations: ['Repeated minute samples are correlated.'] };
const odds = { pregame: { ready: true, trained_at: 1760050000, report }, ingame: { ready: false, reason: 'Held-out scores failed the baseline', report } };
const prediction = { ready: true, blue: .62, red: .38, coverage: { draft: { known_slots: 10, supported_slots: 7 }, matchups: { supported_roles: 3 }, players: { eligible: 4 }, source: 'Frozen TRAIN only.' } };
const live = { in_game: true, game_id: 99, started: 1760050000000, odds: { ready: false, blue: .95, red: .05, reason: 'Explicit roles required' }, players: Array.from({ length: 10 }, (_, i) => ({ team: i < 5 ? 100 : 200, champion_id: i + 1, role: 'JUNGLE', tier: 'GOLD', riot_id: `Player ${i}`, hidden: i === 0, jungle: i === 1 ? { games: 10, start: { red: 4, blue: 3 }, early_jungle_proxy: { label: 'Early jungle side at 2:00 (proximity proxy, not starting buff)', observed: 7, unknown: 3 }, invades: 1, first_gank: { games: 5, label: 'First lane takedown before 10:00 (not all ganks)', lanes: { top: 2, mid: 3 }, median_t: 180 }, lane_takedowns_per_game: .7 } : null })) };
const clash = { team: { name: 'Team <script>bad()</script>', tag: 'TEST', tier: 2 }, members: [{ puuid: 'other', riot_id: 'Scout <img src=x>', role: 'TOP', tier: null, cached_games: 20, pending: true, pool: [{ champion_id: 1, ...wr(10, 6) }], pockets: [{ champion_id: 2, points: 30000, predicted: false }] }], bans: [{ champion_id: 1, games: 10, share: .5 }], pending: true, note: 'Ban share is a game-weighted roster frequency, not a pick probability.' };
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Fixture request did not arrive'); await new Promise((done) => setTimeout(done, 10)); }
}
async function fixture(browser, width = 375, responder) {
  const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], state = { requests: [], goals: [] };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="app"><div id="slot"></div></main></body></html>' });
    const entry = { url, method: request.method(), body: request.postDataJSON() };
    state.requests.push(entry);
    const overridden = responder ? await responder(entry, state) : null;
    let body, status = overridden?.status || 200;
    if (overridden) body = overridden.body;
    else if (url.pathname.endsWith('/draft')) body = { ...clone(draft), role: url.searchParams.get('role'), opponent: url.searchParams.has('opp') ? +url.searchParams.get('opp') : null };
    else if (url.pathname.endsWith('/coaching')) body = { ...clone(coaching), goals: clone(state.goals) };
    else if (url.pathname.endsWith('/goals')) {
      if (entry.method === 'POST') state.goals = [{ ...entry.body, puuid: 'me', created: 1760050010 }];
      else state.goals = state.goals.filter((goal) => goal.role !== url.searchParams.get('role') || goal.metric !== url.searchParams.get('metric'));
      body = { goals: state.goals };
    } else if (url.pathname === '/api/odds') body = odds;
    else if (url.pathname.startsWith('/api/clash/')) body = clash;
    else if (url.pathname === '/api/live/me/odds') body = prediction;
    else { status = 404; body = { detail: `Unexpected fixture request ${url.pathname}` }; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('https://insights.test/#/p/euw1/Test%23ONE/40');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: app });
  await page.addScriptTag({ content: insights });
  await page.evaluate((fixtureMeta) => {
    META = fixtureMeta; DATA = { puuid: 'me', profile: { platform: 'euw1' } }; ME = { username: 'tester', account: { puuid: 'me' } };
    Object.assign(view.player, { role: 'TOP', range: '40', opp: '9', tab: 'draft' }); nav = 1;
  }, meta);
  return { context, page, state, errors };
}
async function dimensions(page) {
  const overflow = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  assert(overflow.content <= overflow.width + 1, `Page overflow: ${JSON.stringify(overflow)}`);
  const targets = await page.locator('.insight button, .insight select, .insight input, .insight summary, .insight a').evaluateAll((elements) => elements.filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map((el) => ({ text: el.textContent.slice(0, 50), width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
  for (const target of targets) assert(target.height >= 44 && target.width >= 44, `Small target: ${JSON.stringify(target)}`);
  assert.equal(await page.locator('.insight script, .insight img[src="x"]').count(), 0, 'Unescaped server text became HTML');
}
const call = (page, name) => page.evaluate((fn) => window[fn](document.querySelector('#slot')), name);
async function expandAll(page) { await page.locator('.insight details').evaluateAll((elements) => elements.forEach((el) => { el.open = true; })); }
async function checkWidth(browser, width) {
  const { context, page, state, errors } = await fixture(browser, width);
  try {
    await call(page, 'loadDraftInsights');
    const request = state.requests[0];
    assert.equal(request.url.pathname, '/api/player/me/draft');
    assert.equal(request.url.searchParams.get('role'), 'TOP');
    assert.equal(request.url.searchParams.get('range'), '40');
    assert.equal(request.url.searchParams.get('opp'), '9');
    assert.equal(await page.locator('.insight-draft > .insight-content > .insight-grid .insight-box').count(), 1, 'Only own-pool counter candidates');
    assert.match(await page.locator('.insight-draft').innerText(), /90% credible 40.0%–78.0%/);
    assert.match(await page.locator('.insight-draft').innerText(), /n=2/);
    assert.match(await page.locator('.insight-draft').innerText(), /2W 1L/);
    assert.equal(state.requests.filter((entry) => entry.url.pathname.startsWith('/api/clash/')).length, 0);
    await expandAll(page);
    await page.locator('.insight-clash-form input').fill('real-team');
    await page.locator('.insight-clash-form button[type="submit"]').click();
    await page.locator('.insight-clash-result h3').waitFor();
    assert.equal(state.requests.at(-1).url.searchParams.get('sync'), '0');
    assert.match(await page.locator('.insight-clash-result').innerText(), /Rank unavailable/);
    await page.locator('[data-sync]').click();
    await until(() => state.requests.at(-1).url.searchParams.get('sync') === '1');
    await page.waitForFunction(() => !document.querySelector('[data-sync]').disabled);
    await dimensions(page);

    await page.evaluate(() => { view.player.tab = 'coaching'; });
    await call(page, 'loadCoaching');
    assert.equal(await page.locator('[data-goal-action="start"]').count(), 3);
    assert.match(await page.locator('.insight-coaching').innerText(), /next ten Top games/);
    const meter = page.locator('[role="meter"]');
    assert.equal(await meter.getAttribute('aria-valuenow'), '35');
    assert.equal(await page.locator('.insight-percentile').count(), 2, 'Missing percentile is not fabricated as zero');
    await page.locator('[data-goal-action="start"][data-index="2"]').click();
    await page.locator('.insight-goal').waitFor();
    assert.deepEqual(state.requests.find((entry) => entry.method === 'POST').body, { role: 'TOP', metric: 'kp', target: .6 });
    assert.match(await page.locator('.insight-goal').innerText(), /not progress since this goal began/);
    await page.locator('[data-goal-action="delete"]').click();
    await page.waitForFunction(() => !document.querySelector('.insight-goal'));
    const deletion = state.requests.find((entry) => entry.method === 'DELETE');
    assert.equal(deletion.url.searchParams.get('role'), 'TOP');
    assert.equal(deletion.url.searchParams.get('metric'), 'kp');
    await page.locator('[aria-label="Coaching role"]').selectOption('JUNGLE');
    assert.match(await page.locator('.insight-role-content').innerText(), /Jungle/);
    assert.equal(await page.locator('[role="meter"]').getAttribute('aria-valuenow'), '0');
    await expandAll(page);
    await dimensions(page);
    assert(!await page.locator('.insight-role-content').innerText().then((text) => text.includes('Lane CS')));
    assert.match(await page.locator('.insight-coaching').innerText(), /no finite slow-end estimate/);

    await page.evaluate(async () => { nav++; location.hash = '#/odds'; await showOdds(); });
    assert.equal(await page.locator('.insight-scorecard').count(), 2);
    assert.match(await page.locator('.insight-scorecard').nth(0).innerText(), /Ready · held-out validation passed/);
    assert.match(await page.locator('.insight-scorecard').nth(1).innerText(), /Unavailable · no usable validated model/);
    assert.equal(await page.locator('.insight-scorecard').nth(0).locator('dd').nth(2).innerText(), '4 / 24');
    assert.match(await page.locator('.insight-scorecards').innerText(), /0.2100/);
    assert.match(await page.locator('.insight-scorecards').innerText(), /55.0%/);
    assert(!await page.locator('.insight-scorecards').innerText().then((text) => text.includes('97%')));
    await expandAll(page);
    await dimensions(page);

    await page.evaluate((data) => {
      nav++; location.hash = '#/p/euw1/Test%23ONE/40'; view.player.tab = 'live';
      document.querySelector('#app').innerHTML = '<div id="slot"></div>';
      window.fixtureLive = data; mountLiveInsights(document.querySelector('#slot'), data);
    }, live);
    assert.equal(await page.locator('.insight-live select').count(), 10);
    assert.deepEqual(await page.locator('.insight-live select').evaluateAll((elements) => elements.map((el) => el.value)), Array(10).fill(''), 'Never infer roles, even from a role-looking player field');
    assert(!await page.locator('.insight-live-odds').innerText().then((text) => text.includes('95.0%')), 'Unavailable odds cannot display fake probabilities');
    assert.equal(state.requests.filter((entry) => entry.url.pathname.startsWith('/api/live/')).length, 0);
    await expandAll(page);
    await page.locator('.insight-live select').evaluateAll((elements) => elements.forEach((el) => { el.value = 'TOP'; el.dispatchEvent(new Event('change')); }));
    await page.locator('.insight-live-form > button').click();
    assert.match(await page.locator('.insight-live-form .insight-status').innerText(), /exactly once/);
    assert.equal(state.requests.filter((entry) => entry.url.pathname.startsWith('/api/live/')).length, 0);
    await page.locator('.insight-live select').evaluateAll((elements, roleList) => elements.forEach((el, i) => { el.value = roleList[i % 5]; el.dispatchEvent(new Event('change')); }), roles);
    await page.locator('.insight-live-form > button').click();
    await page.waitForFunction(() => document.querySelector('.insight-live-odds').textContent.includes('62.0%'));
    const assignment = state.requests.at(-1);
    assert.equal(assignment.url.pathname, '/api/live/me/odds');
    assert.deepEqual(assignment.body, { roles: live.players.map((player, i) => ({ team: player.team, champion_id: player.champion_id, role: roles[i % 5] })), game_id: live.game_id });
    await page.evaluate(() => mountLiveInsights(document.querySelector('#slot'), fixtureLive));
    assert.deepEqual(await page.locator('.insight-live select').evaluateAll((elements) => elements.map((el) => el.value)), [...roles, ...roles], 'Polling retains user assignments');
    await expandAll(page);
    assert.match(await page.locator('.insight-live-habits').innerText(), /not starting buff/);
    assert.match(await page.locator('.insight-live-habits').innerText(), /not all ganks/);
    assert(!await page.locator('.insight-live-habits').innerText().then((text) => text.includes('Player 0')));
    await dimensions(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  console.log(`PASS insights layout, contracts and actions at ${width}px`);
}
async function checkLatestAndGuards(browser) {
  const gate = deferred(); let calls = 0;
  const test = await fixture(browser, 375, async ({ url }) => {
    if (!url.pathname.endsWith('/draft')) return null;
    const index = ++calls;
    if (index === 1) await gate.promise;
    return { body: { ...draft, note: index === 1 ? 'OBSOLETE NOTE' : 'LATEST NOTE' } };
  });
  try {
    await test.page.evaluate(() => { window.old = loadDraftInsights(document.querySelector('#slot')); });
    await until(() => calls === 1);
    await call(test.page, 'loadDraftInsights');
    gate.resolve(); await test.page.evaluate(() => old);
    assert.match(await test.page.locator('.insight-draft').textContent(), /LATEST NOTE/);
    assert(!await test.page.locator('.insight-draft').textContent().then((text) => text.includes('OBSOLETE NOTE')));
  } finally { gate.resolve(); await test.context.close(); }
  for (const guard of ['nav', 'hash', 'puuid', 'identity', 'role', 'range', 'opponent', 'element', 'marker']) {
    const delayed = deferred(); let reached = false;
    const { context, page, errors } = await fixture(browser, 375, async ({ url }) => {
      if (!url.pathname.endsWith('/draft')) return null;
      reached = true; await delayed.promise;
      return { status: 401, body: { detail: 'STALE ERROR' } };
    });
    try {
      await page.evaluate(() => { window.pending = loadDraftInsights(document.querySelector('#slot')); });
      await until(() => reached);
      await page.evaluate((which) => {
        if (which === 'nav') nav++;
        if (which === 'hash') location.hash = '#/other';
        if (which === 'puuid') DATA.puuid = 'other';
        if (which === 'identity') ME.username = 'someone-else';
        if (which === 'role') view.player.role = 'JUNGLE';
        if (which === 'range') view.player.range = '100';
        if (which === 'opponent') view.player.opp = '2';
        if (which === 'element') document.querySelector('#slot').remove();
        if (which === 'marker') document.querySelector('#slot').replaceChildren();
      }, guard);
      delayed.resolve(); await page.evaluate(() => pending);
      assert(!await page.locator('body').innerText().then((text) => text.includes('STALE ERROR')));
      assert.equal(await page.evaluate(() => !!ME), true, `Stale 401 must not log out for ${guard}`);
      assert.deepEqual(errors, []);
    } finally { delayed.resolve(); await context.close(); }
  }
  console.log('PASS latest requests, navigation, identity, filter, element and stale-401 guards');
}
async function checkRetriesAndQuietStates(browser) {
  let draftCalls = 0, goalCalls = 0;
  const test = await fixture(browser, 320, ({ url }) => {
    if (url.pathname.endsWith('/draft') && ++draftCalls === 1) return { status: 503, body: { detail: 'Try again <img src=x>' } };
    if (url.pathname.endsWith('/goals') && ++goalCalls === 1) return { status: 503, body: { detail: 'Save failed <img src=x>' } };
    return null;
  });
  try {
    await call(test.page, 'loadDraftInsights');
    const retry = test.page.locator('.insight-draft > .insight-status button'), before = await retry.boundingBox();
    assert.match(await test.page.locator('.insight-status').innerText(), /Try again <img/);
    await retry.click(); await test.page.locator('.insight-draft h2').waitFor();
    const after = await retry.evaluate((el) => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }));
    assert.equal(before.height, after.height); assert.equal(before.width, after.width);
    await test.page.evaluate(() => { view.player.tab = 'coaching'; });
    await call(test.page, 'loadCoaching');
    const button = test.page.locator('[data-goal-action="start"]').first(), goalBefore = await button.boundingBox();
    await button.click(); await test.page.waitForFunction(() => document.querySelector('[data-goal-action="start"]').textContent.includes('Retry'));
    const goalAfter = await button.boundingBox();
    assert.equal(goalBefore.height, goalAfter.height); assert.equal(goalBefore.width, goalAfter.width);
    assert.match(await test.page.locator('.insight-action-status').first().innerText(), /Save failed <img/);
    await button.click(); await test.page.locator('.insight-goal').waitFor();
    await dimensions(test.page);
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  for (const [kind, body] of [['draft', { ...draft, counters: [], matchups: [] }], ['coaching', { ...coaching, can_edit: false, roles: [], forecast: { available: false, reason: 'unranked' } }], ['odds', {}]]) {
    const { context, page, errors } = await fixture(browser, 320, ({ url }) => url.pathname.endsWith(`/${kind}`) ? { body } : null);
    try {
      if (kind === 'odds') await page.evaluate(async () => { location.hash = '#/odds'; await showOdds(); });
      else await call(page, kind === 'draft' ? 'loadDraftInsights' : 'loadCoaching');
      await expandAll(page); await dimensions(page);
      if (kind === 'coaching') assert.equal(await page.locator('[data-goal-action]').count(), 0);
      if (kind === 'odds') assert.equal(await page.locator('.insight-readiness').filter({ hasText: 'Unavailable' }).count(), 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log('PASS stable retry controls, escaped errors, read-only and quiet empty states');
}
async function checkStaleGoalAndLive(browser) {
  for (const mutation of ['goals', 'odds']) {
    const gate = deferred(); let reached = false;
    const test = await fixture(browser, 375, async ({ url, method }) => {
      if (method !== 'POST' || !url.pathname.endsWith(`/${mutation}`)) return null;
      reached = true; await gate.promise;
      return { status: 401, body: { detail: 'STALE MUTATION ERROR' } };
    });
    try {
      if (mutation === 'goals') {
        await call(test.page, 'loadCoaching');
        await test.page.locator('[data-goal-action="start"]').first().click();
        await until(() => reached);
        await test.page.locator('[aria-label="Coaching role"]').selectOption('JUNGLE');
      } else {
        await test.page.evaluate((data) => { view.player.tab = 'live'; mountLiveInsights(document.querySelector('#slot'), data); }, live);
        await expandAll(test.page);
        await test.page.locator('.insight-live select').evaluateAll((elements, roleList) => elements.forEach((el, i) => { el.value = roleList[i % 5]; el.dispatchEvent(new Event('change')); }), roles);
        await test.page.locator('.insight-live-form > button').click();
        await until(() => reached);
        await test.page.evaluate((data) => mountLiveInsights(document.querySelector('#slot'), { ...data, game_id: 100 }), live);
        assert.deepEqual(await test.page.locator('.insight-live select').evaluateAll((elements) => elements.map((el) => el.value)), Array(10).fill(''), 'A new real game clears assignments');
      }
      const response = test.page.waitForResponse((reply) => reply.request().method() === 'POST');
      gate.resolve();
      await response;
      await test.page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
      assert(!await test.page.locator('body').innerText().then((text) => text.includes('STALE MUTATION ERROR')));
      assert.equal(await test.page.evaluate(() => !!ME), true);
      assert.deepEqual(test.errors, []);
    } finally { gate.resolve(); await test.context.close(); }
  }
  console.log('PASS stale goal errors and new-game live response guards');
}
async function checkContractEdges(browser) {
  const goal = { role: 'TOP', metric: 'kp', target: .6, created: 1760050010, progress: { value: .7, games: 3 } };
  const test = await fixture(browser, 320, ({ url }) => {
    if (url.pathname.endsWith('/coaching')) return { body: { ...coaching, can_edit: false, goals: [goal] } };
    if (url.pathname.endsWith('/draft')) return { body: { ...draft, opponent: null, matchups: [{ ...matchup, ...wr(0, 0) }] } };
    return null;
  });
  try {
    await test.page.evaluate(() => { view.player.opp = ''; });
    await call(test.page, 'loadDraftInsights');
    assert.equal(test.state.requests[0].url.searchParams.has('opp'), false, 'Optional opponent is omitted, not sent as an empty ID');
    assert.equal(await test.page.locator('.insight-draft > .insight-content > .insight-grid').count(), 0);
    assert.match(await test.page.locator('.insight-draft').innerText(), /No paired games/);
    await test.page.evaluate(() => { view.player.tab = 'coaching'; });
    await call(test.page, 'loadCoaching');
    assert.equal(await test.page.locator('[data-goal-action]').count(), 0, 'Read-only coaching cannot mutate even when focus and goals exist');
    assert.match(await test.page.locator('.insight-goal').innerText(), /Backend progress since this goal began: 70.0% · 3 valid samples/);
    await dimensions(test.page);
    await test.page.evaluate((data) => { view.player.tab = 'live'; mountLiveInsights(document.querySelector('#slot'), { ...data, players: data.players.slice(0, 5) }); }, live);
    assert.equal(await test.page.locator('.insight-live select').count(), 0);
    assert.match(await test.page.locator('.insight-live').textContent(), /All ten known champions/);
    await test.page.evaluate(() => mountLiveInsights(document.querySelector('#slot'), { in_game: false }));
    assert.equal(await test.page.locator('.insight-live').count(), 0);
    assert.equal(test.state.requests.length, 2, 'Incomplete and ended live games do not request fabricated odds');
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  console.log('PASS optional opponent, own-only records, backend goal progress, read-only goals and incomplete live lineups');
}
async function refreshFixture(browser, width = 375) {
  const queues = new Map();
  const test = await fixture(browser, width, async (entry) => {
    const kind = entry.url.pathname.split('/').at(-1), planned = queues.get(kind)?.shift();
    if (!planned) return null;
    await planned.gate.promise;
    return typeof planned.reply === 'function' ? planned.reply(entry) : planned.reply;
  });
  test.hold = (kind, reply) => {
    const gate = deferred();
    if (!queues.has(kind)) queues.set(kind, []);
    queues.get(kind).push({ gate, reply });
    return gate;
  };
  return test;
}
const beginRefresh = (page, name, key = 'refresh') => page.evaluate(({ fn, pending }) => {
  window[pending] = window[fn](document.querySelector('#slot'));
}, { fn: name, pending: key });
async function checkRefreshContext(browser, width) {
  const test = await refreshFixture(browser, width), { page, state } = test;
  try {
    await call(page, 'loadDraftInsights');
    await page.evaluate(() => document.querySelector('#slot').insertAdjacentHTML('beforebegin', '<form><label>Draft role<select name="draft_role"><option>TOP</option><option>JUNGLE</option></select></label><label>Lane opponent<select name="lane_opp"><option>9</option><option>2</option></select></label></form>'));
    await page.getByText('Clash scouting', { exact: true }).click();
    await page.getByText('Samples and limitations', { exact: true }).click();
    await page.getByText('Takeaway', { exact: true }).click();
    await page.getByText('Matchup records · 1', { exact: true }).click();
    await page.locator('[name="team_id"]').fill('Team-before-refresh');
    await page.locator('[name="platform"]').selectOption('na1');
    await page.locator('[name="team_id"]').focus();
    await page.evaluate(() => {
      window.savedHost = document.querySelector('.insight-draft');
      window.savedInput = document.querySelector('[name="team_id"]');
      savedInput.setSelectionRange(2, 6, 'backward');
      window.savedHeight = savedHost.getBoundingClientRect().height;
      DATA = { ...DATA, profile: { ...DATA.profile, refreshed: true } }; // Parent's same-player background poll.
    });
    const gate = test.hold('draft', { body: { ...clone(draft), matchups: [matchup, { ...matchup, champion_id: 2 }], note: 'REFRESHED DATA' } });
    const expected = state.requests.length + 1;
    await beginRefresh(page, 'loadDraftInsights'); await until(() => state.requests.length === expected);
    assert.deepEqual(await page.evaluate(() => ({ host: savedHost === document.querySelector('.insight-draft'), input: savedInput === document.activeElement, start: savedInput.selectionStart, opacity: getComputedStyle(document.querySelector('.insight-content')).opacity, height: savedHost.getBoundingClientRect().height === savedHeight })), { host: true, input: true, start: 2, opacity: '0.75', height: true }, 'Pending refresh keeps the frame and focused input, without a skeleton or layout jump');
    await page.locator('[name="team_id"]').fill('Team-edited-during-refresh');
    await page.evaluate(() => document.querySelector('[name="team_id"]').setSelectionRange(3, 10, 'backward'));
    gate.resolve(); await page.evaluate(() => refresh);
    assert.deepEqual(await page.locator('[name="team_id"]').evaluate((node) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, focused: node === document.activeElement })), { value: 'Team-edited-during-refresh', start: 3, end: 10, direction: 'backward', focused: true });
    assert.equal(await page.locator('[name="platform"]').inputValue(), 'na1');
    assert.equal(await page.evaluate(() => savedHost === document.querySelector('.insight-draft')), true);
    for (const [heading, open] of [['Clash scouting', true], ['Samples and limitations', true], ['Takeaway', false], ['Matchup records · 2', false]]) assert.equal(await page.getByText(heading, { exact: true }).evaluate((node) => node.parentElement.open), open, heading);
    assert.match(await page.locator('.insight-draft').textContent(), /REFRESHED DATA/);
    assert.equal(await page.locator('.insight-content').evaluate((node) => getComputedStyle(node).opacity), '1');
    assert.equal(state.requests.length, expected, 'Restoring controls must not dispatch changes or automatically fetch scouting');

    for (const [name, field, value] of [['lane_opp', 'opp', '2'], ['draft_role', 'role', 'JUNGLE']]) {
      const control = page.locator(`[name="${name}"]`);
      await control.selectOption(value); await control.focus();
      await page.evaluate(({ key, next }) => { view.player[key] = next; }, { key: field, next: value });
      const filterGate = test.hold('draft', ({ url }) => ({ body: { ...clone(draft), role: url.searchParams.get('role'), opponent: +url.searchParams.get('opp'), counters: [], note: 'NEW FILTER DATA' } }));
      const countBefore = state.requests.length;
      await beginRefresh(page, 'loadDraftInsights'); await until(() => state.requests.length > countBefore);
      assert.equal(await page.evaluate(() => savedHost === document.querySelector('.insight-draft')), true, 'Draft filter changes keep the Clash frame while fetching fresh data');
      filterGate.resolve(); await page.evaluate(() => refresh);
      assert.equal(state.requests.at(-1).url.searchParams.get(field), value);
      assert.equal(await control.evaluate((node) => node === document.activeElement), true, 'Refreshing scoped data must not steal focus from a parent role/lane control');
      assert.equal(await control.inputValue(), value);
      assert.equal(await page.locator('[name="team_id"]').inputValue(), 'Team-edited-during-refresh');
      assert.equal(await page.locator('[name="platform"]').inputValue(), 'na1');
      assert.equal(await page.getByText('Clash scouting', { exact: true }).evaluate((node) => node.parentElement.open), true);
    }
    await dimensions(page);
    const filterFailure = test.hold('draft', { status: 503, body: { detail: 'Draft filter refresh failed' } });
    await page.evaluate(() => { view.player.opp = '9'; });
    const filterExpected = state.requests.length + 1;
    await beginRefresh(page, 'loadDraftInsights'); await until(() => state.requests.length === filterExpected);
    filterFailure.resolve(); await page.evaluate(() => refresh);
    await page.locator('.insight-clash-form button[type="submit"]').click();
    await page.locator('.insight-clash-result h3').waitFor();
    assert.equal(state.requests.at(-1).url.pathname, '/api/clash/na1/Team-edited-during-refresh', 'Retained Clash controls remain usable independently of a failed lane-filter refresh');
    assert.equal(state.requests.at(-1).url.searchParams.get('sync'), '0');

    await page.evaluate(() => { view.player.tab = 'habits'; view.player.role = 'JUNGLE'; delete view.player.coachRole; });
    await call(page, 'loadCoaching');
    const picker = page.locator('[aria-label="Coaching role"]');
    assert.equal(await picker.inputValue(), 'TOP', 'Coach initialization is independent of Draft role');
    await picker.selectOption('JUNGLE'); await picker.focus();
    assert.deepEqual(await page.evaluate(() => [view.player.coachRole, view.player.role]), ['JUNGLE', 'JUNGLE']);
    const coachingGate = test.hold('coaching', { body: { ...clone(coaching), roles: coaching.roles.map((row) => ({ ...row, games: row.role === 'JUNGLE' ? 9 : row.games })) } });
    const coachExpected = state.requests.length + 1;
    await beginRefresh(page, 'loadCoaching'); await until(() => state.requests.length === coachExpected);
    await picker.selectOption('TOP');
    assert.equal(await page.locator('[data-goal-action="start"]').count(), 3, 'Role controls remain usable while refreshing');
    await picker.selectOption('JUNGLE');
    await page.getByText('Metric comparisons and sample counts', { exact: true }).click();
    await page.getByText('Takeaway', { exact: true }).click();
    await page.getByText('Playstyle fingerprint · vs GOLD', { exact: true }).click();
    await picker.focus();
    await page.evaluate(() => { view.player.role = 'TOP'; });
    coachingGate.resolve(); await page.evaluate(() => refresh);
    assert.equal(await picker.inputValue(), 'JUNGLE');
    assert.equal(await picker.evaluate((node) => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => [view.player.coachRole, view.player.role]), ['JUNGLE', 'TOP'], 'Coaching selection must not overwrite Draft role');
    assert.match(await page.locator('.insight-role-content').textContent(), /9 selected Jungle role games/);
    for (const [heading, open] of [['Takeaway', false], ['Metric comparisons and sample counts', true], ['Playstyle fingerprint · vs GOLD', false]]) assert.equal(await page.getByText(heading, { exact: true }).evaluate((node) => node.parentElement.open), open);
    await page.evaluate(() => { window.savedPicker = document.querySelector('[aria-label="Coaching role"]'); });
    const failureGate = test.hold('coaching', { status: 503, body: { detail: 'Temporary refresh failure' } });
    const failedExpected = state.requests.length + 1;
    await beginRefresh(page, 'loadCoaching'); await until(() => state.requests.length === failedExpected);
    failureGate.resolve(); await page.evaluate(() => refresh);
    assert.equal(await page.evaluate(() => savedPicker === document.activeElement && savedPicker === document.querySelector('[aria-label="Coaching role"]')), true, 'Refresh failures leave the old DOM and focus intact');
    assert.match(await page.locator('.insight-coaching > .insight-status').innerText(), /Temporary refresh failure.*Showing previous insights/);
    await picker.selectOption('TOP');
    assert.equal(await page.locator('[data-goal-action="start"]').count(), 3, 'A failed refresh must not invalidate old rendered-control handlers');
    await call(page, 'loadCoaching');
    assert.equal(await picker.inputValue(), 'TOP');
    await page.evaluate(() => { document.querySelector('#slot').replaceChildren(); view.player.role = 'JUNGLE'; });
    await call(page, 'loadCoaching');
    assert.equal(await picker.inputValue(), 'TOP', 'coachRole also survives a parent remount');
    await page.evaluate(() => { view.player.coachRole = 'JUNGLE'; });
    await call(page, 'loadCoaching');
    assert.equal(await picker.inputValue(), 'JUNGLE', 'The persisted role is the source of truth, not an obsolete select snapshot');
    assert.match(await page.locator('.insight-role-content').textContent(), /selected Jungle role games/);
    await dimensions(page);
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  console.log(`PASS persistent coaching role, refresh frame/focus/caret/disclosures, editable pending controls and Clash inputs at ${width}px`);
}
async function checkRefresh401Guards(browser) {
  for (const [kind, name] of [['draft', 'loadDraftInsights'], ['coaching', 'loadCoaching']]) {
    const test = await refreshFixture(browser), { page, state } = test;
    try {
      await call(page, name);
      const oldGate = test.hold(kind, { status: 401, body: { detail: 'OBSOLETE REFRESH 401' } });
      const newGate = test.hold(kind, { body: kind === 'draft' ? { ...draft, note: 'LATEST REFRESH' } : coaching });
      const first = state.requests.length + 1;
      await beginRefresh(page, name, 'oldRefresh'); await until(() => state.requests.length === first);
      await beginRefresh(page, name, 'newRefresh'); await until(() => state.requests.length === first + 1);
      oldGate.resolve(); await page.evaluate(() => oldRefresh);
      assert.equal(await page.evaluate(() => !!ME), true, 'An obsolete refresh 401 must not log out even though its reused host is still connected');
      assert.equal(await page.locator(`.insight-${kind}`).getAttribute('aria-busy'), 'true', 'An obsolete completion must not clear the newest refresh state');
      assert(!await page.locator('body').textContent().then((text) => text.includes('OBSOLETE REFRESH 401')));
      newGate.resolve(); await page.evaluate(() => newRefresh);
      assert.equal(await page.locator(`.insight-${kind}`).getAttribute('aria-busy'), 'false');
      if (kind === 'draft') assert.match(await page.locator('.insight-draft').textContent(), /LATEST REFRESH/);
      assert.deepEqual(test.errors, []);
    } finally { await test.context.close(); }
  }
  console.log('PASS obsolete refresh 401s and latest busy state with reused Draft/coaching hosts');
}
async function checkLiveGameContract(browser) {
  const gate = deferred();
  const spectator = { ...clone(live), queue: 'Ranked Solo', form_games: 10, pending: 0, without_history: 0, bans: [], players: live.players.map((player) => ({ ...player, division: 'IV', lp: 30, form: wr(), on_champ: wr(3, 2), cached_games: 20, loading: false })) };
  let posts = 0, gets = 0;
  const test = await fixture(browser, 320, async ({ url, method }) => {
    if (method === 'POST' && url.pathname === '/api/live/me/odds') {
      posts++;
      if (posts === 1) await gate.promise;
      if (posts === 2) return { status: 409, body: { detail: 'The game changed. Refresh the live view and assign the new lineup' } };
      if (posts === 4) return { status: 409, body: { detail: 'No current game. Refresh the live view before assigning roles' } };
      return { body: prediction };
    }
    if (method === 'GET' && url.pathname === '/api/live/me') {
      gets++;
      return { body: gets === 3 ? { in_game: false } : { ...spectator, game_id: gets === 1 ? live.game_id : live.game_id + 1 } };
    }
    return null;
  });
  const { page, state } = test;
  const assign = async () => {
    await expandAll(page);
    await page.locator('.insight-live select').evaluateAll((elements, roleList) => elements.forEach((el, i) => { el.value = roleList[i % 5]; el.dispatchEvent(new Event('change')); }), roles);
  };
  const oddsPosts = () => state.requests.filter((request) => request.method === 'POST' && request.url.pathname === '/api/live/me/odds');
  try {
    await page.evaluate((data) => {
      view.player.tab = 'live';
      document.querySelector('#app').innerHTML = '<div id="tab-body"></div>';
      window.spectatorLive = data;
      renderLive(data);
    }, spectator);
    await assign();
    await page.locator('.insight-live-form > button').click(); await until(() => posts === 1);
    assert.equal(oddsPosts()[0].body.game_id, live.game_id);
    await page.evaluate(() => {
      window.savedLiveSlot = document.querySelector('#live-insights');
      window.savedLiveControl = document.querySelector('.insight-live-form').closest('details').querySelector(':scope > summary');
      savedLiveControl.focus();
      renderLive({ ...spectatorLive, players: [...spectatorLive.players].reverse() });
    });
    assert.equal(await page.evaluate(() => savedLiveSlot === document.querySelector('#live-insights') && savedLiveControl === document.activeElement), true, 'Parent same-game polling retains the slot and focus, even if spectator rows reorder');
    assert.equal(await page.locator('.insight-live-form > button').isDisabled(), true, 'An in-flight odds request survives same-game polling');
    gate.resolve();
    await page.waitForFunction(() => document.querySelector('.insight-live-odds').textContent.includes('62.0%'));
    await page.locator('.insight-live-form > button').click();
    const refresh = page.getByRole('button', { name: 'Refresh live game', exact: true });
    await refresh.waitFor();
    await dimensions(page);
    assert.equal(gets, 0, '409 does not automatically fetch a replacement game');
    assert.equal(await page.locator('.insight-live-form > button').isDisabled(), true);
    assert.equal(await page.locator('.insight-live select:disabled').count(), 10);
    assert(!await page.locator('.insight-live-odds').innerText().then((text) => text.includes('62.0%')), 'Changed-game errors clear the old prediction');
    await page.evaluate(() => document.querySelector('.insight-live-form').requestSubmit());
    assert.equal(posts, 2, 'The stale form cannot repost its assignments');
    await refresh.click();
    await page.waitForFunction(() => document.querySelector('.insight-live-form .insight-status').textContent.includes('still shows the previous game'));
    assert.equal(gets, 1);
    assert.equal(posts, 2);
    assert.equal(await refresh.isEnabled(), true, 'An unchanged refreshed game leaves an explicit recovery action, not a hidden dead end');
    assert.equal(await page.locator('.insight-live-form > button').isDisabled(), true);
    await refresh.click();
    await page.waitForFunction(() => document.querySelector('#live-insights') !== savedLiveSlot);
    assert.equal(gets, 2);
    assert.equal(posts, 2, 'Fetching the new game must not automatically request odds');
    assert.deepEqual(await page.locator('.insight-live select').evaluateAll((elements) => elements.map((el) => el.value)), Array(10).fill(''), 'A new game ID clears assignments even when its champions match the previous lineup');
    await assign();
    await page.locator('.insight-live-form > button').click();
    await page.waitForFunction(() => document.querySelector('.insight-live-odds').textContent.includes('62.0%'));
    assert.equal(oddsPosts()[2].body.game_id, live.game_id + 1, 'Fresh, explicitly assigned roles carry the actual new game ID');
    await page.locator('.insight-live-form > button').click(); await refresh.waitFor();
    await refresh.click();
    await page.getByText('Not in a game anymore', { exact: true }).waitFor();
    assert.equal(gets, 3);
    assert.equal(posts, 4, 'No-current-game recovery fetches the view, not another odds POST');
    const legacy = clone(spectator); delete legacy.game_id;
    await page.evaluate((data) => renderLive(data), legacy);
    await assign();
    await page.locator('.insight-live-form > button').click();
    await page.waitForFunction(() => document.querySelector('.insight-live-odds').textContent.includes('62.0%'));
    const legacyPost = oddsPosts().at(-1);
    assert.equal(Object.hasOwn(legacyPost.body, 'game_id'), false, 'Older spectator payloads omit game_id rather than inventing one');
    assert.deepEqual(legacyPost.body, { roles: legacy.players.map((player, i) => ({ team: player.team, champion_id: player.champion_id, role: roles[i % 5] })) });
    await dimensions(page);
    assert.deepEqual(test.errors, []);
  } finally { gate.resolve(); await test.context.close(); }
  console.log('PASS actual/optional game IDs, same-game in-flight retention, explicit 409 live refresh and fresh reassignment');
}
async function checkLiveOddsPolicy(browser) {
  const { context, page, state, errors } = await fixture(browser, 320);
  const disabled = { ...clone(live), odds_enabled: false, odds: prediction };
  try {
    await page.evaluate((data) => {
      view.player.tab = 'live';
      const slot = document.querySelector('#slot');
      slot.innerHTML = liveInsights(data);
      mountLiveInsights(slot, data);
    }, disabled);
    const policy = page.locator('.insight-live-odds');
    assert.match(await policy.innerText(), /Live odds are disabled pending Riot use-case review/);
    assert.equal(await policy.locator('a').getAttribute('href'), '#/odds');
    assert.equal(await page.locator('.insight-live-form, .insight-live select').count(), 0);
    assert.equal(await page.getByText('Assign roles to request pregame odds', { exact: true }).count(), 0);
    assert(!await policy.innerText().then((text) => /62\.0%|samples|assign|missing roles/i.test(text)), 'Policy disablement must override cached odds without pretending a data or role problem');
    await expandAll(page);
    assert.match(await page.locator('.insight-live-habits').innerText(), /10 cached jungle games/);
    assert.match(await page.locator('.insight-live-habits').innerText(), /not starting buff/);
    assert.equal(state.requests.length, 0, 'Policy-disabled live context performs no odds POST or other API call');
    await dimensions(page);

    await page.evaluate((data) => mountLiveInsights(document.querySelector('#slot'), data), live);
    assert.equal(await page.locator('.insight-live select').count(), 10, 'A missing flag preserves legacy assignment behavior');
    await expandAll(page);
    await page.locator('.insight-live select').evaluateAll((elements, roleList) => elements.forEach((el, i) => { el.value = roleList[i % 5]; el.dispatchEvent(new Event('change')); }), roles);
    await page.evaluate(() => { window.legacyPolicyForm = document.querySelector('.insight-live-form'); });
    await page.locator('.insight-live-form > button').click();
    await page.waitForFunction(() => document.querySelector('.insight-live-odds').textContent.includes('62.0%'));
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].method, 'POST');
    await page.evaluate((data) => {
      mountLiveInsights(document.querySelector('#slot'), data);
      legacyPolicyForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }, disabled);
    assert.equal(await page.locator('.insight-live-form, .insight-live select').count(), 0, 'A same-game policy change also removes previously mounted assignments');
    assert.match(await policy.innerText(), /disabled pending Riot use-case review/);
    assert(!await policy.innerText().then((text) => text.includes('62.0%')));
    assert.equal(state.requests.length, 1, 'A removed assignment form cannot POST after policy disablement');
    await page.evaluate((data) => mountLiveInsights(document.querySelector('#slot'), data), { ...disabled, players: disabled.players.map((player) => player.jungle ? { ...player, jungle: { ...player.jungle, games: 11 } } : player) });
    await expandAll(page);
    assert.match(await page.locator('.insight-live-habits').innerText(), /11 cached jungle games/, 'Policy-disabled same-game polling still updates historical habits');
    await dimensions(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  console.log('PASS policy-disabled live odds: no assignment UI or POST, legacy behavior and historical habits preserved');
}
(async () => {
  const browser = await playwright[process.env.BROWSER || 'chromium'].launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  try {
    for (const width of [320, 375, 768, 1280]) await checkWidth(browser, width);
    await checkLatestAndGuards(browser);
    await checkRetriesAndQuietStates(browser);
    await checkStaleGoalAndLive(browser);
    await checkContractEdges(browser);
    for (const width of [320, 1280]) await checkRefreshContext(browser, width);
    await checkRefresh401Guards(browser);
    await checkLiveGameContract(browser);
    await checkLiveOddsPolicy(browser);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
