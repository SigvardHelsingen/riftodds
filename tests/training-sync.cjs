// Pure: node tests/training-sync.cjs
// Mock browser: NODE_PATH=.browser-tools/node_modules node tests/training-sync.cjs --browser
// Real training core + in-memory responses only; no server, DB, Riot, network or real footage.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../static/training-review.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const source = read('static/training-review.js');
const copy = value => JSON.parse(JSON.stringify(value));
const mark = { kind: 'arrow', x: .2, y: .2, x2: .7, y2: .7, text: 'Keep this annotation' };
const moment = (seconds = 40, id = 'm1') => ({ id, seconds, title: 'Existing decision', known: 'Typed knowledge', options: 'Typed alternatives', decision: 'Wait', outcome: 'Unknown', lesson: 'Check cover', annotations: [copy(mark)] });
const review = (basis, moments = [moment()]) => ({ title: 'Saved review', match_id: 'EUW1_A', source_label: 'Manual label', ...(basis ? { time_basis: basis } : {}), moments });
const entry = (id, data, teamId = null) => ({ id, kind: 'reviews', data, team_id: teamId, owner: 'alice', revision: 1, created: 1, updated: 1 });
const cached = (matchId = 'EUW1_A', label = 'Cached objective') => ({ match: { match_id: matchId, game_start: 1700000000000, duration: 1800, champion_id: 1, role: 'MIDDLE', patch: '26.1', queue_id: 420 }, available: true, reason: null, events: [{ seconds: 60, kind: 'monster', label, side: 'them' }, { seconds: 2000, kind: 'building', label: 'Beyond recording', side: 'us' }], prompts: [{ id: `${matchId}:early_death:60`, match_id: matchId, seconds: 60, title: 'A cached reflection', question: 'What information and options were visible?', evidence: 'Timing alone is not causation.', kind: 'early_death' }], note: 'Cached observations, not a mistake verdict or cause attribution.' });
let count = 0;
function check(name, fn) { fn(); console.log(`pure ok ${++count} - ${name}`); }
check('module registration is request-free', () => {
  const registered = [];
  vm.runInNewContext(source, { window: { Training: { register: name => registered.push(name) }, fetch() { throw Error('No module requests'); } } });
  assert.deepEqual(registered, ['review', 'lessons', 'puzzles']);
});
check('old reviews default to video; only the allowed time_basis field is serialized', () => {
  const old = review();
  assert.equal(R.reviewData(old).time_basis, 'video');
  assert.equal(old.time_basis, undefined);
  const data = R.reviewData({ ...review('match'), offset: 20, calibration: { offset: 20 }, filename: 'SECRET.mp4', blob: {}, video_url: 'blob:secret', context: cached() });
  assert.deepEqual(Object.keys(data).sort(), ['title', 'match_id', 'source_label', 'time_basis', 'moments'].sort());
  assert.equal(data.time_basis, 'match');
  for (const time_basis of [null, '', 'game', true, 1]) assert.throws(() => R.reviewData({ ...old, time_basis }));
});
check('manual anchors support both offset signs and exact inverse conversions including zero', () => {
  assert.equal(R.clockOffset(80, 60, 180), 20);
  assert.equal(R.clockOffset(20, 60, 180), -40);
  assert.equal(R.convertSeconds(60, 'match', 'video', 20), 80);
  assert.equal(R.convertSeconds(80, 'video', 'match', 20), 60);
  assert.equal(R.convertSeconds(40, 'match', 'video', -40), 0);
  assert.equal(R.convertSeconds(0, 'video', 'match', -40), 40);
  assert.equal(R.convertSeconds(0, 'video', 'video', null), 0);
  assert.equal(R.convertSeconds(40, undefined, 'match', 20), 20);
  assert.equal(R.playbackSeconds(40, undefined, null, 180), 40);
});
check('invalid anchors, offsets, absent alignment and out-of-recording seeks never clamp to zero', () => {
  for (const args of [[-1, 0, 180], [181, 0, 180], [0, -1, 180], [0, 28801, 180], [NaN, 0, 180], [0, 0, Infinity]]) assert.throws(() => R.clockOffset(...args));
  for (const offset of [null, undefined, NaN, Infinity, '20', 28801, -28801]) assert.throws(() => R.convertSeconds(60, 'match', 'video', offset));
  assert.throws(() => R.playbackSeconds(10, 'match', -20, 180), /unavailable/);
  assert.throws(() => R.playbackSeconds(180, 'match', 20, 180), /unavailable/);
  assert.equal(R.playbackSeconds(160, 'match', 20, 180), 180);
});
check('all-moment basis conversion is atomic and rejects negative or oversized timestamps', () => {
  const old = review(undefined, [moment(40), moment(10, 'm2')]), before = copy(old);
  assert.throws(() => R.convertReviewBasis(old, 'match', 20));
  assert.deepEqual(old, before);
  assert.throws(() => R.convertReviewBasis(review('match', [moment(28790)]), 'video', 20));
  const converted = R.convertReviewBasis(review(undefined, [moment(40)]), 'match', 20);
  assert.equal(converted.time_basis, 'match'); assert.equal(converted.moments[0].seconds, 20);
  assert.deepEqual(converted.moments[0].annotations, [mark]);
  assert.equal(R.convertReviewBasis(review(undefined, []), 'match', null).time_basis, 'match');
});

