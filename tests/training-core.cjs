// Pure Node checks: node tests/training-core.cjs. No browser, database or real API.
'use strict';
const assert = require('node:assert/strict');
const T = require('../static/training.js');
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const entry = (kind, id = 'record', data = {}, extra = {}) => ({ id, kind, owner: 'alice', team_id: null, revision: 1, created: 1, updated: 1, data, ...extra });
function fixture(respond = () => ({})) {
  const calls = [], messages = [], state = {
    controller: new AbortController(), pending: 0, refreshSequence: 0, cleanups: [], forms: new Map(), dirtyChecks: new Set(), username: 'alice',
    bootstrap: T.normalizeBootstrap({}), submitting: null, alive: true,
    root: { querySelector: () => ({ set textContent(message) { messages.push(message); }, classList: { toggle() {} } }) }
  };
  state.current = () => state.alive;
  global.api = async (path, opts, current) => {
    const call = { path, opts, current, body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    return respond(call);
  };
  return { state, ctx: T.createContext(state, T.parseRoute('#/practice')), calls, messages };
}

check('routes, aliases, IDs and query prefill remain data, not markup', () => {
  assert.equal(T.parseRoute('#/practice').section, '');
  assert.equal(T.parseRoute('#/practice/').section, '');
  assert.equal(T.parseRoute('#/practice/lasthit').workout, 'last-hit');
  assert.equal(T.parseRoute('#/practice/dodge').workout, 'trading-window');
  for (const section of ['review', 'lessons', 'puzzles', 'team', 'lab', 'experiments']) assert.equal(T.parseRoute(`#/practice/${section}`).section, section);
  const route = T.parseRoute('#/practice/review/a%2Fb?match=EUW_1&focus=%3Cscript%3E&role=TOP');
  assert.equal(route.id, 'a/b');
  assert.equal(route.params.get('focus'), '<script>');
  assert.equal(route.params.get('match'), 'EUW_1');
  assert.equal(T.parseRoute('#/practice/review/%ZZ').section, 'unknown');
  assert.equal(T.parseRoute('#/practice/experiments/foreign').section, 'unknown');
  assert.equal(T.parseRoute('#/other').section, 'unknown');
  assert.equal(T.parseRoute('#/practice/team/a/extra').section, 'unknown');
  assert.equal(T.escapeHTML('<img src="x" onerror=\'x\'>&'), '&lt;img src=&quot;x&quot; onerror=&#39;x&#39;&gt;&amp;');
});

check('experiment groups preserve zero vs missing and never invent empty means', () => {
  const empty = T.summarizeExperiment([]);
  assert.equal(empty.baseline.mean, null);
  assert.equal(empty.practice.mean, null);
  assert.equal(empty.difference, null);
  const rows = [
    { phase: 'baseline', value: 0, adhered: true }, { phase: 'baseline', value: null },
    { phase: 'baseline', value: '8' }, { phase: 'baseline', value: true },
    { phase: 'practice', value: 2 }, { phase: 'practice', value: 4, adhered: true },
    { phase: 'practice', value: Infinity }, { phase: 'practice', value: NaN }
  ];
  const copy = rows.map((row) => ({ ...row })), result = T.summarizeExperiment(rows);
  assert.deepEqual(result, {
    baseline: { count: 1, missing: 3, mean: 0, adhered: 1, total: 4 },
    practice: { count: 2, missing: 2, mean: 3, adhered: 1, total: 4 }, difference: 3
  });
  assert.deepEqual(rows, copy, 'Summarizing must not alter observations');
  assert.equal(T.summarizeExperiment([{ phase: 'practice', value: 0 }]).difference, null);
});

check('session progress excludes missing/non-numeric results, not real zeros', () => {
  assert.deepEqual(T.summarizeSessions([]), { count: 0, measured: 0, missing: 0, minutes: 0 });
  assert.deepEqual(T.summarizeSessions([
    entry('sessions', 'a', { result: 0, minutes: 0 }), entry('sessions', 'b', { result: null, minutes: 10 }),
    entry('sessions', 'c', { result: '3' }), entry('sessions', 'd', { result: 3, minutes: 5 })
  ]), { count: 4, measured: 2, missing: 2, minutes: 15 });
});

check('comparison includes keyboard-readable numeric tables and a causal caveat', () => {
  const html = T.experimentComparison({ observations: [], measure: '<script>', better: 'lower' });
  assert.match(html, /<table class="training-table">/);
  assert.match(html, /<caption>/);
  assert.match(html, /scope="col"/);
  assert.match(html, /scope="row"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /not a causal estimate/);
  assert.match(html, /Not recorded/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

check('bootstrap and merged pages never put shared documents in personal lists', () => {
  const a = entry('reviews', 'a'), shared = entry('reviews', 'b', {}, { team_id: 'private-team' });
  const boot = T.normalizeBootstrap({ entries: { reviews: [a, shared] }, limits: { has_more: { reviews: true } } });
  assert.deepEqual(boot.entries.reviews, [a]);
  assert.equal(Object.keys(boot.entries).length, 8);
  T.mergePage(boot, 'reviews', [shared, entry('reviews', 'c')]);
  T.mergeEntry(boot, entry('reviews', 'a', { title: 'Updated' }, { revision: 2 }));
  assert.equal(boot.entries.reviews.length, 2);
  assert.equal(boot.entries.reviews.find((e) => e.id === 'a').revision, 2);
  assert.equal(boot.limits.has_more.reviews, true);
});

check('form fingerprints preserve unchecked state, blanks and disabled named fields', () => {
  const form = { elements: [
    { name: 'result', type: 'number', value: '' }, { name: 'adhered', type: 'checkbox', value: 'on', checked: false },
    { name: 'reflection', type: 'textarea', value: 'Keep this note', disabled: true }, { name: 'save', type: 'submit', value: 'Save' }
  ] };
  const original = T.formSnapshot(form);
  form.elements[0].value = '0';
  assert.notEqual(T.formSnapshot(form), original);
  form.elements[0].value = '';
  assert.equal(T.formSnapshot(form), original);
  form.elements[1].checked = true;
  assert.notEqual(T.formSnapshot(form), original);
});

check('required shared context exists and bootstrap loading is explicit only', async () => {
  const { ctx, calls, state } = fixture(() => ({ catalog: { workouts: [] }, entries: { plans: [] } }));
  for (const method of ['current', 'request', 'cleanup', 'refresh', 'status', 'save', 'remove']) assert.equal(typeof ctx[method], 'function', method);
  assert.equal(calls.length, 0, 'Constructing a context cannot fetch');
  assert(ctx.params instanceof URLSearchParams);
  await ctx.refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/training');
  assert.equal(calls[0].current, ctx.current);
  assert.equal(calls[0].opts.signal, state.controller.signal);
  assert.equal(ctx.bootstrap, state.bootstrap);
  for (const path of ['/api/player/foreign', '/api/training/../player/foreign', '/api/training/%2e%2e/player/foreign', 'https://foreign.test/api/training']) {
    await assert.rejects(ctx.request(path), /inside/);
  }
  assert.equal(calls.length, 1, 'No Riot or unrelated requests');
});

check('POST and full PUT use exact bodies, returned revisions and safe ID encoding', async () => {
  const { ctx, calls } = fixture((call) => ({ entry: entry('sessions', 'id/a', call.body.data, { revision: call.opts.method === 'PUT' ? 2 : 1 }) }));
  const data = { result: 0, reflection: 'Manual practice', plan_id: null };
  const created = await ctx.save('sessions', data);
  assert.deepEqual(calls[0].body, { data, team_id: null });
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(ctx.bootstrap.entries.sessions[0], created);
  const updated = await ctx.save('sessions', { ...data, result: null }, created);
  assert.equal(calls[1].path, '/api/training/entries/sessions/id%2Fa');
  assert.equal(calls[1].opts.method, 'PUT');
  assert.deepEqual(calls[1].body, { data: { ...data, result: null }, revision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(ctx.bootstrap.entries.sessions.length, 1);
});

check('team saves return entries but do not enter personal cache', async () => {
  const { ctx, calls } = fixture((call) => ({ entry: entry('boards', 'board', call.body.data, { team_id: 'team/a' }) }));
  const result = await ctx.save('boards', { title: 'Shared' }, null, 'team/a');
  assert.equal(result.team_id, 'team/a');
  assert.equal(calls[0].body.team_id, 'team/a');
  assert.equal(ctx.bootstrap.entries.boards.length, 0);
});

check('active plan save synchronizes server-archived revisions, without rerendering', async () => {
  const previous = entry('plans', 'old', { status: 'active' });
  const archived = entry('plans', 'old', { status: 'archived' }, { revision: 2 });
  const next = entry('plans', 'new', { status: 'active' });
  const { ctx, calls, state } = fixture((call) => call.opts.method === 'POST' ? { entry: next } : { entries: [next, archived], has_more: false });
  state.bootstrap.entries.plans = [previous];
  await ctx.save('plans', next.data);
  assert.equal(calls.length, 2);
  assert.equal(ctx.bootstrap.entries.plans.find((row) => row.id === 'old').revision, 2);
  assert.equal(ctx.bootstrap.entries.plans.filter((row) => row.data.status === 'active').length, 1);
});

check('activating a plan refreshes an archived predecessor beyond the newest page', async () => {
  const old = entry('plans', 'old', { status: 'active' }), next = entry('plans', 'next', { status: 'active' });
  const newest = [next, ...Array.from({ length: 49 }, (_, i) => entry('plans', `archive-${i}`, { status: 'archived' }))];
  const { ctx, state, calls } = fixture((call) => {
    if (call.opts.method === 'POST') return { entry: next };
    return call.path.includes('offset=50') ? { entries: [{ ...old, revision: 2, data: { status: 'archived' } }], has_more: false } : { entries: newest, has_more: true };
  });
  state.bootstrap.entries.plans = [old];
  await ctx.save('plans', next.data);
  assert.equal(calls.length, 3);
  assert.equal(state.bootstrap.entries.plans.find(row => row.id === 'old').revision, 2);
  assert.deepEqual(state.bootstrap.entries.plans.filter(row => row.data.status === 'active').map(row => row.id), ['next']);
});

check('DELETE requires the current revision and does not send data or owner fields', async () => {
  const { ctx, calls, state } = fixture(() => ({ ok: true }));
  const saved = entry('sessions', 'id/a', {}, { revision: 7 });
  state.bootstrap.entries.sessions = [saved];
  await ctx.remove(saved);
  assert.equal(calls[0].path, '/api/training/entries/sessions/id%2Fa?revision=7');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.equal(calls[0].opts.body, undefined);
  assert.equal(ctx.bootstrap.entries.sessions.length, 0);
  await assert.rejects(ctx.remove({ ...saved, revision: 0 }), /revision/);
  await assert.rejects(ctx.save('sessions', {}, { ...saved, revision: 0 }), /revision/);
  assert.equal(calls.length, 1);
});

check('409 preserves both cache and entered text and never retries or overwrites', async () => {
  const conflict = Object.assign(new Error('This entry changed. Reload it before saving or deleting.'), { status: 409 });
  const { ctx, state, calls } = fixture(() => { throw conflict; });
  const old = entry('reviews'); state.bootstrap.entries.reviews = [old];
  const draft = { title: 'Unsaved notes' }, before = clone(draft);
  await assert.rejects(ctx.save('reviews', draft, old), (error) => error === conflict);
  assert.equal(calls.length, 1);
  assert.equal(state.pending, 0);
  assert.equal(ctx.bootstrap.entries.reviews[0], old);
  assert.deepEqual(draft, before);
  assert.match(T.failure(conflict), /Nothing was overwritten/);
  assert.match(T.failure(new Error('This entry changed. Reload it before saving or deleting.')), /another window/);
  assert.match(T.failure(Object.assign(new Error('Member storage limit reached'), { status: 409 })), /storage limit/);
});

check('typing while a save is pending remains dirty after success', async () => {
  const wait = deferred();
  const { ctx, state } = fixture(() => wait.promise);
  const form = { elements: [{ name: 'title', type: 'text', value: 'Submitted' }] };
  state.forms.set(form, 'old saved baseline'); state.submitting = form;
  const promise = ctx.save('reviews', { title: 'Submitted' });
  assert.equal(state.pending, 1);
  form.elements[0].value = 'Typed while saving';
  wait.resolve({ entry: entry('reviews', 'new', { title: 'Submitted' }) });
  await promise;
  assert.equal(state.pending, 0);
  assert.notEqual(state.forms.get(form), T.formSnapshot(form));
  assert.match(state.forms.get(form), /Submitted/);
  assert.equal(form.elements[0].value, 'Typed while saving');
});

check('obsolete requests cannot synchronize private data or issue new mutations', async () => {
  const wait = deferred(), { ctx, state, calls } = fixture(() => wait.promise);
  const promise = ctx.save('reviews', { title: 'Old member' });
  state.alive = false;
  wait.resolve({ entry: entry('reviews') });
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(state.bootstrap.entries.reviews.length, 0);
  await assert.rejects(ctx.remove(entry('reviews')), { name: 'AbortError' });
  assert.equal(calls.length, 1);
  assert.equal(state.pending, 0);
});

check('overlapping explicit refreshes keep only the latest response', async () => {
  const a = deferred(), b = deferred(); let count = 0;
  const { ctx } = fixture(() => (++count === 1 ? a.promise : b.promise));
  const first = ctx.refresh(), second = ctx.refresh();
  b.resolve({ entries: { reviews: [entry('reviews', 'latest')] } });
  await second;
  a.resolve({ entries: { reviews: [entry('reviews', 'obsolete')] } });
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(ctx.bootstrap.entries.reviews[0].id, 'latest');
});

check('late list responses cannot downgrade a locally saved revision', () => {
  const boot = T.normalizeBootstrap({ entries: { reviews: [entry('reviews', 'a', { title: 'New' }, { revision: 3 })] } });
  T.mergePage(boot, 'reviews', [entry('reviews', 'a', { title: 'Old' }, { revision: 2 })]);
  assert.equal(boot.entries.reviews[0].revision, 3);
  assert.equal(boot.entries.reviews[0].data.title, 'New');
});

check('a refresh started before a save cannot erase the saved record', async () => {
  const wait = deferred();
  const { ctx } = fixture((call) => call.opts.method === 'POST' ? { entry: entry('reviews', 'new') } : wait.promise);
  const refreshing = ctx.refresh();
  await ctx.save('reviews', {});
  wait.resolve({ entries: { reviews: [] } });
  await assert.rejects(refreshing, { name: 'AbortError' });
  assert.equal(ctx.bootstrap.entries.reviews[0].id, 'new');
});

check('explicit refresh during a pending mutation waits rather than replacing data', async () => {
  const wait = deferred(), { ctx, calls } = fixture(() => wait.promise);
  const saving = ctx.save('reviews', {});
  await assert.rejects(ctx.refresh(), /Wait for the current training save/);
  assert.equal(calls.length, 1);
  wait.resolve({ entry: entry('reviews') });
  await saving;
});

check('post-save history read failure reports a saved plan, not a failed creation', async () => {
  const saved = entry('plans', 'new', { status: 'active' });
  const { ctx, state, messages } = fixture((call) => {
    if (call.opts.method === 'POST') return { entry: saved };
    throw new Error('Fixture history failure');
  });
  state.bootstrap.entries.plans = [entry('plans', 'old', { status: 'active' })];
  assert.equal(await ctx.save('plans', saved.data), saved);
  assert.equal(ctx.bootstrap.entries.plans[0], saved);
  assert.equal(ctx.bootstrap.entries.plans.length, 1, 'Do not offer predecessor edits with an unknown archived revision');
  ctx.status('Weekly plan saved.');
  assert.match(messages.at(-1), /archived plan revisions could not be reloaded/);
});

check('canvas dirty predicates and cleanup callbacks have route-local lifetime', () => {
  const { ctx, state } = fixture(); let unsaved = true;
  const unregister = ctx.guardDirty(() => unsaved);
  assert.equal([...state.dirtyChecks][0](), true);
  unsaved = false;
  assert.equal([...state.dirtyChecks][0](), false);
  unregister();
  assert.equal(state.dirtyChecks.size, 0);
  const cleanup = () => {};
  ctx.cleanup(cleanup);
  assert.deepEqual(state.cleanups, [cleanup]);
});

check('registered feature names are bounded and registration is request-free', () => {
  for (const name of ['review', 'lessons', 'puzzles', 'team', 'lab']) T.Training.register(name, () => {});
  assert.throws(() => T.Training.register('unknown', () => {}), TypeError);
  assert.throws(() => T.Training.register('review', 'not a renderer'), TypeError);
  assert.equal(T.Training.canLeave(), true, 'No mounted page means there is no draft');
});

// Optional mocked Chromium coverage: NODE_PATH=.browser-tools/node_modules node tests/training-core.cjs --browser
async function browserSuite() {
  const fs = require('node:fs'), path = require('node:path'), { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  let count = 0;
  const workout = { id: 'last-hit', title: 'Last hits', roles: ['MIDDLE'], minutes: 10, goal: 'Repeat the same setup', steps: ['Open League manually', 'Record the result'], measure: 'Last hits', unit: 'last hits', tip: 'No pass/fail target' };
  async function fixture({ hash = '#/practice', width = 375, records = {} } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    const state = { records: T.normalizeBootstrap({ entries: clone(records) }).entries, calls: [], errors: [], sequence: 0, fail: null, hold: null };
    page.on('pageerror', error => state.errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      assert.equal(url.origin, 'https://training.test', 'No real network requests');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><main id="app"></main>' });
      assert.match(url.pathname, /^\/api\/training(?:\/|$)/);
      const call = { path: url.pathname, query: url.searchParams, method: req.method(), body: req.postData() ? req.postDataJSON() : null };
      state.calls.push(call);
      if (state.fail?.(call)) return route.fulfill({ status: 409, json: { detail: 'This entry changed. Reload it before saving or deleting.' } });
      if (state.hold?.when(call)) { const held = state.hold; held.arrived = true; await held.gate.promise; }
      const parts = url.pathname.split('/'), kind = parts[4], id = parts[5];
      let result;
      if (url.pathname === '/api/training') result = {
        catalog: { workouts: [workout], starter_puzzles: [] }, entries: Object.fromEntries(Object.entries(state.records).map(([kind, rows]) => [kind, rows.slice(0, 50)])), teams: [], invitations: [],
        limits: { has_more: Object.fromEntries(Object.entries(state.records).map(([kind, rows]) => [kind, rows.length > 50])), per_member: 200 }
      };
      else if (url.pathname === '/api/training/export') result = { entries: state.records, username: 'alice' };
      else if (call.method === 'GET') {
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 50);
        assert(limit > 0 && limit <= 50);
        result = { entries: state.records[kind].slice(offset, offset + limit), has_more: offset + limit < state.records[kind].length };
      } else {
        const rows = state.records[kind], old = rows.find(row => row.id === id);
        if (call.method !== 'POST' && (!old || Number(call.body?.revision ?? url.searchParams.get('revision')) !== old.revision)) return route.fulfill({ status: 409, json: { detail: 'Revision conflict' } });
        if (call.method === 'DELETE') { state.records[kind] = rows.filter(row => row.id !== id); result = { ok: true }; }
        else {
          assert.deepEqual(Object.keys(call.body).sort(), ['data', call.method === 'POST' ? 'team_id' : 'revision'].sort());
          if (kind === 'plans' && call.body.data.status === 'active') for (const row of rows) if (row !== old && row.data.status === 'active') { row.data.status = 'archived'; row.revision++; }
          const saved = entry(kind, old?.id || `created-${++state.sequence}`, clone(call.body.data), { revision: (old?.revision || 0) + 1 });
          if (old) rows[rows.indexOf(old)] = saved; else rows.unshift(saved);
          result = { entry: saved };
        }
      }
      await route.fulfill({ json: result });
    });
    await page.goto('https://training.test/' + hash);
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../static/style.css'), 'utf8') });
    const css = path.join(__dirname, '../static/training.css');
    if (fs.existsSync(css)) await page.addStyleTag({ content: fs.readFileSync(css, 'utf8') });
    await page.evaluate(() => {
      window.ME = { username: 'alice' }; window.nav = 0; window.confirmResult = false; window.prompts = 0;
      window.confirm = () => { prompts++; return confirmResult; };
      window.api = async (path, opts) => { const response = await fetch(path, opts), body = await response.json(); if (!response.ok) throw Object.assign(Error(body.detail), { status: response.status }); return body; };
      window.urls = { made: [], revoked: [] };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); urls.made.push(url); return url; };
      URL.revokeObjectURL = url => { urls.revoked.push(url); revoke(url); };
      document.addEventListener('click', event => { if (event.target.closest('a[download]')) event.preventDefault(); });
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../static/training.js'), 'utf8') });
    assert.equal(state.calls.length, 0);
    await page.evaluate(() => showTraining());
    return { page, state, async close() { await page.evaluate(() => Training.dispose()); assert.deepEqual(state.errors, []); await context.close(); } };
  }
  const status = (page, message) => page.locator('[data-training-status]').filter({ hasText: message }).waitFor();
  async function check(name, fn) { await fn(); console.log(`browser ok ${++count} - ${name}`); }
  async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw Error('Fixture did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    for (const width of [320, 375, 768, 1280]) await check(`hub keyboard, new-only escaped prefill, session zero/missing and layout at ${width}px`, async () => {
      const { page, state, close } = await fixture({ width, hash: '#/practice?focus=%3Cscript%3E&role=MIDDLE' });
      assert.equal(await page.locator('[data-plan-editor] [name="focus"]').inputValue(), '<script>');
      assert.equal(await page.locator('#app script').count(), 0);
      const tools = page.getByRole('navigation', { name: 'Training tools', exact: true });
      for (const section of ['review', 'lessons', 'puzzles', 'lab', 'experiments', 'team']) {
        const link = tools.locator(`a[href="#/practice/${section}"]`);
        assert(await link.isVisible(), `${section} should not be hidden behind a disclosure`);
        assert(await link.evaluate(node => !node.closest('details')), 'Tools must be discoverable without expanding a plan');
        const box = await link.boundingBox();
        assert(box.width >= 44 && box.height >= 44, 'Tool links need touch-sized targets');
      }
      assert(await tools.evaluate(node => !!(node.compareDocumentPosition(document.querySelector('[data-plan-editor]')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'Tool links come before the long editors and history');
      assert.equal(await page.evaluate(() => Training.canLeave()), true);
      await page.locator('[data-plan-editor] [type="submit"]').focus(); await page.keyboard.press('Enter');
      await status(page, 'Weekly plan saved');
      const session = page.locator('[data-session-editor] form');
      await session.locator('[name="result"]').fill('0'); await session.locator('[name="reflection"]').fill('Same setup');
      await session.locator('[type="submit"]').click(); await status(page, 'Session saved');
      assert.equal(state.records.sessions[0].data.result, 0);
      await session.locator('[data-new-session]').click();
      await page.locator('[data-session-editor] [type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('[data-progress]').textContent.includes('2 saved sessions'));
      assert.equal(state.records.sessions[0].data.result, null);
      assert.match(await page.locator('[data-progress]').innerText(), /1 numeric result and 1 unrecorded result\./);
      assert.equal(await page.evaluate(() => Training.canLeave()), true);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal page overflow');
      await close();
    });
    await check('hub pending saves preserve new typing/focus; 409 and canceled reload keep edits', async () => {
      const { page, state, close } = await fixture();
      const title = page.locator('[data-plan-editor] [name="title"]');
      await page.locator('[data-plan-editor] [name="focus"]').fill('One focus');
      state.hold = { when: call => call.method === 'POST', gate: deferred() };
      await page.locator('[data-plan-editor] [type="submit"]').click(); await until(() => state.hold.arrived);
      await title.fill('Typed after submission'); state.hold.gate.resolve();
      await status(page, 'New edits made while waiting');
      assert.equal(await title.inputValue(), 'Typed after submission'); assert.equal(await title.evaluate(node => node === document.activeElement), true);
      assert.equal(await page.evaluate(() => Training.canLeave()), false);
      state.hold = null; state.fail = call => call.method === 'PUT';
      await page.locator('[data-plan-editor] [type="submit"]').click(); await status(page, 'Nothing was overwritten');
      await page.locator('[data-reload]').click();
      assert.equal(await title.inputValue(), 'Typed after submission');
      assert.equal(state.calls.filter(call => call.method === 'PUT').length, 1);
      assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; }), true);
      await close();
    });
    await check('experiments track structural drafts, zero values, saved comparison and failed saves at mobile width', async () => {
      const { page, state, close } = await fixture({ width: 320, hash: '#/practice/experiments' });
      const form = page.locator('[data-experiment-editor] form');
      for (const [name, value] of Object.entries({ title: 'One change', hypothesis: 'Comparable setups', change: 'One habit', measure: 'Time', unit: 'seconds' })) await form.locator(`[name="${name}"]`).fill(value);
      await form.locator('[data-add-observation="baseline"]').click(); await form.locator('[name="observation_value"]').fill('0');
      await form.locator('[data-add-observation="practice"]').click(); await form.locator('[name="observation_value"]').nth(1).fill('2');
      assert.equal(await page.evaluate(() => Training.canLeave()), false);
      await form.locator('[type="submit"]').focus(); await page.keyboard.press('Enter'); await status(page, 'Experiment saved');
      assert.equal(state.records.experiments[0].data.observations[0].value, 0);
      assert.match(await page.locator('[data-experiment-comparison]').innerText(), /Practice mean is 2 seconds higher/);
      assert.equal(await page.evaluate(() => Training.canLeave()), true);
      await form.locator('[name="hypothesis"]').fill('Unsaved experiment notes'); state.fail = call => call.method === 'PUT';
      await form.locator('[type="submit"]').click(); await status(page, 'Nothing was overwritten');
      assert.equal(await form.locator('[name="hypothesis"]').inputValue(), 'Unsaved experiment notes');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal page overflow');
      await close();
    });
    await check('core bounded older pages survive remote deletion without replacing the session editor', async () => {
      const records = { sessions: Array.from({ length: 52 }, (_, i) => entry('sessions', `s${i}`, { workout_id: 'last-hit', result: i, minutes: 1 })) };
      const { page, state, close } = await fixture({ records });
      await page.locator('[data-session-editor] [name="reflection"]').fill('Keep this unsaved note');
      state.records.sessions.shift();
      await page.locator('[data-older-sessions]').click(); await status(page, 'Loaded more');
      assert.equal(await page.locator('[data-record-id="s50"]').count(), 1, 'Remote deletion must not skip the first unseen record');
      await page.locator('[data-older-sessions]').click(); await status(page, 'All available personal sessions');
      assert.equal(await page.locator('[data-record-id="s51"]').count(), 1);
      assert.equal(await page.locator('[data-session-editor] [name="reflection"]').inputValue(), 'Keep this unsaved note');
      assert(state.calls.every(call => call.method === 'GET'));
      await close();
    });
    await check('export URLs are revoked on disposal and obsolete member saves cannot change the replacement route', async () => {
      const { page, state, close } = await fixture();
      await page.locator('[data-export]').click(); await status(page, 'export downloaded');
      const url = await page.evaluate(() => urls.made[0]); assert.match(url, /^blob:/);
      state.hold = { when: call => call.method === 'POST', gate: deferred() };
      await page.locator('[data-session-editor] [type="submit"]').click(); await until(() => state.hold.arrived);
      await page.evaluate(() => { Training.dispose(); ME = { username: 'bob' }; nav++; document.querySelector('#app').textContent = 'New member route'; });
      state.hold.gate.resolve(); await page.waitForTimeout(100);
      assert.equal(await page.locator('#app').innerText(), 'New member route');
      assert((await page.evaluate(() => urls.revoked)).includes(url));
      await close();
    });
  } finally { await browser.close(); }
}

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  delete global.api;
  if (failed) process.exitCode = 1;
  else {
    console.log(`${checks.length} training core checks passed`);
    if (process.argv.includes('--browser')) await browserSuite();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
