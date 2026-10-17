// Pure checks: node tests/training-lab.cjs
// Mocked browser regressions: NODE_PATH=.browser-tools/node_modules node tests/training-lab.cjs --browser
// Uses real training/lab scripts with an in-memory API only; no server, database or Riot.
'use strict';
const assert = require('node:assert/strict');
const L = require('../static/training-lab.js');
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
const mark = (extra = {}) => ({ id: 'm1', kind: 'arrow', team: 'blue', label: '', x: .2, y: .3, x2: .6, y2: .7, ...extra });

check('resistance uses 100/(100+R), and 2-100/(100-R) below zero', () => {
  close(L.resistanceMultiplier(0), 1, 'no armor');
  close(L.resistanceMultiplier(100), .5, '100 armor halves damage');
  close(L.resistanceMultiplier(-100), 1.5, 'negative armor amplifies damage');
  for (const bad of [NaN, Infinity, -101, 1001, '50', null]) assert.throws(() => L.resistanceMultiplier(bad));
});

check('mechanics: damage, effective health, hits and haste from entered numbers only', () => {
  const r = L.mechanics({ damage: 100, health: 1000, resistance: 50, cooldown: 10, haste: 30 });
  close(r.dealt, 100 * 100 / 150, 'damage per hit');
  close(r.effectiveHealth, 1500, 'effective health');
  assert.equal(r.hits, 15);
  close(r.cooldown, 10 / 1.3, 'haste-adjusted cooldown');
  assert.equal(L.mechanics({ damage: 0, health: 10, resistance: 0, cooldown: 0, haste: 0 }).hits, null, 'Zero damage never reaches zero health');
  assert.equal(L.mechanics({ damage: 10, health: 0, resistance: 0, cooldown: 0, haste: 0 }).hits, 0);
  for (const bad of [{ damage: -1 }, { health: Infinity }, { cooldown: '5' }, { haste: 1001 }]) {
    assert.throws(() => L.mechanics({ damage: 1, health: 1, resistance: 0, cooldown: 1, haste: 0, ...bad }));
  }
});

check('hit rounding follows floating-point scale without hiding real extra hits', () => {
  const hits = (health, damage = 1, resistance = 0) => L.mechanics({ damage, health, resistance, cooldown: 0, haste: 0 }).hits;
  assert.equal(hits(1000, 100, 50), 15, 'A few rounding errors above 15 do not add a hit');
  for (const health of [Number.MIN_VALUE, 1e-20, 1e-10]) {
    assert.equal(hits(health, 10000), 1, 'Positive health needs at least one hit, even when the ratio underflows');
  }
  for (const whole of [1, 15, 10000]) {
    assert.equal(hits(whole), whole);
    assert.equal(hits(whole + whole * 1e-10), whole + 1, 'A real fractional hit must round up');
    assert.equal(hits(whole - whole * 1e-10), whole);
  }
  assert.equal(hits(0, 0), 0, 'Zero health needs no hits even with zero damage');
  assert.equal(hits(1, 0), null, 'Zero damage cannot remove positive health');
});

check('keyboard moves keep the whole mark on the board and keep its shape', () => {
  const original = mark(), before = structuredClone(original);
  const moved = L.moveMark(original, .5, -.5);
  close(moved.x2 - moved.x, .4, 'arrow width kept');
  close(moved.y2 - moved.y, .4, 'arrow height kept');
  close(moved.x2, 1, 'clamped right'); close(moved.y, 0, 'clamped top');
  assert.deepEqual(original, before, 'input untouched');
  assert.notStrictEqual(moved, original, 'Movement returns a separate mark');
  assert.throws(() => L.moveMark(mark({ x: 2 }), 0, 0));
  assert.throws(() => L.moveMark(mark(), NaN, 0));
});

check('marks are validated strictly', () => {
  assert.ok(L.validMark(mark()));
  for (const bad of [{ kind: 'champion' }, { team: 'purple' }, { x: -0.01 }, { y2: 1.01 }, { label: 'x'.repeat(161) }, { id: 5 }]) {
    assert.ok(!L.validMark(mark(bad)), JSON.stringify(bad));
  }
});