const until = async fn => { const deadline = Date.now() + 5000; while (!fn()) { if (Date.now() > deadline) throw Error('Mock response did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)); } };
async function browserSuite() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  let browserCount = 0;
  const test = async (name, fn) => { await fn(); console.log(`browser ok ${++browserCount} - ${name}`); };
  async function fixture({ hash = '#/practice/review', records = [], width = 375 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const state = { records: copy(records), calls: [], errors: [], reply: { status: 200, body: cached() }, hold: false, gates: [], serial: 0 };
    const team = { id: 't1', name: 'Accepted team', owner: 'alice', members: [{ username: 'alice', status: 'active' }] };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== 'https://training.test') throw Error(`Unexpected network ${url.href}`);
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="app"></main>' });
      const call = { path: url.pathname, method: req.method(), body: req.postData() ? req.postDataJSON() : null, query: url.search };
      state.calls.push(call);
      let status = 200, body;
      if (url.pathname === '/api/training') body = { entries: { reviews: state.records.filter(r => !r.team_id), lessons: [], puzzles: [], attempts: [] }, teams: [team], invitations: [], catalog: {}, limits: { has_more: {} } };
      else if (url.pathname.startsWith('/api/training/review-context/')) {
        const reply = copy(state.reply); status = reply.status; body = reply.body;
        if (state.hold) { state.hold = false; const gate = {}; state.gates.push(gate); await new Promise(resolve => { gate.release = resolve; }); }
      } else if (url.pathname.startsWith('/api/training/entries/')) {
        const parts = url.pathname.split('/'), kind = parts[4], id = parts[5];
        if (req.method() === 'GET') body = { entries: state.records.filter(r => r.team_id === url.searchParams.get('team_id')), has_more: false };
        else {
          const saved = { id: id || `created-${++state.serial}`, kind, owner: 'alice', team_id: call.body.team_id ?? null, revision: id ? 2 : 1, data: copy(call.body.data) };
          if (id) state.records = state.records.filter(r => r.id !== id);
          state.records.unshift(saved); body = { entry: saved };
        }
      } else throw Error(`Unexpected API ${url.pathname}`);
      await route.fulfill({ status, json: body });
    });
    await page.goto('https://training.test/' + hash);
    await page.addStyleTag({ content: read('static/style.css') + '\n' + read('static/training.css') });
    await page.evaluate(() => {
      window.ME = { username: 'alice' }; window.nav = 0; window.confirmations = []; window.confirmResult = true;
      window.confirm = message => { confirmations.push(message); return confirmResult; };
      window.apiDone = 0;
      // Intentionally let old replies finish, to exercise the real core/module stale guards.
      window.api = async (path, opts = {}) => { const { signal, ...rest } = opts; try { const response = await fetch(path, rest), body = await response.json(); if (!response.ok) throw Object.assign(Error(body.detail), { status: response.status }); return body; } finally { apiDone++; } };
      window.urls = { made: [], revoked: [], releases: 0 };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), release = SVGElement.prototype.releasePointerCapture;
      URL.createObjectURL = blob => { const url = create(blob); urls.made.push(url); return url; };
      URL.revokeObjectURL = url => { urls.revoked.push(url); revoke(url); };
      SVGElement.prototype.releasePointerCapture = function (pointer) { urls.releases++; return release.call(this, pointer); };
      HTMLMediaElement.prototype.load = function () {};
      HTMLMediaElement.prototype.pause = function () {};
    });
    await page.addScriptTag({ content: read('static/training.js') });
    await page.addScriptTag({ content: source });
    assert.equal(state.calls.length, 0, 'Module load must never fetch context');
    await page.evaluate(() => showTraining());
    const close = async () => { await page.evaluate(() => Training.dispose()); assert.deepEqual(state.errors, []); await context.close(); };
    return { page, state, close };
  }
  const action = (page, name) => page.locator(`[data-action="${name}"]`);
  const openContext = page => page.locator('[data-review-context]').evaluate(el => { el.open = true; });
  const loadContext = async page => { await openContext(page); await action(page, 'load-context').click(); };
  const loaded = page => page.locator('[data-context-status]').filter({ hasText: 'context loaded' }).waitFor();
  const save = async page => {
    const done = await page.evaluate(() => apiDone);
    await page.locator('[data-review-form] [type="submit"]').click();
    await page.waitForFunction(done => apiDone > done && !document.querySelector('[data-review-form] [type="submit"]').disabled, done);
    await page.locator('[data-status]').filter({ hasText: 'Review notes saved' }).waitFor();
  };
  async function media(page, time = 80, duration = 180) {
    await page.locator('[data-video-file]').setInputFiles({ name: 'SECRET-LOCAL.mp4', mimeType: 'video/mp4', buffer: Buffer.from('mock media') });
    await page.evaluate(({ time, duration }) => {
      const video = document.querySelector('video'); let current = time;
      Object.defineProperties(video, { duration: { value: duration, configurable: true }, videoWidth: { value: 1920, configurable: true }, videoHeight: { value: 1080, configurable: true }, currentTime: { get: () => current, set: value => { current = value; }, configurable: true } });
      video.dispatchEvent(new Event('loadedmetadata'));
    }, { time, duration });
  }
  async function align(page, seconds = 60) { await page.locator('[data-clock-sync]').evaluate(el => { el.open = true; }); await page.locator('[name="anchor-seconds"]').fill(String(seconds)); await action(page, 'align-clock').click(); }
  async function release(page, gate) { const done = await page.evaluate(() => apiDone); gate.release(); await page.waitForFunction(done => apiDone > done, done); }
  try {
    await test('vanilla routes make only their normal bootstrap request; query data never adds or saves', async () => {
      for (const hash of ['#/practice/review', '#/practice/lessons', '#/practice/puzzles', '#/practice/review?match=EUW1_A&at=60&prompt=EUW1_A%3Aearly_death%3A60&question=UNTRUSTED']) {
        const f = await fixture({ hash });
        assert.deepEqual(f.state.calls.map(c => c.path), ['/api/training']);
        if (hash.includes('/review')) { assert.equal(await f.page.locator('[data-moments] li').count(), 0); assert.equal(await f.page.getByText('UNTRUSTED').count(), 0); }
        await f.close();
      }
    });
    await test('cached focus highlights only after explicit load; keyboard creation is unsaved, trusted and basis-aware', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review?match=EUW1_A&at=60&prompt=EUW1_A%3Aearly_death%3A60&question=UNTRUSTED', width: 320 });
      await page.locator('[name="title"]').fill('Keep my draft title');
      await page.locator('[name="time_basis"]').selectOption('match');
      await loadContext(page); await loaded(page);
      assert.equal(await page.locator('[data-context-row][aria-current="true"]').count(), 1);
      assert.equal(await page.locator('[data-moments] li').count(), 0);
      assert.equal(await page.locator('[name="title"]').inputValue(), 'Keep my draft title');
      assert.equal(state.calls.filter(c => c.method !== 'GET').length, 0);
      const create = page.locator('[data-context-row][aria-current="true"] [data-action="context-moment"]');
      await create.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[name="moment-title"]').inputValue(), 'A cached reflection');
      assert.equal(await page.locator('[name="options"]').inputValue(), 'What information and options were visible?');
      assert.equal(await page.locator('[name="seconds"]').inputValue(), '60');
      assert.match(await page.locator('[data-moments]').innerText(), /Match clock/);
      assert.equal(state.calls.filter(c => c.method !== 'GET').length, 0);
      const metrics = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
      assert.ok(metrics.width <= metrics.viewport + 1, 'Cached context must fit mobile width');
      await close();
    });
    await test('alignment maps use-current, moment jumps and event jumps; missing/outside playback never seeks zero', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review('match'))] });
      await media(page); await action(page, 'seek-moment').click();
      assert.match(await page.locator('[data-status]').innerText(), /Align/);
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), 80);
      await align(page); await action(page, 'use-time').click();
      assert.equal(await page.locator('[name="moment-seconds"]').inputValue(), '60');
      await action(page, 'seek-moment').click(); assert.equal(await page.locator('video').evaluate(v => v.currentTime), 60);
      await loadContext(page); await loaded(page);
      await action(page, 'context-jump').first().click(); assert.equal(await page.locator('video').evaluate(v => v.currentTime), 80);
      await action(page, 'context-jump').last().click();
      assert.match(await page.locator('[data-status]').innerText(), /unavailable/);
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), 80);
      await page.locator('[name="seek"]').fill('15'); await action(page, 'seek').click(); assert.equal(await page.locator('video').evaluate(v => v.currentTime), 15);
      assert.match(await page.locator('[name="seek"]').locator('..').innerText(), /video seconds/);
      await media(page); await action(page, 'seek-moment').click(); assert.match(await page.locator('[data-status]').innerText(), /Align/);
      await align(page); await action(page, 'detach').click(); assert.match(await page.locator('[data-sync-status]').innerText(), /Not aligned/);
      assert.equal(state.calls.filter(c => c.path.includes('review-context')).length, 1);
      await close();
    });
    await test('video-basis cached prefills require alignment and retain numeric annotation drafts when cancelled', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1?match=EUW1_B&at=60&prompt=EUW1_A%3Aearly_death%3A60', records: [entry('r1', review())] });
      await loadContext(page); await loaded(page);
      assert.equal(await page.locator('[name="match_id"]').inputValue(), 'EUW1_A', 'Saved reviews ignore queue-link prefill');
      assert.equal(await page.locator('[data-context-row][aria-current]').count(), 0);
      await action(page, 'context-moment').first().click();
      assert.equal(await page.locator('[data-moments] li').count(), 1);
      assert.match(await page.locator('[data-status]').innerText(), /Align/);
      await media(page); await align(page);
      await page.locator('[data-moment-editor] details').evaluate(el => { el.open = true; });
      await page.locator('[name="ann-x"]').fill('.45');
      await page.evaluate(() => { confirmResult = false; }); await action(page, 'context-moment').first().click();
      assert.equal(await page.locator('[data-moments] li').count(), 1);
      assert.equal(await page.locator('[name="ann-x"]').inputValue(), '.45');
      assert.match(await page.evaluate(() => confirmations.at(-1)), /numeric annotation/);
      await page.evaluate(() => { confirmResult = true; }); await action(page, 'context-moment').first().click();
      assert.equal(await page.locator('[name="seconds"]').inputValue(), '80');
      assert.match(await page.locator('[data-moments]').innerText(), /Video clock/);
      assert.equal(state.calls.filter(c => c.method !== 'GET').length, 0);
      await close();
    });
    await test('atomic basis change requires confirmation, keeps annotations, guards dirty state and sends only allowed fields', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review(undefined, [moment(40), moment(10, 'm2')]))] });
      await media(page); await align(page);
      assert.equal(await page.evaluate(() => Training.canLeave()), true, 'Calibration and local media are not persisted note drafts');
      await page.locator('[name="time_basis"]').selectOption('match');
      assert.equal(await page.locator('[name="time_basis"]').inputValue(), 'video');
      assert.equal(await page.locator('[name="seconds"]').inputValue(), '40');
      assert.equal(await page.evaluate(() => confirmations.length), 0, 'Reject invalid conversion before confirmation or mutation');
      await page.locator('[name="seconds"]').fill('60'); await page.locator('[name="seconds"]').press('Tab');
      await action(page, 'moment').nth(1).click(); await page.locator('[name="seconds"]').fill('60');
      await save(page);
      await page.evaluate(() => { confirmResult = false; });
      await page.locator('[name="time_basis"]').selectOption('match');
      assert.equal(await page.locator('[name="time_basis"]').inputValue(), 'video');
      await page.evaluate(() => { confirmResult = true; });
      await page.locator('[name="time_basis"]').selectOption('match');
      assert.equal(await page.locator('[name="time_basis"]').inputValue(), 'match', await page.evaluate(() => JSON.stringify({ status: document.querySelector('[data-status]').textContent, sync: document.querySelector('[data-sync-status]').textContent, confirmations })));
      assert.equal(await page.locator('[name="seconds"]').inputValue(), '40');
      await page.evaluate(() => { confirmResult = false; });
      assert.equal(await page.evaluate(() => Training.canLeave()), false);
      await save(page); assert.equal(await page.evaluate(() => Training.canLeave()), true);
      const data = state.calls.filter(c => c.method === 'PUT').at(-1).body.data;
      assert.deepEqual(data.moments.map(m => m.seconds), [40, 40]);
      assert.deepEqual(data.moments[0].annotations, [mark]);
      assert.equal(data.time_basis, 'match');
      assert.deepEqual(Object.keys(data).sort(), ['title', 'match_id', 'source_label', 'time_basis', 'moments'].sort());
      assert.ok(!JSON.stringify(data).match(/SECRET|blob:|offset|filename/));
      await close();
    });
    await test('real-core pointer drafts and video replacement release capture/URLs; review/match changes reset alignment', async () => {
      const { page, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review())] });
      await media(page); await align(page);
      await page.locator('[data-moment-editor] details').evaluate(el => { el.open = true; });
      await page.locator('[name="tool"]').selectOption('arrow');
      await page.locator('[data-overlay]').scrollIntoViewIfNeeded();
      const box = await page.locator('[data-overlay]').boundingBox();
      await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4); await page.mouse.down();
      await page.evaluate(() => { confirmResult = false; });
      assert.equal(await page.evaluate(() => Training.canLeave()), false);
      await media(page);
      assert.ok(await page.evaluate(() => urls.releases >= 1));
      await page.mouse.up();
      assert.match(await page.locator('[data-sync-status]').innerText(), /Not aligned/);
      await align(page); await page.locator('[name="match_id"]').fill('EUW1_B');
      assert.match(await page.locator('[data-sync-status]').innerText(), /Not aligned/);
      await align(page); await page.evaluate(() => { confirmResult = true; }); await action(page, 'new').click();
      assert.match(await page.locator('[data-sync-status]').innerText(), /Not aligned/);
      await align(page); await action(page, 'load').first().click();
      assert.match(await page.locator('[data-sync-status]').innerText(), /Not aligned/);
      await page.evaluate(() => Training.dispose());
      assert.equal(await page.locator('video').getAttribute('src'), null);
      assert.deepEqual(await page.evaluate(() => urls.revoked), await page.evaluate(() => urls.made));
      await close();
    });
    await test('latest-only cached response survives A-B-A safely; new typing preserves inputs/focus and invalidates a reply', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review?match=EUW1_A' });
      state.hold = true; state.reply.body = cached('EUW1_A', 'STALE A'); await loadContext(page); await until(() => state.gates.length === 1);
      await page.locator('[name="match_id"]').fill('EUW1_B'); await page.locator('[name="match_id"]').fill('EUW1_A');
      state.reply.body = cached('EUW1_A', 'LATEST A'); await loadContext(page); await loaded(page);
      await release(page, state.gates[0]);
      assert.match(await page.locator('[data-context-content]').innerText(), /LATEST A/);
      assert.doesNotMatch(await page.locator('[data-context-content]').innerText(), /STALE A/);
      state.hold = true; state.reply.body = cached('EUW1_A', 'STALE TYPING'); await loadContext(page); await until(() => state.gates.length === 2);
      await page.locator('[name="title"]').fill('New title during request'); await release(page, state.gates[1]);
      assert.equal(await page.locator('[name="title"]').inputValue(), 'New title during request');
      assert.equal(await page.evaluate(() => document.activeElement.name), 'title');
      assert.doesNotMatch(await page.locator('[data-context-content]').innerText(), /STALE TYPING/);
      assert.match(await page.locator('[data-context-status]').innerText(), /Inputs changed/);
      await close();
    });
    await test('404 clears cached context only, sanitizes error details, and missing timelines remain unavailable', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review('match'))] });
      await loadContext(page); await loaded(page);
      state.reply = { status: 404, body: { detail: 'OTHER-MEMBER-SECRET' } };
      await loadContext(page); await page.locator('[data-context-status]').filter({ hasText: 'currently linked account' }).waitFor();
      assert.equal(await page.locator('[data-context-content]').innerText(), '');
      assert.equal(await page.locator('[name="known"]').inputValue(), 'Typed knowledge');
      assert.equal(await page.getByText('OTHER-MEMBER-SECRET').count(), 0);
      state.reply = { status: 200, body: { ...cached(), available: false, reason: 'A usable cached timeline is unavailable; nothing was fetched.', events: [], prompts: [] } };
      await loadContext(page); await page.locator('[data-context-content]').filter({ hasText: 'unavailable' }).waitFor();
      assert.equal(await action(page, 'context-moment').count(), 0);
      await close();
    });
    await test('death-before-future-objective evidence is retrospective outcome, never player knowledge', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review('match'))] });
      const typedKnown = 'Typed before reading the timeline; enemy position unknown.';
      const evidence = 'Your death was 45s before the enemy team took Dragon. Timing alone is not causation.';
      const question = 'What information and options did you have before this death?';
      state.reply.body = { ...cached(), events: [{ seconds: 400, kind: 'death', label: 'Your death', side: 'us' }, { seconds: 445, kind: 'monster', label: 'Dragon', side: 'them' }], prompts: [{ id: 'EUW1_A:death_before_objective:400', match_id: 'EUW1_A', seconds: 400, title: 'A death before an enemy objective', question, evidence, kind: 'death_before_objective' }] };
      await page.locator('[name="known"]').fill(typedKnown);
      await loadContext(page); await loaded(page);
      assert.equal(await page.locator('[name="known"]').inputValue(), typedKnown, 'Loading retrospective context leaves typed knowledge unchanged');
      await action(page, 'context-moment').first().click();
      assert.equal(await page.locator('[name="seconds"]').inputValue(), '400');
      assert.equal(await page.locator('[name="known"]').inputValue(), '');
      assert.equal(await page.locator('[name="outcome"]').inputValue(), evidence);
      assert.equal(await page.locator('[name="options"]').inputValue(), question);
      assert.equal(state.calls.filter(c => c.method !== 'GET').length, 0, 'Explicit prefill is still an unsaved draft');
      await save(page);
      const data = state.calls.filter(c => c.method === 'PUT').at(-1).body.data;
      assert.equal(data.moments[0].known, typedKnown);
      assert.deepEqual(data.moments[0].annotations, [mark]);
      assert.equal(data.moments[1].known, '');
      assert.equal(data.moments[1].outcome, evidence);
      assert.equal(data.moments[1].options, question);
      await action(page, 'moment').first().click();
      assert.equal(await page.locator('[name="known"]').inputValue(), typedKnown);
      await close();
    });
    await test('context metadata stays out of notes and payloads while explicitly typed private notes are preserved', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review('match'))] });
      const typedKnown = 'My private reference https://notes.example/reference; not match metadata.';
      const metadata = { filename: 'CONTEXT-METADATA-private.mp4', video_url: 'https://metadata.invalid/CONTEXT-METADATA', blob_url: 'blob:CONTEXT-METADATA', offset: 123 };
      const context = cached();
      state.reply.body = { ...context, ...metadata, private_metadata: metadata, match: { ...context.match, ...metadata }, events: context.events.map(event => ({ ...event, ...metadata })), prompts: context.prompts.map(prompt => ({ ...prompt, ...metadata })) };
      await page.locator('[name="known"]').fill(typedKnown);
      await loadContext(page); await loaded(page);
      assert.equal(await page.locator('[name="known"]').inputValue(), typedKnown);
      assert.equal(await page.locator('[name="source_label"]').inputValue(), 'Manual label');
      assert.doesNotMatch(await page.locator('[data-context-content]').innerText(), /CONTEXT-METADATA/);
      await action(page, 'context-moment').first().click();
      assert.equal(await page.locator('[name="known"]').inputValue(), '');
      assert.equal(await page.locator('[name="outcome"]').inputValue(), context.prompts[0].evidence);
      await page.locator('[data-action="context-moment"][data-kind="events"][data-index="0"]').click();
      assert.equal(await page.locator('[name="known"]').inputValue(), '');
      assert.equal(await page.locator('[name="options"]').inputValue(), '');
      assert.match(await page.locator('[name="outcome"]').inputValue(), /Cached event at 1:00 \(Match clock\): Cached objective/);
      await save(page);
      const payload = state.calls.filter(c => c.method === 'PUT').at(-1).body;
      assert.equal(payload.data.moments[0].known, typedKnown, 'Privacy allowlisting must not erase user-authored prose or URLs');
      assert.deepEqual(Object.keys(payload.data).sort(), ['title', 'match_id', 'source_label', 'time_basis', 'moments'].sort());
      for (const created of payload.data.moments.slice(1)) {
        assert.equal(created.known, '');
        assert.deepEqual(Object.keys(created).sort(), ['id', 'seconds', 'title', 'known', 'options', 'decision', 'outcome', 'lesson', 'annotations'].sort());
      }
      assert.doesNotMatch(JSON.stringify(state.calls), /CONTEXT-METADATA|filename|video_url|blob_url|private_metadata|offset/);
      assert.deepEqual(state.calls.map(c => [c.method, c.path]), [['GET', '/api/training'], ['GET', '/api/training/review-context/EUW1_A'], ['PUT', '/api/training/entries/reviews/r1']]);
      await close();
    });
    await test('explicit cached action preserves annotations and asks before discarding a derived draft', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review('match'))] });
      await loadContext(page); await loaded(page); await action(page, 'make-lesson').click();
      await page.locator('[data-derived-form] [name="question"]').fill('Keep my derived draft');
      await page.evaluate(() => { confirmResult = false; }); await action(page, 'context-moment').first().click();
      assert.equal(await page.locator('[data-moments] li').count(), 1);
      assert.equal(await page.locator('[data-derived-form] [name="question"]').inputValue(), 'Keep my derived draft');
      await page.evaluate(() => { confirmResult = true; }); await action(page, 'context-moment').first().click();
      assert.equal(await page.locator('[data-moments] li').count(), 2);
      await save(page);
      assert.deepEqual(state.calls.filter(c => c.method === 'PUT').at(-1).body.data.moments[0].annotations, [mark]);
      await close();
    });
    await test('derived timestamps carry their basis; saved team copies retain basis and read-only team views fetch no context', async () => {
      const { page, state, close } = await fixture({ hash: '#/practice/review/r1', records: [entry('r1', review('match'))] });
      await action(page, 'make-lesson').click(); assert.match(await page.locator('[name="question"]').inputValue(), /Match clock/);
      await action(page, 'cancel-derived').click(); await action(page, 'make-puzzle').click();
      assert.match(await page.locator('[name="context"]').inputValue(), /40 seconds · Match clock/);
      await action(page, 'cancel-derived').click();
      await page.locator('[name="share-team"]').evaluate(el => { el.closest('details').open = true; });
      await page.locator('[name="share-team"]').selectOption('t1'); await action(page, 'share').click();
      await page.locator('[data-status]').filter({ hasText: 'new team copy' }).waitFor();
      const shared = state.calls.find(c => c.method === 'POST').body;
      assert.equal(shared.data.time_basis, 'match'); assert.equal(shared.team_id, 't1');
      await close();
      const team = await fixture({ hash: '#/practice/review/shared?team=t1&match=PRIVATE&at=60', records: [entry('shared', review('match'), 't1')] });
      assert.match(await team.page.locator('[data-team-notes]').innerText(), /Match clock/);
      assert.equal(await team.page.locator('video, [data-review-context], input[type="file"]').count(), 0);
      assert.ok(team.state.calls.every(c => c.path === '/api/training' || (c.path.includes('/entries/reviews') && c.query.includes('team_id=t1'))));
      await team.close();
    });
    await test('pending context cannot apply after new review, different review, account switch or disposal', async () => {
      for (const transition of ['new', 'load', 'account', 'dispose']) {
        const { page, state, close } = await fixture({ hash: '#/practice/review?match=EUW1_A', records: [entry('r1', review())] });
        state.hold = true; state.reply.body = cached('EUW1_A', 'LATE PRIVATE CONTEXT'); await loadContext(page); await until(() => state.gates.length === 1);
        if (transition === 'new') await action(page, 'new').click();
        else if (transition === 'load') await action(page, 'load').click();
        else if (transition === 'account') await page.evaluate(() => { ME = { username: 'bob' }; });
        else await page.evaluate(() => Training.dispose());
        await release(page, state.gates[0]);
        assert.equal(await page.getByText('LATE PRIVATE CONTEXT', { exact: true }).count(), 0);
        assert.equal(await page.locator('[data-context-row]').count(), 0);
        await close();
      }
    });
  } finally { await browser.close(); }
}
if (process.argv.includes('--browser')) browserSuite().catch(error => { console.error(error); process.exitCode = 1; });
else console.log('Mock browser suite available with --browser (existing optional Playwright tooling).');
