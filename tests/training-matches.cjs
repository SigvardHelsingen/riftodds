// Mock browser: NODE_PATH=.browser-tools/node_modules node tests/training-matches.cjs
// BROWSER=chromium|webkit, TRAINING_CASE=<label regex>, optional PLAYWRIGHT_EXECUTABLE_PATH.
// Real core/styles; frozen in-memory training_matches.py responses only. No server, DB or external network.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../static/training.js');
const copy = value => structuredClone(value);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const NOTE = 'Descriptive observations, not evidence that practice caused a change. Missing metrics are not zeros. Filters and game window are captured at tracking start; explicitly restart to change them. Candidate searches are bounded to 200 cached player matches.';
const REVIEW_NOTE = 'Prompts describe cached events, not causes or recommended plays. Review what was known at the time. Missing timelines are not games without events; nothing is fetched automatically.';
const CACHE_REASON = 'Completed match cache is unavailable; no data was fetched.';
const OPTIONS = freeze({ account: { game_name: 'Fixture player', tag_line: 'TEST', platform: 'euw1' }, patches: ['26.20', '26.19'], champions: [{ id: 1, name: 'Champion 1' }, { id: 22, name: 'Champion 22' }], queues: [{ id: 420, label: 'Ranked Solo' }, { id: 440, label: 'Ranked Flex' }, { id: 400, label: 'Normal Draft' }, { id: 490, label: 'Quickplay' }], roles: [{ id: 'TOP', label: 'Top' }, { id: 'JUNGLE', label: 'Jungle' }, { id: 'MIDDLE', label: 'Middle' }, { id: 'BOTTOM', label: 'Bottom' }, { id: 'UTILITY', label: 'Support' }], available: true, reason: null, truncated: false });
const TRACKING = freeze({ started: 1700000000.25, games: 3, role: 'MIDDLE', champion_id: 22, queue_id: 420, patch: '26.20' });
const match = (match_id = 'EUW1_fixture', game_start = 1700000001000) => ({ match_id, game_start, duration: 1800, champion_id: 22, role: 'MIDDLE', patch: '26.20', queue_id: 420 });
const BASELINE = freeze([{ ...match('EUW1_before', 1699900000000), win: true, values: { cs10: 0, deaths: 0, early_deaths: 0, lane_gold10: 0 } }, { match_id: 'EUW1_missing', missing: true, game_start: null, duration: null, champion_id: null, role: null, patch: null, queue_id: null, win: null, values: { cs10: null, deaths: null, early_deaths: null, lane_gold10: null } }]);
const PRACTICE = freeze([{ ...match(), win: false, values: { cs10: null, deaths: 2, early_deaths: null, lane_gold10: null } }]);
const PROMPT = freeze({ id: 'EUW1_fixture:early_death:0', match_id: 'EUW1_fixture', seconds: 0, title: 'An early death', question: 'What was visible, and what alternatives did you consider?', evidence: 'The cached timeline records your death at 0s, before 10 minutes.', kind: 'early_death' });
const CONTEXT = freeze({ match: match(), available: true, reason: null, events: [{ seconds: 0, kind: 'death', label: 'Your death', side: 'us' }, { seconds: 60, kind: 'monster', label: 'Dragon', side: 'them' }], prompts: [PROMPT], note: REVIEW_NOTE });
const definitions = role => [['cs10', role === 'JUNGLE' ? 'Jungle CS before 10 minutes' : 'Lane CS at 10 minutes', role === 'JUNGLE' ? 'jungle minions' : 'lane minions'], ['lane_gold10', 'Gold difference vs lane opponent at 10 minutes', 'gold'], ['deaths', 'Deaths per game', 'deaths'], ['early_deaths', 'Deaths before 10 minutes', 'deaths']].filter(([key]) => role === 'UTILITY' ? !['cs10', 'lane_gold10'].includes(key) : role === 'JUNGLE' ? key !== 'lane_gold10' : role ? true : ['deaths', 'early_deaths'].includes(key));
function progress(tracking = null, { available = !!tracking, reason = tracking ? null : 'Start match tracking for this plan.', started = false } = {}) {
  const baseline = available ? copy(BASELINE) : [], practice = available && !started ? copy(PRACTICE) : [];
  return { available, reason, tracking: copy(tracking), baseline: { games: tracking ? 2 : 0, rows: baseline }, practice: { games: practice.length, rows: practice }, metrics: definitions(tracking?.role).map(([key, label, unit]) => {
    const group = rows => { const values = rows.map(row => row.values[key]).filter(value => value !== null); return { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, n: values.length }; };
    const a = group(baseline), b = group(practice);
    return { key, label, unit, baseline: a, practice: b, difference: a.n && b.n ? b.mean - a.mean : null };
  }), note: NOTE, truncated: false };
}
function queue(planId = null, tracking = null) { return { available: true, reason: null, scope: { plan_id: planId, ...(tracking ? copy(tracking) : { queue_id: 420, games: 10 }) }, games_considered: 2, timelines_available: 1, prompts: [copy(PROMPT)], missing_timelines: 1, note: REVIEW_NOTE, truncated: false }; }
class MatchHTTPError extends Error { constructor(status, message) { super(message); this.status = status; } }
const requireFields = (condition, message = 'Invalid request fields or types') => { if (!condition) throw new MatchHTTPError(422, message); };
function exact(value, required, optional = []) { requireFields(value !== null && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key))); }
function validateStart(body) {
  exact(body, ['revision', 'role', 'champion_id', 'queue_id', 'patch']);
  requireFields(Number.isInteger(body.revision) && body.revision >= 1 && body.revision <= 2 ** 31 - 1);
  requireFields(OPTIONS.roles.some(role => role.id === body.role));
  requireFields(body.champion_id === null || Number.isInteger(body.champion_id) && body.champion_id >= 1 && body.champion_id <= 2 ** 31 - 1);
  requireFields(Number.isInteger(body.queue_id) && OPTIONS.queues.some(queue => queue.id === body.queue_id));
  requireFields(typeof body.patch === 'string' && body.patch.trim().length > 0 && [...body.patch].length <= 32 && !/\p{C}/u.test(body.patch));
}
// Shared by the integrated index test, but importing this file never launches a browser.
class MatchFixture {
  constructor() { this.links = new Map(); this.options = OPTIONS; this.context = CONTEXT; this.progressReply = null; this.queueReply = null; }
  handles(url) { return /^\/api\/training\/(?:matches\/options|plans\/[^/]+\/matches|review-queue|review-context\/[^/]+)$/.test(url.pathname); }
  handle(call, find) {
    const { method, url, body, headers = {} } = call;
    const planRoute = url.pathname.match(/^\/api\/training\/plans\/([^/]+)\/matches$/);
    const allowed = method === 'DELETE' && planRoute ? ['revision'] : method === 'GET' && url.pathname.endsWith('/review-queue') ? ['plan_id'] : [];
    requireFields([...url.searchParams].every(([key]) => allowed.includes(key) && url.searchParams.getAll(key).length === 1), 'Unknown or duplicate query fields');
    if (method === 'POST') { requireFields(headers['content-type']?.split(';')[0] === 'application/json'); validateStart(body); }
    else requireFields(body === null, 'Unexpected request body');
    const ownPlan = id => { const entry = find(decodeURIComponent(id)); if (!entry || entry.kind !== 'plans' || entry.team_id !== null || entry.owner !== call.user) throw new MatchHTTPError(404, 'Training entry not found'); return entry; };
    if (url.pathname.endsWith('/matches/options') && method === 'GET') return copy(this.options);
    if (planRoute) {
      const entry = ownPlan(planRoute[1]), tracking = this.links.get(entry.id) || null;
      if (method === 'GET') return copy(this.progressReply || progress(tracking));
      requireFields(['POST', 'DELETE'].includes(method));
      const requested = method === 'POST' ? body.revision : url.searchParams.get('revision');
      requireFields(method === 'POST' || typeof requested === 'string' && /^[0-9]{1,10}$/.test(requested) && Number(requested) >= 1 && Number(requested) <= 2 ** 31 - 1);
      if (Number(requested) !== entry.revision) throw new MatchHTTPError(409, 'This entry changed. Reload it before saving or deleting.');
      if (method === 'POST') {
        requireFields(this.options.patches.includes(body.patch) && (body.champion_id === null || this.options.champions.some(champion => champion.id === body.champion_id)), 'Choose a patch and champion from the available cached match options');
        const link = { started: TRACKING.started, games: entry.data.games, role: body.role, champion_id: body.champion_id, queue_id: body.queue_id, patch: body.patch };
        this.links.set(entry.id, link); entry.revision++; entry.updated++;
        return { ...progress(link, { started: true }), entry: copy(entry) };
      }
      this.links.delete(entry.id); entry.revision++; entry.updated++;
      return { ok: true, entry: copy(entry) };
    }
    if (url.pathname.endsWith('/review-queue') && method === 'GET') {
      const planId = url.searchParams.get('plan_id'); if (planId !== null) ownPlan(planId);
      if (this.queueReply) return copy(this.queueReply);
      if (planId && !this.links.has(planId)) return { ...queue(planId), available: false, reason: 'Start match tracking for this plan.', games_considered: 0, timelines_available: 0, missing_timelines: 0, prompts: [] };
      return queue(planId, this.links.get(planId));
    }
    if (url.pathname.startsWith('/api/training/review-context/') && method === 'GET') {
      if (decodeURIComponent(url.pathname.split('/').at(-1)) !== this.context.match.match_id) throw new MatchHTTPError(404, 'Completed match not found');
      return copy(this.context);
    }
    throw Error(`Unmocked match API: ${method} ${url.pathname}`);
  }
}
module.exports = { MatchFixture, MatchHTTPError, OPTIONS, TRACKING, CONTEXT, PROMPT, NOTE, REVIEW_NOTE, CACHE_REASON, progress, queue };

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const entry = (id = 'p1', data = {}) => ({ id, kind: 'plans', owner: 'alice', team_id: null, revision: 1, created: 1, updated: 1, data: { title: 'A deliberate week', focus: 'One repeatable focus', role: 'MIDDLE', champion: 'Champion 22', workout_id: 'last-hit', minutes: 10, games: 3, status: 'active', ...data } });
const workout = freeze({ id: 'last-hit', title: 'Last hits', roles: ['MIDDLE'], minutes: 10, goal: 'Repeat the setup', steps: ['Open League manually', 'Record the result'], measure: 'Last hits', unit: 'last hits', tip: 'No promotion target' });
async function bounded(promise, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), 6000); })]); } finally { clearTimeout(timer); } }
async function until(fn, label = 'mock response') { const deadline = Date.now() + 6000; while (!fn()) { if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); } }
const key = async locator => { await locator.waitFor(); await locator.focus(); assert(await locator.evaluate(node => node === document.activeElement)); await locator.press('Enter'); };
async function disclose(page, selector) { const details = page.locator(selector); if (!await details.evaluate(node => node.open)) await key(details.locator(':scope > summary')); }
const matchCalls = state => state.calls.filter(call => /\/(?:matches(?:\/options)?|review-queue|review-context\/[^/]+)$/.test(call.url.pathname));
const tick = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function loadMatches(f) {
  await disclose(f.page, '[data-match-tools]');
  const before = f.state.calls.length;
  await key(f.page.locator('[data-load-matches]'));
  await until(() => f.state.calls.slice(before).some(call => call.url.pathname.endsWith('/matches/options')), 'explicit options');
  await f.page.waitForFunction(available => { const button = document.querySelector('[data-load-matches]'); return button && !button.disabled && (!available || document.querySelector('[name="match_patch"]')?.options.length > 0); }, f.matches.options.available);
  await tick(f.page);
  if (!f.matches.options.available) assert.equal(await f.page.locator('[data-match-form]').count(), 0, 'Unavailable options show their reason instead of an enrollment form');
}
async function configure(f, champion = '22') {
  const form = f.page.locator('[data-match-form]');
  await form.locator('[name="match_role"]').selectOption('MIDDLE');
  const champions = form.locator('[name="match_champion"]');
  await champions.selectOption(champion || await champions.locator('option').evaluateAll(nodes => nodes.find(node => !/^[1-9]\d*$/.test(node.value)).value));
  await form.locator('[name="match_queue"]').selectOption('420'); await form.locator('[name="match_patch"]').selectOption('26.20');
}
async function start(f, champion = '22') {
  await configure(f, champion); const n = f.state.calls.length;
  await key(f.page.locator('[data-start-tracking]'));
  await until(() => f.state.calls.slice(n).some(call => call.method === 'POST' && call.url.pathname.endsWith('/matches')), 'explicit start');
  await f.page.waitForFunction(() => !document.querySelector('[data-start-tracking]').disabled); await tick(f.page);
}
async function loadQueue(f) {
  const n = f.state.calls.length; await key(f.page.locator('[data-load-queue]'));
  await until(() => f.state.calls.slice(n).some(call => call.url.pathname.endsWith('/review-queue')), 'explicit queue');
  await f.page.waitForFunction(() => !document.querySelector('[data-load-queue]').disabled); await tick(f.page);
}
async function layout(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow at mobile width');
  for (const selector of ['[data-load-matches]', '[data-start-tracking]', '[data-load-queue]', '[data-review-queue] a']) {
    const target = page.locator(selector).first(); if (!await target.count() || !await target.isVisible()) continue;
    const box = await target.boundingBox(); assert(box.width >= 44 && box.height >= 44, `${selector} needs a 44px touch target`);
  }
}
async function browserSuite() {
  const playwright = require('playwright'), type = playwright[process.env.BROWSER || 'chromium']; assert(type, 'Unknown BROWSER');
  const browser = await type.launch({ headless: true, timeout: 15000, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const active = new Set(), failures = []; let ran = 0;
  async function fixture({ width = 320, hash = '#/practice', plans = [entry()], tracking = null } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' }), page = await context.newPage(); page.setDefaultTimeout(6000);
    const state = { records: T.normalizeBootstrap({ entries: { plans: copy(plans) } }).entries, calls: [], errors: [], unexpected: [], rules: [], held: new Set(), serial: 0 };
    const matches = new MatchFixture(); if (tracking) matches.links.set(plans[0].id, copy(tracking));
    page.on('pageerror', error => state.errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        assert.equal(url.origin, 'https://training.test', 'No real network');
        // WebKit routes addScriptTag's local Blob scripts and native video-control resources too.
        if (url.protocol === 'blob:') { assert.equal(request.method(), 'GET'); return await route.continue(); }
        if (url.pathname === '/') return await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="app"></main>' });
        assert.match(url.pathname, /^\/api\/training(?:\/|$)/);
        const call = { url, method: request.method(), body: request.postData() ? request.postDataJSON() : null, headers: request.headers(), user: 'alice' }; state.calls.push(call);
        const index = state.rules.findIndex(rule => rule.when(call)), rule = index < 0 ? null : state.rules.splice(index, 1)[0];
        let body, status = 200;
        try {
          if (rule?.reply) { status = rule.reply.status; body = copy(rule.reply.body); }
          else if (url.pathname === '/api/training' && call.method === 'GET') { assert.equal(url.search, ''); body = { catalog: { workouts: [workout], starter_puzzles: [] }, entries: copy(state.records), teams: [], invitations: [], limits: { has_more: {}, per_member: 200 } }; }
          else if (matches.handles(url)) body = matches.handle(call, id => state.records.plans.find(row => row.id === id));
          else if (/^\/api\/training\/entries\/plans(?:\/[^/]+)?$/.test(url.pathname)) {
            const id = url.pathname.split('/')[5], old = state.records.plans.find(row => row.id === id);
            if (call.method === 'GET') { exact(Object.fromEntries(url.searchParams), [], ['offset', 'limit']); body = { entries: copy(state.records.plans), has_more: false }; }
            else {
              requireFields(['POST', 'PUT'].includes(call.method)); exact(call.body, call.method === 'POST' ? ['data'] : ['data', 'revision'], call.method === 'POST' ? ['team_id'] : []);
              exact(call.body.data, ['title', 'focus', 'role', 'champion', 'workout_id', 'minutes', 'games', 'status']);
              requireFields(typeof call.body.data.title === 'string' && call.body.data.title.trim() && Number.isInteger(call.body.data.games) && call.body.data.games >= 1 && call.body.data.games <= 20);
              if (call.method === 'PUT' && (!old || call.body.revision !== old.revision)) throw new MatchHTTPError(409, 'This entry changed. Reload it before saving or deleting.');
              const saved = { ...(old || entry(`created-${++state.serial}`)), data: copy(call.body.data), revision: (old?.revision || 0) + 1 };
              if (saved.data.status === 'active') for (const row of state.records.plans) if (row.id !== saved.id && row.data.status === 'active') { row.data.status = 'archived'; row.revision++; }
              if (old) state.records.plans[state.records.plans.indexOf(old)] = saved; else state.records.plans.unshift(saved); body = { entry: copy(saved) };
            }
          } else throw Error(`Unmocked API: ${call.method} ${url.pathname}`);
        } catch (error) { if (!(error instanceof MatchHTTPError)) throw error; status = error.status; body = { detail: error.message }; if (status === 422) state.unexpected.push(`${call.method} ${url.pathname}: ${error.message}`); }
        rule?.hit.resolve(call);
        if (rule?.gate) { state.held.add(rule); await rule.gate.promise; state.held.delete(rule); }
        try { await route.fulfill({ status, json: body }); } catch (error) { if (!rule?.gate) throw error; }
      } catch (error) { state.unexpected.push(error.stack); await route.fulfill({ status: 599, json: { detail: error.message } }).catch(() => {}); }
    });
    await page.goto('https://training.test/' + hash);
    await page.addStyleTag({ content: read('static/style.css') + '\n' + read('static/training.css') });
    await page.evaluate(() => {
      window.ME = { username: 'alice' }; window.nav = 0; window.confirmResult = true; window.confirmations = []; window.apiDone = 0;
      window.confirm = message => { confirmations.push(message); return confirmResult; };
      // Deliberately finish old requests even after disposal, exercising actual stale guards rather than abort alone.
      window.api = async (path, options = {}) => { const { signal, ...rest } = options; try { const response = await fetch(path, rest), body = await response.json(); if (!response.ok) throw Object.assign(Error(body.detail), { status: response.status }); return body; } finally { apiDone++; } };
    });
    await page.addScriptTag({ content: read('static/training.js') }); await page.addScriptTag({ content: read('static/training-review.js') });
    assert.equal(state.calls.length, 0, 'Registration is request-free'); await page.evaluate(() => showTraining());
    const f = { page, state, matches,
      next(when, reply = null, hold = false) { const rule = { when, reply, hit: deferred(), gate: hold ? deferred() : null }; state.rules.push(rule); return { hit: () => bounded(rule.hit.promise, 'expected held request'), async release() { const before = await page.evaluate(() => apiDone); rule.gate?.resolve(); await page.waitForFunction(n => apiDone > n, before); await tick(page); } }; },
      async close() { active.delete(f); for (const rule of [...state.rules, ...state.held]) rule.gate?.resolve(); try { assert.deepEqual(state.errors, [], 'No uncaught browser errors'); assert.deepEqual(state.unexpected, [], 'No unmocked requests or rejected request schemas'); assert.equal(state.rules.length, 0, 'Every expected request was made'); assert.equal(await page.evaluate(() => window.__matchXSS), undefined); } finally { await page.evaluate(() => Training.dispose()).catch(() => {}); await context.close(); } }
    }; active.add(f); return f;
  }
  const selected = process.env.TRAINING_CASE ? new RegExp(process.env.TRAINING_CASE, 'i') : null;
  async function check(name, fn) { if (selected && !selected.test(name)) return; ran++; try { await fn(); console.log(`ok - ${name}`); } catch (error) { failures.push(name); console.error(`not ok - ${name}\n${error.stack}`); } finally { for (const f of [...active]) try { await f.close(); } catch (error) { failures.push(`${name} cleanup`); console.error(error.stack); } } }
  try {
    await check('vanilla routes, aliases and queue links never opt in automatically', async () => {
      for (const hash of ['#/practice', '#/practice?focus=Draft&role=MIDDLE', '#/practice/lasthit', '#/practice/dodge', '#/practice/experiments', '#/practice/review', '#/practice/review?match=EUW1_fixture&at=0&prompt=EUW1_fixture%3Aearly_death%3A0', '#/practice/lessons', '#/practice/puzzles']) {
        const f = await fixture({ hash }); await tick(f.page); assert.deepEqual(f.state.calls.map(call => call.url.pathname), ['/api/training']); await f.close();
      }
    });
    for (const width of [320, 1280]) await check(`explicit opt-in, captured window, zero/null samples, queue links and touch/keyboard ${width}px`, async () => {
      const f = await fixture({ width }), { page, state } = f;
      await disclose(page, '[data-match-tools]'); assert.equal(matchCalls(state).length, 0, 'Opening a disclosure does not fetch');
      await loadMatches(f);
      assert.deepEqual(matchCalls(state).map(call => [call.method, call.url.pathname]).sort(), [['GET', '/api/training/matches/options'], ['GET', '/api/training/plans/p1/matches']].sort());
      assert.equal(await page.locator('[name="match_role"]').inputValue(), 'MIDDLE');
      assert.equal(await page.locator('[name="match_patch"]').inputValue(), '26.20');
      assert.equal(await page.locator('[name="match_queue"]').inputValue(), '420');
      assert.equal(await page.locator('[name="match_champion"]').inputValue(), '22', 'Saved champion name resolves to an offered numeric ID');
      assert.equal(await page.locator('[name="review_scope"]').inputValue(), 'plan');
      await start(f); assert.equal(state.records.plans[0].revision, 2);
      const request = matchCalls(state).find(call => call.method === 'POST'); assert.deepEqual(request.body, { revision: 1, role: 'MIDDLE', champion_id: 22, queue_id: 420, patch: '26.20' }); assert.equal(request.url.search, '');
      await loadMatches(f);
      const comparison = page.locator('[data-match-comparison]'); await comparison.locator('table').waitFor();
      const rows = await comparison.locator('tbody tr').allInnerTexts();
      const cs = rows.find(row => /Lane CS at 10 minutes/.test(row)); assert(cs, 'CS numeric metric is present without hover'); assert.match(cs, /\b0\b/); assert.match(cs, /\b1\b/); assert.match(cs, /missing|unavailable|not recorded|—/i);
      const deaths = rows.find(row => /Deaths per game/.test(row)); assert.match(deaths, /\b0\b/); assert.match(deaths, /\b2\b/);
            const headers = await comparison.locator('thead th').allInnerTexts(), baselineColumn = headers.findIndex(text => /baseline/i.test(text)), practiceColumn = headers.findIndex(text => /practice/i.test(text));
            assert(baselineColumn >= 0 && practiceColumn >= 0, 'Numeric columns identify the compared windows');
            const csRow = comparison.locator('tbody tr').filter({ hasText: 'Lane CS at 10 minutes' });
            const values = await csRow.evaluate((row, columns) => columns.map(column => row.cells[column].innerText), [baselineColumn, practiceColumn]);
            assert.match(values[0], /\b0\b/, 'A measured zero remains zero'); assert.match(values[1], /missing|unavailable|not recorded|—/i, 'No numeric sample must not display a zero mean');
      assert.match(await comparison.innerText(), /sample|\bn\b|recorded/i); assert.match(await comparison.innerText(), /missing|unavailable|not recorded/i); assert.match(await comparison.innerText(), /descriptive|not.*caus|not evidence/i);
      const window = await page.locator('[data-match-window]').innerText(); assert.match(window, /26\.20/); assert.match(window, /3/); assert.match(window, /middle|mid/i); assert.match(window, /captur|start|window/i);
      await page.locator('[name="match_patch"]').selectOption('26.19'); assert.equal(await page.locator('[data-match-window]').innerText(), window, 'Draft filters cannot relabel the captured sample');
      await loadQueue(f); const call = matchCalls(state).filter(call => call.url.pathname.endsWith('/review-queue')).at(-1); assert.equal(call.url.search, '?plan_id=p1');
      const list = page.locator('[data-review-queue]'); assert.match(await list.innerText(), /1.*(?:missing|unavailable)|(?:missing|unavailable).*1/i);
      assert.match(await page.locator('[data-review-scope]').innerText(), /plan|26\.20/i);
      const link = list.locator('a[href^="#/practice/review?"]').first(); const href = await link.getAttribute('href'), url = new URL(href.slice(1), 'https://training.test');
      assert.equal(url.pathname, '/practice/review'); assert.deepEqual(Object.fromEntries(url.searchParams), { match: PROMPT.match_id, at: '0', prompt: PROMPT.id });
      const region = comparison.locator('[tabindex="0"]').first(); if (await region.count()) { await region.focus(); await page.keyboard.press('ArrowRight'); assert(await region.evaluate(node => node === document.activeElement)); }
      await layout(page); await key(link); assert.equal(await page.evaluate(() => location.hash), href); assert.equal(matchCalls(state).filter(call => call.url.pathname.includes('/review-context/')).length, 0, 'A queue link only navigates; context remains explicit'); await f.close();
    });
    await check('start/stop revisions merge into the next ordinary plan save, including null champion', async () => {
      const f = await fixture(); await loadMatches(f); await start(f, '');
      assert.equal(matchCalls(f.state).find(call => call.method === 'POST').body.champion_id, null);
      await disclose(f.page, '[data-plan-details]'); const title = f.page.locator('[data-plan-editor] [name="title"]'); await title.fill('After enrollment'); await key(f.page.locator('[data-plan-editor] [type="submit"]'));
      await f.page.locator('[data-training-status]').filter({ hasText: 'Weekly plan saved' }).waitFor();
      assert.equal(f.state.calls.find(call => call.method === 'PUT').body.revision, 2); assert.equal(f.state.records.plans[0].revision, 3);
      await key(f.page.locator('[data-stop-tracking]')); await until(() => f.state.records.plans[0].revision === 4, 'stop revision'); await tick(f.page);
      const stop = matchCalls(f.state).find(call => call.method === 'DELETE'); assert.equal(stop.url.search, '?revision=3'); assert.equal(stop.body, null); assert.equal(f.matches.links.has('p1'), false);
      await title.fill('After stopping'); await key(f.page.locator('[data-plan-editor] [type="submit"]')); await until(() => f.state.records.plans[0].revision === 5);
      assert.equal(f.state.calls.filter(call => call.method === 'PUT').at(-1).body.revision, 4); await f.close();
    });
    await check('pending options and enrollment preserve new plan/session/filter typing and focus', async () => {
      const f = await fixture(), { page } = f; await disclose(page, '[data-match-tools]'); await disclose(page, '[data-plan-details]');
      const title = page.locator('[data-plan-editor] [name="title"]'), reflection = page.locator('[data-session-editor] [name="reflection"]');
      const originalTitle = await title.elementHandle(), originalSession = await reflection.elementHandle(), savedPlanData = copy(f.state.records.plans[0].data);
      const options = f.next(call => call.url.pathname.endsWith('/matches/options'), null, true); await key(page.locator('[data-load-matches]')); await options.hit();
      await title.fill('Typed after loading started'); await reflection.fill('Session draft survives options'); await options.release();
      assert.equal(await title.inputValue(), 'Typed after loading started'); assert.equal(await reflection.inputValue(), 'Session draft survives options'); assert(await originalTitle.evaluate(node => node.isConnected)); assert(await originalSession.evaluate(node => node.isConnected && node === document.activeElement));
      await page.locator('[data-plan-editor] [name="games"]').fill('7');
            await configure(f); const gate = f.next(call => call.method === 'POST' && call.url.pathname.endsWith('/matches'), null, true); await key(page.locator('[data-start-tracking]')); await gate.hit();
      await page.locator('[name="match_patch"]').selectOption('26.19'); await title.fill('Typed during enrollment'); await gate.release();
      assert.equal(await title.inputValue(), 'Typed during enrollment'); assert(await originalTitle.evaluate(node => node.isConnected && node === document.activeElement)); assert.equal(await page.locator('[name="match_patch"]').inputValue(), '26.19'); assert.equal(await reflection.inputValue(), 'Session draft survives options');
      assert.equal(f.state.records.plans[0].revision, 2);
      assert.deepEqual(f.state.records.plans[0].data, savedPlanData, 'Enrollment must not auto-save a dirty plan');
      assert.equal(f.matches.links.get('p1').games, savedPlanData.games, 'Tracking captures the saved game window, not the unsaved draft');
      assert.equal(await page.locator('[data-plan-editor] [name="games"]').inputValue(), '7');
      assert.equal(f.state.calls.filter(call => /^\/api\/training\/entries\/plans(?:\/|$)/.test(call.url.pathname) && ['POST', 'PUT'].includes(call.method)).length, 0, 'Only an explicit plan save may persist plan edits');
            const saved = f.next(call => call.method === 'PUT', null, true); await key(page.locator('[data-plan-editor] [type="submit"]')); await saved.hit();
            const role = page.locator('[name="match_role"]'), originalRole = await role.elementHandle(); await role.selectOption('UTILITY'); await role.focus(); await saved.release();
            assert.equal(await role.inputValue(), 'UTILITY'); assert(await originalRole.evaluate(node => node.isConnected && node === document.activeElement), 'An ordinary plan save cannot replace or blur the match filter input');
            assert.equal(f.state.records.plans[0].revision, 3); assert.equal(f.state.calls.find(call => call.method === 'PUT').body.revision, 2);
            assert.match(await page.locator('[data-match-saved-window]').innerText(), /first 7 comparable games/, 'The next-start window follows the saved plan without replacing inputs');
            assert.equal(f.matches.links.get('p1').games, savedPlanData.games, 'The already captured window remains frozen'); await f.close();
    });
    await check('pending progress and stop preserve replacement drafts and focused input nodes', async () => {
      const f = await fixture({ tracking: TRACKING }), { page } = f; await loadMatches(f); await disclose(page, '[data-plan-details]');
      const title = page.locator('[data-plan-editor] [name="title"]'), original = await title.elementHandle();
      const progressGate = f.next(call => call.method === 'GET' && call.url.pathname.endsWith('/plans/p1/matches'), null, true); await key(page.locator('[data-load-matches]')); await progressGate.hit();
      await page.locator('[name="match_role"]').selectOption('TOP'); await title.fill('New input during progress'); await progressGate.release();
      assert.equal(await title.inputValue(), 'New input during progress'); assert.equal(await page.locator('[name="match_role"]').inputValue(), 'TOP'); assert(await original.evaluate(node => node.isConnected && node === document.activeElement));
      const stopGate = f.next(call => call.method === 'DELETE' && call.url.pathname.endsWith('/matches'), null, true); await key(page.locator('[data-stop-tracking]')); await stopGate.hit(); await title.fill('New input during stop'); await stopGate.release();
      assert.equal(await title.inputValue(), 'New input during stop'); assert(await original.evaluate(node => node.isConnected && node === document.activeElement)); await key(page.locator('[data-plan-editor] [type="submit"]')); await until(() => f.state.records.plans[0].revision === 3); assert.equal(f.state.calls.find(call => call.method === 'PUT').body.revision, 2); await f.close();
    });
    await check('enrollment supersedes a pending progress read without stranding the refresh button', async () => {
      const f = await fixture(), { page } = f; await loadMatches(f);
      const old = f.next(call => call.method === 'GET' && call.url.pathname.endsWith('/plans/p1/matches'), null, true);
      await key(page.locator('[data-load-matches]')); await old.hit();
      await start(f); await old.release(); await tick(page);
      assert.equal(await page.locator('[data-load-matches]').isEnabled(), true);
      assert.equal(await page.locator('[data-stop-tracking]').isVisible(), true, 'Old progress cannot erase the newly captured window');
      assert.match(await page.locator('[data-match-window]').innerText(), /26\.20/);
      await loadMatches(f); await f.close();
    });
    await check('a changed review scope can refresh before an obsolete request finishes', async () => {
      const f = await fixture({ tracking: TRACKING }), { page } = f; await loadMatches(f);
      const body = queue('p1', TRACKING); body.prompts[0].title = 'OBSOLETE-PLAN-PROMPT';
      const old = f.next(call => call.url.pathname.endsWith('/review-queue'), { status: 200, body }, true);
      await key(page.locator('[data-load-queue]')); await old.hit();
      await page.locator('[name="review_scope"]').selectOption('recent');
      assert.equal(await page.locator('[data-load-queue]').isEnabled(), true);
      await loadQueue(f); await old.release(); await tick(page);
      assert.equal(await page.locator('[data-review-queue] a').count(), 1);
      assert(!(await page.locator('[data-review-queue]').innerText()).includes('OBSOLETE-PLAN-PROMPT'));
      await f.close();
    });
    await check('409 enrollment/stop keeps drafts and never silently resubmits', async () => {
      const f = await fixture(), { page } = f; await loadMatches(f); await disclose(page, '[data-plan-details]'); await page.locator('[data-plan-editor] [name="focus"]').fill('Unsent focus'); await configure(f);
      const conflict = { status: 409, body: { detail: 'This entry changed. Reload it before saving or deleting.' } };
      f.next(call => call.method === 'POST' && call.url.pathname.endsWith('/matches'), conflict); await key(page.locator('[data-start-tracking]')); await page.locator('[data-match-status]').filter({ hasText: /changed|reload|conflict/i }).waitFor(); await tick(page);
      assert.equal(await page.locator('[name="match_champion"]').inputValue(), '22'); assert.equal(await page.locator('[data-plan-editor] [name="focus"]').inputValue(), 'Unsent focus'); assert.equal(f.state.records.plans[0].revision, 1); assert.equal(matchCalls(f.state).filter(call => call.method === 'POST').length, 1);
      await start(f); f.next(call => call.method === 'DELETE' && call.url.pathname.endsWith('/matches'), conflict); await key(page.locator('[data-stop-tracking]')); await page.locator('[data-match-status]').filter({ hasText: /changed|reload|conflict/i }).waitFor(); await tick(page);
      assert.equal(matchCalls(f.state).filter(call => call.method === 'DELETE').length, 1); assert.equal(f.matches.links.has('p1'), true); assert.equal(f.state.records.plans[0].revision, 2); assert.equal(await page.locator('[data-plan-editor] [name="focus"]').inputValue(), 'Unsent focus'); await f.close();
    });
    await check('missing cache and relinked account remain unavailable, never zero-valued observations', async () => {
      for (const reason of [CACHE_REASON, 'Tracking belongs to a different linked account. Relink that account or explicitly restart tracking.']) {
        const f = await fixture({ tracking: TRACKING }); f.matches.options = freeze({ ...copy(OPTIONS), patches: [], champions: [], available: false, reason }); f.matches.progressReply = freeze(progress(TRACKING, { available: false, reason })); f.matches.queueReply = freeze({ ...queue('p1', TRACKING), available: false, reason, games_considered: 0, timelines_available: 0, missing_timelines: 0, prompts: [] });
        await loadMatches(f); const text = await f.page.locator('[data-match-tools]').innerText(); assert.match(text, /unavailable|different linked account/i); assert(!/\b0(?:\.0+)?\s+(?:deaths|lane minions|gold)\b/i.test(text));
        const rows = await f.page.locator('[data-match-comparison] tbody tr').allInnerTexts(); for (const row of rows) assert.match(row, /unavailable|missing|not recorded|—/i, 'Unavailable means must stay distinct from valid zero sample counts');
        await loadQueue(f); assert.equal(await f.page.locator('[data-review-queue] a').count(), 0); assert.match(await f.page.locator('[data-match-tools]').innerText(), /unavailable|different linked account/i); assert.equal(matchCalls(f.state).filter(call => call.method !== 'GET').length, 0); await f.close();
      }
    });
    await check('queue scope defaults, immediate clearing, and A-B-A stale response isolation', async () => {
      const recent = await fixture({ plans: [] }); await disclose(recent.page, '[data-match-tools]'); assert.equal(await recent.page.locator('[name="review_scope"]').inputValue(), 'recent'); await loadQueue(recent); assert.equal(matchCalls(recent.state).at(-1).url.search, ''); await recent.close();
      const f = await fixture({ tracking: TRACKING }), { page } = f; await loadMatches(f); await loadQueue(f); assert.equal(await page.locator('[data-review-queue] a').count(), 1);
      const selector = page.locator('[name="review_scope"]'); await selector.selectOption('recent'); assert.equal(await page.locator('[data-review-queue] a').count(), 0, 'Clear immediately on scope change'); assert.equal(matchCalls(f.state).filter(call => call.url.pathname.endsWith('/review-queue')).length, 1, 'Changing scope does not fetch');
      const oldBody = queue(); oldBody.prompts[0].title = 'OLD-RECENT-PRIVATE'; const old = f.next(call => call.url.pathname.endsWith('/review-queue'), { status: 200, body: oldBody }, true); await key(page.locator('[data-load-queue]')); await old.hit();
      await selector.selectOption('plan'); await selector.selectOption('recent'); await old.release(); assert(!/OLD-RECENT-PRIVATE/.test(await page.locator('[data-review-queue]').innerText()), 'Same value after A-B-A is still a new scope epoch'); assert.equal(await page.locator('[data-review-queue] a').count(), 0);
      await loadQueue(f); assert.equal(matchCalls(f.state).at(-1).url.search, ''); assert.match(await page.locator('[data-review-scope]').innerText(), /recent|10|solo/i); await f.close();
    });
    await check('changing the saved active plan clears loaded/pending queue and discards the old plan reply', async () => {
      const f = await fixture({ tracking: TRACKING }), { page } = f; await loadMatches(f); await loadQueue(f);
      const oldBody = queue('p1', TRACKING); oldBody.prompts[0].title = 'OLD-PLAN-ONLY'; const old = f.next(call => call.url.pathname.endsWith('/review-queue'), { status: 200, body: oldBody }, true); await key(page.locator('[data-load-queue]')); await old.hit();
      await page.locator('[data-new-plan]').evaluate(node => { node.closest('details').open = true; }); await key(page.locator('[data-new-plan]')); await page.locator('[data-plan-editor] [name="title"]').fill('Replacement active plan'); await key(page.locator('[data-plan-editor] [type="submit"]')); await until(() => f.state.records.plans.some(row => row.id !== 'p1' && row.data.status === 'active')); await tick(page);
      assert.equal(await page.locator('[data-review-queue] a').count(), 0); await old.release(); assert(!/OLD-PLAN-ONLY/.test(await page.locator('[data-match-tools]').innerText()));
      const before = matchCalls(f.state).filter(call => call.url.pathname.endsWith('/review-queue')).length; assert.equal(before, 2, 'New active plan cannot automatically reload a private queue'); await loadQueue(f); assert.equal(matchCalls(f.state).filter(call => call.url.pathname.endsWith('/review-queue')).at(-1).url.searchParams.get('plan_id'), f.state.records.plans.find(row => row.data.status === 'active').id); await f.close();
    });
    await check('late queue/options/progress cannot cross account, navigation or disposal boundaries', async () => {
      for (const endpoint of ['queue', 'options', 'progress']) for (const boundary of ['account', 'navigation', 'dispose']) {
        const f = await fixture({ tracking: TRACKING }), { page } = f; await loadMatches(f);
        const marker = `PRIVATE-${endpoint}-${boundary}`, body = endpoint === 'queue' ? queue('p1', TRACKING) : endpoint === 'options' ? copy(OPTIONS) : progress(TRACKING);
        if (endpoint === 'queue') body.prompts[0].title = marker; else if (endpoint === 'options') { body.account.game_name = marker; body.champions[0].name = marker; } else { body.note = marker; body.metrics[0].label = marker; }
        const when = call => call.method === 'GET' && (endpoint === 'queue' ? call.url.pathname.endsWith('/review-queue') : endpoint === 'options' ? call.url.pathname.endsWith('/matches/options') : call.url.pathname.endsWith('/plans/p1/matches'));
        const old = f.next(when, { status: 200, body }, true); await key(page.locator(endpoint === 'queue' ? '[data-load-queue]' : '[data-load-matches]')); await old.hit();
        if (boundary === 'account') await page.evaluate(() => { ME = { username: 'bob' }; });
        else if (boundary === 'navigation') await page.evaluate(async () => { location.hash = '#/practice/experiments'; nav++; await showTraining(); });
        else await page.evaluate(() => { Training.dispose(); document.querySelector('#app').replaceChildren(); });
        await old.release(); assert(!(await page.locator('#app').innerText()).includes(marker), `${endpoint} must not reveal old private response after ${boundary}`); await f.close();
      }
    });
    await check('cached labels, notes and prompts are escaped; links retain only encoded review focus', async () => {
      const f = await fixture({ tracking: TRACKING }), { page } = f; const literal = '<img src=x onerror="window.__matchXSS=1"> & "quoted"';
      f.matches.options = freeze({ ...copy(OPTIONS), account: { ...OPTIONS.account, game_name: literal }, champions: OPTIONS.champions.map(champion => ({ ...champion, name: literal })) });
      const result = progress(TRACKING); result.metrics[0].label = literal; result.note = literal; f.matches.progressReply = freeze(result);
      const q = queue('p1', TRACKING); Object.assign(q.prompts[0], { title: literal, question: literal, evidence: literal }); q.note = literal; f.matches.queueReply = freeze(q);
      await loadMatches(f); await loadQueue(f); assert.match(await page.locator('[data-match-tools]').innerText(), /<img src=x onerror=/); assert.equal(await page.locator('#app img[src="x"], #app script, #app [onerror]').count(), 0); assert.equal(await page.evaluate(() => window.__matchXSS), undefined);
      const link = page.locator('[data-review-queue] a').first(), href = await link.getAttribute('href'), url = new URL(href.slice(1), 'https://training.test'); assert.deepEqual([...url.searchParams.keys()].sort(), ['at', 'match', 'prompt']); assert.equal(url.searchParams.get('prompt'), PROMPT.id); await layout(page); await key(link); assert.equal(await page.evaluate(() => location.hash), href); await f.close();
    });
  } finally { for (const f of [...active]) await f.close().catch(() => {}); await browser.close(); }
  assert(ran > 0, 'TRAINING_CASE did not match any checks'); if (failures.length) throw Error(`FAILED ${failures.length}: ${failures.join('; ')}`);
}
function pureSuite() {
  assert(Object.isFrozen(OPTIONS) && Object.isFrozen(OPTIONS.champions[0]) && Object.isFrozen(CONTEXT.prompts[0]));
  const original = JSON.stringify(OPTIONS), fixture = new MatchFixture(), plan = entry();
  const call = (method, route, body = null) => ({ method, url: new URL('/api/training' + route, 'https://training.test'), body, headers: { 'content-type': 'application/json' }, user: 'alice' });
  const valid = { revision: 1, role: 'MIDDLE', champion_id: 22, queue_id: 420, patch: '26.20' };
  for (const bad of [{ ...valid, champion_id: '22' }, { ...valid, queue_id: '420' }, { ...valid, queue_id: true }, { ...valid, revision: '1' }, { ...valid, extra: 'ignored?' }, { ...valid, role: '' }]) assert.throws(() => fixture.handle(call('POST', '/plans/p1/matches', bad), () => plan), MatchHTTPError);
  const started = fixture.handle(call('POST', '/plans/p1/matches', valid), () => plan); assert.equal(started.entry.revision, 2); assert.equal(started.practice.games, 0); assert.equal(started.metrics.find(metric => metric.key === 'cs10').baseline.mean, 0); assert.equal(started.metrics.find(metric => metric.key === 'cs10').practice.mean, null);
  assert.throws(() => fixture.handle(call('POST', '/plans/p1/matches', valid), () => plan), error => error.status === 409);
  assert.throws(() => fixture.handle(call('GET', '/review-queue?plan_id=p1&unknown=1'), () => plan), MatchHTTPError);
  assert.throws(() => fixture.handle(call('DELETE', '/plans/p1/matches?revision=2&revision=2'), () => plan), MatchHTTPError);
  assert.deepEqual(fixture.handle(call('DELETE', '/plans/p1/matches?revision=2'), () => plan), { ok: true, entry: plan }); assert.equal(plan.revision, 3); assert.equal(JSON.stringify(OPTIONS), original);
  console.log('ok - frozen backend-shaped fixtures, strict fields/types/queries, nullable samples and revision transitions');
}
if (require.main === module) { pureSuite(); if (!process.argv.includes('--pure')) browserSuite().catch(error => { console.error(error.stack); process.exitCode = 1; }); }