check('diagram escapes labels and says it is schematic, not live positions', () => {
  const svg = L.diagram([mark({ label: '<img src=x onerror=alert(1)>' }), mark({ id: 'bad', x: 9 })], 'm1');
  assert.doesNotMatch(svg, /<img/);
  assert.match(svg, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(svg, /Schematic only · not live positions/);
  assert.equal((svg.match(/<g /g) || []).length, 1, 'Invalid marks are not drawn');
  assert.match(svg, /stroke-width="7"/, 'The selected mark is emphasized');
});

let failed = 0;
for (const [name, fn] of checks) {
  try { fn(); console.log(`ok - ${name}`); } catch (error) { failed++; console.error(`not ok - ${name}\n${error.stack}`); }
}
if (failed) { console.error(`${failed} of ${checks.length} lab checks failed`); process.exitCode = 1; }
else console.log(`${checks.length} lab checks passed`);

async function browserSuite() {
  const { chromium } = require('playwright');
  const path = require('node:path');
  const browser = await chromium.launch({ headless: true, timeout: 15000, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  async function fixture() {
    const page = await browser.newPage({ viewport: { width: 375, height: 900 } }), errors = [];
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().url() === 'http://lab.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="app"></main>' });
      errors.push(`Unexpected network: ${route.request().url()}`); return route.abort();
    });
    await page.goto('http://lab.test/#/practice/lab');
    await page.evaluate(mark => {
      window.ME = { username: 'alice' };
      const copy = value => structuredClone(value);
      window.lab = { calls: [], dialogs: [], confirm: false, held: null, serial: 1, records: [{ id: 'b1', kind: 'boards', owner: 'alice', team_id: null, revision: 1, data: { title: 'Saved setup', notes: 'Original notes', marks: [mark] } }] };
      window.confirm = message => { lab.dialogs.push(message); return lab.confirm; };
      window.api = async (url, options = {}) => {
        const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
        lab.calls.push({ url, method, body });
        if (method === 'GET' && url === '/api/training') return { entries: { boards: copy(lab.records.filter(row => !row.team_id)) }, teams: [{ id: 't1', name: 'Duo' }], limits: {} };
        const match = url.match(/^\/api\/training\/entries\/boards(?:\/([^?]+))?(?:\?revision=(\d+))?$/);
        if (!match) throw Error(`Unexpected fixture API: ${method} ${url}`);
        const existing = lab.records.find(row => row.id === match[1]);
        if (method !== 'POST' && (!existing || existing.revision !== (body?.revision ?? Number(match[2])))) throw Error('Revision conflict (409)');
        let result;
        if (method === 'DELETE') { lab.records = lab.records.filter(row => row !== existing); result = { ok: true }; }
        else if (method === 'POST' || method === 'PUT') {
          const entry = existing || { id: `b${++lab.serial}`, kind: 'boards', owner: 'alice', team_id: body.team_id, revision: 0 };
          entry.data = copy(body.data); ++entry.revision;
          if (!existing) lab.records.push(entry);
          result = { entry: copy(entry) };
        } else throw Error(`Unexpected fixture method: ${method}`);
        if (lab.held?.method === method) { lab.held.arrived = true; await new Promise(resolve => { lab.held.release = resolve; }); }
        return result;
      };
    }, mark());
    await page.addScriptTag({ path: path.join(__dirname, '../static/training.js') });
    await page.addScriptTag({ path: path.join(__dirname, '../static/training-lab.js') });
    await page.evaluate(() => showTraining());
    await page.locator('[data-lab-open="b1"]').click();
    const action = name => page.locator(`[data-lab-action="${name}"]`);
    const field = name => page.locator(`[data-lab-form] [name="${name}"]`);
    const submit = page.locator('[data-lab-form] [type="submit"]');
    const status = page.locator('[data-lab-status]');
    return {
      page, action, field, submit, status,
      hold: method => page.evaluate(method => { lab.held = { method, arrived: false }; }, method),
      arrived: () => page.waitForFunction(() => lab.held?.arrived),
      release: () => page.evaluate(() => { const held = lab.held; lab.held = null; held.release(); }),
      dirty: () => page.evaluate(() => { lab.confirm = false; return !Training.canLeave(); }),
      async close() {
        await page.evaluate(() => { lab.held?.release?.(); Training.dispose(); });
        await page.context().close(); assert.deepEqual(errors, []);
      }
    };
  }
  let passed = 0;
  async function check(name, fn) {
    const f = await fixture();
    try { await fn(f); passed++; console.log(`browser ok - ${name}`); }
    finally { await f.close(); }
  }
  const focused = locator => locator.evaluate(el => document.activeElement === el);
  try {
    await check('blank, bad and out-of-range coordinates stay dirty and survive cancelled discard', async f => {
      assert.equal(await f.dirty(), false);
      const x = f.field('x');
      for (const value of ['', '101']) {
        await x.fill(value); assert.equal(await f.dirty(), true);
        await f.action('new').click(); assert.equal(await x.inputValue(), value);
      }
      await x.fill(''); await x.press('e');
      assert.equal(await x.evaluate(el => el.validity.badInput), true);
      assert.equal(await f.dirty(), true);
      await f.action('new').click();
      assert.equal(await x.evaluate(el => el.validity.badInput), true, 'Cancelling preserves even an unfinished number');
      await x.fill('20'); assert.equal(await f.dirty(), false, 'Restoring the saved coordinate clears the guard');
      await x.fill('21'); assert.equal(await focused(x), true);
      const svg = f.page.locator('[data-lab-diagram] svg');
      await svg.focus(); assert.equal(await focused(svg), true, 'Blur/change does not detach the diagram');
      await svg.press('ArrowRight'); assert.equal(await focused(svg), true);
      await svg.click({ position: { x: 80, y: 60 } }); assert.equal(await focused(svg), true, 'Pointer redraw retains diagram focus too');
      assert.equal(await f.page.evaluate(() => lab.calls.filter(call => call.method !== 'GET').length), 0);
    });
    await check('successful saves preserve the form, focus, disclosure and team selection', async f => {
      await f.page.locator('[data-lab-sharing] summary').click();
      await f.page.locator('[data-lab-team]').selectOption('t1');
      await f.field('title').fill('Updated setup');
      await f.page.evaluate(() => { window.beforeForm = document.querySelector('[data-lab-form]'); });
      await f.submit.press('Enter');
      await f.status.filter({ hasText: 'Personal strategy board saved' }).waitFor();
      assert.equal(await f.page.evaluate(() => beforeForm === document.querySelector('[data-lab-form]')), true);
      assert.equal(await focused(f.submit), true, 'The submit control regains focus if the user did not move elsewhere');
      assert.equal(await f.page.locator('[data-lab-sharing] details').evaluate(el => el.open), true);
      assert.equal(await f.page.locator('[data-lab-team]').inputValue(), 't1');
      assert.equal(await f.dirty(), false);
    });
    await check('pending saves keep invalid/newer edits and advance only the submitted baseline', async f => {
      await f.field('title').fill('Submitted setup'); await f.hold('PUT'); await f.submit.click(); await f.arrived();
      await f.field('x').fill(''); await f.release();
      await f.status.filter({ hasText: 'Newer changes typed' }).waitFor();
      assert.equal(await f.status.evaluate(el => el.classList.contains('error')), false, 'A successful save is not reported as a failure');
      assert.equal(await f.field('x').inputValue(), ''); assert.equal(await focused(f.field('x')), true);
      assert.equal(await f.dirty(), true);
      await f.page.locator('[data-lab-sharing] summary').click(); await f.page.locator('[data-lab-team]').selectOption('t1');
      await f.action('share').click();
      await f.status.filter({ hasText: 'Every coordinate needs a number' }).waitFor();
      assert.equal(await f.page.evaluate(() => lab.records.length), 1, 'Invalid edits cannot be shared');
      await f.field('x').fill('20'); assert.equal(await f.dirty(), false, 'Reverting to submitted data is clean');
      await f.field('notes').fill('Submitted notes'); await f.hold('PUT'); await f.submit.click(); await f.arrived();
      await f.field('notes').fill('Newer unsaved notes');
      await f.field('notes').evaluate(el => el.setSelectionRange(2, 7)); await f.release();
      await f.status.filter({ hasText: 'Newer changes typed' }).waitFor();
      assert.equal(await f.field('notes').inputValue(), 'Newer unsaved notes'); assert.equal(await focused(f.field('notes')), true);
      assert.deepEqual(await f.field('notes').evaluate(el => [el.selectionStart, el.selectionEnd]), [2, 7]);
      await f.action('share').click(); await f.status.filter({ hasText: 'Save your current changes before sharing' }).waitFor();
      assert.equal(await f.page.evaluate(() => lab.records[0].data.notes), 'Submitted notes');
      assert.equal(await f.dirty(), true);
    });
    await check('pending share copies saved data, not edits made while waiting', async f => {
      await f.page.locator('[data-lab-sharing] summary').click(); await f.page.locator('[data-lab-team]').selectOption('t1');
      await f.page.evaluate(() => { lab.confirm = true; });
      await f.hold('POST'); await f.action('share').click(); await f.arrived();
      await f.field('notes').fill('Private newer notes'); await f.release();
      await f.status.filter({ hasText: 'Your original remains private' }).waitFor();
      assert.equal(await f.field('notes').inputValue(), 'Private newer notes'); assert.equal(await focused(f.field('notes')), true);
      assert.deepEqual(await f.page.evaluate(() => lab.records.map(row => [row.team_id, row.data.notes])), [[null, 'Original notes'], ['t1', 'Original notes']]);
      assert.equal(await f.page.locator('[data-lab-list] li').count(), 1);
      assert.equal(await f.dirty(), true);
    });
    await check('pending deletion keeps invalid edits as a new board with no stale sharing/deletion controls', async f => {
      await f.page.evaluate(() => { lab.confirm = true; });
      await f.hold('DELETE'); await f.action('delete').click(); await f.arrived();
      await f.field('x').fill(''); await f.release();
      await f.status.filter({ hasText: 'Newer edits remain here' }).waitFor();
      assert.equal(await f.field('x').inputValue(), ''); assert.equal(await focused(f.field('x')), true);
      assert.equal(await f.action('delete').count(), 0); assert.equal(await f.action('share').count(), 0);
      assert.equal(await f.submit.textContent(), 'Save personal board'); assert.equal(await f.dirty(), true);
      await f.field('x').fill('22'); await f.submit.click();
      await f.status.filter({ hasText: 'Personal strategy board saved' }).waitFor();
      assert.deepEqual(await f.page.evaluate(() => lab.calls.filter(call => call.method !== 'GET').map(call => call.method)), ['DELETE', 'POST']);
      assert.equal(await f.page.evaluate(() => lab.records[0].data.marks[0].x), .22);
      assert.equal(await f.dirty(), false);
    });
    console.log(`${passed} lab browser checks passed`);
  } finally { await browser.close(); }
}
if (!failed && process.argv.includes('--browser')) browserSuite().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
