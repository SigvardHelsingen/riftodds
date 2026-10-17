// Integrated browser regression: NODE_PATH=.browser-tools/node_modules node tests/training.cjs
// Uses the real index, scripts, styles and CSP; never starts main, a server, SQLite or Riot.
// Optional: SCREENSHOTS=1 (OS temp directory), TRAINING_CASE=<label regex>,
// BROWSER, PLAYWRIGHT_EXECUTABLE_PATH. No dependencies beyond the existing Playwright.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const playwright = require('playwright');
const { MatchFixture, MatchHTTPError, PROMPT } = require('./training-matches.cjs');

const root = path.resolve(__dirname, '..');
const origin = 'http://rift.test';
const TIMEOUT = 7000, CASE_TIMEOUT = 45000;
const kinds = ['plans', 'sessions', 'reviews', 'lessons', 'puzzles', 'attempts', 'experiments', 'boards'];
const sharedKinds = ['reviews', 'puzzles', 'boards'];
const workoutIds = ['last-hit', 'recall', 'jungle-clear', 'vision-setup', 'review-rotation', 'trading-window'];
const roles = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', ''];
const literal = '<img src="x" onerror="window.__trainingXSS=1"> & "quoted"';
const videoName = 'NEVER-SEND-private-device-video.webm';
const copy = value => structuredClone(value);
const now = () => Math.floor(Date.now() / 1000);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const end = Date.now() + TIMEOUT;
  while (!predicate()) {
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// Deliberately strict fixture, mirroring training.py models and training_api.py envelopes.
// Unknown/missing keys, numeric strings/booleans, wrong references and stale revisions
// must fail, rather than letting browser integration accidentally rely on a permissive mock.
class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (status, message) => { throw new HTTPError(status, message); };
const requireThat = (condition, message = 'Invalid request fields or types') => { if (!condition) reject(422, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  requireThat(object(value));
  requireThat(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}
const string = (max, nonblank = false, prose = false) => value => {
  requireThat(typeof value === 'string' && [...value].length <= max && (!nonblank || value.trim().length > 0));
  requireThat(![...value].some(c => /\p{C}/u.test(c) && !(prose && '\n\r\t'.includes(c))), 'Control characters are not allowed');
};
const label = string(160), identifier = string(160, true), title = string(120, true);
const prose = string(4000, false, true), requiredProse = string(4000, true, true);
const numeric = (min, max, integer = false) => value => requireThat(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)));
const integer = (min, max) => numeric(min, max, true);
const enumeration = values => value => requireThat(values.includes(value));
const nullable = validate => value => { if (value !== null) validate(value); };
const boolean = value => requireThat(typeof value === 'boolean');
const revision = integer(1, 2 ** 31 - 1);
const sourceLabel = value => { label(value); requireThat(!/[/\\]|^[a-zA-Z][a-zA-Z0-9+.-]*:|^~/.test(value), 'Use a descriptive source label, not a path or URL'); };
const record = (schema, optional = {}) => value => { keys(value, Object.keys(schema), Object.keys(optional)); for (const [key, validate] of Object.entries(schema)) validate(value[key]); for (const [key, validate] of Object.entries(optional)) if (Object.hasOwn(value, key)) validate(value[key]); };
const array = (validate, min, max, unique = false) => values => {
  requireThat(Array.isArray(values) && values.length >= min && values.length <= max);
  values.forEach(validate);
  if (unique) requireThat(new Set(values.map(row => row.id)).size === values.length, 'IDs within a document must be unique');
};
const coordinate = numeric(0, 1), seconds = numeric(0, 28800);
const annotation = record({ kind: enumeration(['arrow', 'circle', 'text']), x: coordinate, y: coordinate, x2: coordinate, y2: coordinate, text: label });
const moment = record({ id: identifier, seconds, title, known: prose, options: prose, decision: prose, outcome: prose, lesson: prose, annotations: array(annotation, 0, 30) });
const choice = record({ label: string(160, true), tradeoff: prose });
const date = value => {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.slice(0, 4) !== '0000');
  const parsed = new Date(`${value}T00:00:00Z`);
  requireThat(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value);
};
const observation = record({ id: identifier, date, phase: enumeration(['baseline', 'practice']), value: numeric(0, 100000), adhered: boolean, context: prose });
const mark = record({ id: identifier, kind: enumeration(['arrow', 'ward', 'position', 'text']), x: coordinate, y: coordinate, x2: coordinate, y2: coordinate, label, team: enumeration(['blue', 'red', 'neutral']) });
const schemas = {
  plans: record({ title, focus: prose, role: enumeration(roles), champion: label, workout_id: enumeration(workoutIds), minutes: integer(1, 120), games: integer(1, 20), status: enumeration(['active', 'archived']) }),
  sessions: record({ plan_id: nullable(identifier), workout_id: enumeration(workoutIds), minutes: integer(0, 240), repetitions: integer(1, 100), result: nullable(numeric(-1e9, 1e9)), unit: label, focus: prose, reflection: prose, adhered: boolean, role: label, champion: label, patch: label }),
  reviews: record({ title, match_id: sourceLabel, source_label: sourceLabel, moments: array(moment, 0, 50, true) }, { time_basis: enumeration(['video', 'match']) }),
  lessons: record({ question: requiredProse, answer: requiredProse, source_review_id: nullable(identifier), due: integer(0, 253402300799), interval_days: integer(1, 365), repetitions: integer(0, 1000) }),
  puzzles: record({ title, prompt: requiredProse, context: prose, choices: array(choice, 2, 5), discussion: prose, source_review_id: nullable(identifier), seconds: nullable(seconds) }),
  attempts: record({ puzzle_id: identifier, choice_index: integer(0, 4), reason: prose, reflection: prose }),
  experiments: record({ title, hypothesis: requiredProse, change: requiredProse, measure: label, unit: label, better: enumeration(['higher', 'lower']), role: label, champion: label, patch: label, phase: enumeration(['baseline', 'practice', 'complete']), observations: array(observation, 0, 100, true) }),
  boards: record({ title, notes: prose, marks: array(mark, 0, 100, true) })
};
const catalog = {
  workouts: workoutIds.map((id, i) => ({ id, title: ['Consistent last hits', 'Recall preparation', 'Repeatable jungle clear', 'Vision before an objective', 'Review a rotation', 'Trading windows'][i], roles: roles.filter(Boolean), minutes: 10,
    goal: 'Repeat a consistent manual setup inside League.', steps: ['Open League Practice Tool yourself.', 'Repeat the setup and record what changed.'], measure: 'Manually recorded result', unit: i === 0 ? 'last hits' : 'repetitions', tip: 'Compare consistent setups, not promotion targets.' })),
  starter_puzzles: ['recall-window', 'objective-trade', 'unsafe-wave'].map((id, i) => ({ id, title: ['A possible recall window', 'Trade or contest?', 'An exposed side wave'][i], prompt: 'Which option would you consider, and why?', context: 'Enemy jungle position is unknown.',
    choices: [{ label: 'Reset now', tradeoff: 'Recover resources but concede time.' }, { label: 'Wait for information', tradeoff: 'Keep options open but extend exposure.' }], discussion: 'Both can be reasonable depending on resources, vision and cover. Neither guarantees a win.', source_review_id: null, seconds: null }))
};
function validateData(kind, data) {
  if (!schemas[kind]) reject(404, 'Unknown training kind');
  schemas[kind](data);
  requireThat(Buffer.byteLength(JSON.stringify(data)) <= 32768, 'Entry exceeds the 32 KiB limit');
}

