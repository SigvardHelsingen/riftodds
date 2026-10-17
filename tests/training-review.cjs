// Pure checks: node tests/training-review.cjs
// Optional mocked browser suite: NODE_PATH=.browser-tools/node_modules node tests/training-review.cjs --browser
// No server, production database, Riot calls, real footage, or added dependencies.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/training-review.js'), 'utf8');
const R = require('../static/training-review.js');
const copy = value => JSON.parse(JSON.stringify(value));
const mark = () => ({ kind: 'arrow', x: .2, y: .3, x2: .7, y2: .8, text: '<img src=x onerror=alert(1)>' });
const moment = () => ({ id: 'moment-zero', seconds: 0, title: 'A decision', known: 'Enemy missing', options: 'Wait or move', decision: 'Wait', outcome: 'Unknown', lesson: 'Check cover', annotations: [mark()] });
const review = () => ({ title: 'Review <script>bad()</script>', match_id: 'EUW1_123', source_label: 'Manual evening session', moments: [moment()] });
const lesson = () => ({ question: 'What was known?', answer: 'Only visible information', source_review_id: null, due: 0, interval_days: 1, repetitions: 0 });
const puzzle = () => ({ title: 'Recall window', prompt: 'What would you consider?', context: 'Jungle position unknown', choices: [{ label: 'Recall', tradeoff: 'Concede pressure, recover resources' }, { label: 'Stay', tradeoff: 'Keep pressure, remain exposed' }], discussion: 'Both depend on cover and wave state.', source_review_id: null, seconds: 0 });
const entry = (kind, id, data, extra = {}) => ({ id, kind, data, team_id: null, owner: 'alice', revision: 1, created: 100, updated: 100, ...extra });
const starters = ['recall-window', 'objective-trade', 'unsafe-wave'].map(id => ({ id, ...puzzle(), title: id }));
let count = 0;
function check(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
check('registers only the owned renderers, with no load-time requests', () => {
  const names = [];
  vm.runInNewContext(source, { window: { Training: { register(name, renderer) { assert.equal(typeof renderer, 'function'); names.push(name); } } } });
  assert.deepEqual(names, ['review', 'lessons', 'puzzles']);
});
check('serializers are explicit allowlists, never copying File/URL/filename metadata', () => {
  const data = { ...review(), filename: 'private.mp4', filepath: '/private/video.mp4', video_url: 'blob:private', file: { content: 'not video' } };
  data.moments[0].video = 'secret'; data.moments[0].annotations[0].upload = 'secret';
  assert.deepEqual(R.reviewData(data), { ...review(), time_basis: 'video' });
  assert.equal(R.puzzleData({ ...puzzle(), filename: 'private.mp4' }).filename, undefined);
  assert.equal(R.attemptData({ puzzle_id: 'recall-window', choice_index: 0, reason: 'Wait for cover', reflection: '' }).choice_index, 0);
  assert.equal(R.reviewData(data).moments[0].seconds, 0);
});
check('strict finite numbers, text controls, schema lengths and bounds', () => {
  for (const value of [NaN, Infinity, -Infinity, true, false, '0', -1, 28801]) {
    const d = review(); d.moments[0].seconds = value; assert.throws(() => R.reviewData(d));
  }
  for (const key of ['x', 'y', 'x2', 'y2']) for (const value of [NaN, true, '0.1', -.01, 1.01]) assert.throws(() => R.annotation({ ...mark(), [key]: value }));
  for (const source_label of ['/Users/alice/video.mp4', 'C:\\private\\video.mp4', 'blob:abc', 'https://x.test', 'data:video/mp4,abc', '~private']) assert.throws(() => R.reviewData({ ...review(), source_label }));
  for (const title of ['', ' ', 'x'.repeat(121), 'bad\nlabel', 'bad\u0085label', 'bad\u202elabel']) assert.throws(() => R.reviewData({ ...review(), title }));
  assert.equal(R.lessonData({ ...lesson(), question: 'Tabs\tand\nnewlines\rwork' }).question, 'Tabs\tand\nnewlines\rwork');
  for (const data of [{ ...lesson(), due: true }, { ...lesson(), interval_days: 0 }, { ...lesson(), repetitions: 1001 }]) assert.throws(() => R.lessonData(data));
  assert.throws(() => R.puzzleData({ ...puzzle(), choices: [] }));
  assert.throws(() => R.puzzleData({ ...puzzle(), choices: Array(6).fill(puzzle().choices[0]) }));
  assert.throws(() => R.attemptData({ puzzle_id: 'p', choice_index: 0, reason: String.fromCharCode(0), reflection: '' }));
});
check('serializers accept optional prose allowed by the service; reasoning-before-reveal is a separate UI rule', () => {
  const data = { ...puzzle(), discussion: '', choices: puzzle().choices.map(choice => ({ ...choice, tradeoff: '' })) };
  assert.deepEqual(R.puzzleData(data), data);
  assert.deepEqual(R.attemptData({ puzzle_id: 'p', choice_index: 0, reason: '', reflection: '' }), { puzzle_id: 'p', choice_index: 0, reason: '', reflection: '' });
});
check('moment / annotation / UTF-8 byte limits and duplicate IDs', () => {
  assert.throws(() => R.reviewData({ ...review(), moments: Array(51).fill(moment()) }));
  assert.throws(() => R.reviewData({ ...review(), moments: [moment(), moment()] }));
  const d = review(); d.moments[0].annotations = Array(31).fill(mark()); assert.throws(() => R.reviewData(d));
  const large = review();
  for (const key of ['known', 'options', 'decision', 'outcome', 'lesson']) large.moments[0][key] = '界'.repeat(3000);
  assert.throws(() => R.reviewData(large), /32 KiB/);
});
check('letterboxed geometry excludes horizontal and vertical bars', () => {
  assert.deepEqual(R.frameRect({ left: 10, top: 20, width: 400, height: 400 }, 1920, 1080), { left: 10, top: 107.5, width: 400, height: 225 });
  const f = R.frameRect({ left: 20, top: 30, width: 800, height: 300 }, 400, 300);
  assert.deepEqual(f, { left: 220, top: 30, width: 400, height: 300 });
  assert.equal(R.framePoint(f, 200, 80), null);
  assert.deepEqual(R.framePoint(f, 320, 105), { x: .25, y: .25 });
  assert.equal(R.framePoint(null, 0, 0), null);
  assert.equal(R.frameRect({ left: 0, top: 0, width: 0, height: 300 }, 1920, 1080), null);
});
check('keyboard movement preserves endpoints and clamps the whole mark', () => {
  const moved = R.moveMark(mark(), .9, -.9);
  assert.ok(Math.abs(moved.x2 - 1) < 1e-12);
  assert.ok(Math.abs(moved.y) < 1e-12);
  assert.ok(Math.abs(moved.x2 - moved.x - .5) < 1e-12);
  assert.ok(Math.abs(moved.y2 - moved.y - .5) < 1e-12);
  assert.equal(R.stamp(0), '0:00'); assert.equal(R.stamp(125), '2:05');
});

async function browserSuite() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  let browserCount = 0;
  const check = async (name, fn) => { await fn(); browserCount++; console.log(`browser ok ${browserCount} - ${name}`); };
  async function fixture({ section = 'review', id = '', query = '', records = {}, width = 375, limits = {} } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const state = { records: copy(records), calls: [], errors: [], fail: null, hold: null, sequence: 0 };
    for (const kind of ['reviews', 'lessons', 'puzzles', 'attempts']) state.records[kind] ||= [];
    const teams = [{ id: 'accepted-team', name: 'Accepted <team>', owner: 'alice', members: [{ username: 'alice', status: 'active' }] }];
    const bootstrap = { entries: Object.fromEntries(Object.entries(state.records).map(([k, rows]) => [k, rows.filter(r => !r.team_id).slice(0, 50)])), catalog: { starter_puzzles: starters }, teams, invitations: [{ id: 'pending-team' }], limits: { has_more: Object.fromEntries(Object.entries(state.records).map(([k, rows]) => [k, rows.filter(r => !r.team_id).length > 50])), ...limits } };
    page.on('pageerror', error => state.errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main class="training" id="root"></main>' });
      assert.equal(url.origin, 'https://training.test', 'Unexpected external request');
      assert.ok(url.pathname === '/api/training' || url.pathname.startsWith('/api/training/'), `Unexpected API ${url.pathname}`);
      const call = { path: url.pathname, query: url.searchParams, method: req.method(), body: req.postData() ? req.postDataJSON() : null };
      state.calls.push(call);
      const failure = state.fail;
      if (failure && failure(call)) return route.fulfill({ status: 409, json: { detail: 'Revision conflict (409). Reload saved data.' } });
      if (state.hold && state.hold.when(call)) { const held = state.hold; held.arrived = true; await new Promise(resolve => { held.release = resolve; }); if (held.result) return route.fulfill({ json: held.result }); }
      let result, status = 200;
      const parts = url.pathname.split('/'), kind = parts[4], recordId = parts[5];
      if (url.pathname === '/api/training') {
              result = bootstrap;
            } else if (parts[3] === 'lessons' && parts[5] === 'grade') {
        const target = state.records.lessons.find(r => r.id === parts[4]);
        assert.equal(call.body.revision, target.revision);
        target.revision++;
        target.data.repetitions++;
        target.data.interval_days = { again: 1, good: 2, easy: 4 }[call.body.rating];
        target.data.due = Math.floor(Date.now() / 1000) + target.data.interval_days * 86400;
        result = { entry: target };
      } else if (req.method() === 'GET') {
        const teamId = url.searchParams.get('team_id');
        const list = state.records[kind].filter(r => teamId ? r.team_id === teamId : !r.team_id);
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 50);
        result = { entries: list.slice(offset, offset + limit), has_more: offset + limit < list.length };
      } else if (req.method() === 'POST') {
        const saved = entry(kind, `created-${++state.sequence}`, copy(call.body.data), { team_id: call.body.team_id });
        state.records[kind].unshift(saved); result = { entry: saved };
      } else if (req.method() === 'PUT') {
        const saved = state.records[kind].find(r => r.id === recordId);
        assert.equal(call.body.revision, saved.revision);
        saved.data = copy(call.body.data); saved.revision++; result = { entry: saved };
      } else if (req.method() === 'DELETE') {
        const saved = state.records[kind].find(r => r.id === recordId);
        assert.equal(Number(url.searchParams.get('revision')), saved.revision);
        state.records[kind] = state.records[kind].filter(r => r.id !== recordId); result = { ok: true };
      } else { status = 404; result = { detail: 'Unexpected fixture route' }; }
      await route.fulfill({ status, json: result });
    });
    await page.goto('https://training.test/#/practice/' + section);
    // Only base styles and the primary agent's shared stylesheet, if already present.
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../static/style.css'), 'utf8') });
    const shared = path.join(__dirname, '../static/training.css');
    if (fs.existsSync(shared)) await page.addStyleTag({ content: fs.readFileSync(shared, 'utf8') });
    await page.evaluate(() => {
      window.renderers = {};
      window.Training = { register: (name, fn) => { window.renderers[name] = fn; } };
      window.active = true; window.username = 'alice'; window.cleanups = [];
      window.urls = { made: [], revoked: [], pauses: 0 };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), pause = HTMLMediaElement.prototype.pause;
      URL.createObjectURL = blob => { const url = create(blob); urls.made.push(url); return url; };
      URL.revokeObjectURL = url => { urls.revoked.push(url); revoke(url); };
      HTMLMediaElement.prototype.pause = function () { urls.pauses++; return pause.call(this); };
    });
    await page.addScriptTag({ content: source });
    assert.equal(state.calls.length, 0, 'Script must not request data before rendering');
    await page.evaluate(({ bootstrap, section, id, query }) => {
      const root = document.querySelector('#root');
      const current = () => window.active && window.username === 'alice' && root.isConnected;
      const ctx = window.ctx = { bootstrap, section, id, params: new URLSearchParams(query), current, cleanup(fn) { cleanups.push(fn); }, status() {}, async refresh() { throw Error('No automatic bootstrap refresh is allowed'); },
        async request(path, opts) { const response = await fetch(path, opts); const body = await response.json(); if (!response.ok) throw Object.assign(Error(body.detail), { status: response.status }); return body; },
        async save(kind, data, existing = null, teamId = null) {
          const payload = existing ? { data, revision: existing.revision } : { data, team_id: teamId };
          const result = await this.request(`/api/training/entries/${kind}${existing ? '/' + existing.id : ''}`, { method: existing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (current() && !result.entry.team_id) { const list = bootstrap.entries[kind]; const index = list.findIndex(r => r.id === result.entry.id); if (index < 0) list.unshift(result.entry); else list[index] = result.entry; }
          return result.entry;
        },
        async remove(entry) { await this.request(`/api/training/entries/${entry.kind}/${entry.id}?revision=${entry.revision}`, { method: 'DELETE' }); }
      };
      renderers[section](root, ctx);
      window.dispose = () => { window.active = false; for (const fn of cleanups.splice(0)) fn(); };
    }, { bootstrap, section, id, query });
    async function close() {
      await page.evaluate(() => dispose());
      assert.deepEqual(state.errors, [], 'Unexpected browser errors');
      await context.close();
    }
    return { context, page, state, close };
  }
  const action = (page, name) => page.locator(`[data-action="${name}"]`);
  const saveReview = page => page.locator('[data-review-form] [type="submit"]').click();
  const waitFor = async predicate => { const until = Date.now() + 5000; while (!predicate()) { if (Date.now() > until) throw Error('Timed out waiting for fixture'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try {
    await check('new-only match prefill, numeric annotation fallback, limits, failed-save recovery and safe labels', async () => {
      const { page, state, close } = await fixture({ query: 'match=EUW1_prefill' });
      assert.equal(await page.locator('[name="match_id"]').inputValue(), 'EUW1_prefill');
      await page.locator('[data-video-file]').setInputFiles({ name: 'NEVER-SEND-my-video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not real footage') });
      assert.equal(await page.locator('[name="source_label"]').inputValue(), '');
      const url = await page.locator('video').getAttribute('src');
      await page.locator('[name="title"]').fill('A careful review');
      await action(page, 'add-moment').click();
      await page.locator('[name="moment-title"]').fill('Before rotating');
      await page.locator('[name="known"]').fill('Only visible information');
      await page.locator('[data-moment-editor] details').evaluate(el => { el.open = true; });
      await page.locator('[name="ann-text"]').fill('<img src=x onerror=alert(1)>');
      await page.locator('[name="ann-x"]').fill('0');
      await page.locator('[name="ann-y"]').fill('1');
      await action(page, 'apply-mark').click();
      state.fail = call => call.method === 'POST';
      await saveReview(page);
      await page.locator('[data-status]').filter({ hasText: /Revision conflict/ }).waitFor();
      assert.equal(await page.locator('[name="known"]').inputValue(), 'Only visible information');
      assert.equal(await page.locator('video').getAttribute('src'), url);
      assert.equal(await page.locator('[data-video-file]').evaluate(el => el.files.length), 1);
      assert.equal(await page.locator('#root img[src=x], #root script').count(), 0, 'Note text must not become elements');
      state.fail = null;
      await saveReview(page);
      await page.locator('[data-status]').filter({ hasText: 'Review notes saved' }).waitFor();
      const body = state.calls.at(-1).body;
      assert.equal(body.data.moments[0].seconds, 0);
      assert.equal(body.data.moments[0].annotations[0].x, 0);
      assert.equal(body.data.moments[0].annotations[0].y, 1);
      assert.equal(body.team_id, null);
      assert.ok(!JSON.stringify(state.calls).includes('NEVER-SEND'));
      assert.ok(!JSON.stringify(body).includes('blob:'));
      await action(page, 'new').click();
      assert.equal(await page.locator('[name="match_id"]').inputValue(), '');
      await close();
      assert.deepEqual(await Promise.resolve(state.errors), []);
    });
    await check('letterboxed pointer drawing, SVG text safety, keyboard/numeric editing and media cleanup', async () => {
      const { page, close } = await fixture({ records: { reviews: [entry('reviews', 'r1', review())] }, id: 'r1', query: 'match=NEVER-REPLACE' });
      await page.locator('[name="title"]').waitFor();
      await page.waitForFunction(() => document.querySelector('[name="title"]').value.startsWith('Review'));
      assert.equal(await page.locator('[name="match_id"]').inputValue(), 'EUW1_123');
      await page.locator('[data-video-file]').setInputFiles({ name: 'private.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local') });
      await page.evaluate(() => {
        const video = document.querySelector('video');
        Object.defineProperties(video, { videoWidth: { value: 1920, configurable: true }, videoHeight: { value: 1080, configurable: true }, duration: { value: 120, configurable: true } });
        let time = 0; Object.defineProperty(video, 'currentTime', { get: () => time, set: value => { time = value; }, configurable: true });
        video.style.height = '300px'; video.dispatchEvent(new Event('loadedmetadata'));
      });
      await page.locator('[data-moment-editor] details').evaluate(el => { el.open = true; });
      await page.locator('[name="tool"]').selectOption('arrow');
      const box = await page.locator('[data-overlay]').boundingBox();
      assert.ok(box.height < 300, 'Overlay must exclude letterbox bars');
      await page.mouse.move(box.x + box.width * .25, box.y + box.height * .25);
      await page.mouse.down(); await page.mouse.move(box.x + box.width * .75, box.y + box.height * .75); await page.mouse.up();
      assert.ok(Math.abs(Number(await page.locator('[name="ann-x"]').inputValue()) - .25) < .02);
      assert.ok(Math.abs(Number(await page.locator('[name="ann-y"]').inputValue()) - .25) < .02);
      assert.ok(Math.abs(Number(await page.locator('[name="ann-y2"]').inputValue()) - .75) < .02);
      await page.locator('[data-overlay]').focus(); await page.keyboard.press('ArrowRight');
      assert.ok(Math.abs(Number(await page.locator('[name="ann-x"]').inputValue()) - .26) < .02);
      await page.keyboard.press('Delete');
      assert.equal(await page.locator('[data-mark-list] li').count(), 1);
      await page.locator('[name="ann-kind"]').selectOption('text');
      await page.locator('[name="ann-text"]').fill('<img src=x onerror=alert(1)>');
      await action(page, 'apply-mark').click();
      assert.equal(await page.locator('[data-overlay] text').textContent(), '<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('[data-overlay] img, #root img[src=x]').count(), 0);
      await action(page, 'new-mark').click();
      await page.locator('[name="ann-kind"]').selectOption('circle');
      await page.locator('[name="ann-x"]').fill('.4'); await page.locator('[name="ann-y"]').fill('.4');
      await page.locator('[name="ann-x2"]').fill('.6'); await page.locator('[name="ann-y2"]').fill('.4');
      await action(page, 'apply-mark').click();
      assert.ok(Number(await page.locator('[data-overlay] circle').getAttribute('r')) > 0);
      await page.locator('[data-stage]').focus(); await page.keyboard.press('5');
      assert.equal(await page.locator('video').evaluate(el => el.currentTime), 60);
      await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('video').evaluate(el => el.currentTime), 55);
      await page.locator('[name="seek"]').fill('0'); await action(page, 'seek').click();
      assert.equal(await page.locator('video').evaluate(el => el.currentTime), 0);
      await page.locator('[data-video-file]').setInputFiles({ name: 'another.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local 2') });
      assert.equal(await page.evaluate(() => urls.revoked.length), 1);
      await page.evaluate(() => dispose());
      assert.equal(await page.locator('video').getAttribute('src'), null);
      assert.equal(await page.locator('[data-video-file]').evaluate(el => el.files.length), 0);
      assert.deepEqual(await page.evaluate(() => urls.revoked), await page.evaluate(() => urls.made));
      assert.ok(await page.evaluate(() => urls.pauses >= 3));
      await close();
    });
    await check('edits during saves and explicit conflict reload preserve focus and the local video', async () => {
      const saved = entry('reviews', 'r1', review());
      const { page, state, close } = await fixture({ records: { reviews: [saved] }, id: 'r1' });
      await page.waitForFunction(() => document.querySelector('[name="title"]').value.startsWith('Review'));
      await page.locator('[data-video-file]').setInputFiles({ name: 'secret.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local') });
      const url = await page.locator('video').getAttribute('src');
      state.hold = { when: call => call.method === 'PUT' };
      await page.locator('[name="title"]').fill('Submitted title'); await saveReview(page);
      await waitFor(() => state.hold.arrived);
      await page.locator('[name="title"]').fill('Typed while saving');
      state.hold.release();
      await page.locator('[data-status]').filter({ hasText: 'Review notes saved' }).waitFor();
      assert.equal(await page.locator('[name="title"]').inputValue(), 'Typed while saving');
      assert.equal(await page.evaluate(() => document.activeElement.name), 'title');
      assert.match(await page.locator('[data-dirty]').innerText(), /Unsaved/);
      state.hold = null;
      await action(page, 'reload').click();
      await page.waitForFunction(() => document.querySelector('[name="title"]').value === 'Submitted title');
      assert.equal(await page.locator('video').getAttribute('src'), url);
      assert.equal(await page.locator('[data-video-file]').evaluate(el => el.files.length), 1);
      await close();
    });
    await check('personal review pagination/load/delete and direct manual lesson CRUD', async () => {
          const rows = Array.from({ length: 51 }, (_, i) => entry('reviews', `r-${i}`, { ...review(), title: `Review ${i}` }));
          const first = await fixture({ records: { reviews: rows }, width: 320 });
          await action(first.page, 'more').click();
          await first.page.locator('[data-action="load"][data-id="r-50"]').waitFor();
          assert(first.state.calls.some(call => call.query.get('offset') === '50'));
          await first.page.locator('[data-action="load"][data-id="r-50"]').click();
          await first.page.waitForFunction(() => document.querySelector('[name="title"]').value === 'Review 50');
          await action(first.page, 'delete').click();
          await first.page.locator('[data-status]').filter({ hasText: 'Saved review deleted' }).waitFor();
          assert.equal(await first.page.locator('[name="title"]').inputValue(), 'Review 50');
          assert.equal(first.state.calls.at(-1).query.get('revision'), '1');
          await first.close();
          const second = await fixture({ section: 'lessons', width: 320 });
          const { page, state } = second;
          await page.locator('[name="question"]').fill('What did I know?');
          await page.locator('[name="answer"]').fill('Visible state only');
          state.fail = call => call.method === 'POST';
          await page.locator('[data-lesson-form] [type="submit"]').click();
          await page.locator('[data-status]').filter({ hasText: /Revision conflict/ }).waitFor();
          assert.equal(await page.locator('[name="answer"]').inputValue(), 'Visible state only');
          state.fail = null;
          await page.locator('[data-lesson-form] [type="submit"]').click();
          await page.locator('[data-status]').filter({ hasText: 'Personal lesson saved' }).waitFor();
          await page.locator('[name="answer"]').fill('Consider visible state and uncertainty');
          await page.locator('[data-lesson-form] [type="submit"]').click();
          await waitFor(() => state.records.lessons[0].revision === 2);
          await action(page, 'delete').click();
          await page.locator('[data-status]').filter({ hasText: 'Saved lesson deleted' }).waitFor();
          assert.equal(state.calls.at(-1).query.get('revision'), '2');
          assert.equal(await page.locator('[name="answer"]').inputValue(), 'Consider visible state and uncertainty');
          await second.close();
        });
        await check('explicit lessons/puzzles from a saved zero-second moment, and explicit team copies', async () => {
      const { page, state, close } = await fixture({ records: { reviews: [entry('reviews', 'r1', review())] }, id: 'r1' });
      await page.waitForFunction(() => document.querySelector('[name="title"]').value.startsWith('Review'));
      await action(page, 'make-lesson').click();
      assert.equal(state.calls.length, 0, 'Opening a derived form must not save');
      await page.locator('[data-derived-form] [type="submit"]').click();
      await page.locator('[data-status]').filter({ hasText: 'New personal lesson saved' }).waitFor();
      assert.equal(state.calls.at(-1).body.data.source_review_id, 'r1');
      await action(page, 'make-puzzle').click();
      await action(page, 'add-choice').click();
      assert.equal(await page.locator('[data-derived-form] fieldset').count(), 3);
      await action(page, 'remove-choice').click();
      for (let i = 0; i < 2; i++) { await page.locator(`[name="choice-${i}"]`).fill(`Option ${i}`); await page.locator(`[name="tradeoff-${i}"]`).fill(`Risk ${i}`); }
      await page.locator('[data-derived-form] [type="submit"]').click();
      await page.locator('[data-status]').filter({ hasText: 'New personal puzzle saved' }).waitFor();
      assert.equal(state.calls.at(-1).body.data.seconds, 0);
      assert.equal(state.calls.at(-1).body.data.source_review_id, 'r1');
      await page.locator('[name="share-team"]').evaluate(el => { el.closest('details').open = true; });
      assert.equal(await page.locator('[name="share-team"] option[value="pending-team"]').count(), 0);
      await page.locator('[name="share-team"]').selectOption('accepted-team'); await action(page, 'share').click();
      await page.locator('[data-status]').filter({ hasText: 'A new team copy was saved' }).waitFor();
      assert.equal(state.calls.at(-1).body.team_id, 'accepted-team');
      assert.equal(state.records.reviews.filter(r => !r.team_id).length, 1);
      assert.deepEqual(state.records.reviews.find(r => r.id === 'r1').data, review());
      await close();
    });
    await check('personal pagination and older due lessons; grading is server-side for all three ratings', async () => {
      const future = Math.floor(Date.now() / 1000) + 86400;
      const rows = Array.from({ length: 50 }, (_, i) => entry('lessons', `future-${i}`, { ...lesson(), question: `Future ${i}`, due: future }));
      rows.push(...['again', 'good', 'easy'].map(rating => entry('lessons', rating, { ...lesson(), question: `Due ${rating}` })));
      const { page, state, close } = await fixture({ section: 'lessons', records: { lessons: rows } });
      assert.equal(await page.locator('[data-due] [data-action="recall"]').count(), 0);
      await action(page, 'more').click();
      await page.locator('[data-due] [data-action="recall"]').first().waitFor();
      assert(state.calls.some(call => call.query.get('offset') === '50'));
      assert.equal(await page.locator('[data-due] [data-action="recall"]').count(), 3);
      for (const rating of ['again', 'good', 'easy']) {
        await page.locator(`[data-action="recall"][data-id="${rating}"]`).click();
        assert.equal(await action(page, 'grade').count(), 0);
        await action(page, 'reveal').click();
        if (rating === 'again') {
          state.fail = call => call.path.endsWith('/grade');
          await page.locator(`[data-rating="${rating}"]`).click();
          await page.locator('[data-status]').filter({ hasText: /Revision conflict/ }).waitFor();
          assert.match(await page.locator('[data-recall]').innerText(), /Only visible information/);
          state.fail = null;
          await action(page, 'reload-recall').click();
          await action(page, 'reveal').waitFor(); await action(page, 'reveal').click();
        }
        await page.locator(`[data-rating="${rating}"]`).click();
        await page.locator('[data-status]').filter({ hasText: 'Recall recorded' }).waitFor();
        const body = state.calls.at(-1).body;
        assert.deepEqual(body, { revision: 1, rating });
        assert.ok(!Object.hasOwn(body, 'due'));
        assert.equal(state.records.lessons.find(e => e.id === rating).data.repetitions, 1);
      }
      await close();
    });
    await check('puzzles require pre-reveal reasoning, privately save attempts, and support manual CRUD/sharing', async () => {
      const own = entry('puzzles', 'p1', { ...puzzle(), source_review_id: 'private-review' });
      const { page, state, close } = await fixture({ section: 'puzzles', records: { puzzles: [own] } });
      await page.locator('[data-action="practice"][data-id="recall-window"]').click();
      assert.equal(await page.locator('[data-discussion]').innerText(), '');
      await action(page, 'reveal').click(); assert.equal(await page.locator('[data-discussion]').innerText(), '');
      await page.locator('[name="choice"][value="0"]').check(); await page.locator('[name="reason"]').fill('I assume cover is missing');
      await action(page, 'reveal').click();
      assert.match(await page.locator('[data-discussion]').innerText(), /Both depend/);
      assert.equal(await page.locator('[name="reason"]').isDisabled(), true);
      await page.locator('[name="reflection"]').fill('Wave state would change my choice');
      state.fail = call => call.path.endsWith('/attempts');
      await page.locator('[data-attempt-form] [type="submit"]').click();
      await page.locator('[data-status]').filter({ hasText: /Revision conflict/ }).waitFor();
      assert.equal(await page.locator('[name="reflection"]').inputValue(), 'Wave state would change my choice');
      state.fail = null; await page.locator('[data-attempt-form] [type="submit"]').click();
      await page.locator('[data-attempt-status]').filter({ hasText: 'Personal attempt saved' }).waitFor();
      assert.equal(state.calls.at(-1).body.data.choice_index, 0);
      assert.equal(state.calls.at(-1).body.data.puzzle_id, 'recall-window');
      assert.equal(state.calls.at(-1).body.team_id, null);
      await page.locator('[data-action="load"][data-id="p1"]').click();
      await page.waitForFunction(() => document.querySelector('[data-puzzle-form] [name="title"]').value === 'Recall window');
      await page.locator('[data-puzzle-form] [name="title"]').fill('An edited puzzle');
      await page.locator('[data-puzzle-form] [type="submit"]').click();
      await page.locator('[data-status]').filter({ hasText: 'Personal puzzle saved' }).waitFor();
      assert.equal(state.calls.at(-1).method, 'PUT');
      await page.locator('[name="share-team"]').evaluate(el => { el.closest('details').open = true; });
      await page.locator('[name="share-team"]').selectOption('accepted-team'); await action(page, 'share').click();
      await page.locator('[data-status]').filter({ hasText: 'A new team copy was saved' }).waitFor();
      assert.equal(state.calls.at(-1).body.data.source_review_id, null);
      assert.equal(state.records.puzzles.find(r => r.id === 'p1').data.source_review_id, 'private-review');
      await action(page, 'delete').click(); await page.locator('[data-status]').filter({ hasText: 'Saved puzzle deleted' }).waitFor();
      assert.equal(await page.locator('[data-puzzle-form] [name="title"]').inputValue(), 'An edited puzzle');
      assert.equal(state.calls.at(-1).query.get('revision'), '2');
      await action(page, 'new').click();
      for (const [name, value] of Object.entries({ title: 'Direct manual puzzle', prompt: 'Which option and why?', context: 'An uncertain setup', 'choice-0': 'Wait', 'choice-1': 'Move', 'tradeoff-0': 'Lose tempo', 'tradeoff-1': 'Lose safety', discussion: 'Both depend on cover' })) await page.locator(`[data-puzzle-form] [name="${name}"]`).fill(value);
      await page.locator('[data-puzzle-form] [type="submit"]').click();
      await page.locator('[data-status]').filter({ hasText: 'Personal puzzle saved' }).waitFor();
      assert.equal(state.calls.at(-1).method, 'POST');
      await close();
    });
    await check('team notes use scoped reads only; no personal media, editing, or implicit copies', async () => {
      const { page, state, close } = await fixture({ id: 'shared', query: 'team=accepted-team', records: { reviews: [entry('reviews', 'private', { ...review(), title: 'PRIVATE TITLE' }), entry('reviews', 'shared', { ...review(), title: 'SHARED TITLE' }, { team_id: 'accepted-team' })] } });
      await page.locator('[data-team-notes] h3').waitFor();
      assert.equal(await page.locator('video, input[type="file"], [data-review-form]').count(), 0);
      assert.equal(await page.getByText('PRIVATE TITLE').count(), 0);
      assert.equal(state.calls[0].query.get('team_id'), 'accepted-team');
      assert.ok(state.calls.every(call => call.method === 'GET'));
      assert.equal(await page.locator('img[src=x], [data-team-notes] script').count(), 0);
      await close();
    });
    await check('real training core detects pointer/numeric/moment drafts and recognizes successful saves', async () => {
          const { page, close } = await fixture();
          await page.evaluate(() => { dispose(); const root = document.querySelector('#root'); root.id = 'app'; root.replaceChildren(); window.ME = { username: 'alice' }; window.nav = 0; window.prompts = 0; window.confirm = () => { prompts++; return false; }; window.api = async (path, opts) => { const response = await fetch(path, opts); const body = await response.json(); if (!response.ok) throw Error(body.detail); return body; }; });
          await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../static/training.js'), 'utf8') });
          await page.addScriptTag({ content: source });
          await page.evaluate(() => showTraining());
          await page.locator('[data-review-form]').waitFor();
          assert.equal(await page.evaluate(() => Training.canLeave()), true);
          await page.locator('[name="title"]').fill('Integrated review');
          await action(page, 'add-moment').click(); await page.locator('[name="moment-title"]').fill('Integrated moment');
          await saveReview(page);
          await page.locator('[data-status]').filter({ hasText: 'Review notes saved' }).waitFor();
          assert.equal(await page.evaluate(() => Training.canLeave()), true);
          assert.equal(await page.evaluate(() => prompts), 0);
          await page.locator('[name="known"]').fill('This field is outside the top-level form');
          assert.equal(await page.evaluate(() => Training.canLeave()), false);
          await saveReview(page);
          await page.waitForFunction(() => document.querySelector('[data-dirty]').textContent.startsWith('Saved'));
          assert.equal(await page.evaluate(() => Training.canLeave()), true);
          await page.locator('[data-moment-editor] details').evaluate(el => { el.open = true; });
          await page.locator('[name="ann-x"]').fill('.1');
          assert.equal(await page.evaluate(() => Training.canLeave()), false);
          await saveReview(page);
          await page.waitForFunction(() => !document.querySelector('[data-review-form] [type="submit"]').disabled);
          assert.equal(await page.evaluate(() => Training.canLeave()), false, 'Unapplied numeric fields must remain a draft after saving other notes');
          await action(page, 'apply-mark').click(); await saveReview(page);
          await page.waitForFunction(() => document.querySelector('[data-dirty]').textContent.startsWith('Saved'));
          assert.equal(await page.evaluate(() => Training.canLeave()), true);
          await page.evaluate(() => Training.dispose());
          await close();
        });
        await check('explicit loads do not replace edits made while their requests were in flight', async () => {
          const { page, state, close } = await fixture({ records: { reviews: [entry('reviews', 'r1', review())] }, id: 'r1' });
          await page.waitForFunction(() => document.querySelector('[name="title"]').value.startsWith('Review'));
          state.hold = { when: call => call.method === 'GET' };
          await action(page, 'reload').click(); await waitFor(() => state.hold.arrived);
          await page.locator('[name="title"]').fill('New work during a read');
          state.hold.release();
          await page.locator('[data-status]').filter({ hasText: 'your new edits were kept' }).waitFor();
          assert.equal(await page.locator('[name="title"]').inputValue(), 'New work during a read');
          assert.equal(await page.evaluate(() => document.activeElement.name), 'title');
          await close();
        });
        await check('bounded personal pagination cannot skip a record after another tab deletes an earlier row', async () => {
          const records = { reviews: Array.from({ length: 52 }, (_, i) => entry('reviews', `r${i}`, { ...review(), title: `Review ${i}` })) };
          const { page, state, close } = await fixture({ records });
          state.records.reviews.shift();
          await action(page, 'more').click(); await page.locator('[data-action="load"][data-id="r50"]').waitFor();
          await action(page, 'more').click(); await page.locator('[data-action="load"][data-id="r51"]').waitFor();
          assert(state.calls.every(call => call.method === 'GET' && Number(call.query.get('limit')) <= 50));
          await close();
        });
        await check('a saved revision supersedes an earlier reload in both the editor and cached list', async () => {
          const original = entry('reviews', 'r1', review());
          const { page, state, close } = await fixture({ id: 'r1', records: { reviews: [original] } });
          await page.waitForFunction(() => document.querySelector('[name="title"]').value.startsWith('Review'));
          await page.locator('[name="title"]').fill('Save this submitted version');
          state.hold = { when: call => call.method === 'GET', result: { entries: [copy(original)], has_more: false } };
          await action(page, 'reload').click(); await waitFor(() => state.hold.arrived);
          await saveReview(page); await page.locator('[data-status]').filter({ hasText: 'Review notes saved' }).waitFor();
          state.hold.release(); await page.locator('[data-status]').filter({ hasText: 'your new edits were kept' }).waitFor();
          assert.equal(await page.locator('[name="title"]').inputValue(), 'Save this submitted version');
          state.hold = null;
          await page.locator('[data-action="load"][data-id="r1"]').click();
          assert.equal(await page.locator('[name="title"]').inputValue(), 'Save this submitted version');
          assert.match(await page.locator('[data-editor-title]').innerText(), /revision 2/);
          await close();
        });
        await check('derived forms retain typing during saves and subsequently update, rather than duplicate, the new lesson', async () => {
          const { page, state, close } = await fixture({ id: 'r1', records: { reviews: [entry('reviews', 'r1', review())] } });
          await page.waitForFunction(() => document.querySelector('[name="title"]').value.startsWith('Review'));
          await action(page, 'make-lesson').click();
          state.hold = { when: call => call.method === 'POST' && call.path.endsWith('/lessons') };
          await page.locator('[data-derived-form] [type="submit"]').click(); await waitFor(() => state.hold.arrived);
          await page.locator('[data-derived-form] [name="question"]').fill('Typed while the new lesson was saving');
          state.hold.release(); await page.locator('[data-status]').filter({ hasText: 'New personal lesson saved' }).waitFor();
          assert.equal(await page.locator('[data-derived-form] [name="question"]').inputValue(), 'Typed while the new lesson was saving');
          state.hold = null;
          await page.locator('[data-derived-form] [type="submit"]').click(); await page.locator('[data-derived-form]').waitFor({ state: 'detached' });
          assert.equal(state.records.lessons.length, 1);
          assert.equal(state.records.lessons[0].revision, 2);
          assert.equal(state.records.lessons[0].data.question, 'Typed while the new lesson was saving');
          assert.deepEqual(state.calls.filter(call => call.path.includes('/lessons')).map(call => call.method), ['POST', 'PUT']);
          await close();
        });
        await check('a choice-only unsaved attempt still asks before replacement', async () => {
          const { page, close } = await fixture({ section: 'puzzles' });
          await page.locator('[data-action="practice"][data-id="recall-window"]').click();
          await page.locator('[name="choice"][value="0"]').check();
          await page.evaluate(() => { window.prompts = 0; window.confirm = () => { prompts++; return false; }; });
          await page.locator('[data-action="practice"][data-id="objective-trade"]').click();
          assert.equal(await page.evaluate(() => prompts), 1);
          assert.equal(await page.locator('[name="choice"][value="0"]').isChecked(), true);
          assert.equal(await page.locator('[data-attempt] h3').innerText(), 'recall-window');
          await close();
        });
        await check('obsolete saves cannot write after logout, identity switch or detached roots', async () => {
      for (const obsolete of ['logout', 'identity', 'detached']) {
        const { page, state, close } = await fixture();
        await page.locator('[name="title"]').fill('Private unsaved draft');
        state.hold = { when: call => call.method === 'POST' };
        await saveReview(page); await waitFor(() => state.hold.arrived);
        await page.evaluate(obsolete => {
          if (obsolete === 'logout') { dispose(); document.querySelector('#root').innerHTML = '<h2>Public login</h2>'; }
          else if (obsolete === 'identity') window.username = 'bob';
          else document.querySelector('#root').remove();
        }, obsolete);
        const html = await page.content(); state.hold.release();
        await page.waitForTimeout(100);
        assert.equal(await page.content(), html, 'Obsolete async completion wrote to the DOM');
        await close();
      }
    });
  } finally { await browser.close(); }
}
if (process.argv.includes('--browser')) browserSuite().catch(error => { console.error(error); process.exitCode = 1; });
else console.log('Browser suite available with --browser (existing optional Playwright tooling).');
