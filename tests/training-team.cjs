// Optional standalone browser suite. No real server, member database, Riot calls or cache writes.
// NODE_PATH=.browser-tools/node_modules node tests/training-team.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const serializers = require('../static/training-review.js');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/training-team.js'), 'utf8');
const sharedCSS = path.join(root, 'static/training.css');
const css = fs.readFileSync(path.join(root, 'static/style.css'), 'utf8') + (fs.existsSync(sharedCSS) ? '\n' + fs.readFileSync(sharedCSS, 'utf8') : '');
const copy = (value) => JSON.parse(JSON.stringify(value));
const malicious = '<img src=x onerror="window.injected=true"> & "private"';
const team = { id: 't1', name: `Friends ${malicious}`, owner: 'alice', created: 1, members: [{ username: 'alice', status: 'active' }, { username: 'bob', status: 'active' }, { username: 'carol', status: 'invited' }] };
const invitation = { id: 't2', name: 'Invited team', owner: 'dana', members: [{ username: 'dana', status: 'active' }, { username: 'alice', status: 'invited' }] };
const mark = (kind = 'arrow') => ({ id: `m-${kind}`, kind, x: 0, y: 1, x2: 1, y2: 0, label: malicious, team: 'neutral' });
const record = (kind, id, owner, data) => ({ id, kind, owner, team_id: 't1', revision: 3, created: 1, updated: 1, data });
const board = record('boards', 'board1', 'bob', { title: 'Shared board', notes: malicious, marks: [mark()] });
const review = record('reviews', 'review1', 'bob', { title: 'Bob review', match_id: '', source_label: malicious, moments: [{ id: 'moment1', seconds: 0, title: malicious, known: malicious, options: 'Recall or hold; both have costs.', decision: 'Recall', outcome: 'Unknown', lesson: 'Discuss uncertainty', annotations: [{ kind: 'text', x: 0, y: 1, x2: 0, y2: 1, text: malicious }] }] });
const puzzle = record('puzzles', 'puzzle1', 'alice', { title: 'Alice puzzle', prompt: malicious, context: 'Incomplete information', choices: [{ label: 'Recall', tradeoff: 'Tempo versus resources' }, { label: 'Stay', tradeoff: malicious }], discussion: 'No guaranteed answer', source_review_id: null, seconds: 0 });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error('Fixture action did not arrive'); await new Promise((done) => setTimeout(done, 10)); }
}
async function fixture(browser, { width = 375, id = 't1', username = 'alice', responder, many = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage(), errors = [];
  const state = { requests: [], teams: [copy(team), copy(invitation)], docs: [copy(board), copy(review), copy(puzzle)], serial: 0, revoked: false };
  if (many) for (let i = 0; i < 52; ++i) state.docs.push(record('boards', `extra${i}`, 'bob', { title: `Older board ${i}`, notes: `PRIVATE OLDER ${i}`, marks: [] }));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="app"><div id="slot"></div></main></body></html>' });
    const req = { url, method: request.method(), body: request.postDataJSON() };
    state.requests.push(req);
    const override = responder ? await responder(req, state) : null;
    let status = override?.status || 200, body = override?.body;
    if (!override) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (!url.pathname.startsWith('/api/training')) { status = 500; body = { detail: 'Non-training network request' }; }
      else if (parts.length === 2) body = { teams: state.teams.filter((value) => value.owner === username || value.members.some((member) => member.username === username && member.status === 'active')), invitations: state.teams.filter((value) => value.members.some((member) => member.username === username && member.status === 'invited')).map(({ id, name, owner }) => ({ id, name, owner })), entries: { reviews: [], puzzles: [], boards: [] } };
      else if (parts[2] === 'teams') {
        const value = state.teams.find((item) => item.id === parts[3]);
        if (parts.length === 3 && req.method === 'POST') {
          const created = { id: `new${++state.serial}`, name: req.body.name, owner: username, created: 1, members: [{ username, status: 'active' }] };
          state.teams.push(created); body = { team: created };
        } else if (!value || state.revoked) { status = 404; body = { detail: 'Not found' }; }
        else if (parts[4] === 'accept') { value.members.find((member) => member.username === username).status = 'active'; body = { team: value }; }
        else if (parts[4] === 'invite') { value.members.push({ username: req.body.username, status: 'invited' }); body = { ok: true }; }
        else if (parts[4] === 'members') { value.members = value.members.filter((member) => member.username !== decodeURIComponent(parts[5])); body = { ok: true }; }
        else if (req.method === 'DELETE') { state.teams = state.teams.filter((item) => item.id !== value.id); state.docs = state.docs.filter((item) => item.team_id !== value.id); body = { ok: true }; }
        else body = { team: value, entries: { reviews: [], puzzles: [], boards: [] } };
      } else if (parts[2] === 'entries') {
        const kind = parts[3], existing = state.docs.find((item) => item.id === parts[4]);
        if (req.method === 'POST' || req.method === 'PUT') {
          if (kind === 'reviews') assert.deepEqual(serializers.reviewData(req.body.data), req.body.data, 'Review fixtures must obey the same schema as personal/team saves');
          if (kind === 'puzzles') assert.deepEqual(serializers.puzzleData(req.body.data), req.body.data, 'Puzzle fixtures must obey required text, bounds and reference types');
        }
        if (state.revoked) { status = 404; body = { detail: 'Not found' }; }
        else if (req.method === 'GET') {
          const list = state.docs.filter((item) => item.kind === kind && item.team_id === url.searchParams.get('team_id'));
          const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
          assert(limit > 0 && limit <= 50, 'Every document read must be bounded');
          body = { entries: list.slice(offset, offset + limit), has_more: offset + limit < list.length };
        } else if (req.method === 'POST') {
          const entry = { id: `doc${++state.serial}`, kind, owner: username, team_id: req.body.team_id, revision: 1, created: 1, updated: 1, data: req.body.data };
          state.docs.unshift(entry); body = { entry };
        } else if (!existing) { status = 404; body = { detail: 'Not found' }; }
        else if (Number(req.body?.revision ?? url.searchParams.get('revision')) !== existing.revision) { status = 409; body = { detail: 'Revision conflict' }; }
        else if (req.method === 'PUT') { existing.data = req.body.data; ++existing.revision; body = { entry: existing }; }
        else { state.docs = state.docs.filter((item) => item.id !== existing.id); body = { ok: true }; }
      } else { status = 500; body = { detail: 'Unexpected fixture request' }; }
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('https://training.test/');
  await page.addStyleTag({ content: css });
  await page.evaluate(({ username, teams }) => {
    window.ME = { username };
    window.registered = {};
    window.Training = { register: (name, renderer) => { registered[name] = renderer; } }; // esc is optional.
    window.bootstrap = { teams: teams.filter((team) => team.owner === username || team.members.some((member) => member.username === username && member.status === 'active')), invitations: [{ id: 't2', name: 'Invited team', owner: 'dana' }], entries: { reviews: [], puzzles: [], boards: [] } };
    window.inputEvents = 0; window.resetEvents = 0; window.statuses = [];
    document.addEventListener('input', () => ++window.inputEvents);
    document.addEventListener('reset', () => ++window.resetEvents);
    window.leave = () => { window.routeActive = false; for (const fn of window.cleanups || []) fn(); window.cleanups = []; };
    window.mount = (id) => {
      leave(); window.routeActive = true;
      const ctx = {
        id, bootstrap, current: () => routeActive, cleanup: (fn) => cleanups.push(fn),
        status: (message, error) => statuses.push({ message, error }),
        request: async (path, options) => {
          const response = await fetch(path, options), body = await response.json();
          if (response.status === 401) leave();
          if (!response.ok) throw Object.assign(new Error(body.detail || `HTTP ${response.status}`), { status: response.status });
          return body;
        },
        refresh: async () => { const next = await ctx.request('/api/training'); window.bootstrap = next; return next; },
        save: async (kind, data, entry, teamId) => {
          const body = entry ? { data, revision: entry.revision } : { data, team_id: teamId };
          const reply = await ctx.request(`/api/training/entries/${kind}${entry ? `/${entry.id}` : ''}`, { method: entry ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return reply.entry;
        },
        remove: (entry) => ctx.request(`/api/training/entries/${entry.kind}/${entry.id}?revision=${entry.revision}`, { method: 'DELETE' }),
      };
      registered.team(document.querySelector('#slot'), ctx);
    };
  }, { username, teams: state.teams });
  await page.addScriptTag({ content: source });
  assert.deepEqual(await page.evaluate(() => Object.keys(registered)), ['team']);
  assert.equal(state.requests.length, 0, 'Registration must not fetch');
  await page.evaluate((id) => mount(id), id);
  if (id && !state.revoked) await page.locator('[data-list-kind="boards"] [data-action="open"]').first().waitFor();
  return { context, page, state, errors };
}
const click = (page, action) => page.locator(`[data-action="${action}"]`).first().click();
const open = async (page, kind) => {
  await page.waitForFunction(() => document.querySelector('.training[aria-busy]')?.getAttribute('aria-busy') === 'false');
  const control = page.locator(`[data-list-kind="${kind}"] [data-action="open"]`).first();
  const title = await control.textContent();
  await control.click();
  await page.waitForFunction((title) => document.querySelector('[data-editor] h2')?.textContent === title, title);
};
const done = (page, message = 'Saved privately') => page.waitForFunction((message) => document.querySelector('[data-status]')?.textContent.includes(message), message);
async function dimensions(page) {
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert(metrics.content <= metrics.viewport + 1, `Horizontal page overflow: ${JSON.stringify(metrics)}`);
  const targets = await page.locator('.training button, .training input, .training select, .training textarea, .training summary, .training a').evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => ({ text: node.textContent.slice(0, 60) || node.name, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  for (const target of targets) assert(target.width >= 44 && target.height >= 44, `Small target: ${JSON.stringify(target)}`);
  assert.equal(await page.locator('.training img, .training script, .training video, .training iframe').count(), 0, 'Authored text must never become markup or media');
  assert.equal(await page.evaluate(() => !!window.injected), false);
}
async function checkLayoutAndBoard(browser, width) {
  const test = await fixture(browser, { width });
  const { page, state } = test;
  try {
    await open(page, 'boards');
    await page.locator('[name="title"]').waitFor();
    assert.equal(await page.locator('[name="notes"]').inputValue(), malicious);
    assert.equal(await page.locator('[data-mark] [name="x"]').inputValue(), '0');
    const firstX = page.locator('[data-mark] [name="x"]').first();
    await firstX.focus(); await firstX.press('ArrowUp'); await firstX.press('ArrowDown');
    assert.equal(await firstX.inputValue(), '0', 'Coordinate controls are keyboard-operable at boundaries');
    for (const kind of ['position', 'ward', 'text']) {
      await page.locator('[name="new_kind"]').selectOption(kind);
      await page.locator('[data-action="add-mark"]').press('Enter');
      const row = page.locator('[data-mark]').last();
      await row.locator('[name="label"]').fill(`${kind} ${malicious}`);
      await row.locator('[name="x"]').fill('0.25');
      await row.locator('[name="y"]').fill('0.75');
      assert.equal(await row.locator('[name="y"]').evaluate((node) => node === document.activeElement), true, 'Preview updates preserve keyboard focus');
    }
    assert.equal(await page.locator('[data-mark]').count(), 4);
    assert.equal(await page.locator('form[data-form="document"]').getAttribute('data-training-dirty'), 'true');
    await dimensions(page);
    await page.locator('form[data-form="document"] button[type="submit"]').click();
    await done(page);
    assert.equal(await page.locator('[data-form="document"] button[type="submit"]').evaluate((node) => document.activeElement === node), true, 'Saving preserves keyboard focus');
    const save = state.requests.find((req) => req.method === 'PUT');
    assert.equal(save.body.revision, 3);
    assert.deepEqual(Object.keys(save.body.data).sort(), ['marks', 'notes', 'title']);
    assert.deepEqual(save.body.data.marks.map((mark) => mark.kind), ['arrow', 'position', 'ward', 'text']);
    for (const mark of save.body.data.marks) for (const key of ['x', 'y', 'x2', 'y2']) assert(Number.isFinite(mark[key]) && mark[key] >= 0 && mark[key] <= 1);
    assert.equal(await page.locator('form[data-form="document"]').getAttribute('data-training-dirty'), 'false');
    assert(await page.evaluate(() => resetEvents > 0 && inputEvents > 0));
    assert.match(await page.locator('[data-editor]').innerText(), /revision 4/);
    await click(page, 'remove-mark');
    assert.equal(await page.locator('[data-mark]').count(), 3);
    assert.equal(await page.locator('[data-mark] th').allTextContents().then((rows) => rows.join(',')), '1,2,3');
    await dimensions(page);
    assert.deepEqual(test.errors, []);
    assert(state.requests.every((req) => req.url.pathname.startsWith('/api/training')));
  } finally { await test.context.close(); }
  console.log(`PASS original board, all marks, revisions, keyboard, escaping and 44px targets at ${width}px`);
}
async function checkTeams(browser) {
  const test = await fixture(browser, { id: null });
  const { page, state } = test;
  try {
    assert.equal(state.requests.length, 0, 'Team hub uses bootstrap without fetching documents or pending rosters');
    assert(!await page.locator('body').innerText().then((text) => text.includes('Shared board') || text.includes('carol')));
    await page.locator('[name="name"]').fill('Preserve this team name');
    await click(page, 'accept');
    await done(page, 'Invitation accepted');
    assert.equal(await page.locator('[name="name"]').inputValue(), 'Preserve this team name');
    assert(state.requests.some((req) => req.url.pathname === '/api/training/teams/t2/accept' && req.method === 'POST' && JSON.stringify(req.body) === '{}'));
    assert.equal(await page.locator('[data-invites] button').count(), 0);
    await page.locator('form[data-form="create"] button').click();
    await done(page, 'Private team created');
    assert.deepEqual(state.requests.find((req) => req.url.pathname === '/api/training/teams' && req.method === 'POST').body, { name: 'Preserve this team name' });
    await page.evaluate(() => { bootstrap.invitations.push({ id: 't2', name: 'Again', owner: 'dana' }); mount(null); });
    await click(page, 'decline');
    await done(page, 'Invitation declined');
    assert(state.requests.some((req) => req.method === 'DELETE' && req.url.pathname === '/api/training/teams/t2/members/alice'));
    await page.evaluate(() => mount('t1'));
    await page.locator('[data-list-kind="boards"] button[data-action="open"]').waitFor();
    await page.locator('summary').first().click();
    await page.locator('[name="username"]').fill('eve');
    await page.locator('form[data-form="invite"] button').click();
    await done(page, 'Invitation sent');
    assert.deepEqual(state.requests.find((req) => req.url.pathname.endsWith('/invite')).body, { username: 'eve' });
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="revoke"]').filter({ hasText: 'eve' }).click();
    await done(page, 'revoked');
    assert(state.requests.some((req) => req.method === 'DELETE' && req.url.pathname.endsWith('/members/eve')));
    const before = state.requests.length;
    page.once('dialog', (dialog) => dialog.dismiss());
    await click(page, 'delete-team');
    assert.equal(state.requests.length, before, 'Team deletion needs explicit confirmation');
    page.once('dialog', (dialog) => dialog.accept());
    await click(page, 'delete-team');
    await done(page, 'were deleted');
    assert.equal(await page.locator('[data-editor]').count(), 0);
    assert(!await page.locator('body').innerText().then((text) => text.includes('Shared board')));
    await dimensions(page);
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  console.log('PASS team create/list, explicit invitations, owner invite/revoke and confirmed cascade deletion');
}
async function checkPermissionsAndNotes(browser) {
  const test = await fixture(browser);
  const { page, state } = test;
  try {
    await open(page, 'reviews');
    assert.equal(await page.locator('[data-editor] form').count(), 0, 'Owner must not edit another creator’s review');
    assert.equal(await page.locator('[data-editor] [data-action="delete-doc"]').count(), 1, 'Owner may moderate documents');
    await page.locator('[data-editor] summary').click();
    assert.match(await page.locator('[data-editor]').innerText(), /Recall or hold/);
    await dimensions(page);
    await open(page, 'puzzles');
    await page.locator('[name="puzzle_seconds"]').fill('0');
    await page.locator('[data-choice] [name="tradeoff"]').first().fill(malicious);
    await page.locator('[data-form="document"] button[type="submit"]').click();
    await done(page);
    const save = state.requests.find((req) => req.method === 'PUT');
    assert.equal(save.body.data.seconds, 0, 'Zero is not missing');
    assert.equal(save.body.data.choices[0].tradeoff, malicious);
    await page.evaluate(() => { leave(); ME = { username: 'bob' }; mount('t1'); });
    await page.locator('[data-list-kind="boards"] [data-action="open"]').waitFor();
    await open(page, 'puzzles');
    assert.equal(await page.locator('[data-editor] form').count(), 0, 'Non-creator cannot edit puzzle');
    assert.equal(await page.locator('[data-editor] [data-action="delete-doc"]').count(), 0, 'Non-owner cannot delete teammate document');
    assert.match(await page.locator('[data-editor]').innerText(), /Tempo|private/);
    await open(page, 'reviews');
    assert.equal(await page.locator('[name="known"]').inputValue(), malicious);
    await page.locator('[name="known"]').fill('Changed known information');
    await page.locator('[data-form="document"] button[type="submit"]').click();
    await done(page);
    const reviewSave = state.requests.find((req) => req.method === 'PUT' && req.url.pathname.endsWith('/review1'));
    assert.equal(reviewSave.body.data.time_basis, 'video', 'Legacy team reviews stay on video clock');
    assert.equal(reviewSave.body.data.moments[0].known, 'Changed known information');
    assert.deepEqual(reviewSave.body.data.moments[0].annotations, review.data.moments[0].annotations, 'Existing review annotations are not lost');
    await click(page, 'close');
    await page.locator('summary').first().click();
    assert.equal(await page.locator('[data-action="delete-team"]').count(), 0);
    page.once('dialog', (dialog) => dialog.accept());
    await click(page, 'leave');
    await done(page, 'You left');
    assert.equal(await page.locator('[data-list-kind]').count(), 0);
    assert.equal(await page.evaluate(() => bootstrap.teams.some((team) => team.id === 't1')), false);
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  console.log('PASS creator-only review/puzzle editing, owner moderation, safe notes/tradeoffs, zero seconds and member leave');
}
async function checkReviewClockBasis(browser) {
  const test = await fixture(browser);
  const { page, state } = test;
  try {
    state.docs.find(doc => doc.id === 'review1').data.time_basis = 'match';
    await page.evaluate(() => mount('t1'));
    await page.locator('[data-list-kind="reviews"] [data-action="open"]').waitFor();
    await open(page, 'reviews');
    assert.match(await page.locator('[data-editor]').innerText(), /Match clock/);
    assert.equal(await page.locator('video, input[type="file"], [data-review-context]').count(), 0);
    await page.evaluate(() => { leave(); ME = { username: 'bob' }; mount('t1'); });
    await page.locator('[data-list-kind="reviews"] [data-action="open"]').waitFor();
    await open(page, 'reviews');
    assert.match(await page.locator('[name="seconds"]').locator('..').innerText(), /Match clock/);
    await click(page, 'add-moment');
    assert.match(await page.locator('[name="seconds"]').last().locator('..').innerText(), /Match clock/);
    await page.locator('[name="moment_title"]').last().fill('Another match-clock moment');
    await page.locator('[data-form="document"] button[type="submit"]').click(); await done(page);
    const saved = state.requests.find(req => req.method === 'PUT' && req.url.pathname.endsWith('/review1'));
    assert.equal(saved.body.data.time_basis, 'match');
    assert.deepEqual(saved.body.data.moments[0].annotations, review.data.moments[0].annotations);
    assert.ok(state.requests.every(req => !/review-context|review-queue/.test(req.url.pathname)), 'Team views never fetch personal context');
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  console.log('PASS team match-clock views, new moments and revisioned saves preserve basis without personal-context requests');
}
async function checkDocumentLifecycle(browser) {
  const test = await fixture(browser);
  const { page, state } = test;
  try {
    for (const kind of ['boards', 'reviews', 'puzzles']) {
      await page.waitForFunction(() => document.querySelector('.training')?.getAttribute('aria-busy') === 'false');
      await page.locator(`[data-action="new"][data-kind="${kind}"]`).click();
      await page.locator('[data-editor] [name="title"]').waitFor();
      await page.locator('[name="title"]').fill(`Created ${kind}`);
      if (kind === 'boards') {
        await page.locator('[name="notes"]').fill('Manual private discussion');
        await click(page, 'add-mark');
        await page.locator('[data-mark] [name="x"]').fill('1.1');
        const before = state.requests.length;
        await page.locator('[data-form="document"] button[type="submit"]').click();
        assert.equal(state.requests.length, before, 'Invalid normalized coordinates cannot be submitted');
        await page.locator('[data-mark] [name="x"]').fill('1');
        await page.locator('[data-mark] [name="y"]').fill('0');
      } else if (kind === 'reviews') {
        await page.locator('[name="known"]').fill('Only the information known at this moment');
        await click(page, 'add-moment');
        assert.equal(await page.locator('[data-moment]').count(), 2);
        await click(page, 'remove-moment');
        await page.locator('[name="moment_title"]').fill('Before rotating');
      } else {
        await page.locator('[data-choice] [name="label"]').nth(0).fill('Recall');
        await page.locator('[data-choice] [name="label"]').nth(1).fill('Stay');
        await click(page, 'add-choice');
        await page.locator('[data-choice] [name="label"]').nth(2).fill('Rotate');
        await page.locator('[data-choice] [name="tradeoff"]').nth(2).fill('Costs tempo, may help a teammate');
        await click(page, 'remove-choice');
        await page.locator('[name="prompt"]').fill('Which option would you consider?');
        await page.locator('[name="discussion"]').fill('Both depend on cover and resources.');
        for (const field of await page.locator('[data-choice] [name="tradeoff"]').all()) await field.fill('Trade safety against tempo');
        await page.locator('[name="puzzle_seconds"]').fill('0');
      }
      const posted = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/entries/${kind}`));
      await page.locator('[data-form="document"] button[type="submit"]').click();
      await posted;
      await done(page);
      await page.waitForFunction(() => document.querySelector('[data-editor]')?.textContent.includes('revision 1'));
      const req = state.requests.find((req) => req.method === 'POST' && req.url.pathname.endsWith(`/entries/${kind}`));
      assert.equal(req.body.team_id, 't1');
      assert.equal(Object.hasOwn(req.body, 'owner'), false);
      assert.equal(Object.hasOwn(req.body, 'revision'), false);
      const saved = state.docs.find((entry) => entry.data.title === `Created ${kind}`);
      await page.locator('[name="title"]').fill(`Edited ${kind}`);
      const updated = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/${saved.id}`));
      await page.locator('[data-form="document"] button[type="submit"]').click();
      await updated;
      await page.waitForFunction(() => document.querySelector('[data-editor]')?.textContent.includes('revision 2'));
      page.once('dialog', (dialog) => dialog.accept());
      await click(page, 'delete-doc');
      await done(page, 'Shared document deleted');
      const deletion = state.requests.find((req) => req.method === 'DELETE' && req.url.pathname.endsWith(`/${saved.id}`));
      assert.equal(deletion.url.searchParams.get('revision'), '2');
      assert.equal(await page.locator('[data-editor] form').count(), 0);
    }
    await open(page, 'reviews');
    page.once('dialog', (dialog) => dialog.accept());
    await click(page, 'delete-doc');
    await done(page, 'Shared document deleted');
    assert(state.requests.some((req) => req.method === 'DELETE' && req.url.pathname.endsWith('/review1') && req.url.searchParams.get('revision') === '3'), 'Team owner can delete a teammate document with its revision');
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  console.log('PASS new team boards/reviews/puzzles, bounds, structural editing, revisioned update/delete and owner moderation');
}
async function checkFailuresAndPaging(browser) {
  let rejectSave = 500;
  const test = await fixture(browser, { many: true, responder: (req) => req.method === 'PUT' && rejectSave ? { status: rejectSave, body: { detail: 'Fixture save failure' } } : null });
  const { page, state } = test;
  try {
    assert.equal(await page.locator('[data-list-kind="boards"] [data-action="open"]').count(), 50);
    await page.locator('[data-list-kind="boards"] [data-action="older"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-list-kind="boards"] [data-action="open"]').length === 53);
    assert(state.requests.some((req) => req.url.searchParams.get('offset') === '50' && req.url.searchParams.get('limit') === '50'));
    await open(page, 'boards');
    await page.locator('[name="notes"]').fill('UNSAVED SECRET');
    await page.locator('[data-form="document"] button[type="submit"]').click();
    await done(page, 'Fixture save failure');
    assert.equal(await page.locator('[data-form="document"] button[type="submit"]').evaluate((node) => document.activeElement === node), true, 'Failed save keeps keyboard focus in the editor');
    assert.equal(await page.locator('[name="notes"]').inputValue(), 'UNSAVED SECRET');
    rejectSave = 409;
    await page.locator('[data-form="document"] button[type="submit"]').click();
    await done(page, 'revision changed');
    assert.equal(await page.locator('[name="notes"]').inputValue(), 'UNSAVED SECRET');
    assert.match(await page.locator('[data-editor]').innerText(), /revision 3/);
    const before = state.requests.length;
    page.once('dialog', (dialog) => dialog.dismiss());
    await click(page, 'refresh-team');
    assert.equal(state.requests.length, before, 'Refresh must not silently discard a conflicting draft');
    assert.equal(await page.locator('[name="notes"]').inputValue(), 'UNSAVED SECRET');
    page.once('dialog', (dialog) => dialog.accept());
    await click(page, 'refresh-team');
    await page.locator('[data-list-kind="boards"] [data-action="open"]').first().waitFor();
    assert.equal(await page.locator('[data-editor] form').count(), 0);
    await open(page, 'boards');
    state.revoked = true;
    // Seed a deliberately accidental core cache reference to check defensive purging.
    await page.evaluate((board) => bootstrap.entries.boards.push(board), board);
    await page.locator('[name="notes"]').fill('MUST BE CLEARED');
    await page.locator('[data-form="document"] button[type="submit"]').click();
    await done(page, 'no longer accessible');
    assert.equal(await page.locator('[data-editor], [data-list-kind], [data-members]').count(), 0);
    const body = await page.locator('body').innerText();
    assert(!body.includes('MUST BE CLEARED') && !body.includes('Shared board') && !body.includes('PRIVATE OLDER'));
    assert.equal(await page.evaluate(() => bootstrap.entries.boards.length + bootstrap.teams.filter((team) => team.id === 't1').length), 0);
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  console.log('PASS bounded older pages, failed saves/409 preserve draft, explicit refresh and 404 privacy purge');
}
async function checkInviteAndCoreGuards(browser) {
  const test = await fixture(browser, { responder: (req) => req.url.pathname.endsWith('/invite') ? { status: 404, body: { detail: 'Member not found' } } : null });
  const { page } = test;
  try {
    await open(page, 'boards');
    await page.locator('[name="notes"]').fill('KEEP THIS DRAFT');
    await page.locator('summary').first().click();
    await page.locator('[name="username"]').fill('not-a-member');
    await page.locator('[data-form="invite"] button').click();
    await done(page, 'member could not be invited');
    assert.equal(await page.locator('[name="notes"]').inputValue(), 'KEEP THIS DRAFT', 'A missing invite target is not removed-team access');
    assert.equal(await page.locator('[name="username"]').inputValue(), 'not-a-member');
    assert.equal(await page.locator('[data-list-kind]').count(), 3);
    assert.deepEqual(test.errors, []);
  } finally { await test.context.close(); }
  const corePath = path.join(root, 'static/training.js');
  if (fs.existsSync(corePath)) {
    const integrated = await fixture(browser);
    const { page } = integrated;
    try {
      await page.evaluate(() => {
        leave();
        window.api = async (path, options) => {
          const response = await fetch(path, options), body = await response.json();
          if (!response.ok) throw Object.assign(new Error(body.detail), { status: response.status });
          return body;
        };
        location.hash = '#/practice/team/t1';
      });
      await page.addScriptTag({ content: fs.readFileSync(corePath, 'utf8') });
      await page.addScriptTag({ content: source });
      await page.evaluate(() => showTraining());
      await page.locator('[data-list-kind="boards"] [data-action="open"]').first().waitFor();
      await open(page, 'boards');
      page.on('dialog', (dialog) => dialog.dismiss());
      assert.equal(await page.evaluate(() => Training.canLeave()), true);
      await page.locator('[data-members]').evaluate(node => { node.closest('details').open = true; });
      await page.locator('[name="username"]').fill('Unsent invitation');
      await click(page, 'close');
      await open(page, 'boards'); // verify() refreshes the roster, not the input's saved baseline.
      assert.equal(await page.locator('[name="username"]').inputValue(), 'Unsent invitation');
      assert.equal(await page.evaluate(() => Training.canLeave()), false, 'An async roster refresh must not mark an unsent invite as saved');
      const reads = integrated.state.requests.length;
      await click(page, 'refresh-team');
      assert.equal(integrated.state.requests.length, reads, 'Team refresh must confirm before discarding an unsent invitation');
      assert.equal(await page.locator('[name="username"]').inputValue(), 'Unsent invitation');
      await page.locator('[name="username"]').fill('');
      assert.equal(await page.evaluate(() => Training.canLeave()), true);
      await page.locator('[name="notes"]').fill('Tracked by the actual core');
      assert.equal(await page.evaluate(() => Training.canLeave()), false);
      await click(page, 'add-mark');
      await page.locator('[data-form="document"] button[type="submit"]').click();
      await done(page);
      assert.equal(await page.evaluate(() => Training.canLeave()), true, 'A successful multi-step team save resets the generic core dirty guard');
      await click(page, 'remove-mark');
      assert.equal(await page.evaluate(() => Training.canLeave()), false, 'Structural annotation changes participate in core navigation guards');
      await page.evaluate(() => Training.dispose());
      assert.equal(await page.locator('[data-editor], [data-list-kind]').count(), 0);
      assert.deepEqual(integrated.errors, []);
    } finally { await integrated.context.close(); }
  }
  console.log('PASS unknown invite target preserves team drafts and real-core dirty/save/dispose integration');
}
async function checkStaleAndInitial404(browser) {
  const gate = deferred(); let held = false;
  const test = await fixture(browser, { responder: async (req) => {
    if (req.url.pathname.endsWith('/boards') && held) { await gate.promise; return { body: { entries: [board], has_more: false } }; }
    return null;
  } });
  try {
    held = true;
    await test.page.evaluate(() => mount('t1'));
    await until(() => test.state.requests.filter((req) => req.url.pathname.endsWith('/boards')).length === 2);
    await test.page.evaluate(() => { leave(); document.querySelector('#slot').textContent = 'NEW ROUTE'; ME = { username: 'other-member' }; });
    const response = test.page.waitForResponse((response) => response.url().includes('/entries/boards'));
    gate.resolve();
    await response;
    await test.page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    assert.equal(await test.page.locator('#slot').innerText(), 'NEW ROUTE');
    assert.deepEqual(test.errors, []);
  } finally { gate.resolve(); await test.context.close(); }
  const missing = await fixture(browser);
  try {
    missing.state.revoked = true;
    await missing.page.evaluate(() => mount('t1'));
    await done(missing.page, 'no longer accessible');
    assert.equal(await missing.page.locator('[data-list-kind]').count(), 0);
    assert.deepEqual(missing.errors, []);
  } finally { await missing.context.close(); }
  const revokedList = await fixture(browser, { many: true });
  try {
    await open(revokedList.page, 'boards');
    await revokedList.page.locator('[name="notes"]').fill('NO STALE DOCUMENTS');
    revokedList.state.revoked = true;
    await revokedList.page.locator('[data-list-kind="boards"] [data-action="older"]').click();
    await done(revokedList.page, 'no longer accessible');
    assert.equal(await revokedList.page.locator('[data-editor], [data-list-kind]').count(), 0);
    assert(!await revokedList.page.locator('body').innerText().then((text) => text.includes('NO STALE DOCUMENTS') || text.includes('Shared board')));
    assert.deepEqual(revokedList.errors, []);
  } finally { await revokedList.context.close(); }
  console.log('PASS dispose/logout clears private DOM, delayed replies cannot cross member/routes, team/list 404 clears all known notes');
}
async function checkRemotePagingAndPendingDelete(browser) {
  const paging = await fixture(browser, { many: true });
  try {
    paging.state.docs = paging.state.docs.filter(entry => entry.id !== 'board1');
    await paging.page.locator('[data-list-kind="boards"] [data-action="older"]').click();
    await paging.page.getByRole('button', { name: 'Older board 49', exact: true }).waitFor();
    await paging.page.locator('[data-list-kind="boards"] [data-action="older"]').click();
    await paging.page.getByRole('button', { name: 'Older board 51', exact: true }).waitFor();
    assert.deepEqual(paging.errors, []);
  } finally { await paging.context.close(); }
  const gate = deferred(); let held = false;
  const deleting = await fixture(browser, { responder: async req => {
    if (req.method === 'DELETE' && req.url.pathname.endsWith('/board1')) { held = true; await gate.promise; }
    return null;
  } });
  try {
    await open(deleting.page, 'boards');
    deleting.page.once('dialog', dialog => dialog.accept());
    await click(deleting.page, 'delete-doc'); await until(() => held);
    await deleting.page.locator('[name="notes"]').fill('New edits made AFTER confirming deletion');
    gate.resolve(); await done(deleting.page, 'New edits made while waiting have been kept');
    assert.equal(await deleting.page.locator('[name="notes"]').inputValue(), 'New edits made AFTER confirming deletion');
    assert.equal(await deleting.page.locator('[data-editor] [data-action="delete-doc"]').count(), 0);
    await deleting.page.locator('[data-form="document"] [type="submit"]').click(); await done(deleting.page);
    assert.equal(deleting.state.docs.filter(entry => entry.kind === 'boards').length, 1);
    const saved = deleting.state.docs.find(entry => entry.kind === 'boards');
    assert.notEqual(saved.id, 'board1');
    assert.equal(saved.data.notes, 'New edits made AFTER confirming deletion');
    assert.equal(saved.team_id, 't1');
    assert.deepEqual(deleting.errors, []);
  } finally { gate.resolve(); await deleting.context.close(); }
  console.log('PASS remotely shifted team pages do not skip records and pending deletion preserves newer edits as an unsaved new document');
}
(async () => {
  const type = process.env.BROWSER || 'chromium';
  const browser = await playwright[type].launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  try {
    for (const width of [320, 375, 768, 1280]) await checkLayoutAndBoard(browser, width);
    await checkTeams(browser);
    await checkPermissionsAndNotes(browser);
    await checkReviewClockBasis(browser);
    await checkDocumentLifecycle(browser);
    await checkFailuresAndPaging(browser);
    await checkInviteAndCoreGuards(browser);
    await checkStaleAndInitial404(browser);
    await checkRemotePagingAndPendingDelete(browser);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