class FixtureStore {
  constructor() { this.users = new Set(['alice', 'bob', 'carol']); this.entries = new Map(); this.teams = new Map(); this.matches = new MatchFixture(); this.serial = 0; }
  member(teamId, user, invited = false) {
    const team = this.teams.get(teamId);
    if (!team?.members.some(m => m.username === user && (invited || m.status === 'active'))) reject(404, 'Training team not found');
    return team;
  }
  find(kind, id, user) {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== kind || (entry.team_id === null ? entry.owner !== user : !this.teams.get(entry.team_id)?.members.some(m => m.username === user && m.status === 'active'))) reject(404, 'Training entry not found');
    return entry;
  }
  list(kind, user, teamId = null, offset = 0, limit = 50) {
    if (!kinds.includes(kind)) reject(404, 'Unknown training kind');
    if (teamId !== null) this.member(teamId, user);
    const rows = [...this.entries.values()].reverse().filter(e => e.kind === kind && (teamId === null ? e.owner === user && e.team_id === null : e.team_id === teamId));
    return { entries: copy(rows.slice(offset, offset + limit)), has_more: rows.length > offset + limit };
  }
  workspace(user) {
    const pages = Object.fromEntries(kinds.map(kind => [kind, this.list(kind, user)]));
    const own = [...this.entries.values()].filter(e => e.owner === user);
    return copy({ catalog, entries: Object.fromEntries(kinds.map(kind => [kind, pages[kind].entries])),
      teams: [...this.teams.values()].filter(t => t.members.some(m => m.username === user && m.status === 'active')),
      invitations: [...this.teams.values()].filter(t => t.members.some(m => m.username === user && m.status === 'invited')).map(t => ({ team_id: t.id, team_name: t.name, owner: t.owner, created: t.created })),
      limits: { per_member: 200, per_team: 100, teams_per_member: 10, members_per_team: 20, entry_bytes: 32768, page_size: 50, member_count: own.length, personal_count: own.filter(e => e.team_id === null).length, remaining: 200 - own.length, has_more: Object.fromEntries(kinds.map(kind => [kind, pages[kind].has_more])) } });
  }
  references(kind, data, user, teamId) {
    const ref = (refKind, id) => { if (id !== null) { const e = this.find(refKind, id, user); if (e.team_id !== teamId) reject(404, 'Training entry not found'); } };
    if (kind === 'sessions') ref('plans', data.plan_id);
    if (kind === 'lessons' || kind === 'puzzles') ref('reviews', data.source_review_id);
    if (kind === 'attempts') {
      const puzzle = catalog.starter_puzzles.find(p => p.id === data.puzzle_id) || this.find('puzzles', data.puzzle_id, user).data;
      requireThat(data.choice_index < puzzle.choices.length, 'Choice index is outside this puzzle');
    }
  }
  save(kind, data, user, teamId = null, existing = null) {
    validateData(kind, data);
    if (teamId !== null) { requireThat(sharedKinds.includes(kind), 'This kind is private and cannot be shared'); this.member(teamId, user); }
    this.references(kind, data, user, teamId);
    if (kind === 'plans' && data.status === 'active') for (const e of this.entries.values()) {
      if (e.owner === user && e.kind === kind && e.id !== existing?.id && e.data.status === 'active') { e.data.status = 'archived'; e.revision++; e.updated = now(); }
    }
    data = copy(data);
    if (kind === 'reviews' && !Object.hasOwn(data, 'time_basis')) data.time_basis = 'video';
    if (kind === 'lessons') Object.assign(data, existing ? { due: existing.data.due, interval_days: existing.data.interval_days, repetitions: existing.data.repetitions } : { due: now(), interval_days: 1, repetitions: 0 });
    const entry = existing ? { ...existing, revision: existing.revision + 1, updated: now(), data } : { id: `entry-${++this.serial}`, kind, owner: user, team_id: teamId, revision: 1, created: now(), updated: now(), data };
    this.entries.set(entry.id, entry);
    return { entry: copy(entry) };
  }
  handle(call) {
    const { method, url, body, user, headers } = call;
    if (!user || !this.users.has(user)) reject(401, 'Not logged in');
    const parts = url.pathname.split('/').slice(3).map(decodeURIComponent);
    const [area, kind, id] = parts;
    const allowedQuery = method === 'GET' && area === 'entries' && parts.length === 2 ? ['team_id', 'offset', 'limit'] : method === 'DELETE' && (area === 'entries' || area === 'plans' && id === 'matches') ? ['revision'] : method === 'GET' && area === 'review-queue' ? ['plan_id'] : [];
    requireThat([...url.searchParams.keys()].every(key => allowedQuery.includes(key) && url.searchParams.getAll(key).length === 1), 'Unknown or duplicate query fields');
    if (['POST', 'PUT'].includes(method)) {
      requireThat(headers['content-type']?.split(';')[0] === 'application/json', 'Use application/json');
      requireThat(Buffer.byteLength(call.raw || '') <= 40960);
      if (headers.origin && headers.origin !== origin) reject(403, 'Cross-origin training mutations are not allowed');
    } else requireThat(body === null, 'Unexpected request body');
    const owner = team => { if (team.owner !== user) reject(403, 'Only the team owner can do this'); };
    const fresh = entry => { revision(body.revision); if (entry.revision !== body.revision) reject(409, 'This entry changed. Reload it before saving or deleting.'); };
    if (this.matches.handles(url)) {
          try { return this.matches.handle(call, planId => this.find('plans', planId, user)); }
          catch (error) { if (error instanceof MatchHTTPError) reject(error.status, error.message); throw error; }
        }
        if (!area && method === 'GET') return this.workspace(user);
    if (area === 'entries') {
      if (!kinds.includes(kind)) reject(404, 'Unknown training kind');
      if (method === 'GET' && parts.length === 2) {
        const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 50);
        integer(0, 200)(offset); integer(1, 50)(limit);
        return this.list(kind, user, url.searchParams.get('team_id'), offset, limit);
      }
      if (method === 'POST' && parts.length === 2) {
        keys(body, ['data'], ['team_id']);
        nullable(identifier)(body.team_id ?? null);
        return this.save(kind, body.data, user, body.team_id ?? null);
      }
      if (parts.length === 3 && ['PUT', 'DELETE'].includes(method)) {
        const entry = this.find(kind, id, user);
        if (method === 'PUT') {
          keys(body, ['data', 'revision']); fresh(entry);
          if (entry.owner !== user && !(kind === 'boards' && entry.team_id)) reject(403, 'Only the creator can edit this document');
          return this.save(kind, body.data, user, entry.team_id, entry);
        }
        const requested = Number(url.searchParams.get('revision')); revision(requested);
        if (entry.revision !== requested) reject(409, 'This entry changed. Reload it before saving or deleting.');
        if (entry.owner !== user && this.member(entry.team_id, user).owner !== user) reject(403, 'Only the creator or team owner can delete this document');
        this.entries.delete(id); return { ok: true };
      }
    }
    if (area === 'lessons' && id === 'grade' && parts.length === 3 && method === 'POST') {
      keys(body, ['revision', 'rating']); enumeration(['again', 'good', 'easy'])(body.rating);
      const entry = this.find('lessons', kind, user); fresh(entry);
      const interval = body.rating === 'again' ? 1 : entry.data.repetitions === 0 ? (body.rating === 'good' ? 1 : 4) : Math.min(365, entry.data.interval_days * (body.rating === 'good' ? 2 : 3));
      entry.data = { ...entry.data, due: now() + interval * 86400, interval_days: interval, repetitions: Math.min(1000, entry.data.repetitions + 1) }; entry.revision++; entry.updated = now();
      return { entry: copy(entry) };
    }
    if (area === 'teams') {
      if (parts.length === 1 && method === 'POST') {
        keys(body, ['name']); title(body.name);
        const team = { id: `team-${++this.serial}`, name: body.name, owner: user, created: now(), members: [{ username: user, status: 'active' }] };
        this.teams.set(team.id, team); return { team: copy(team) };
      }
      if (parts.length === 3 && id === 'accept' && method === 'POST') {
        keys(body, []); const team = this.member(kind, user, true);
        team.members.find(m => m.username === user).status = 'active'; return { team: copy(team) };
      }
      const team = this.member(kind, user);
      if (parts.length === 2 && method === 'GET') return { team: copy(team), entries: Object.fromEntries(sharedKinds.map(k => [k, this.list(k, user, team.id).entries])), has_more: Object.fromEntries(sharedKinds.map(k => [k, this.list(k, user, team.id).has_more])) };
      if (parts.length === 3 && id === 'invite' && method === 'POST') {
        owner(team); keys(body, ['username']); string(64)(body.username); requireThat(body.username.length > 0);
        if (!this.users.has(body.username)) reject(404, 'Member not found');
        if (!team.members.some(m => m.username === body.username)) team.members.push({ username: body.username, status: 'invited' });
        return { ok: true };
      }
      if (parts.length === 2 && method === 'DELETE') { owner(team); this.teams.delete(team.id); for (const [key, entry] of this.entries) if (entry.team_id === team.id) this.entries.delete(key); return { ok: true }; }
    }
    throw Error(`Unmocked API: ${method} ${url.pathname}`);
  }
}

