/* Training workspace boundary (TRAINING_CONTRACT.md): this file owns only the
 * member-local route lifecycle, window.Training/context, hub and experiments.
 * app.js owns auth/router: call Training.canLeave() BEFORE replacing a route,
 * Training.dispose() on route/login replacement, then showTraining() after DOM ready.
 * Load before training-review/team/lab.js; extras register(name, (root, ctx) => ...).
 * No requests at script load, Riot access, localStorage drafts, styles or router hooks.
 * ctx.bootstrap is a live getter; refresh() updates data, NEVER an editor's DOM.
 * Every async renderer must check ctx.current() before touching DOM and register
 * listeners/media cleanup with ctx.cleanup(fn). Native form submissions calling
 * ctx.save synchronously are marked saved automatically; async/multi-step editors
 * can use the additive ctx.markSaved(form) after their whole save succeeds.
 * ctx.guardDirty(predicate) adds canvas/out-of-form drafts to canLeave(); it returns
 * an unregister function and is also released on dispose. Do not add router hooks.
 * Explicit reload discards drafts only after confirmation. 409 never retries a PUT.
 */
(() => {
  'use strict';
  const kinds = ['plans', 'sessions', 'reviews', 'lessons', 'puzzles', 'attempts', 'experiments', 'boards'];
  const roleNames = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
  const renderers = new Map();
  const list = (value) => Array.isArray(value) ? value : [];
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const E = (value) => typeof esc === 'function' ? esc(value ?? '') : escapeHTML(value);
  const number = (value) => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : 'Not recorded';
  const dateTime = (seconds) => finite(seconds) ? new Date(seconds * 1000).toLocaleString() : 'Date not recorded';
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const newId = () => globalThis.crypto?.randomUUID?.() || `obs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const field = (label, html) => `<label>${E(label)}${html}</label>`;
  const input = (name, value = '', attrs = '') => `<input name="${E(name)}" value="${E(value)}" ${attrs}>`;
  const prose = (name, value = '', attrs = '') => `<textarea name="${E(name)}" maxlength="4000" rows="3" ${attrs}>${E(value)}</textarea>`;
  const options = (items, selected) => items.map(([value, label]) => `<option value="${E(value)}"${value === selected ? ' selected' : ''}>${E(label)}</option>`).join('');
  const roles = (selected) => {
    const items = [['', 'Any / not recorded'], ...Object.entries(roleNames)];
    if (selected && !Object.hasOwn(roleNames, selected)) items.push([selected, selected]);
    return `<select name="role">${options(items, selected)}</select>`;
  };
  const action = (label, attrs = '') => `<button type="button" class="btn ghost" ${attrs}>${E(label)}</button>`;
  const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let active = null;

  function parseRoute(hash) {
    const [path, ...query] = String(hash || '#/practice').replace(/^#/, '').split('?');
    const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
    let section = parts[1] || '', id = '';
    try { id = decodeURIComponent(parts[2] || ''); } catch (_) { section = 'unknown'; }
    let workout = '';
    if (section === 'lasthit' || section === 'dodge') {
      workout = section === 'lasthit' ? 'last-hit' : 'trading-window';
      section = '';
    }
    if (parts[0] !== 'practice' || parts.length > 3 || (id && !['review', 'team'].includes(section))) section = 'unknown';
    return { section, id, params: new URLSearchParams(query.join('?')), workout };
  }

  function summarizeExperiment(observations) {
    const group = (phase) => {
      const rows = list(observations).filter((row) => row.phase === phase);
      const values = rows.map((row) => row.value).filter(finite);
      return { count: values.length, missing: rows.length - values.length,
        mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        adhered: rows.filter((row) => row.adhered === true).length, total: rows.length };
    };
    const baseline = group('baseline'), practice = group('practice');
    return { baseline, practice, difference: baseline.mean === null || practice.mean === null ? null : practice.mean - baseline.mean };
  }

  function summarizeSessions(entries) {
    const rows = list(entries), values = rows.map((entry) => entry.data?.result).filter(finite);
    return { count: rows.length, measured: values.length, missing: rows.length - values.length,
      minutes: rows.reduce((sum, entry) => sum + (finite(entry.data?.minutes) ? entry.data.minutes : 0), 0) };
  }

  function member() {
    return typeof ME !== 'undefined' ? ME?.username || '' : globalThis.ME?.username || '';
  }
  const navigation = () => typeof nav !== 'undefined' ? nav : null;
  function staleError() {
    const error = new Error('This training page is no longer current.');
    error.name = 'AbortError';
    return error;
  }
  function failure(error) {
    const message = error?.message || '';
    if (/storage|capacity|limit reached|revision limit/i.test(message)) {
      return `${message} Your text has been kept. Export personal data and manage older records before retrying; nothing was overwritten.`;
    }
    if (error?.status === 409 || error?.statusCode === 409 || /409|revision|conflict|stale|entry changed|changed since|out.of.date/i.test(message)) {
      return 'This record changed in another window. Your text is still here. Use “Reload saved data” to get the latest version; copy any notes you want to keep first. Nothing was overwritten.';
    }
    return `${error?.message || 'The request failed.'} Your entered text has been kept. Retry when ready; if a save may have reached the server, reload saved data before creating a duplicate.`;
  }
  function formSnapshot(form) {
    return JSON.stringify([...form.elements].filter((el) => el.name && !['submit', 'button', 'reset'].includes(el.type))
      .map((el) => [el.name, el.type, el.value, ['checkbox', 'radio'].includes(el.type) ? el.checked : null]));
  }
  function watchForm(state, form) {
    if (!state.forms.has(form)) state.forms.set(form, formSnapshot(form));
    return form;
  }
  function dirty(state, form) {
    return state.forms.has(form) && state.forms.get(form) !== formSnapshot(form);
  }
  function hasDrafts(state) {
    return [...state.forms.keys()].some((form) => form.isConnected && dirty(state, form))
      || [...state.dirtyChecks].some((check) => { try { return !!check(); } catch (_) { return true; } });
  }
  function markSaved(state, form, snapshot) {
    if (form && state.forms.has(form)) state.forms.set(form, snapshot ?? formSnapshot(form));
  }
  function confirmDiscard(state, form = null) {
    if (form && state.savingForms.has(form)) {
      state.ctx.status('Wait for this editor’s current save or deletion to finish before switching records. Your inputs are still editable.');
      return false;
    }
    if (!state.current() || (!form ? !hasDrafts(state) : !dirty(state, form))) return state.current();
    return window.confirm('Discard unsaved training changes? Saved records will not be deleted.');
  }
  function canLeave() {
    const state = active;
    if (!state || state.disposed || member() !== state.username || !state.root.isConnected) return true;
    if (!hasDrafts(state) && !state.pending) return true;
    return window.confirm(state.pending
      ? 'A training save is still in progress and may finish on the server. Leave this page? Unsaved changes will be lost.'
      : 'Leave training and discard unsaved changes? Choose Cancel to keep editing.');
  }
  function dispose() {
    const state = active;
    if (!state) return;
    active = null;
    state.disposed = true;
    state.controller.abort();
    state.cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch (_) { /* Continue releasing the remaining resources. */ } });
    state.root.querySelectorAll('video, audio').forEach((media) => {
      media.pause();
      media.removeAttribute('src');
      media.querySelectorAll('source').forEach((source) => source.removeAttribute('src'));
      media.load();
    });
    state.forms.clear();
    state.savingForms.clear();
    state.dirtyChecks.clear();
    state.deletedPlans.clear();
    state.bootstrap = null;
  }
  function on(state, target, type, listener, options) {
    target.addEventListener(type, listener, options);
    state.cleanups.push(() => target.removeEventListener(type, listener, options));
  }
  function normalizeBootstrap(payload) {
    const result = { ...payload, catalog: payload?.catalog || {}, entries: {}, teams: list(payload?.teams), invitations: list(payload?.invitations), limits: payload?.limits || {} };
    kinds.forEach((kind) => { result.entries[kind] = list(payload?.entries?.[kind]).filter((entry) => entry.team_id == null); });
    return result;
  }
  function replaceList(root, html) {
    const open = new Set([...root.querySelectorAll('details[open][data-record-id]')].map((node) => node.dataset.recordId));
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const recordId = focused?.closest('[data-record-id]')?.dataset.recordId;
    const index = focused && recordId ? [...focused.closest('[data-record-id]').querySelectorAll('summary, button, [tabindex]')].indexOf(focused) : -1;
    root.innerHTML = html;
    root.querySelectorAll('details[data-record-id]').forEach((node) => { node.open = open.has(node.dataset.recordId); });
    if (recordId && index >= 0) {
      const record = [...root.querySelectorAll('[data-record-id]')].find((node) => node.dataset.recordId === recordId);
      record?.querySelectorAll('summary, button, [tabindex]')[index]?.focus({ preventScroll: true });
    }
  }
  function mergeEntry(bootstrap, entry) {
    if (entry.team_id != null) return;
    const rows = bootstrap.entries[entry.kind];
    if (!rows) return;
    const index = rows.findIndex((row) => row.id === entry.id);
    if (index < 0) rows.unshift(entry);
    else if (!(rows[index].revision > entry.revision)) rows[index] = entry;
  }
  function mergePage(bootstrap, kind, entries) {
    list(entries).forEach((entry) => {
      if (entry.kind === kind && entry.team_id == null) mergeEntry(bootstrap, entry);
    });
  }
  function createContext(state, parsed) {
    const current = state.current;
    async function request(path, opts = {}) {
      if (!current()) throw staleError();
      const destination = new URL(path, 'https://training.invalid');
      if (!String(path).startsWith('/api/training') || destination.origin !== 'https://training.invalid' || !/^\/api\/training(?:\/|$)/.test(destination.pathname)) {
        throw new Error('Training requests must stay inside /api/training.');
      }
      const mutation = !['GET', 'HEAD'].includes((opts.method || 'GET').toUpperCase());
      if (mutation) { state.pending++; state.writeEpoch = (state.writeEpoch || 0) + 1; }
      try {
        const caller = typeof api === 'function' ? api : window.api;
        if (typeof caller !== 'function') throw new Error('The application API is unavailable.');
        const payload = await caller(path, { ...opts, signal: opts.signal || state.controller.signal }, current);
        if (!current()) throw staleError();
        return payload;
      } finally {
        if (mutation) { state.pending--; state.writeEpoch++; }
      }
    }
    async function refresh() {
      if (state.pending) throw new Error('Wait for the current training save to finish before refreshing saved data.');
      const sequence = ++state.refreshSequence, epoch = state.writeEpoch || 0;
      const payload = await request('/api/training');
      if (!current() || sequence !== state.refreshSequence || epoch !== (state.writeEpoch || 0)) throw staleError();
      state.bootstrap = normalizeBootstrap(payload);
      state.historyWarning = '';
      return state.bootstrap;
    }
    async function save(kind, data, existing = null, teamId = null) {
      if (!kinds.includes(kind) || (existing && existing.kind !== kind)) throw new Error('Unknown training record kind.');
      if (existing && (!Number.isSafeInteger(existing.revision) || existing.revision < 1)) throw new Error('Reload saved data before editing this record: its revision is missing.');
      const submitted = state.submitting;
      const snapshot = submitted ? formSnapshot(submitted) : null;
      const path = `/api/training/entries/${kind}${existing ? `/${encodeURIComponent(existing.id)}` : ''}`;
      const payload = await request(path, jsonOptions(existing ? 'PUT' : 'POST', existing
        ? { data, revision: existing.revision } : { data, team_id: teamId }));
      if (!current()) throw staleError();
      if (!payload.entry || payload.entry.kind !== kind) throw new Error('The server did not return the saved record. Reload saved data before retrying.');
      mergeEntry(state.bootstrap, payload.entry);
      // Activating a plan archives its predecessor server-side (including its revision).
      // Read the affected list only; do not redraw or reset any open editor.
      if (kind === 'plans' && data.status === 'active') {
        try {
          // Lists are ordered by creation, not update time: the archived predecessor
          // may be older than the first page even though its revision just changed.
          const unresolved = new Set(state.bootstrap.entries.plans.filter((entry) => entry.id !== payload.entry.id && entry.data.status === 'active').map((entry) => entry.id));
          let offset = 0;
          do {
            const plans = await request(`/api/training/entries/plans?offset=${offset}&limit=50`);
            if (!current()) throw staleError();
            mergePage(state.bootstrap, 'plans', plans.entries);
            list(plans.entries).forEach((entry) => unresolved.delete(entry.id));
            offset += list(plans.entries).length;
            if (!plans.has_more || !list(plans.entries).length) break;
          } while (unresolved.size && offset < 200);
          // A predecessor deleted in another window is no longer editable either.
          state.bootstrap.entries.plans = state.bootstrap.entries.plans.filter((entry) => !unresolved.has(entry.id));
        } catch (error) {
          if (!current()) throw error;
          state.historyWarning = 'The plan was saved, but archived plan revisions could not be reloaded. Reload saved data before editing older plans.';
          state.bootstrap.entries.plans = state.bootstrap.entries.plans.filter((entry) => entry.id === payload.entry.id || entry.data.status !== 'active');
          status(state.historyWarning, true);
        }
      }
      if (submitted) markSaved(state, submitted, snapshot);
      return payload.entry;
    }
    async function remove(entry) {
      if (!entry || !kinds.includes(entry.kind) || !Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error('Reload saved data before deleting: its revision is missing.');
      await request(`/api/training/entries/${entry.kind}/${encodeURIComponent(entry.id)}?revision=${entry.revision}`, { method: 'DELETE' });
      if (!current()) throw staleError();
      state.bootstrap.entries[entry.kind] = state.bootstrap.entries[entry.kind].filter((row) => row.id !== entry.id);
    }
    function status(message = '', error = false) {
      if (!current()) return;
      const el = state.root.querySelector('[data-training-status]');
      el.textContent = [message, state.historyWarning && message !== state.historyWarning ? state.historyWarning : ''].filter(Boolean).join(' ');
      el.classList.toggle('error', error);
    }
    return { current, request, get bootstrap() { return state.bootstrap; }, section: parsed.section, id: parsed.id,
      params: parsed.params, cleanup(fn) {
        if (typeof fn !== 'function') return;
        if (state.disposed) fn();
        else state.cleanups.push(fn);
      }, refresh, status, save, remove,
      markSaved(form) { if (current()) markSaved(state, form); },
      guardDirty(check) {
        if (typeof check !== 'function') throw new TypeError('A dirty guard must be a function.');
        if (!current()) return () => {};
        state.dirtyChecks.add(check);
        return () => state.dirtyChecks.delete(check);
      } };
  }

  function installDraftGuard(state) {
    const scan = () => {
      state.forms.forEach((_, form) => { if (!form.isConnected) state.forms.delete(form); });
      state.root.querySelectorAll('form').forEach((form) => watchForm(state, form));
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(state.root, { childList: true, subtree: true });
    state.cleanups.push(() => observer.disconnect());
    on(state, state.root, 'input', (event) => {
      if (!state.current()) return;
      const form = event.target.closest?.('form');
      if (form && !state.forms.has(form)) state.forms.set(form, 'untracked input');
    }, true);
    on(state, state.root, 'change', (event) => {
      if (!state.current()) return;
      const form = event.target.closest?.('form');
      if (form && !state.forms.has(form)) state.forms.set(form, 'untracked input');
    }, true);
    on(state, state.root, 'submit', (event) => {
      if (!state.current()) return;
      const form = event.target;
      state.submitting = form;
      queueMicrotask(() => { if (state.submitting === form) state.submitting = null; });
    }, true);
    on(state, window, 'beforeunload', (event) => {
      if (member() !== state.username || (!hasDrafts(state) && !state.pending)) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  async function showTraining() {
    dispose();
    const app = document.querySelector('#app');
    if (!app || !member()) return;
    const parsed = parseRoute(location.hash), root = document.createElement('section');
    root.className = 'training';
    root.innerHTML = `<header class="training-head"><p><a href="#/practice">Training workspace</a></p>
      <h1>${parsed.section === 'experiments' ? 'Practice experiments' : parsed.section ? E(({ review: 'Match review', lessons: 'Lessons', puzzles: 'Decision puzzles', team: 'Team workspace', lab: 'Strategy lab' })[parsed.section] || 'Training') : 'One focus. Deliberate practice.'}</h1>
      <p class="training-muted">Private member notes · manual practice inside League · no Riot fetching or live advice.</p></header>
      <p class="training-status" data-training-status role="status" aria-live="polite" aria-atomic="true">Loading saved training data…</p>
      <div data-training-content></div>`;
    app.replaceChildren(root);
    const state = { root, username: member(), hash: location.hash, navigation: navigation(), controller: new AbortController(),
      cleanups: [], forms: new Map(), savingForms: new Set(), dirtyChecks: new Set(), deletedPlans: new Set(), pending: 0, disposed: false, bootstrap: null, refreshSequence: 0, submitting: null };
    active = state;
    state.current = () => active === state && !state.disposed && root.isConnected && root.parentElement === app
      && member() === state.username && location.hash === state.hash && navigation() === state.navigation;
    const ctx = createContext(state, parsed), content = root.querySelector('[data-training-content]');
    state.ctx = ctx;
    installDraftGuard(state);
    try {
      await ctx.refresh();
      if (!ctx.current()) return;
      // An old plan can remain active while newer archived plans push it beyond
      // bootstrap's newest-50 window. Resolve it before saying no plan is saved.
      if (!parsed.section && !ctx.bootstrap.entries.plans.some((entry) => entry.data.status === 'active')) {
        let offset = ctx.bootstrap.entries.plans.length;
        let more = ctx.bootstrap.limits.has_more?.plans ?? offset === 50;
        while (more && offset < 200) {
          const page = await ctx.request(`/api/training/entries/plans?offset=${offset}&limit=50`);
          if (!ctx.current()) return;
          mergePage(ctx.bootstrap, 'plans', page.entries);
          offset += list(page.entries).length;
          more = !!page.has_more && list(page.entries).length > 0;
          if (list(page.entries).some((entry) => entry.data.status === 'active')) break;
        }
      }
      ctx.status('');
      if (!parsed.section) renderHub(content, ctx, state, parsed);
      else if (parsed.section === 'experiments') renderExperiments(content, ctx, state);
      else if (renderers.has(parsed.section)) await renderers.get(parsed.section)(content, ctx);
      else {
        content.innerHTML = '<section class="training-card"><h2>This section could not be opened</h2><p>Check the address or reload the page to load the training tools.</p><a href="#/practice">Return to your training focus</a></section>';
      }
      if (!ctx.current()) return;
      content.querySelectorAll('form').forEach((form) => watchForm(state, form));
    } catch (error) {
      if (!ctx.current()) return;
      ctx.status(error.message || 'Training could not load.', true);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = 'Retry loading training';
      content.append(retry);
      on(state, retry, 'click', () => { if (canLeave()) showTraining(); });
    }
  }

  function bindReload(state, button) {
    on(state, button, 'click', () => {
      if (!state.current() || !canLeave()) return;
      showTraining();
    });
  }
  function bindSubmit(state, form, save, done) {
    watchForm(state, form);
    let busy = false;
    on(state, form, 'submit', async (event) => {
      event.preventDefault();
      if (!state.current() || busy || state.savingForms.has(form) || !form.reportValidity()) return;
      busy = true;
      state.savingForms.add(form);
      const button = event.submitter || form.querySelector('[type="submit"]');
      const snapshot = formSnapshot(form);
      const focused = document.activeElement === button;
      if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
      try {
        const result = await save();
        if (!state.current() || !form.isConnected) return;
        markSaved(state, form, snapshot);
        done?.(result);
        if (dirty(state, form)) state.ctx.status('Submitted values saved. New edits made while waiting are not saved yet; choose Save again to keep them.');
      } catch (error) {
        if (state.current()) state.ctx.status(failure(error), true);
      } finally {
        busy = false;
        state.savingForms.delete(form);
        if (state.current() && button?.isConnected) {
          button.disabled = false;
          button.removeAttribute('aria-busy');
          if (focused && document.activeElement === document.body) button.focus({ preventScroll: true });
        }
      }
    });
  }
  const control = (form, name) => form.elements.namedItem(name);
  const value = (form, name) => control(form, name).value.trim();
  const numeric = (form, name, nullable = false) => {
    const text = value(form, name);
    if (!text && nullable) return null;
    if (!text || !Number.isFinite(Number(text))) throw new Error('Enter a finite number, or leave an optional result empty.');
    return Number(text);
  };
  function workoutSelect(catalog, selected) {
    const workouts = list(catalog.workouts), items = workouts.map((workout) => [workout.id, workout.title]);
    if (selected && !items.some(([id]) => id === selected)) items.push([selected, `${selected} (saved workout)`]);
    return `<select name="workout_id" required>${options(items.length ? items : [['', 'Catalog unavailable']], selected)}</select>`;
  }
  function contextFields(data, patch = false) {
    return `<div class="training-grid">${field('Role', roles(data.role || ''))}${field('Champion (optional)', input('champion', data.champion, 'maxlength="160"'))}
      ${patch ? field('Patch / setup version (optional)', input('patch', data.patch, 'maxlength="160"')) : ''}</div>`;
  }
  function workoutHTML(workout) {
    return `<h3>${E(workout.title)}</h3><p>${E(workout.goal)}</p>
      <p class="training-muted">${E(list(workout.roles).map((role) => roleNames[role] || role).join(' · ') || 'All roles')} · ${E(workout.minutes)} minutes · manual practice inside League</p>
      <ol>${list(workout.steps).map((step) => `<li>${E(step)}</li>`).join('')}</ol>
      <p><strong>Record:</strong> ${E(workout.measure)}${workout.unit ? ` (${E(workout.unit)})` : ''}</p>
      <p class="training-muted">${E(workout.tip)}</p>`;
  }
  function limitsHTML(bootstrap) {
    const limits = bootstrap.limits;
    const counts = finite(limits.member_count) && finite(limits.per_member)
      ? `<p>At the last saved-data load: ${E(limits.member_count)} of ${E(limits.per_member)} member records used${finite(limits.remaining) ? ` · ${E(limits.remaining)} remaining` : ''}. Shared documents you created count toward member storage while your team membership is active. Losing access frees that quota without deleting the team’s copy; accepting a re-invitation counts those documents again.</p>` : '';
    return `<details class="training-details"><summary>Storage limits and loaded history</summary>${counts}
      <p>Initial lists contain at most 50 newest records per kind. Use “Load older” below to access older personal records. Progress describes only loaded sessions, not all games or a live match feed.</p>
      <p>Storage is bounded. Export before deleting anything you want to keep.</p>
      <dl>${[['per_member', 'Records per member'], ['per_team', 'Records per team'], ['teams_per_member', 'Teams per member'], ['members_per_team', 'Members per team'], ['entry_bytes', 'Bytes per record'], ['page_size', 'Records per page']].map(([key, label]) => `<dt>${E(label)}</dt><dd>${E(number(limits[key]))}</dd>`).join('')}</dl>
      <p>Older records beyond the initial bootstrap pages:</p><ul>${kinds.map((kind) => `<li>${E(kind)}: ${limits.has_more?.[kind] === true ? 'available — load older in that tool' : limits.has_more?.[kind] === false ? 'none beyond the initial page' : 'not specified — use the tool’s older-record control'}</li>`).join('')}</ul></details>`;
  }
  function boundaryHTML() {
    return '<details class="training-details"><summary>Privacy and workspace limits</summary><p>Training records belong to your authenticated membership, independently of a linked Riot account. Only reviews, puzzles and boards you explicitly create or copy into a team are shared with accepted teammates; plans, sessions and experiments remain personal.</p><p>Workouts are manual instructions inside League, not a playable clone. This workspace does not fetch Riot data, upload footage, run external AI analysis or provide live decision support. Local review media stays on your device and must be reselected on a later visit. Comparisons do not establish causation or promise rank gains.</p></details>';
  }
  function trainingLinks() {
    let profile = '';
    if (typeof myHash === 'function') profile = myHash() || '';
    return `<nav class="training-tools" aria-label="Training tools">
      ${[['review', 'Review a match'], ['lessons', 'Recall your lessons'], ['puzzles', 'Decision puzzles'], ['lab', 'Strategy lab'], ['experiments', 'Practice experiments'], ['team', 'Team workspace']].map(([path, label]) => `<a href="#/practice/${path}">${E(label)}</a>`).join('')}
      ${profile ? `<a href="${E(profile)}" data-training-coaching>Coaching &amp; habits</a>` : '<a href="#/">Find a player’s coaching focus</a>'}
      </nav>`;
  }
  function bindCoaching(state, root) {
    const link = root.querySelector('[data-training-coaching]');
    if (link) on(state, link, 'click', (event) => {
      if (!state.current() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (typeof view !== 'undefined') view.player.tab = 'habits';
    });
  }
  function bindExport(state, button, ctx) {
    on(state, button, 'click', async () => {
      if (!ctx.current() || button.disabled) return;
      button.disabled = true;
      let url = null;
      try {
        const payload = await ctx.request('/api/training/export');
        if (!ctx.current()) return;
        url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `rift-odds-training-${today()}.json`;
        link.hidden = true;
        state.root.append(link);
        link.click();
        link.remove();
        const downloadURL = url;
        const timer = setTimeout(() => URL.revokeObjectURL(downloadURL), 1000);
        state.cleanups.push(() => { clearTimeout(timer); URL.revokeObjectURL(downloadURL); });
        url = null;
        ctx.status('Personal training export downloaded. It contains private notes; store it safely. Team documents are not included.');
      } catch (error) {
        if (ctx.current()) ctx.status(failure(error), true);
      } finally {
        if (url) URL.revokeObjectURL(url);
        if (ctx.current()) button.disabled = false;
      }
    });
  }

  // Rescan bounded pages to the first unseen record on each explicit load. This
  // avoids gaps after creates/deletes shift offsets and does not replace editors.
  function pager(state, ctx, kind, button, changed) {
    let busy = false;
    if (ctx.bootstrap.limits.has_more?.[kind] === false) button.hidden = true;
    on(state, button, 'click', async () => {
      if (!ctx.current() || busy) return;
      busy = true;
      const focused = document.activeElement === button, epoch = state.writeEpoch || 0;
      button.disabled = true;
      try {
        let offset = 0, more = true;
        const known = new Set(ctx.bootstrap.entries[kind].map((entry) => entry.id));
        while (more) {
          const payload = await ctx.request(`/api/training/entries/${kind}?offset=${offset}&limit=50`);
          if (!ctx.current()) return;
          if (epoch !== (state.writeEpoch || 0)) throw new Error('Saved records changed while loading this list. Use Load older again to read the current list.');
          const rows = list(payload.entries);
          mergePage(ctx.bootstrap, kind, rows);
          offset += rows.length;
          more = !!payload.has_more && rows.length > 0;
          if (rows.some((entry) => !known.has(entry.id)) || !more) break;
          if (offset >= 200) throw new Error('The loaded list reached the per-member bound. Reload saved data before continuing.');
        }
        changed();
        if (!more) {
          const end = document.createElement('p');
          end.className = 'training-muted';
          end.tabIndex = -1;
          end.textContent = `All available personal ${kind} are loaded.`;
          button.before(end);
          const restoreFocus = focused && (document.activeElement === button || document.activeElement === document.body);
          button.hidden = true;
          if (restoreFocus) end.focus({ preventScroll: true });
          ctx.status(end.textContent);
        } else {
          ctx.status(`Loaded more ${kind}. Progress and lists now include all loaded records; more remain.`);
        }
      } catch (error) {
        if (ctx.current()) ctx.status(failure(error), true);
      } finally {
        busy = false;
        if (ctx.current()) button.disabled = false;
      }
    });
  }

  function matchComparison(data) {
    if (!data?.available) return `<p class="training-muted">${E(data?.reason || 'Match observations have not been loaded.')}</p>`;
    const metrics = list(data.metrics);
    return `<p><strong>${E(data.practice?.games || 0)} of ${E(data.tracking?.games || 0)} subsequent comparable games cached.</strong> Baseline: ${E(data.baseline?.games || 0)} captured games. Each metric has its own observed sample count.</p>
      <div class="table-scroll" tabindex="0" role="region" aria-label="Match progress numeric comparison"><table class="training-table"><caption>Cached match observations · practice minus baseline, not a causal effect</caption><thead><tr><th scope="col">Measure</th><th scope="col">Baseline mean (n)</th><th scope="col">Practice mean (n)</th><th scope="col">Difference</th></tr></thead><tbody>${metrics.map(m => `<tr><th scope="row">${E(m.label)}${m.unit ? ` (${E(m.unit)})` : ''}</th><td>${E(number(m.baseline?.mean))} (n=${E(m.baseline?.n ?? 0)})</td><td>${E(number(m.practice?.mean))} (n=${E(m.practice?.n ?? 0)})</td><td>${E(number(m.difference))}</td></tr>`).join('')}</tbody></table></div>
      <p class="training-muted">${E(data.note || 'Descriptive observations, not evidence that practice caused a change. Missing metrics are not zeros.')}${data.truncated ? ' The bounded cache search was truncated; these are not all of your matches.' : ''}</p>
      <details class="training-details"><summary>Games behind these observations</summary>${['baseline', 'practice'].map(phase => `<h4>${phase === 'baseline' ? 'Frozen baseline' : 'Subsequent practice games'}</h4><ul class="training-list">${list(data[phase]?.rows).map(row => `<li>${E(row.match_id)} · ${row.missing ? 'No longer available in cache; metrics remain missing.' : `${E(dateTime(row.game_start / 1000))} · ${E(roleNames[row.role] || row.role)} · patch ${E(row.patch)}`}<br>${list(data.metrics).map(m => `${E(m.label)}: ${E(number(row.values?.[m.key]))}`).join(' · ')}</li>`).join('') || '<li>No cached games in this window.</li>'}</ul>`).join('')}</details>`;
  }
  function reviewQueueHTML(data) {
    if (!data?.available) return `<p class="training-muted">${E(data?.reason || 'Review prompts have not been loaded.')}</p>`;
    return `<p>${E(data.games_considered)} completed cached games considered; ${E(data.timelines_available)} usable timelines and ${E(data.missing_timelines)} unavailable timelines. Missing timelines are not games without events.</p>
      <ul class="training-list">${list(data.prompts).map(prompt => {
        const seconds = finite(prompt.seconds) && prompt.seconds >= 0 && prompt.seconds <= 28800 ? prompt.seconds : null;
        if (seconds === null || typeof prompt.match_id !== 'string' || !prompt.match_id) return '';
        const query = new URLSearchParams({ match: prompt.match_id, at: String(seconds), prompt: prompt.id || '' });
        return `<li><h4>${E(prompt.title)}</h4><p>${E(prompt.question)}</p><p class="training-muted">${E(prompt.evidence)}</p><a href="#/practice/review?${E(query.toString())}">Review ${E(prompt.match_id)} at ${E(Math.floor(seconds / 60))}:${E(String(Math.floor(seconds % 60)).padStart(2, '0'))}</a></li>`;
      }).join('') || '<li>No prompts in this bounded sample. That is not proof that every decision was good.</li>'}</ul>
      <p class="training-muted">${E(data.note || 'Review prompts describe cached events, not mistakes, causes or recommended plays.')}${data.truncated ? ' The bounded cache search was truncated.' : ''}</p>`;
  }
  function mountMatchTools(state, root, ctx, getPlan, returnedPlan, planEditor) {
    const tools = root.querySelector('[data-match-tools]'), output = tools.querySelector('[data-match-comparison]'), queue = tools.querySelector('[data-review-queue]');
    const config = tools.querySelector('[data-match-config]'), windowLabel = tools.querySelector('[data-match-window]'), scope = tools.querySelector('[name="review_scope"]');
    const status = tools.querySelector('[data-match-status]');
    let planId = getPlan()?.id || '', progress = null, metadata = null, loadSequence = 0, pendingLoad = 0, queueSequence = 0, pendingQueue = 0, busy = false;
    scope.value = planId ? 'plan' : 'recent';
    const current = (id, sequence) => ctx.current() && (getPlan()?.id || '') === id && sequence === loadSequence;
    const say = (message, error = false) => { if (ctx.current()) { status.textContent = message; status.classList.toggle('error', error); } };
    function scopeLabel() {
      tools.querySelector('[data-review-scope]').textContent = scope.value === 'plan'
        ? 'Review scope: subsequent games in this plan’s captured role, champion, queue and patch filters.'
        : 'Review scope: newest ten completed cached ranked solo games, across all roles, champions and patches.';
    }
    function clearQueue() { ++queueSequence; pendingQueue = 0; queue.innerHTML = ''; scopeLabel(); tools.querySelector('[data-load-queue]').disabled = false; }
    function savedWindow() {
      const text = config.querySelector('[data-match-saved-window]');
      if (text && getPlan()) text.textContent = `Start or restart uses the saved plan, not unsaved edits: up to ${getPlan().data.games} preceding cached games and the first ${getPlan().data.games} comparable games started afterward. Restart replaces the previous comparison; export first to retain its configuration.`;
    }
    function drawProgress(data) {
      progress = data;
      output.innerHTML = matchComparison(data);
      const t = data?.tracking;
      windowLabel.textContent = t ? `Captured at ${dateTime(t.started)} · ${roleNames[t.role] || t.role} · ${t.champion_id ? championName(t.champion_id) : 'any champion'} · ${queueName(t.queue_id)} · patch ${t.patch} · first ${t.games} subsequent games. Editing the plan does not change this window; explicitly restart to change it.` : 'No match tracking is active for this plan. Starting captures a baseline now; nothing is enrolled automatically.';
      const stop = tools.querySelector('[data-stop-tracking]'); stop.hidden = !t;
      const submit = config.querySelector('[data-start-tracking]'); if (submit) submit.textContent = t ? 'Restart match tracking' : 'Start match tracking';
    }
    function championName(id) { return typeof META !== 'undefined' && META?.champions?.[id]?.name || metadata?.champions?.find(c => c.id === id)?.name || `Champion ${id}`; }
    function queueName(id) { return metadata?.queues?.find(q => q.id === id)?.label || `Queue ${id}`; }
    function renderConfig() {
      const account = metadata?.account;
      tools.querySelector('[data-match-account]').textContent = account ? `Currently linked: ${account.game_name}#${account.tag_line} (${account.platform}). This self-link is not Riot account verification.` : 'No Riot account is currently linked. Personal plans and notes are still available.';
      if (config.querySelector('form')) { savedWindow(); return; } // Refreshes never replace filter drafts or their focus.
      if (!metadata?.available || !getPlan()) {
        config.innerHTML = `<p class="training-muted">${E(!getPlan() ? 'Save an active weekly plan before connecting match results.' : metadata?.reason || 'Cached match options are unavailable.')}</p>`;
        return;
      }
      const t = progress?.tracking, plan = getPlan();
      const champion = t?.champion_id ?? list(metadata.champions).find(c => championName(c.id).toLowerCase() === (plan.data.champion || '').trim().toLowerCase())?.id ?? '';
      const choiceOptions = (rows, selected) => options(rows.map(row => [String(row.id), row.label || row.name]), String(selected));
      config.innerHTML = `<form class="training-form" data-match-form><p>Connect only completed games from your currently linked account. Choose consistent filters; no match or timeline downloads are triggered.</p><div class="training-grid">
        ${field('Match role', `<select name="match_role" required>${choiceOptions(metadata.roles, t?.role || plan.data.role || 'MIDDLE')}</select>`)}
        ${field('Match champion', `<select name="match_champion"><option value="">Any champion</option>${options(list(metadata.champions).map(c => [String(c.id), championName(c.id)]), String(champion))}</select>`)}
        ${field('Match queue', `<select name="match_queue" required>${choiceOptions(metadata.queues, t?.queue_id || 420)}</select>`)}
        ${field('Match patch', `<select name="match_patch" required>${options(list(metadata.patches).map(patch => [patch, patch]), t?.patch || metadata.patches[0])}</select>`)}</div>
        <p class="training-muted" data-match-saved-window></p><p class="training-muted">Unfinished games, remakes and nonstandard maps are excluded.</p>
        <button type="submit" class="btn" data-start-tracking>${t ? 'Restart match tracking' : 'Start match tracking'}</button></form>`;
      savedWindow();
      const form = config.querySelector('form'); watchForm(state, form);
      on(state, form, 'submit', event => { event.preventDefault(); mutate(event.submitter, false); });
    }
    async function load() {
      if (busy || !ctx.current()) return;
      const id = getPlan()?.id || '', sequence = ++loadSequence, button = tools.querySelector('[data-load-matches]');
      pendingLoad = sequence; button.disabled = true; say('Reading completed cached matches only…');
      try {
        const [opts, data] = await Promise.all([ctx.request('/api/training/matches/options'), id ? ctx.request(`/api/training/plans/${encodeURIComponent(id)}/matches`) : Promise.resolve(null)]);
        if (!current(id, sequence)) return;
        metadata = opts; drawProgress(data || { available: false, reason: 'Save an active weekly plan to connect match results.' }); renderConfig(); clearQueue();
        say(opts.available ? 'Cached match options loaded. Tracking starts only when you explicitly choose Start match tracking.' : opts.reason || 'No eligible cached matches. Nothing was fetched.');
      } catch (error) {
        if (current(id, sequence)) { output.replaceChildren(); windowLabel.textContent = ''; clearQueue(); say(failure(error), true); }
      } finally {
        if (pendingLoad === sequence) pendingLoad = 0;
        if (ctx.current() && button.isConnected) button.disabled = busy || pendingLoad !== 0;
      }
    }
    async function mutate(button, stopping) {
      const plan = getPlan(), form = config.querySelector('form'), editorForm = planEditor.querySelector('form');
      if (!ctx.current() || busy || !plan || !stopping && (!form || !form.reportValidity())) return;
      if (state.savingForms.has(editorForm)) { say('Wait for the current plan save to finish. Match tracking uses the saved plan’s game window; unsaved plan edits are kept.', true); return; }
      if (!window.confirm(stopping ? 'Stop linking new cached match observations to this plan? Your plan, sessions and review notes are kept.' : progress?.tracking ? 'Restart tracking now and replace its frozen baseline and subsequent-game window?' : 'Start observing subsequent completed cached matches with these filters? No new Riot requests will be made.')) return;
      const id = plan.id, sequence = ++loadSequence, snapshot = form ? formSnapshot(form) : null;
      busy = true; pendingLoad = 0; button.disabled = true; tools.querySelector('[data-load-matches]').disabled = true; state.savingForms.add(editorForm);
      try {
        const path = `/api/training/plans/${encodeURIComponent(id)}/matches`;
        const result = await ctx.request(stopping ? `${path}?revision=${plan.revision}` : path, stopping ? { method: 'DELETE' } : jsonOptions('POST', {
          revision: plan.revision, role: value(form, 'match_role'), champion_id: value(form, 'match_champion') ? numeric(form, 'match_champion') : null,
          queue_id: numeric(form, 'match_queue'), patch: value(form, 'match_patch')
        }));
        if (!current(id, sequence)) return;
        returnedPlan(result.entry); // Advance only the saved revision; never replace a live editor.
        drawProgress(stopping ? { available: false, reason: 'Match tracking stopped. The plan and personal notes are unchanged.', tracking: null } : result);
        clearQueue();
        if (form && !stopping) markSaved(state, form, snapshot);
        say(stopping ? 'Match tracking stopped. No personal notes were deleted.' : `Match tracking started. The frozen baseline and subsequent-game window use the submitted filters.${form && dirty(state, form) ? ' Newer filter edits are still unsaved; restart explicitly to apply them.' : ''}`);
      } catch (error) { if (current(id, sequence)) { if (error.status === 404) { output.replaceChildren(); clearQueue(); } say(failure(error), true); } }
      finally {
        busy = false; state.savingForms.delete(editorForm);
        if (ctx.current()) { if (button.isConnected) button.disabled = false; tools.querySelector('[data-load-matches]').disabled = pendingLoad !== 0; }
      }
    }
    on(state, tools.querySelector('[data-load-matches]'), 'click', load);
    on(state, tools.querySelector('[data-stop-tracking]'), 'click', event => mutate(event.currentTarget, true));
    on(state, scope, 'change', clearQueue);
    on(state, tools.querySelector('[data-load-queue]'), 'click', async event => {
      const button = event.currentTarget, id = getPlan()?.id || '', selected = scope.value, sequence = ++queueSequence;
      if (selected === 'plan' && !id) { say('Save an active plan and start match tracking, or explicitly choose recent ranked solo games.'); return; }
      pendingQueue = sequence; button.disabled = true; queue.replaceChildren(); say('Looking for review prompts in cached completed games…');
      try {
        const data = await ctx.request(`/api/training/review-queue${selected === 'plan' ? `?plan_id=${encodeURIComponent(id)}` : ''}`);
        if (!ctx.current() || sequence !== queueSequence || scope.value !== selected || (getPlan()?.id || '') !== id) return;
        queue.innerHTML = reviewQueueHTML(data); scopeLabel(); say(data.available ? 'Review prompts loaded. These are questions to investigate, not mistake verdicts.' : data.reason || 'No cached review context is available.');
      } catch (error) { if (ctx.current() && sequence === queueSequence) { queue.replaceChildren(); say(failure(error), true); } }
      finally { if (pendingQueue === sequence) pendingQueue = 0; if (ctx.current() && button.isConnected) button.disabled = pendingQueue !== 0; }
    });
    scopeLabel();
    return () => {
      const id = getPlan()?.id || '';
      if (id === planId) { savedWindow(); return; }
      planId = id; ++loadSequence; pendingLoad = 0; clearQueue(); progress = metadata = null; config.replaceChildren(); output.replaceChildren(); windowLabel.textContent = ''; tools.querySelector('[data-match-account]').textContent = '';
      scope.value = id ? 'plan' : 'recent'; scopeLabel(); tools.querySelector('[data-stop-tracking]').hidden = true; tools.querySelector('[data-load-matches]').disabled = false;
      say('The active plan changed. Explicitly load cached observations for this plan.');
    };
  }

  function renderHub(root, ctx, state, parsed) {
    state.ctx = ctx;
    const workouts = list(ctx.bootstrap.catalog.workouts);
    let activePlan = ctx.bootstrap.entries.plans.find((entry) => entry.data.status === 'active') || null;
    const selected = parsed.workout || activePlan?.data.workout_id || workouts[0]?.id || '';
    root.innerHTML = `<section class="training-card" aria-labelledby="training-focus-title"><h2 id="training-focus-title">Your next focus</h2>
      <div data-focus-summary></div>${trainingLinks()}<details class="training-details" data-plan-details${activePlan ? '' : ' open'}><summary>${activePlan ? 'Edit weekly plan' : 'Save a weekly plan'}</summary><div data-plan-editor></div></details>
            <details class="training-details" data-match-tools><summary>Connect practice to match results and choose a review moment</summary><p>Compare a frozen baseline with subsequent completed cached games. This is optional, private and descriptive—not proof that practice caused a change.</p>
            <div class="training-actions">${action('Load cached match progress', 'data-load-matches')}${action('Stop match tracking', 'data-stop-tracking hidden')}</div><p data-match-status class="training-status" role="status" aria-live="polite"></p><p data-match-window class="training-muted"></p><p data-match-account class="training-muted"></p><div data-match-config></div><div data-match-comparison></div>
            <h3>What should I review?</h3>${field('Review scope', '<select name="review_scope"><option value="plan">This plan’s tracked games</option><option value="recent">Recent ranked solo games · all roles, champions and patches</option></select>')}<p data-review-scope class="training-muted"></p>${action('Find cached review prompts', 'data-load-queue')}<div data-review-queue></div></details></section>
      <section class="training-card"><h2>Manual Practice Tool workouts</h2><p>Open League’s Practice Tool yourself, follow the full setup and steps below, then explicitly save your result. Repeat a consistent setup; there are no pass/fail or promotion targets.</p>
      <div class="training-grid">${workouts.map((workout) => `<details class="training-details"${workout.id === selected ? ' open' : ''}><summary>${E(workout.title)}</summary>${workoutHTML(workout)}${action('Log this workout', `data-use-workout="${E(workout.id)}"`)}</details>`).join('') || '<p>Workout instructions could not be loaded. Use “Reload saved data” to try again.</p>'}</div></section>
      <section class="training-card"><h2 data-session-heading>Log a practice session</h2><p>Record what happened, including a reflection. Nothing is saved until you choose Save session. An empty result is not zero.</p><div data-session-editor></div></section>
      <section class="training-card"><h2>Recent progress</h2><div data-progress></div><div data-session-history></div>${action('Load older sessions', 'data-older-sessions')}</section>
      <details class="training-details"><summary>Saved weekly plans</summary><div data-plan-history></div>${action('Load older plans', 'data-older-plans')} ${action('Create another weekly plan', 'data-new-plan')}</details>
      ${limitsHTML(ctx.bootstrap)}${boundaryHTML()}
      <div class="training-actions">${action('Reload saved data', 'data-reload')} ${action('Export my personal training data', 'data-export')}</div>`;
    const planEditor = root.querySelector('[data-plan-editor]'), sessionEditor = root.querySelector('[data-session-editor]');
    let editedPlan = activePlan, editedSession = null, syncMatchPlan = null;

    const defaults = () => ({ title: 'This week’s practice', focus: parsed.params.get('focus')?.slice(0, 4000) || '',
      role: roleNames[parsed.params.get('role')] ? parsed.params.get('role') : '', champion: '', workout_id: selected,
      minutes: workouts.find((workout) => workout.id === selected)?.minutes || 10, games: 3, status: 'active' });
    const focusSummary = () => {
      activePlan = ctx.bootstrap.entries.plans.find((entry) => entry.data.status === 'active') || null;
      root.querySelector('[data-focus-summary]').innerHTML = activePlan
        ? `<p><strong>${E(activePlan.data.focus || activePlan.data.title)}</strong></p><p>${E(activePlan.data.minutes)} minutes of ${E(workouts.find((workout) => workout.id === activePlan.data.workout_id)?.title || activePlan.data.workout_id)}, then carry the focus into ${E(activePlan.data.games)} games this week${activePlan.data.role ? ` · ${E(roleNames[activePlan.data.role] || activePlan.data.role)}` : ''}${activePlan.data.champion ? ` · ${E(activePlan.data.champion)}` : ''}.</p>`
        : '<p><strong>Choose one repeatable focus before your next games.</strong></p><p>Save a short weekly plan, practice it inside League, and reflect on one session at a time.</p>';
      syncMatchPlan?.();
    };
    function planForm(entry = null) {
      editedPlan = entry;
      const data = entry?.data || defaults();
      planEditor.innerHTML = `<form class="training-form">${field('Plan title', input('title', data.title, 'maxlength="120" required'))}
        ${field('One focus', prose('focus', data.focus))}${contextFields(data)}
        ${field('Workout', workoutSelect(ctx.bootstrap.catalog, data.workout_id))}<div class="training-grid">
        ${field('Practice minutes', input('minutes', data.minutes, 'type="number" min="1" max="120" step="1" required'))}
        ${field('Games to carry this focus into', input('games', data.games, 'type="number" min="1" max="20" step="1" required'))}</div>
        ${field('Plan status', `<select name="status">${options([['active', 'Active this week'], ['archived', 'Archived']], data.status)}</select>`)}
        <p class="training-muted">Saving an active plan archives the previous active plan; it does not delete its history.</p>
        <button type="submit" class="btn">${entry ? 'Save plan changes' : 'Save weekly plan'}</button></form>`;
      const form = planEditor.querySelector('form');
      bindSubmit(state, form, () => ctx.save('plans', {
        title: value(form, 'title'), focus: value(form, 'focus'), role: value(form, 'role'), champion: value(form, 'champion'),
        workout_id: value(form, 'workout_id'), minutes: numeric(form, 'minutes'), games: numeric(form, 'games'), status: value(form, 'status')
      }, editedPlan), (saved) => {
        editedPlan = saved;
        form.querySelector('[type="submit"]').textContent = 'Save plan changes';
        focusSummary();
        planHistory();
        syncPlanOptions();
        ctx.status('Weekly plan saved. Session inputs have not been changed; select the saved plan when linking a session.');
      });
    }
    function sessionForm(entry = null) {
      editedSession = entry;
      const plan = activePlan;
      const workoutId = entry?.data.workout_id || parsed.workout || plan?.data.workout_id || selected;
      const workout = workouts.find((item) => item.id === workoutId) || workouts[0];
      const minutes = (plan?.data.workout_id === workoutId ? plan.data.minutes : workout?.minutes) ?? 10;
      const data = entry ? { ...entry.data, plan_id: state.deletedPlans.has(entry.data.plan_id) ? null : entry.data.plan_id } : { plan_id: plan?.id || null, workout_id: workoutId, minutes, repetitions: 1,
        result: null, unit: workout?.unit || '', focus: plan?.data.focus || parsed.params.get('focus')?.slice(0, 4000) || '', reflection: '', adhered: false,
        role: plan?.data.role || (roleNames[parsed.params.get('role')] ? parsed.params.get('role') : ''), champion: plan?.data.champion || '', patch: '' };
      const planItems = [['', 'No linked plan'], ...ctx.bootstrap.entries.plans.map((item) => [item.id, item.data.title])];
      if (data.plan_id && !planItems.some(([id]) => id === data.plan_id)) planItems.push([data.plan_id, 'Previously linked plan']);
      sessionEditor.innerHTML = `<form class="training-form">${field('Weekly plan (optional)', `<select name="plan_id">${options(planItems, data.plan_id || '')}</select>`)}
        ${field('Workout', workoutSelect(ctx.bootstrap.catalog, data.workout_id))}<div data-session-instructions></div>
        <div class="training-grid">${field('Minutes practiced', input('minutes', data.minutes, 'type="number" min="0" max="240" step="1" required'))}
        ${field('Repetitions', input('repetitions', data.repetitions, 'type="number" min="1" max="100" step="1" required'))}
        ${field('Result (optional; 0 is valid)', input('result', data.result ?? '', 'type="number" min="-1000000000" max="1000000000" step="any"'))}
        ${field('Result unit', input('unit', data.unit, 'maxlength="160"'))}</div>
        ${field('Focus practiced', prose('focus', data.focus))}${contextFields(data, true)}
        <label class="training-inline"><input name="adhered" type="checkbox"${data.adhered ? ' checked' : ''}> I followed my intended practice setup</label>
        ${field('Reflection — what happened and what will you try next?', prose('reflection', data.reflection))}
        <div class="training-actions"><button type="submit" class="btn">${entry ? 'Save session changes' : 'Save session'}</button>${action('Start another session', 'data-new-session')}</div></form>`;
      root.querySelector('[data-session-heading]').textContent = entry ? 'Edit saved session' : 'Log a practice session';
      const form = sessionEditor.querySelector('form'), select = control(form, 'workout_id');
      let previousUnit = workouts.find((item) => item.id === data.workout_id)?.unit || '';
      function instructions() {
        const chosen = workouts.find((item) => item.id === select.value);
        form.querySelector('[data-session-instructions]').innerHTML = chosen
          ? `<details class="training-details"><summary>Steps and measurement for ${E(chosen.title)}</summary>${workoutHTML(chosen)}</details>`
          : '<p class="training-muted">Instructions for this saved workout are not currently in the catalog.</p>';
      }
      instructions();
      on(state, select, 'change', () => {
        if (!ctx.current()) return;
        const nextUnit = workouts.find((item) => item.id === select.value)?.unit || '';
        if (control(form, 'unit').value === previousUnit) control(form, 'unit').value = nextUnit;
        previousUnit = nextUnit;
        instructions();
      });
      on(state, form.querySelector('[data-new-session]'), 'click', () => {
        if (!confirmDiscard(state, form)) return;
        sessionForm();
        sessionEditor.querySelector('select').focus();
      });
      bindSubmit(state, form, () => ctx.save('sessions', {
        plan_id: value(form, 'plan_id') || null, workout_id: value(form, 'workout_id'), minutes: numeric(form, 'minutes'),
        repetitions: numeric(form, 'repetitions'), result: numeric(form, 'result', true), unit: value(form, 'unit'), focus: value(form, 'focus'),
        reflection: value(form, 'reflection'), adhered: control(form, 'adhered').checked, role: value(form, 'role'), champion: value(form, 'champion'), patch: value(form, 'patch')
      }, editedSession), (saved) => {
        editedSession = saved;
        form.querySelector('[type="submit"]').textContent = 'Save session changes';
        root.querySelector('[data-session-heading]').textContent = 'Edit saved session';
        sessionHistory();
        ctx.status('Session saved. Choose “Start another session” for a separate log; saving again updates this record.');
      });
    }
    function sessionHistory() {
      const rows = [...ctx.bootstrap.entries.sessions].sort((a, b) => b.created - a.created), summary = summarizeSessions(rows);
      root.querySelector('[data-progress]').innerHTML = `<p><strong>${summary.count ? `${E(summary.count)} saved session${summary.count === 1 ? '' : 's'} in loaded history.` : 'No sessions logged yet.'}</strong>
        ${summary.count ? `${E(summary.minutes)} recorded minute${summary.minutes === 1 ? '' : 's'}; ${E(summary.measured)} numeric result${summary.measured === 1 ? '' : 's'} and ${E(summary.missing)} unrecorded result${summary.missing === 1 ? '' : 's'}.` : 'Missing practice data is not a zero result.'}</p>
        <p class="training-muted">Compare the same workout, unit, champion, role, patch and setup. These logs are descriptive, not evidence of a causal effect on wins.</p>`;
      replaceList(root.querySelector('[data-session-history]'), rows.length ? `<div class="training-list">${rows.map((entry) => {
        const d = entry.data, title = workouts.find((item) => item.id === d.workout_id)?.title || d.workout_id;
        return `<details class="training-details" data-record-id="${E(entry.id)}"><summary>${E(dateTime(entry.created))} · ${E(title)} · ${E(number(d.result))}${finite(d.result) && d.unit ? ` ${E(d.unit)}` : ''}</summary>
          <dl><dt>Practice</dt><dd>${E(d.minutes)} minutes · ${E(d.repetitions)} repetitions</dd><dt>Context</dt><dd>${E([roleNames[d.role] || d.role, d.champion, d.patch].filter(Boolean).join(' · ') || 'Not recorded')}</dd>
          <dt>Focus</dt><dd>${E(d.focus || 'Not recorded')}</dd><dt>Followed setup</dt><dd>${d.adhered === true ? 'Yes' : d.adhered === false ? 'No' : 'Not recorded'}</dd>
          <dt>Reflection</dt><dd>${E(d.reflection || 'Not recorded')}</dd></dl>
          <div class="training-actions">${action('Edit session', `data-edit-session="${E(entry.id)}"`)}${action('Delete session', `data-delete-session="${E(entry.id)}"`)}</div></details>`;
      }).join('')}</div>` : '<p class="training-muted">Your explicitly saved sessions will appear here.</p>');
    }
    function planHistory() {
      replaceList(root.querySelector('[data-plan-history]'), `<div class="training-list">${ctx.bootstrap.entries.plans.map((entry) => `<article class="training-card" data-record-id="${E(entry.id)}"><h3>${E(entry.data.title)}</h3>
        <p>${E(entry.data.focus)} · ${E(entry.data.status)}</p><div class="training-actions">${action('Edit plan', `data-edit-plan="${E(entry.id)}"`)}
        ${entry.data.status === 'active' ? action('Archive plan', `data-archive-plan="${E(entry.id)}"`) : ''}${action('Delete plan', `data-delete-plan="${E(entry.id)}"`)}</div></article>`).join('') || '<p>No saved plans.</p>'}</div>`);
    }
    function syncPlanOptions() {
      const select = sessionEditor.querySelector('[name="plan_id"]');
      if (!select) return;
      ctx.bootstrap.entries.plans.forEach((entry) => {
        let option = [...select.options].find((item) => item.value === entry.id);
        if (!option) { option = document.createElement('option'); option.value = entry.id; select.append(option); }
        option.textContent = entry.data.title;
      });
    }
    focusSummary();
    planForm(activePlan);
    sessionForm();
    sessionHistory();
    planHistory();
    on(state, root.querySelector('[data-new-plan]'), 'click', () => {
      if (!confirmDiscard(state, planEditor.querySelector('form'))) return;
      planForm();
      root.querySelector('[data-plan-details]').open = true;
      planEditor.querySelector('input').focus();
    });
    on(state, root, 'click', async (event) => {
      const button = event.target.closest('button');
      if (!button || !ctx.current() || button.disabled) return;
      if (button.hasAttribute('data-use-workout')) {
        const form = sessionEditor.querySelector('form');
        control(form, 'workout_id').value = button.dataset.useWorkout;
        control(form, 'workout_id').dispatchEvent(new Event('change', { bubbles: true }));
        sessionEditor.scrollIntoView({ block: 'start', behavior: 'auto' });
        control(form, 'workout_id').focus({ preventScroll: true });
        return;
      }
      const key = ['editSession', 'deleteSession', 'editPlan', 'deletePlan', 'archivePlan'].find((name) => button.dataset[name]);
      if (!key) return;
      const isSession = /Session$/.test(key), kind = isSession ? 'sessions' : 'plans';
      const entry = ctx.bootstrap.entries[kind].find((row) => row.id === button.dataset[key]);
      if (!entry) return;
      const editor = isSession ? sessionEditor : planEditor;
      if (key.startsWith('edit')) {
        if (!confirmDiscard(state, editor.querySelector('form'))) return;
        if (isSession) sessionForm(entry);
        else { planForm(entry); root.querySelector('[data-plan-details]').open = true; }
        editor.querySelector('input, select, textarea').focus();
        return;
      }
      if (!confirmDiscard(state, editor.querySelector('form'))) return;
      const archive = key === 'archivePlan';
      if (!window.confirm(archive ? 'Archive this weekly plan? It stays in your history.' : `Permanently delete this ${isSession ? 'session' : 'plan'}? This cannot be undone.`)) return;
      button.disabled = true;
      const form = editor.querySelector('form'), before = formSnapshot(form);
      state.savingForms.add(form);
      try {
        const archived = archive ? await ctx.save('plans', { ...entry.data, status: 'archived' }, entry) : null;
        if (!archive) await ctx.remove(entry);
        if (!ctx.current()) return;
        const changedWhileWaiting = form.isConnected && before !== formSnapshot(form);
        focusSummary();
        sessionHistory();
        planHistory();
        if (isSession && editedSession?.id === entry.id) {
          if (changedWhileWaiting) {
            editedSession = null;
            form.querySelector('[type="submit"]').textContent = 'Save as a new session';
            root.querySelector('[data-session-heading]').textContent = 'Unsaved session — original deleted';
          } else sessionForm();
        }
        if (!isSession && editedPlan?.id === entry.id) {
          if (changedWhileWaiting) {
            editedPlan = archived;
            form.querySelector('[type="submit"]').textContent = archived ? 'Save plan changes' : 'Save as a new plan';
          } else planForm(archived || activePlan);
        }
        if (!isSession && !archive) {
          state.deletedPlans.add(entry.id);
          const link = sessionEditor.querySelector('[name="plan_id"]');
          [...link.options].find((option) => option.value === entry.id)?.remove();
        }
        ctx.status(`${archive ? 'Plan archived.' : 'Record deleted.'}${changedWhileWaiting ? ' New edits made while waiting have been kept; save explicitly to persist them.' : ''}`);
        if (!changedWhileWaiting) editor.querySelector('input, select, textarea').focus({ preventScroll: true });
      } catch (error) {
        if (ctx.current()) { ctx.status(failure(error), true); button.disabled = false; }
      } finally {
        state.savingForms.delete(form);
      }
    });
    pager(state, ctx, 'sessions', root.querySelector('[data-older-sessions]'), sessionHistory);
    pager(state, ctx, 'plans', root.querySelector('[data-older-plans]'), () => { planHistory(); syncPlanOptions(); });
    bindReload(state, root.querySelector('[data-reload]'));
    bindExport(state, root.querySelector('[data-export]'), ctx);
    bindCoaching(state, root);
    syncMatchPlan = mountMatchTools(state, root, ctx, () => activePlan, entry => {
      mergeEntry(ctx.bootstrap, entry);
      if (editedPlan?.id === entry.id) editedPlan = entry;
      focusSummary(); planHistory(); syncPlanOptions();
    }, planEditor);
  }

  function observationHTML(observation) {
    return `<fieldset data-observation="${E(observation.id)}"><legend>Observation</legend><div class="training-grid">
      ${field('Date', input('observation_date', observation.date, 'type="date" required'))}
      ${field('Phase', `<select name="observation_phase">${options([['baseline', 'Baseline'], ['practice', 'Practice']], observation.phase)}</select>`)}
      ${field('Measured value (0 is valid)', input('observation_value', observation.value ?? '', 'type="number" min="0" max="100000" step="any" required'))}</div>
      <label class="training-inline"><input name="observation_adhered" type="checkbox"${observation.adhered ? ' checked' : ''}> Followed the intended setup</label>
      ${field('Context — matchup, setup differences, interruptions, other changes', prose('observation_context', observation.context))}
      ${action('Remove observation', 'data-remove-observation')}</fieldset>`;
  }
  function readObservations(form) {
    return [...form.querySelectorAll('[data-observation]')].map((row) => {
      const text = row.querySelector('[name="observation_value"]').value.trim();
      const value = text === '' ? null : Number(text);
      if (!finite(value) || value < 0 || value > 100000) throw new Error('Every observation needs a value from 0 to 100000; zero is valid. Remove an unmeasured observation instead of entering a zero.');
      return { id: row.dataset.observation, date: row.querySelector('[name="observation_date"]').value,
        phase: row.querySelector('[name="observation_phase"]').value, value,
        adhered: row.querySelector('[name="observation_adhered"]').checked, context: row.querySelector('[name="observation_context"]').value.trim() };
    });
  }
  function experimentComparison(data) {
    const s = summarizeExperiment(data.observations), suffix = data.unit ? ` ${E(data.unit)}` : '';
    return `<p><strong>${s.difference === null ? 'Not enough recorded data to compare both phases.' : s.difference === 0 ? 'Baseline and practice means are equal.' : `Practice mean is ${E(number(Math.abs(s.difference)))}${suffix} ${s.difference > 0 ? 'higher' : 'lower'} than baseline.`}</strong></p>
      <p class="training-muted">Descriptive association only, not a causal estimate or a promotion prediction. Small samples, champion/role/patch changes and adherence can change the comparison. Preferred direction: ${data.better === 'lower' ? 'lower' : 'higher'}; this is your stated aim, not a verdict.</p>
      <div class="table-scroll" role="region" tabindex="0" aria-label="Baseline and practice numeric comparison"><table class="training-table"><caption>Saved observations · ${E(data.measure || 'Measure')}${data.unit ? ` (${E(data.unit)})` : ''}</caption><thead><tr><th scope="col">Phase</th><th scope="col">Measured n</th><th scope="col">Mean</th><th scope="col">Missing</th><th scope="col">Followed setup</th></tr></thead>
      <tbody>${[['Baseline', s.baseline], ['Practice', s.practice]].map(([label, group]) => `<tr><th scope="row">${label}</th><td>${group.count}</td><td>${E(number(group.mean))}</td><td>${group.missing}</td><td>${group.adhered} of ${group.total}</td></tr>`).join('')}</tbody></table></div>
      <p>Practice minus baseline: ${s.difference === null ? 'Not recorded — both phases need a numeric observation.' : `${E(number(s.difference))}${suffix}`}</p>
      ${list(data.observations).length ? `<details class="training-details"><summary>All saved observation values and context (${data.observations.length})</summary>
        <div class="table-scroll" role="region" tabindex="0" aria-label="Saved observations with dates and context"><table class="training-table"><caption>Saved observations, not unsaved editor changes</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Phase</th><th scope="col">Value${data.unit ? ` (${E(data.unit)})` : ''}</th><th scope="col">Followed setup</th><th scope="col">Context</th></tr></thead>
        <tbody>${data.observations.map((row) => `<tr><td>${E(row.date)}</td><td>${E(row.phase)}</td><td>${E(number(row.value))}</td><td>${row.adhered === true ? 'Yes' : row.adhered === false ? 'No' : 'Not recorded'}</td><td>${E(row.context || 'Not recorded')}</td></tr>`).join('')}</tbody></table></div></details>` : ''}`;
  }
  function renderExperiments(root, ctx, state) {
    state.ctx = ctx;
    let edited = null;
    root.innerHTML = `<section class="training-card"><h2>Change one practice habit; record comparable observations.</h2>
      <p>Write a hypothesis and measurement before practice. Keep role, champion, patch and setup consistent where possible. Record baseline and practice observations, including context and whether you followed the setup.</p>
      <p class="training-muted">Empty groups mean “not recorded”, never zero. Comparisons cannot show that practice caused a result.</p>
      <div data-experiment-editor></div></section><section class="training-card"><h2>Saved experiments</h2><div data-experiment-list></div>${action('Load older experiments', 'data-older-experiments')}</section>
      ${limitsHTML(ctx.bootstrap)}${boundaryHTML()}<div class="training-actions"><a class="btn ghost" href="#/practice">Back to your training focus</a>${action('Reload saved data', 'data-reload')}${action('Export my personal training data', 'data-export')}</div>`;
    const editor = root.querySelector('[data-experiment-editor]');
    function formFor(entry = null) {
      edited = entry;
      const data = entry?.data || { title: '', hypothesis: '', change: '', measure: '', unit: '', better: 'higher',
        role: roleNames[ctx.params.get('role')] ? ctx.params.get('role') : '', champion: '', patch: '', phase: 'baseline', observations: [] };
      editor.innerHTML = `<h3>${entry ? 'Edit experiment' : 'New experiment'}</h3><form class="training-form">
        ${field('Experiment title', input('title', data.title, 'maxlength="120" required'))}
        ${field('Hypothesis — what do you expect to observe?', prose('hypothesis', data.hypothesis, 'required'))}
        ${field('Practice change', prose('change', data.change || (!entry ? ctx.params.get('focus')?.slice(0, 4000) || '' : ''), 'required'))}
        <div class="training-grid">${field('Measure — use the same definition each time', input('measure', data.measure, 'maxlength="160"'))}
        ${field('Unit', input('unit', data.unit, 'maxlength="160"'))}
        ${field('Preferred direction', `<select name="better">${options([['higher', 'Higher'], ['lower', 'Lower']], data.better)}</select>`)}</div>
        ${contextFields(data, true)}${field('Current phase', `<select name="phase">${options([['baseline', 'Baseline'], ['practice', 'Practice'], ['complete', 'Complete']], data.phase)}</select>`)}
        <p>Keep all numbers, including zeros. Do not add a numeric observation when it was not measured; explain missingness in your hypothesis or context instead.</p>
        <div data-observations>${list(data.observations).map(observationHTML).join('')}</div>
        <p data-observation-count class="training-muted"></p>
        <div class="training-actions">${action('Add baseline observation', 'data-add-observation="baseline"')}${action('Add practice observation', 'data-add-observation="practice"')}</div>
        <div class="training-actions"><button type="submit" class="btn">${entry ? 'Save experiment changes' : 'Save experiment'}</button>${action('Start another experiment', 'data-new-experiment')}</div>
        </form><div data-experiment-comparison>${experimentComparison(data)}</div>`;
      const form = editor.querySelector('form'), observations = form.querySelector('[data-observations]');
      function count() {
        const n = observations.querySelectorAll('[data-observation]').length;
        form.querySelector('[data-observation-count]').textContent = `${n} of 100 observations. Changes are not saved until you choose Save experiment.`;
        form.querySelectorAll('[data-add-observation]').forEach((button) => { button.disabled = n >= 100; });
      }
      count();
      watchForm(state, form);
      on(state, form, 'click', (event) => {
        const button = event.target.closest('button');
        if (!button || !ctx.current()) return;
        if (button.hasAttribute('data-add-observation') && observations.children.length < 100) {
          observations.insertAdjacentHTML('beforeend', observationHTML({ id: newId(), date: today(), phase: button.dataset.addObservation, value: null, adhered: false, context: '' }));
          count();
          observations.lastElementChild.querySelector('input').focus();
        } else if (button.hasAttribute('data-remove-observation')) {
          const row = button.closest('[data-observation]');
          const hasContent = row.querySelector('[name="observation_value"]').value !== '' || row.querySelector('textarea').value !== '';
          if (hasContent && !window.confirm('Remove this observation from the editor? Save the experiment to persist this change.')) return;
          const next = row.nextElementSibling || row.previousElementSibling;
          row.remove();
          count();
          (next?.querySelector('input') || form.querySelector('[data-add-observation]')).focus();
        } else if (button.hasAttribute('data-new-experiment')) {
          if (!confirmDiscard(state, form)) return;
          formFor();
          editor.querySelector('input').focus();
        }
      });
      bindSubmit(state, form, () => ctx.save('experiments', {
        title: value(form, 'title'), hypothesis: value(form, 'hypothesis'), change: value(form, 'change'), measure: value(form, 'measure'), unit: value(form, 'unit'),
        better: value(form, 'better'), role: value(form, 'role'), champion: value(form, 'champion'), patch: value(form, 'patch'), phase: value(form, 'phase'), observations: readObservations(form)
      }, edited), (saved) => {
        edited = saved;
        editor.querySelector('h3').textContent = 'Edit experiment';
        form.querySelector('[type="submit"]').textContent = 'Save experiment changes';
        editor.querySelector('[data-experiment-comparison]').innerHTML = experimentComparison(saved.data);
        savedList();
        ctx.status('Experiment saved. The comparison uses saved observations, not unsaved edits.');
      });
    }
    function savedList() {
      replaceList(root.querySelector('[data-experiment-list]'), `<div class="training-list">${ctx.bootstrap.entries.experiments.map((entry) => `<details class="training-details" data-record-id="${E(entry.id)}"><summary>${E(entry.data.title)} · ${E(entry.data.phase)}</summary>
        <p>${E(entry.data.hypothesis)}</p><p>Change: ${E(entry.data.change)}</p><p>Context: ${E([roleNames[entry.data.role] || entry.data.role, entry.data.champion, entry.data.patch].filter(Boolean).join(' · ') || 'Not recorded')}</p>
        ${experimentComparison(entry.data)}<div class="training-actions">${action('Edit experiment', `data-edit-experiment="${E(entry.id)}"`)}${action('Delete experiment', `data-delete-experiment="${E(entry.id)}"`)}</div></details>`).join('') || '<p>No saved experiments. Start with a measurement and a baseline.</p>'}</div>`);
    }
    formFor();
    savedList();
    on(state, root.querySelector('[data-experiment-list]'), 'click', async (event) => {
      const button = event.target.closest('button');
      if (!button || !ctx.current() || button.disabled) return;
      const id = button.dataset.editExperiment || button.dataset.deleteExperiment;
      const entry = ctx.bootstrap.entries.experiments.find((row) => row.id === id);
      if (!entry) return;
      const form = editor.querySelector('form');
      if (!confirmDiscard(state, form)) return;
      if (button.hasAttribute('data-edit-experiment')) {
        formFor(entry);
        editor.querySelector('input').focus();
        return;
      }
      if (!window.confirm('Permanently delete this experiment and all its observations? This cannot be undone.')) return;
      button.disabled = true;
      const before = formSnapshot(form);
      state.savingForms.add(form);
      try {
        await ctx.remove(entry);
        if (!ctx.current()) return;
        const changedWhileWaiting = form.isConnected && before !== formSnapshot(form);
        if (edited?.id === entry.id) {
          if (changedWhileWaiting) {
            edited = null;
            editor.querySelector('h3').textContent = 'Unsaved experiment — original deleted';
            form.querySelector('[type="submit"]').textContent = 'Save as a new experiment';
          } else formFor();
        }
        savedList();
        ctx.status(`Experiment deleted.${changedWhileWaiting ? ' New edits made while waiting have been kept; save as a new experiment to persist them.' : ''}`);
        if (!changedWhileWaiting) editor.querySelector('input').focus();
      } catch (error) {
        if (ctx.current()) { ctx.status(failure(error), true); button.disabled = false; }
      } finally {
        state.savingForms.delete(form);
      }
    });
    pager(state, ctx, 'experiments', root.querySelector('[data-older-experiments]'), savedList);
    bindReload(state, root.querySelector('[data-reload]'));
    bindExport(state, root.querySelector('[data-export]'), ctx);
  }

  const Training = { register(name, renderer) {
    if (!['review', 'lessons', 'puzzles', 'team', 'lab'].includes(name) || typeof renderer !== 'function') throw new TypeError('Register a supported training section and renderer.');
    renderers.set(name, renderer);
  }, esc: E, field, dispose, canLeave };
  if (typeof window !== 'undefined') {
    window.Training = Training;
    window.showTraining = showTraining;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {
    parseRoute, summarizeExperiment, summarizeSessions, escapeHTML, failure,
    normalizeBootstrap, mergeEntry, mergePage, formSnapshot, createContext, experimentComparison, matchComparison, reviewQueueHTML, Training
  };
})();