function productionCSP() {
  // Read literals only; never import/execute main.py (its lifespan accesses production services).
  const source = fs.readFileSync(path.join(root, 'main.py'), 'utf8');
  const block = source.match(/"Content-Security-Policy":\s*"; "\.join\(\(([\s\S]*?)\)\)/);
  assert(block, 'Update the fixture CSP reader if SECURITY_HEADERS changes; never silently omit CSP');
  const policy = [...block[1].matchAll(/"([^"\n]*)"/g)].map(match => match[1]).join('; ');
  assert.match(policy, /default-src 'self'/);
  return policy;
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const metadata = { champions: {}, items: {}, runes: {}, spells: {}, queues: [], platforms: ['euw1'], tiers: ['GOLD'], roles: roles.filter(Boolean), default_range: '40', ranges: [{ key: '40', label: 'Last 40 games', kind: 'games' }], ddragon: '16.20.1' };
const screenshotDirectory = process.env.SCREENSHOTS === '1' ? fs.mkdtempSync(path.join(os.tmpdir(), 'rift-training-')) : null;
const activeFixtures = new Set();
let fixtureSerial = 0;
async function fixture(browser, { width = 375, store = new FixtureStore(), user = 'alice' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT); page.setDefaultNavigationTimeout(TIMEOUT);
  const state = { user, calls: [], assets: [], unexpected: [], errors: [], rules: [], held: new Set(), dialogs: [], dialogExpectations: [], validated: false, serial: ++fixtureSerial };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('websocket', socket => state.unexpected.push(`WebSocket ${socket.url()}`));
  page.on('dialog', dialog => {
    const expected = state.dialogExpectations.shift();
    const actual = { type: dialog.type(), message: dialog.message() };
    state.dialogs.push(actual);
    const matches = expected && actual.type === expected.type && expected.message.test(actual.message);
    if (!matches) state.unexpected.push(`Unexpected ${actual.type} dialog: ${actual.message}`);
    void (matches && expected.decision === 'accept' ? dialog.accept() : dialog.dismiss())
      .then(() => expected?.handled.resolve(actual), error => {
        state.unexpected.push(`Could not handle dialog: ${error.message}`);
        expected?.handled.resolve(actual);
      });
  });
  await context.addInitScript(() => {
    window.__trainingProbe = { violations: [], created: [], revoked: [], detachedVideos: [] };
    document.addEventListener('securitypolicyviolation', event => window.__trainingProbe.violations.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); window.__trainingProbe.created.push(url); return url; };
    URL.revokeObjectURL = url => { window.__trainingProbe.revoked.push(url); return revoke(url); };
  });
  const csp = productionCSP();
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    try {
      // WebKit also routes local Blob media/native video-control images through
      // Playwright. Continue to the browser's Blob store, never the HTTP/API mock.
      if (url.protocol === 'blob:') {
        assert.equal(url.origin, origin, 'Local Blob resources must belong to this page');
        assert.equal(request.method(), 'GET');

        return await route.continue();
      }
      if (url.origin !== origin) {
        if (url.origin === 'https://fonts.googleapis.com' && request.resourceType() === 'stylesheet') return await route.fulfill({ contentType: 'text/css', body: '' });
        throw Error(`External network request: ${request.method()} ${url.href}`);
      }
      if (/^\/static\/practice(?:[./-]|$)/.test(url.pathname)) throw Error(`Old simulator asset requested: ${url.pathname}`);
      if (url.pathname === '/' || url.pathname.startsWith('/static/')) {
        assert.equal(request.method(), 'GET');
        const relative = url.pathname === '/' ? 'static/index.html' : decodeURIComponent(url.pathname.slice(1));
        const filename = path.resolve(root, relative);
        assert(filename.startsWith(path.join(root, 'static') + path.sep), 'Static path escaped its directory');
        assert(fs.statSync(filename).isFile(), `Missing real static file: ${relative}`);
        state.assets.push(url.pathname);
        return await route.fulfill({ contentType: mime[path.extname(filename)] || 'application/octet-stream', headers: { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' }, body: fs.readFileSync(filename) });
      }
      const raw = request.postData(), body = raw ? JSON.parse(raw) : null;
      const call = { method: request.method(), url, body, raw, headers: request.headers(), user: state.user };
      state.calls.push(call);
      let result, status = 200;
      const ruleIndex = state.rules.findIndex(rule => rule.method === call.method && rule.pathname === url.pathname);
      const rule = ruleIndex < 0 ? null : state.rules.splice(ruleIndex, 1)[0];
      try {
        if (url.pathname === '/api/login') {
          keys(body, ['username', 'password']); requireThat(store.users.has(body.username) && body.password === 'fixture-password');
          state.user = body.username; result = { username: state.user };
        } else if (url.pathname === '/api/logout') { keys(body, []); state.user = null; result = { ok: true }; }
        else if (url.pathname === '/api/me') {
          if (!state.user) reject(401, 'Not logged in');
          result = { username: state.user, role: 'member', account: null };
        } else if (url.pathname === '/api/meta') result = metadata;
        else if (url.pathname.startsWith('/api/training')) result = rule?.reply ? rule.reply.body : store.handle(call);
        else throw Error(`Unmocked non-training API: ${call.method} ${url.pathname}`);
        if (rule?.reply) { status = rule.reply.status; result = rule.reply.body; }
      } catch (error) {
        if (!(error instanceof HTTPError)) throw error;
        status = error.status; result = { detail: error.message };
        if (status === 422 || status === 415) state.unexpected.push(`Strict fixture rejected ${call.method} ${url.pathname}: ${error.message}\n${raw}`);
      }
      if (rule) {
        rule.hit.resolve(call);
        if (rule.gate) {
          state.held.add(rule);
          try { await bounded(rule.gate.promise, CASE_TIMEOUT, `release ${call.method} ${url.pathname}`); }
          finally { state.held.delete(rule); }
        }
      }
      try { await route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie' }, body: JSON.stringify(result) }); }
      catch (error) { if (!rule?.gate) throw error; /* Disposed routes may have aborted this held response. */ }
      finally { rule?.done.resolve(); }
    } catch (error) {
      state.unexpected.push(error.stack || error.message);
      await route.fulfill({ status: 599, contentType: 'application/json', body: JSON.stringify({ detail: error.message }) }).catch(() => {});
    }
  });
  const f = {
    page, context, state, store,
    async open(hash = '#/practice') { await page.goto(`${origin}/${hash}`, { waitUntil: 'load' }); },
    async go(hash) {
      // Wait for the real hashchange handler, not a selector that may still match
      // the preceding route's form (especially when switching two hub aliases).
      await bounded(page.evaluate(value => new Promise(resolve => {
        if (location.hash === value) { resolve(); return; }
        window.addEventListener('hashchange', () => queueMicrotask(resolve), { once: true });
        location.hash = value;
      }), hash), TIMEOUT, `hashchange ${hash}`);
    },
    next(method, pathname, reply = null, hold = false) {
      const rule = { method, pathname, reply, gate: hold ? deferred() : null, hit: deferred(), done: deferred() };
      state.rules.push(rule);
      return { hit: () => bounded(rule.hit.promise, TIMEOUT, `request ${method} ${pathname}`), release: async () => { rule.gate?.resolve(); await bounded(rule.done.promise, TIMEOUT, `response ${method} ${pathname}`); } };
    },
    async settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); },
    async expectDialog(type, message, decision, trigger) {
      const expected = { type, message, decision, handled: deferred() };
      state.dialogExpectations.push(expected);
      const [actual] = await Promise.all([
        bounded(expected.handled.promise, TIMEOUT, `expected ${type} dialog: ${message}`),
        trigger()
      ]);
      assert.equal(actual.type, type); assert.match(actual.message, message);
      return actual;
    },
    async clean() {
      assert.deepEqual(state.unexpected, [], 'All network and dialog activity must be explicitly mocked/expected');
      assert.deepEqual(state.errors, [], 'No uncaught browser errors');
      assert.deepEqual(await page.evaluate(() => window.__trainingProbe.violations), [], 'Real production CSP must permit the workspace');
      assert.equal(await page.evaluate(() => window.__trainingXSS), undefined, 'Literal text cannot execute');
      assert(!state.calls.some(call => /NEVER-SEND|blob:|multipart\/form-data|base64,/.test(call.raw || '')), 'Local video/file metadata must never enter any API payload');
      assert(!state.calls.some(call => !['/api/me', '/api/meta', '/api/login', '/api/logout'].includes(call.url.pathname) && !call.url.pathname.startsWith('/api/training')), 'Training cannot call Riot-backed/analytics APIs');
      if (!state.matchOptIn) assert(!state.calls.some(call => store.matches.handles(call.url)), 'Existing journeys must not request any new match endpoint without explicit opt-in');
            assert.equal(state.rules.length, 0, 'All expected requests must actually be sent');
      assert.equal(state.dialogExpectations.length, 0, 'All expected dialogs must actually be shown');
      state.validated = true;
    },
    async close() {
      activeFixtures.delete(f);
      for (const rule of [...state.rules, ...state.held]) rule.gate?.resolve();
      if (!state.validated) {
        if (state.unexpected.length || state.errors.length) console.error(JSON.stringify({ unexpected: state.unexpected, errors: state.errors }, null, 2));
        await screenshot(page, `failure-${state.serial}`).catch(() => {});
      }
      await context.close();
    }
  };
  activeFixtures.add(f);
  return f;
}
const action = (page, name) => page.locator(`[data-action="${name}"]`);
const field = (form, name) => form.locator(`[name="${name}"]`);
const status = (page, text) => page.locator('[role="status"]').filter({ hasText: text }).first().waitFor();
async function keyboardClick(locator) {
  await locator.waitFor();
  const deadline = Date.now() + TIMEOUT;
  while (!await locator.isEnabled()) {
    assert(Date.now() < deadline, 'Keyboard target did not become enabled');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await locator.focus();
  assert(await locator.evaluate(el => document.activeElement === el), 'Keyboard activation must focus the intended control');
  await locator.press('Enter');
}
async function noOverflow(page, label) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1) && !el.closest('.table-scroll, [role="region"]'); }).slice(0, 8).map(el => `${el.tagName}.${el.className}: ${el.getBoundingClientRect().right}`) }));
  assert(size.width <= size.viewport + 1, `${label}: ${JSON.stringify(size)}`);
}
async function screenshot(page, name) {
  if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`), fullPage: true, timeout: TIMEOUT });
}
async function login(f, user) {
  const form = f.page.locator('#login-form'); await form.waitFor();
  await field(form, 'username').fill(user); await field(form, 'password').fill('fixture-password');
  await keyboardClick(form.getByRole('button', { name: 'Log in', exact: true }));
}
async function savePlan(f, text = 'One repeatable focus') {
  const form = f.page.locator('[data-plan-editor] form'); await form.waitFor();
  await field(form, 'title').fill('A deliberate week'); await field(form, 'focus').fill(text);
  await keyboardClick(form.getByRole('button', { name: 'Save weekly plan', exact: true }));
  await status(f.page, 'Weekly plan saved');
  return [...f.store.entries.values()].find(e => e.kind === 'plans' && e.owner === f.state.user && e.data.status === 'active');
}

function checkFixtureContract() {
  const store = new FixtureStore();
  const valid = { title: 'Plan', focus: '', role: '', champion: '', workout_id: 'last-hit', minutes: 10, games: 3, status: 'active' };
  validateData('plans', valid);
  for (const bad of [{ ...valid, owner: 'bob' }, { ...valid, minutes: true }, { ...valid, minutes: '10' }, { ...valid, minutes: 0 }, { ...valid, title: '\u0000' }, { ...valid, workout_id: 'simulator' }]) assert.throws(() => validateData('plans', bad), HTTPError);
  assert.throws(() => validateData('plans', { title: 'Missing fields' }), HTTPError);
  const review = { title: 'Review', match_id: '', source_label: '', moments: [] };
  validateData('reviews', review);
  assert.equal(store.save('reviews', review, 'alice').entry.data.time_basis, 'video', 'Legacy review omission serializes the backend default');
  for (const time_basis of ['video', 'match']) { validateData('reviews', { ...review, time_basis }); assert.equal(store.save('reviews', { ...review, time_basis }, 'alice').entry.data.time_basis, time_basis); }
  for (const time_basis of [null, '', 'game', 0, true]) assert.throws(() => validateData('reviews', { ...review, time_basis }), HTTPError);
  for (const extra of [{ offset: 1 }, { calibration: { offset: 1 } }, { media: {} }]) assert.throws(() => validateData('reviews', { ...review, ...extra }), HTTPError);
  for (const extra of [{ filename: videoName }, { video_url: 'blob:private' }, { source_label: '/private/device/video.webm' }]) assert.throws(() => validateData('reviews', { ...review, ...extra }), HTTPError);
  const session = { plan_id: null, workout_id: 'last-hit', minutes: 0, repetitions: 1, result: null, unit: '', focus: '', reflection: '', adhered: false, role: '', champion: '', patch: '' };
  validateData('sessions', session); validateData('sessions', { ...session, result: 0 });
  assert.throws(() => validateData('sessions', { ...session, result: false }), HTTPError);
  assert.throws(() => store.save('sessions', { ...session, plan_id: 'foreign' }, 'alice'), HTTPError);
  assert.throws(() => store.save('attempts', { puzzle_id: 'recall-window', choice_index: 4, reason: '', reflection: '' }, 'alice'), HTTPError);
}

async function checkLoadOrder(browser) {
  const f = await fixture(browser);
  try {
    await f.open();
    const scripts = await f.page.locator('script[src]').evaluateAll(nodes => nodes.map(node => new URL(node.src).pathname));
    assert.deepEqual(scripts, ['/static/app.js', '/static/insights.js', '/static/training.js', '/static/training-review.js', '/static/training-team.js', '/static/training-lab.js'], 'The real index must load the training core before its renderers, and no simulator');
    assert(await f.page.locator('link[href="/static/training.css"]').count(), 'The real index must load training.css');
    await f.page.locator('[data-plan-editor] form').waitFor();
    assert.equal(f.state.calls.filter(c => c.url.pathname === '/api/training').length, 1, 'Module registration must not bootstrap twice');
    assert.equal(await f.page.evaluate(() => typeof window.Training?.dispose), 'function');
    const tools = f.page.getByRole('navigation', { name: 'Training tools', exact: true });
    await keyboardClick(tools.getByRole('link', { name: 'Review a match', exact: true }));
    await f.page.locator('[data-review-form]').waitFor();
    assert.equal(await f.page.evaluate(() => location.hash), '#/practice/review', 'Visible tool links use the real router and support keyboard activation');
    await f.clean();
  } finally { await f.close(); }
}

async function checkJourney(browser, width) {
  const f = await fixture(browser, { width }); const { page, store } = f;
  try {
    await f.open(`#/practice?focus=${encodeURIComponent(literal)}&role=TOP`);
    const planForm = page.locator('[data-plan-editor] form'); await planForm.waitFor();
    assert.equal(await field(planForm, 'focus').inputValue(), literal);
    assert.equal(await field(planForm, 'role').inputValue(), 'TOP');
    assert.equal(store.entries.size, 0, 'Query prefill is never auto-saved');
    const sessionForm = page.locator('[data-session-editor] form');
    await field(sessionForm, 'reflection').fill('Keep my draft while the plan saves');
    const plan = await savePlan(f, literal);
    assert.equal(await field(sessionForm, 'reflection').inputValue(), 'Keep my draft while the plan saves');
    await field(sessionForm, 'plan_id').selectOption(plan.id);
    await field(sessionForm, 'result').fill('0'); await field(sessionForm, 'adhered').check();
    await keyboardClick(sessionForm.getByRole('button', { name: 'Save session', exact: true }));
    await status(page, 'Session saved');
    const session = [...store.entries.values()].find(e => e.kind === 'sessions');
    assert.equal(session.data.plan_id, plan.id); assert.equal(session.data.result, 0); assert.equal(session.data.adhered, true);
    await noOverflow(page, `hub ${width}`); await screenshot(page, `hub-${width}`);
    await f.go('#/practice/review?match=EUW1_fixture');
    const reviewForm = page.locator('[data-review-form]'); await reviewForm.waitFor();
    assert.equal(await field(reviewForm, 'match_id').inputValue(), 'EUW1_fixture');
    await field(reviewForm, 'title').fill(literal); await field(reviewForm, 'source_label').fill('My manual source');
    await field(page, 'moment-seconds').fill('0'); await keyboardClick(action(page, 'add-moment'));
    await field(page, 'moment-title').fill('Before rotating');
    for (const [name, value] of Object.entries({ known: literal, options: 'Reset now or prepare another wave?', decision: 'Reset with limited resources.', outcome: 'Lost a wave; outcome is not proof.', lesson: 'Check resources and wave timing.' })) await field(page, name).fill(value);
    await keyboardClick(reviewForm.getByRole('button', { name: 'Save review', exact: true }));
    await status(page, 'Review notes saved');
    const review = [...store.entries.values()].find(e => e.kind === 'reviews');
    assert.equal(review.data.moments[0].known, literal); assert.equal(review.data.moments[0].seconds, 0); assert.equal(review.data.time_basis, 'video');
    assert((await page.locator('[data-list]').innerText()).includes(literal), 'Saved review title remains literal text');
    assert.equal(await page.locator('#app img[src="x"], #app script').count(), 0);
    await keyboardClick(action(page, 'make-lesson'));
    const lessonForm = page.locator('[data-derived-form="lessons"]');
    await field(lessonForm, 'question').fill('What would you check before rotating?');
    await keyboardClick(lessonForm.getByRole('button', { name: 'Save new lesson' })); await status(page, 'New personal lesson saved');
    const lesson = [...store.entries.values()].find(e => e.kind === 'lessons'); assert.equal(lesson.data.source_review_id, review.id);
    await keyboardClick(action(page, 'make-puzzle'));
    const puzzleForm = page.locator('[data-derived-form="puzzles"]');
    await field(puzzleForm, 'choice-0').fill('Recall now'); await field(puzzleForm, 'tradeoff-0').fill('Recover but concede wave control.');
    await field(puzzleForm, 'choice-1').fill('Prepare a wave'); await field(puzzleForm, 'tradeoff-1').fill('Better timing but more exposure.');
    await keyboardClick(puzzleForm.getByRole('button', { name: 'Save new puzzle' })); await status(page, 'New personal puzzle saved');
    const puzzle = [...store.entries.values()].find(e => e.kind === 'puzzles'); assert.equal(puzzle.data.source_review_id, review.id); assert.equal(puzzle.data.seconds, 0);
    await noOverflow(page, `review ${width}`); await screenshot(page, `review-${width}`);
    await f.go('#/practice/lessons'); await page.locator('[data-lesson-form]').waitFor();
    await keyboardClick(action(page, 'recall').filter({ hasText: lesson.data.question }));
    assert.equal(await action(page, 'grade').count(), 0, 'Recall grading is unavailable until answer is revealed');
    await keyboardClick(action(page, 'reveal')); await keyboardClick(page.getByRole('button', { name: 'Good', exact: true }));
    await status(page, 'Recall recorded');
    const graded = store.entries.get(lesson.id); assert.equal(graded.revision, 2); assert.equal(graded.data.repetitions, 1); assert(graded.data.due > now());
    const gradeCall = f.state.calls.find(c => c.url.pathname.endsWith('/grade')); assert.deepEqual(gradeCall.body, { revision: 1, rating: 'good' });
    await noOverflow(page, `lessons ${width}`);
    await f.go('#/practice/puzzles'); await page.locator('[data-puzzle-form]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-author]').evaluate(el => el.open), false, 'Puzzle authoring stays on demand; practicing a saved puzzle needs no editor');
    await keyboardClick(action(page, 'practice').filter({ hasText: puzzle.data.title }));
    const attemptForm = page.locator('[data-attempt-form]');
    await field(attemptForm, 'choice').first().focus(); await page.keyboard.press('Space');
    await field(attemptForm, 'reason').fill('Resources are low; I assume the wave is safe to leave.');
    await keyboardClick(action(page, 'reveal'));
    await field(attemptForm, 'reflection').fill(literal);
    assert.equal(await field(attemptForm, 'reason').isDisabled(), true, 'Initial reasoning is retained after reveal');
    await keyboardClick(attemptForm.getByRole('button', { name: 'Save personal attempt' })); await status(page, 'Reasoning and reflection saved privately');
    const attempt = [...store.entries.values()].find(e => e.kind === 'attempts');
    assert.equal(attempt.team_id, null); assert.equal(attempt.data.puzzle_id, puzzle.id); assert.equal(attempt.data.choice_index, 0); assert.equal(attempt.data.reflection, literal);
    await noOverflow(page, `puzzles ${width}`);
    await f.go('#/practice/experiments');
    const experimentForm = page.locator('[data-experiment-editor] form'); await experimentForm.waitFor();
    const comparison = page.locator('[data-experiment-comparison]'); assert.match(await comparison.innerText(), /Not recorded|Not enough recorded data/);
    for (const [name, value] of Object.entries({ title: 'A comparable setup', hypothesis: 'A repeatable warmup may change the measured result.', change: literal, measure: 'Last hits per fixed window', unit: 'last hits', champion: 'Ashe', patch: '26.20' })) await field(experimentForm, name).fill(value);
    await field(experimentForm, 'role').selectOption('BOTTOM');
    for (const [phase, value] of [['baseline', '0'], ['practice', '4']]) {
      await keyboardClick(page.locator(`[data-add-observation="${phase}"]`));
      const row = page.locator('[data-observation]').last(); await field(row, 'observation_value').fill(value); await field(row, 'observation_context').fill(literal); await field(row, 'observation_adhered').check();
    }
    await keyboardClick(experimentForm.getByRole('button', { name: 'Save experiment', exact: true })); await status(page, 'Experiment saved');
    const experiment = [...store.entries.values()].find(e => e.kind === 'experiments');
    assert.deepEqual(experiment.data.observations.map(row => row.value), [0, 4]);
    assert.match(await comparison.innerText(), /4 last hits higher/); assert.match(await comparison.innerText(), /not a causal estimate/);
    const tableRegion = comparison.getByRole('region', { name: 'Baseline and practice numeric comparison' });
    await tableRegion.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await tableRegion.evaluate(el => document.activeElement === el), true, 'Numeric comparison is keyboard accessible without hover');
    const rows = await tableRegion.locator('tbody tr').allTextContents(); assert.match(rows[0], /Baseline/); assert.match(rows[1], /Practice/);
    await noOverflow(page, `experiments ${width}`); await screenshot(page, `experiments-${width}`);
    await page.reload({ waitUntil: 'load' }); await page.locator('[data-experiment-editor] form').waitFor();
    await keyboardClick(page.locator(`[data-experiment-list] [data-record-id="${experiment.id}"] > summary`));
    await keyboardClick(page.locator('[data-edit-experiment]'));
    assert.equal(await field(page.locator('[data-experiment-editor] form'), 'change').inputValue(), literal, 'Saved data survives a real browser reload');
    await f.expectDialog('confirm', /permanently delete this experiment/i, 'accept', () => keyboardClick(page.locator('[data-delete-experiment]')));
    await status(page, 'Experiment deleted');
    assert.equal(store.entries.has(experiment.id), false);
    const deletion = f.state.calls.find(c => c.method === 'DELETE');
    assert.equal(deletion.url.searchParams.get('revision'), '1'); assert.equal(deletion.raw, null);
    await f.clean();
  } finally { await f.close(); }
}

async function localVideoBytes(page) {
  // A real, tiny browser-generated WebM: metadata/playback are not faked. This is
  // intentionally different from the module tests' fake video and patched properties.
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(10), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    return await new Promise((resolve, reject) => {
      let frame = 0;
      const draw = setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#556677' : '#223344'; ctx.fillRect(0, 0, 64, 36); }, 70);
      const deadline = setTimeout(() => { clearInterval(draw); stream.getTracks().forEach(track => track.stop()); reject(Error('Timed out making local video fixture')); }, 3000);
      recorder.ondataavailable = event => chunks.push(event.data);
      recorder.onerror = event => { clearTimeout(deadline); clearInterval(draw); stream.getTracks().forEach(track => track.stop()); reject(Error(event.error?.message || 'Video fixture recording failed')); };
      recorder.onstop = async () => { clearTimeout(deadline); clearInterval(draw); stream.getTracks().forEach(track => track.stop()); resolve([...new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer())]); };
      recorder.start(); setTimeout(() => recorder.stop(), 450);
    });
  });
  assert(bytes.length > 100); return Buffer.from(bytes);
}
async function checkMatchesJourney(browser, width) {
  const f = await fixture(browser, { width }); const { page, store } = f; f.state.matchOptIn = true;
  try {
    await f.open('#/practice?role=MIDDLE'); const plan = await savePlan(f);
    assert.equal(f.state.calls.filter(call => store.matches.handles(call.url)).length, 0, 'Saving a plan never enrolls it or fetches match data');
    const tools = page.locator('[data-match-tools]'); await keyboardClick(tools.locator(':scope > summary'));
    assert.equal(f.state.calls.filter(call => store.matches.handles(call.url)).length, 0, 'Opening the fold-out remains request-free');
    await keyboardClick(page.locator('[data-load-matches]'));
    await page.waitForFunction(() => document.querySelector('[name="match_patch"]')?.options.length > 0 && !document.querySelector('[data-load-matches]').disabled);
    const form = page.locator('[data-match-form]');
    await field(form, 'match_role').selectOption('MIDDLE'); await field(form, 'match_champion').selectOption('22');
    await field(form, 'match_queue').selectOption('420'); await field(form, 'match_patch').selectOption('26.20');
    assert.equal(store.matches.links.size, 0, 'Options do not enroll the member');
    await f.expectDialog('confirm', /^Start observing subsequent completed cached matches/, 'accept', () => keyboardClick(page.locator('[data-start-tracking]')));
    await until(() => store.matches.links.has(plan.id), 'explicit match enrollment');
    await page.waitForFunction(() => !document.querySelector('[data-start-tracking]').disabled);
    const enrollment = f.state.calls.find(call => call.method === 'POST' && call.url.pathname.endsWith('/matches'));
    assert.deepEqual(enrollment.body, { revision: 1, role: 'MIDDLE', champion_id: 22, queue_id: 420, patch: '26.20' });
    assert.equal(store.entries.get(plan.id).revision, 2);
    await keyboardClick(page.locator('[data-load-matches]'));
    await page.locator('[data-match-comparison] table').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-load-matches]').disabled);
    assert.match(await page.locator('[data-match-comparison]').innerText(), /missing|not recorded|unavailable/i);
    assert.match(await page.locator('[data-match-window]').innerText(), /26\.20/);
    assert.equal(await field(page, 'review_scope').inputValue(), 'plan');
    await keyboardClick(page.locator('[data-load-queue]'));
    const link = page.locator('[data-review-queue] a[href^="#/practice/review?"]').first(); await link.waitFor();
    const queueCall = f.state.calls.find(call => call.url.pathname.endsWith('/review-queue'));
    assert.equal(queueCall.url.search, `?plan_id=${plan.id}`);
    const href = await link.getAttribute('href'), focus = new URL(href.slice(1), origin);
    assert.deepEqual(Object.fromEntries(focus.searchParams), { match: PROMPT.match_id, at: '0', prompt: PROMPT.id });
    await noOverflow(page, `match fold-out ${width}`);
    if (screenshotDirectory) await tools.screenshot({ path: path.join(screenshotDirectory, `match-progress-${width}.png`) });
    await keyboardClick(link); const review = page.locator('[data-review-form]'); await review.waitFor();
    assert.equal(await field(review, 'match_id').inputValue(), PROMPT.match_id);
    assert.equal(await page.locator('[data-moments] li').count(), 0);
    assert.equal(f.state.calls.filter(call => call.url.pathname.includes('/review-context/')).length, 0, 'Queue navigation never loads context or adds notes automatically');
    await field(review, 'title').fill('Review a cached decision'); await field(review, 'source_label').fill('My own recording');
    const beforeVideo = f.state.calls.length, buffer = await localVideoBytes(page);
    await page.locator('[data-video-file]').setInputFiles({ name: videoName, mimeType: 'video/webm', buffer });
    await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 1 && video.videoWidth === 64; });
    const blob = await page.locator('video').getAttribute('src'); assert.match(blob, /^blob:/); assert.equal(f.state.calls.length, beforeVideo);
    await field(page, 'seek').fill('0.1'); await keyboardClick(action(page, 'seek'));
    await page.waitForFunction(() => document.querySelector('video').currentTime >= .09);
    const anchor = await page.locator('video').evaluate(video => video.currentTime);
    await keyboardClick(page.locator('[data-clock-sync] > summary')); await field(page, 'anchor-seconds').fill('0'); await keyboardClick(action(page, 'align-clock'));
    await page.locator('[data-sync-status]').filter({ hasText: /aligned/i }).waitFor();
    await f.expectDialog('confirm', /Convert all 0 moment timestamps from Video clock to Match clock/i, 'accept', () => field(review, 'time_basis').selectOption('match'));
    assert.equal(await field(review, 'time_basis').inputValue(), 'match');
    await keyboardClick(page.locator('[data-review-context] > summary')); await keyboardClick(action(page, 'load-context'));
    await page.locator('[data-context-status]').filter({ hasText: 'context loaded' }).waitFor();
    const contextCall = f.state.calls.find(call => call.url.pathname.includes('/review-context/')); assert.equal(contextCall.url.pathname, `/api/training/review-context/${PROMPT.match_id}`); assert.equal(contextCall.url.search, '');
    assert.equal(await page.locator('[data-moments] li').count(), 0, 'Loading cached events alone does not create a moment');
    const requested = page.locator('[data-context-row][aria-current="true"]'); assert.equal(await requested.count(), 1);
    await keyboardClick(requested.locator('[data-action="context-jump"]'));
    assert(Math.abs(await page.locator('video').evaluate(video => video.currentTime) - anchor) < .05, 'A match-clock event seeks through the real local-video alignment');
    await keyboardClick(requested.locator('[data-action="context-moment"]'));
    assert.equal(await field(page, 'seconds').inputValue(), '0'); assert.equal(await field(page, 'moment-title').inputValue(), PROMPT.title);
    await field(page, 'known').fill('Only information visible before the decision'); await field(page, 'lesson').fill('Check the same information next time; timing is not causation.');
    await keyboardClick(review.locator('[type="submit"]')); await status(page, 'Review notes saved');
    const saved = [...store.entries.values()].find(row => row.kind === 'reviews');
    assert.deepEqual(Object.keys(saved.data).sort(), ['title', 'match_id', 'source_label', 'time_basis', 'moments'].sort());
    assert.equal(saved.data.time_basis, 'match'); assert.equal(saved.data.moments[0].seconds, 0); assert.equal(saved.data.moments[0].known, 'Only information visible before the decision');
    assert(!/NEVER-SEND|blob:|offset|calibration|filename|video_url/.test(JSON.stringify(saved.data)));
    assert.equal(f.state.calls.filter(call => call.method === 'POST' && call.url.pathname === '/api/training/entries/reviews').length, 1, 'Only the explicit Save review persists notes');
    await noOverflow(page, `cached review ${width}`); await screenshot(page, `synced-review-${width}`); await f.go('#/practice'); await page.locator('[data-plan-editor] form').waitFor({ state: 'attached' });
    assert(await page.evaluate(url => window.__trainingProbe.revoked.includes(url), blob), 'Leaving the review revokes the private local Blob');
    await f.clean();
  } finally { await f.close(); }
}

async function checkVideoAndDrafts(browser) {
  const f = await fixture(browser); const { page } = f;
  try {
    await f.open('#/practice/review'); await page.locator('[data-review-form]').waitFor();
    const before = f.state.calls.length, buffer = await localVideoBytes(page);
    await page.locator('[data-video-file]').setInputFiles({ name: videoName, mimeType: 'video/webm', buffer });
    await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 1 && video.videoWidth === 64; }, null, { timeout: TIMEOUT });
    const blob = await page.locator('video').getAttribute('src'); assert.match(blob, /^blob:/);
    assert.equal(f.state.calls.length, before, 'Selecting local video makes no API calls');
    assert.equal(await field(page.locator('[data-review-form]'), 'source_label').inputValue(), '');
    await page.locator('[data-stage]').focus(); await page.keyboard.press('m'); assert.equal(await page.locator('video').evaluate(video => video.muted), true);
    await keyboardClick(action(page, 'add-moment'));
    await field(page, 'moment-title').fill('A local review moment');
    await field(page, 'known').fill('Unsaved keyboard note');
    const hash = await page.evaluate(() => location.hash);
    await f.expectDialog('confirm', /unsaved.*changes|discard unsaved/i, 'dismiss', () => keyboardClick(page.locator('.training-head a[href="#/practice"]').first()));
    assert.equal(f.state.dialogs.length, 1, 'Leaving a dirty route asks once'); await f.settle();
    assert.equal(await page.evaluate(() => location.hash), hash); assert.equal(await field(page, 'known').inputValue(), 'Unsaved keyboard note');
    assert.match(f.state.dialogs[0].message, /unsaved|discard|leave/i);
    const liveReview = await page.locator('[data-review-form]').elementHandle(), assetsBeforeReload = f.state.assets.length;
    const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame(), timeout: 1000 })
      .then(() => true, error => { if (error.name === 'TimeoutError') return false; throw error; });
    // A dismissed native reload has no load/commit event to await. Trigger the
    // browser's real reload, dismiss beforeunload, and assert it never commits.
    await f.expectDialog('beforeunload', /.*/, 'dismiss', () => page.evaluate(() => { location.reload(); }));
    assert.equal(await navigation, false, 'Dismissing beforeunload cancels navigation');
    assert.equal(f.state.dialogs.length, 2, 'Reload asks exactly once');
    assert.equal(await liveReview.evaluate(el => el.isConnected), true, 'Dismissed reload preserves the original editor document');
    assert.equal(f.state.assets.length, assetsBeforeReload, 'Cancelled reload does not load a replacement page');
    assert.equal(await field(page, 'known').inputValue(), 'Unsaved keyboard note');
    await field(page.locator('[data-review-form]'), 'title').fill('Saved local notes');
    await keyboardClick(page.locator('[data-review-form] button[type="submit"]')); await status(page, 'Review notes saved');
    const saved = [...f.store.entries.values()].find(e => e.kind === 'reviews');
    assert(!JSON.stringify(saved).includes(videoName)); assert(!JSON.stringify(saved).includes('blob:'));
    // Keep the native element reference only in the test to inspect disposal, not app state.
    await page.evaluate(() => { window.__trainingProbe.detachedVideos.push(document.querySelector('video')); });
    await f.go('#/practice'); await page.locator('[data-plan-editor] form').waitFor();
    assert.equal(await page.evaluate(url => window.__trainingProbe.revoked.includes(url), blob), true, 'Route replacement revokes its Blob URL');
    assert.equal(await page.evaluate(() => window.__trainingProbe.detachedVideos[0].getAttribute('src')), null, 'Route replacement detaches private media');
    assert.equal(await page.evaluate(() => window.__trainingProbe.detachedVideos[0].paused), true);
    await f.go(`#/practice/review/${saved.id}?match=DIFFERENT`); await status(page, 'Saved review loaded');
    assert.equal(await field(page.locator('[data-review-form]'), 'match_id').inputValue(), '', 'Query prefill cannot overwrite a saved review');
    assert.equal(await page.locator('video').getAttribute('src'), null, 'Reloaded review never fetches or restores footage');
    assert.equal(await page.locator('[data-video-file]').evaluate(el => el.files.length), 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0, 'No member drafts or media are persisted in shared browser storage');
    await f.clean();
  } finally { await f.close(); }
}

async function checkAuthAndStale(browser) {
  const f = await fixture(browser, { user: null }); const { page, store } = f;
  try {
    await f.open('#/practice/review'); await page.locator('#login-form').waitFor();
    assert.equal(f.state.calls.filter(c => c.url.pathname.startsWith('/api/training')).length, 0, 'Unauthenticated deep links never request training data');
    await f.go('#/practice/lessons'); await f.settle(); assert.equal(await page.locator('.training').count(), 0);
    await login(f, 'alice'); await page.locator('[data-lesson-form]').waitFor();
    await f.go('#/practice'); await page.locator('[data-plan-editor] form').waitFor(); await savePlan(f, 'ALICE-ONLY-PRIVATE-FOCUS');
    const late = f.next('GET', '/api/training', null, true);
    await f.go('#/practice/review'); await late.hit();
    await keyboardClick(page.locator('#logout')); await page.locator('#login-form').waitFor();
    await late.release(); await f.settle();
    assert.equal(await page.locator('.training').count(), 0); assert(!(await page.locator('#app').innerText()).includes('ALICE-ONLY'));
    await login(f, 'bob'); await page.locator('[data-review-form]').waitFor();
    assert(!(await page.locator('#app').innerText()).includes('ALICE-ONLY'));
    const obsolete401 = f.next('GET', '/api/training', { status: 401, body: { detail: 'Not logged in' } }, true);
    await f.go('#/practice/experiments'); await obsolete401.hit();
    await f.go('#/practice/lessons'); await page.locator('[data-lesson-form]').waitFor();
    await obsolete401.release(); await f.settle();
    assert.equal(await page.locator('#login-form').count(), 0, 'Obsolete 401 cannot log out the current route');
    assert.equal(await page.locator('[data-lesson-form]').count(), 1);
    // A mutation may finish on the server after logout, but must not put Alice's/Bob's notes back in the DOM.
    await f.go('#/practice/review'); await page.locator('[data-review-form]').waitFor();
    await field(page.locator('[data-review-form]'), 'title').fill('BOB-LATE-PRIVATE-NOTE');
    const save = f.next('POST', '/api/training/entries/reviews', null, true);
    await keyboardClick(page.locator('[data-review-form] button[type="submit"]')); await save.hit();
    await f.expectDialog('confirm', /training save.*in progress.*server/i, 'accept', () => keyboardClick(page.locator('#logout')));
    await page.locator('#login-form').waitFor();
    await save.release(); await f.settle(); assert(!(await page.locator('#app').innerText()).includes('BOB-LATE'));
    await login(f, 'alice'); await page.locator('[data-review-form]').waitFor();
    assert(!(await page.locator('#app').innerText()).includes('BOB-LATE'));
    f.next('GET', '/api/training', { status: 401, body: { detail: 'Not logged in' } });
    await f.go('#/practice/lessons'); await page.locator('#login-form').waitFor();
    assert.equal(await page.locator('.training').count(), 0, 'Current 401 clears private workspace');
    assert.equal([...store.entries.values()].filter(e => e.owner === 'alice').length, 1, 'Changing member cannot mutate the previous member records');
    await f.clean();
  } finally { await f.close(); }
}

async function checkFailuresAndAliases(browser) {
  const f = await fixture(browser); const { page } = f;
  try {
    await f.open('#/practice/lasthit'); await page.locator('[data-plan-editor] form').waitFor();
    assert.equal(await field(page.locator('[data-plan-editor] form'), 'workout_id').inputValue(), 'last-hit');
    await f.go('#/practice/dodge'); await page.locator('[data-plan-editor] form').waitFor();
    assert.equal(await field(page.locator('[data-plan-editor] form'), 'workout_id').inputValue(), 'trading-window');
    await f.go('#/practice'); await page.locator('[data-plan-editor] form').waitFor(); const plan = await savePlan(f);
    const form = page.locator('[data-plan-editor] form');
    await field(form, 'focus').fill('Keep this failed-save draft');
    f.next('PUT', `/api/training/entries/plans/${plan.id}`, { status: 409, body: { detail: 'This entry changed. Reload it before saving or deleting.' } });
    await keyboardClick(form.getByRole('button', { name: 'Save plan changes' })); await status(page, 'This record changed in another window.');
    assert.equal(await field(form, 'focus').inputValue(), 'Keep this failed-save draft'); assert.equal(plan.revision, 1);
    assert.equal(f.state.calls.filter(c => c.method === 'PUT').length, 1, 'Conflict never silently retries');
    await f.expectDialog('confirm', /unsaved.*changes|discard unsaved/i, 'dismiss', () => keyboardClick(page.getByRole('button', { name: 'Reload saved data', exact: true })));
    assert.equal(f.state.dialogs.length, 1, 'Explicit reload asks once before replacing unsaved text');
    assert.equal(await field(form, 'focus').inputValue(), 'Keep this failed-save draft');
    await keyboardClick(form.getByRole('button', { name: 'Save plan changes' })); await status(page, 'Weekly plan saved');
    await f.go('#/practice/not-a-section'); await page.getByRole('link', { name: 'Return to your training focus' }).waitFor();
    await keyboardClick(page.getByRole('link', { name: 'Return to your training focus' }));
    await page.locator('[data-plan-editor] form').waitFor({ state: 'attached' });
    await keyboardClick(page.locator('[data-plan-details] summary')); await page.locator('[data-plan-editor] form').waitFor();
    assert.equal(await field(page.locator('[data-plan-editor] form'), 'focus').inputValue(), 'Keep this failed-save draft');
    await f.clean();
  } finally { await f.close(); }
}

async function checkTeams(browser, width) {
  const store = new FixtureStore();
  const alice = await fixture(browser, { width, store }), bob = await fixture(browser, { width, store, user: 'bob' });
  try {
    const page = alice.page;
    await alice.open('#/practice/team'); const create = page.locator('[data-form="create"]'); await create.waitFor();
    await field(create, 'name').fill(literal); await keyboardClick(create.getByRole('button', { name: 'Create private team' })); await status(page, 'Private team created');
    const team = [...store.teams.values()][0];
    await keyboardClick(page.locator(`[data-teams] a[href="#/practice/team/${team.id}"]`)); await page.locator('[data-members]').waitFor({ state: 'attached' });
    await keyboardClick(page.getByText('Members and invitations', { exact: true }));
    const invite = page.locator('[data-form="invite"]'); await field(invite, 'username').fill('bob');
    await keyboardClick(invite.getByRole('button', { name: 'Send private invitation' })); await status(page, 'Invitation sent');
    // Invitation alone must not authorize team documents. Use an actual second member/session.
    assert.throws(() => store.member(team.id, 'bob'), error => error.status === 404);
    await bob.open('#/practice/team'); await bob.page.locator('[data-invites]').waitFor();
    assert((await bob.page.locator('[data-invites]').innerText()).includes(literal));
    assert.equal(await bob.page.locator('[data-members], [data-editor]').count(), 0, 'Pending invite exposes no roster or board');
    await keyboardClick(action(bob.page, 'accept')); await status(bob.page, 'Invitation accepted');
    assert.equal(store.member(team.id, 'bob').members.find(m => m.username === 'bob').status, 'active');
    await keyboardClick(action(page, 'new').filter({ hasText: 'New team strategy board' }));
    const boardForm = page.locator('[data-form="document"]'); await boardForm.waitFor();
    await field(boardForm, 'title').fill('A shared setup'); await field(boardForm, 'notes').fill(literal);
    await keyboardClick(action(page, 'add-mark'));
    const row = page.locator('[data-marks] tr').first(); await field(row, 'x').fill('0'); await field(row, 'y').fill('1'); await field(row, 'label').fill(literal);
    await keyboardClick(boardForm.getByRole('button', { name: 'Save team strategy board' })); await status(page, /saved/i);
    const board = [...store.entries.values()].find(e => e.kind === 'boards'); assert.equal(board.team_id, team.id); assert.equal(board.data.marks[0].x, 0); assert.equal(board.data.marks[0].y, 1);
    await noOverflow(page, `team board ${width}`); await screenshot(page, `team-${width}`);
    await keyboardClick(bob.page.locator(`[data-teams] a[href="#/practice/team/${team.id}"]`));
    await keyboardClick(action(bob.page, 'open').filter({ hasText: 'A shared setup' }));
    const bobForm = bob.page.locator('[data-form="document"]'); await bobForm.waitFor();
    assert.equal(await field(bobForm, 'notes').inputValue(), literal);
    const coordinates = bob.page.getByRole('region', { name: 'Editable annotation coordinates; scroll horizontally for all controls' }); await coordinates.focus(); await bob.page.keyboard.press('ArrowRight');
    assert.equal(await coordinates.evaluate(el => document.activeElement === el), true);
    await field(bob.page.locator('[data-marks] tr').first(), 'x').fill('0.25');
    await keyboardClick(bobForm.getByRole('button', { name: 'Save team strategy board' })); await status(bob.page, /saved/i);
    assert.equal(store.entries.get(board.id).revision, 2); assert.equal(store.entries.get(board.id).owner, 'alice', 'Shared editing never changes ownership');
    assert.equal(store.entries.get(board.id).data.marks[0].x, 0.25);
    assert.equal(store.workspace('bob').entries.boards.length, 0, 'Team documents never become personal bootstrap records');
    await noOverflow(bob.page, `accepted teammate board ${width}`);
    await alice.clean(); await bob.clean();
  } finally { await alice.close(); await bob.close(); }
}

async function checkLab(browser, width) {
  const f = await fixture(browser, { width });
  const page = f.page, labAction = name => page.locator(`[data-lab-action="${name}"]`);
  const boards = () => [...f.store.entries.values()].filter(e => e.kind === 'boards' && e.owner === 'alice');
  try {
    await f.open('#/practice/lab');
    const form = page.locator('[data-lab-form]'); await form.waitFor();
    assert.equal(f.state.calls.length, 3, 'Opening the lab loads only the session, metadata and training bootstrap');
    assert.match(await page.locator('[data-training-content]').innerText(), /not a live assistant or a simulated game/);

    // Build a board with the keyboard only: add a mark, label it, move it with arrows.
    await field(form, 'title').fill(literal);
    await field(form, 'notes').fill('Patch 16.20 · assumes bot has priority');
    await keyboardClick(page.locator('[data-lab-action="add-mark"]'));
    const mark = page.locator('[data-lab-mark]').first(); await mark.waitFor();
    await field(mark, 'label').fill('Ward river entrance');
    await field(mark, 'kind').selectOption('ward');
    const before = Number(await field(mark, 'x').inputValue());
    const svg = page.locator('[data-lab-diagram] svg'); await svg.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    assert(await svg.evaluate(el => document.activeElement === el), 'Moving a mark keeps keyboard focus on the diagram');
    assert(Math.abs(Number(await field(mark, 'x').inputValue()) - (before + 1)) < 1e-6, 'Arrow moves the mark 1%');
    assert(Math.abs(Number(await field(mark, 'y').inputValue()) - 55) < 1e-6, 'Shift+arrow moves the mark 5%');
    assert.match(await svg.innerHTML(), /Ward river entrance/);

    // Leaving with an unsaved board asks first; cancelling keeps every input.
    await f.expectDialog('confirm', /discard unsaved changes/i, 'dismiss', () => page.evaluate(() => { location.hash = '#/practice'; }));
    await f.settle();
    assert.equal(await page.evaluate(() => location.hash), '#/practice/lab');
    assert.equal(await field(form, 'title').inputValue(), literal);

    await keyboardClick(form.getByRole('button', { name: 'Save personal board', exact: true }));
    await page.locator('[data-lab-status]').filter({ hasText: 'Personal strategy board saved' }).waitFor();
    assert.equal(boards().length, 1);
    const saved = boards()[0];
    assert.equal(saved.data.title, literal);
    assert.equal(saved.data.marks[0].kind, 'ward');
    assert.deepEqual(Object.keys(saved.data).sort(), ['marks', 'notes', 'title'], 'Only the board itself is stored');
    assert.match(await page.locator('[data-lab-list]').innerText(), /revision 1/);
    assert.equal(await page.evaluate(() => Training.canLeave()), true, 'A saved board is not dirty');

    // An edit saves with the current revision; a stale revision keeps the edit and explains the conflict.
    await field(page.locator('[data-lab-form]'), 'notes').fill('Second thought');
    await keyboardClick(page.getByRole('button', { name: 'Save board changes', exact: true }));
    await page.locator('[data-lab-status]').filter({ hasText: 'Personal strategy board saved' }).waitFor();
    assert.equal(boards()[0].revision, 2);
    assert.equal(f.state.calls.filter(c => c.method === 'PUT').at(-1).body.revision, 1);
    f.store.entries.get(saved.id).revision = 7; // changed in another window
    await field(page.locator('[data-lab-form]'), 'notes').fill('Conflicting edit');
    await keyboardClick(page.getByRole('button', { name: 'Save board changes', exact: true }));
    await page.locator('[data-lab-status]').filter({ hasText: '409' }).waitFor();
    assert.equal(await field(page.locator('[data-lab-form]'), 'notes').inputValue(), 'Conflicting edit', 'A conflict never discards the edit');
    assert.equal(f.store.entries.get(saved.id).data.notes, 'Second thought', 'Nothing was overwritten');

    // Calculator: numbers only from the entered assumptions; an empty input is not zero.
    await page.locator('summary', { hasText: 'Mechanics calculations' }).click();
    const results = page.locator('[data-calc-results]');
    assert.match(await results.innerText(), /Damage per hit\s+66\.67\s+50/);
    assert.match(await results.innerText(), /Cooldown \(seconds\)\s+10\s+7\.69/);
    await page.locator('[data-calc-inputs] [name="armorB"]').fill('');
    assert.match(await page.locator('[data-calc-takeaway]').innerText(), /empty value is not zero/);
    assert.match(await results.innerText(), /No supported comparison/);
    await noOverflow(page, `strategy lab ${width}px`);
    await screenshot(page, `lab-${width}`);
    assert.equal(f.state.calls.filter(c => !c.url.pathname.startsWith('/api/training') && !['/api/me', '/api/meta'].includes(c.url.pathname)).length, 0);
    await f.clean();
  } finally { await f.close(); }
}

async function checkLabSharing(browser) {
  const store = new FixtureStore();
  const team = store.handle({ method: 'POST', url: new URL(`${origin}/api/training/teams`), body: { name: 'Duo' }, raw: '{"name":"Duo"}', headers: { 'content-type': 'application/json', origin }, user: 'alice' }).team;
  const f = await fixture(browser, { store });
  try {
    await f.open('#/practice/lab');
    const form = f.page.locator('[data-lab-form]'); await form.waitFor();
    await field(form, 'title').fill('Shared setup');
    await keyboardClick(form.getByRole('button', { name: 'Save personal board', exact: true }));
    await f.page.locator('[data-lab-status]').filter({ hasText: 'Personal strategy board saved' }).waitFor();
    await f.page.locator('summary', { hasText: 'Copy this saved board' }).click();
    await f.page.locator('[data-lab-team]').selectOption(team.id);
    await f.expectDialog('confirm', /Copy this saved board/, 'accept', () => keyboardClick(f.page.locator('[data-lab-action="share"]')));
    await f.page.locator('[data-lab-status]').filter({ hasText: 'Your original remains private' }).waitFor();
    const all = [...store.entries.values()].filter(e => e.kind === 'boards');
    assert.equal(all.length, 2, 'Sharing makes a copy');
    assert.equal(all.filter(e => e.team_id === team.id).length, 1);
    assert.equal(all.filter(e => e.team_id === null).length, 1, 'The original stays personal');
    assert.equal(await f.page.locator('[data-lab-list] li').count(), 1, 'The team copy never enters the personal list');
    await f.clean();
  } finally { await f.close(); }
}

(async () => {
  checkFixtureContract(); console.log('ok - strict in-memory API fixture contract');
  const browserType = playwright[process.env.BROWSER || 'chromium'];
  assert(browserType, 'Unknown BROWSER');
  const browser = await browserType.launch({ headless: true, timeout: 15000, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const failures = [];
  const selected = process.env.TRAINING_CASE ? new RegExp(process.env.TRAINING_CASE, 'i') : null;
  let ran = 0;
  async function run(label, check) {
    if (selected && !selected.test(label)) return;
    ran++;
    try { await bounded(check(), CASE_TIMEOUT, label); console.log(`ok - ${label}`); }
    catch (error) {
      failures.push(label); console.error(`not ok - ${label}\n${error.stack}`);
      for (const f of activeFixtures) {
        if (f.state.unexpected.length || f.state.errors.length) console.error(JSON.stringify({ unexpected: f.state.unexpected, errors: f.state.errors }, null, 2));
        await screenshot(f.page, `failure-${failures.length}`).catch(() => {});
      }
    } finally { await Promise.all([...activeFixtures].map(f => f.close().catch(() => {}))); }
  }
  try {
    await run('real index routing, load order and no simulator', () => checkLoadOrder(browser));
    for (const width of [320, 375, 768, 1280]) await run(`member training journey and responsive layout ${width}px`, () => checkJourney(browser, width));
    for (const width of [320, 1280]) await run(`cached matches enrollment, review queue and aligned real Blob journey ${width}px`, () => checkMatchesJourney(browser, width));
        await run('real Blob video CSP, keyboard, unsaved route/reload and disposal', () => checkVideoAndDrafts(browser));
    await run('authentication, current/obsolete 401 and late logout responses', () => checkAuthAndStale(browser));
    await run('legacy route aliases, conflict preservation and explicit reload guard', () => checkFailuresAndAliases(browser));
    for (const width of [320, 1280]) await run(`two-member invite/accept and keyboard board ${width}px`, () => checkTeams(browser, width));
    for (const width of [320, 1280]) await run(`strategy lab board, keyboard, conflict and calculator ${width}px`, () => checkLab(browser, width));
    await run('strategy lab copies a saved board to a team', () => checkLabSharing(browser));
  } finally { await browser.close(); }
  assert(ran > 0, 'TRAINING_CASE did not match any checks');
  if (screenshotDirectory) console.log(`Screenshots: ${screenshotDirectory}`);
  if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exitCode = 1; }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
