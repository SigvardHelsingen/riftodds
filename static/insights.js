/* Optional plain-script UI; load AFTER app.js and load insights.css after style.css.
 * Parent integration (no router/DOM monkey-patching, no automatic API calls):
 *   Draft: await loadDraftInsights(document.querySelector('#draft-insights'));
 *     Call again after changing view.player.role, range or opp; keep the existing pick UI.
 *   Coaching: await loadCoaching(document.querySelector('#coaching-insights'));
 *     Its role selection persists in view.player.coachRole, independently of Draft.
 *   Repeated loads retain the frame; successful refreshes restore scoped controls,
 *     focus/caret and native disclosures. Draft filter changes retain Clash inputs.
 *   Router: in the #/odds branch, call showOdds(); route() owns nav/timers.
 *   Live: mountLiveInsights(document.querySelector('#live-insights'), live);
 *     This renders AND binds the slot. liveInsights(live) is the HTML-only alternative;
 *     mountLiveInsights also binds an existing wrapper returned by liveInsights.
 * Slots must be connected elements. All APIs use app.js's api(path, options, current).
 * Optional live.odds uses model.pregame_prediction's {ready, blue, red, reason, coverage}.
 * live.odds_enabled === false hides live role assignment; missing flags retain legacy UI.
 * Server live odds default off: set LIVE_ODDS=1 only after Riot use-case review.
 * Live odds POST includes live.game_id when supplied. Changed/ended-game errors offer
 * an explicit tabLive() refresh, never an automatic retry with old role assignments.
 * Goals use goal.progress = {value, games} when supplied by the backend; otherwise recent
 * selected-range form is explicitly NOT progress since goal.created (Unix seconds).
 * Clash uses the supplied scouting API contract; sync=1 is never automatic.
 */
(() => {
  'use strict';
  const roles = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  const latest = new Map();
  const mounts = new WeakMap();
  const panels = new WeakMap();
  let liveMemory = null;
  const list = (value) => Array.isArray(value) ? value : [];
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const count = (value) => finite(value) && value >= 0 ? Math.floor(value) : 0;
  const championId = (value) => Number.isSafeInteger(value) && value > 0;
  const championCell = (id, sub = '') => championId(id) ? champCell(id, esc(sub)) : esc('Unknown champion');
  const roleName = (role) => ROLE_NAMES[role] || role || 'Unknown role';
  const rate = (value) => finite(value) && value >= 0 && value <= 1 ? esc(pct(value, 1)) : '–';
  const number = (value, digits = 1) => finite(value) ? esc(value.toFixed(digits)) : '–';
  const metricValue = (metric, value) => {
    if (!finite(value)) return '–';
    if (metric?.unit === 'pct') return rate(value);
    const format = /^\{:\.(\d)f\}(s?)$/.exec(metric?.unit || '');
    return number(value, format ? Math.min(3, +format[1]) : 1) + (format?.[2] || '');
  };
  const dated = (value, seconds = false) => finite(value) && value > 0
    ? esc(new Date(value * (seconds ? 1000 : 1)).toLocaleDateString()) : 'not recorded';
  const identity = () => JSON.stringify([ME?.username, ME?.account?.puuid]);
  const context = (el, host, player = true, draft = false) => {
    const token = nav, hash = location.hash, who = identity();
    const puuid = DATA?.puuid, range = view.player.range, tab = view.player.tab;
    const role = view.player.role, opponent = String(view.player.opp || '');
    return () => el.isConnected && host.parentElement === el && mounts.get(el) === host
      && nav === token && location.hash === hash && identity() === who
      && (!player || (DATA?.puuid === puuid && view.player.range === range && view.player.tab === tab))
      && (!draft || (view.player.role === role && String(view.player.opp || '') === opponent));
  };
  const statusHtml = () => '<div class="insight-status"><p role="status" aria-live="polite"></p><button type="button" class="insight-button insight-retry" disabled>Retry</button></div>';
  function status(el, message = '', retry = false, error = false) {
    el.querySelector('p').textContent = message;
    el.classList.toggle('insight-error', error);
    const button = el.querySelector('button');
    if (button) { button.disabled = !retry; button.classList.toggle('insight-visible', retry); }
  }
  const details = (heading, body, open = false) => `<details class="insight-details"${open ? ' open' : ''}><summary>${esc(heading)}</summary><div class="insight-detail-body">${body}</div></details>`;
  const sample = (value, games) => `${value}<small class="insight-sub">n=${count(games)}</small>`;
  const record = (row = {}) => count(row.games)
    ? `${count(row.wins)}W ${Math.max(0, count(row.games) - count(row.wins))}L · ${rate(row.wr)}<small class="insight-sub">90% credible ${rate(row.lo)}–${rate(row.hi)} · n=${count(row.games)}</small>`
    : '<span class="insight-muted">No paired games</span>';
  const gold = (row = {}) => sample(finite(row.mean) ? `${row.mean > 0 ? '+' : ''}${number(row.mean, 0)} gold` : '–', row.games);

  const normalized = (text) => String(text || '').trim().replace(/\s+/g, ' ');
  function keyed(root, selector, label) {
    const seen = new Map();
    return [...root.querySelectorAll(selector)].map((node) => {
      const name = label(node), index = seen.get(name) || 0;
      seen.set(name, index + 1);
      return [`${name}|${index}`, node];
    });
  }
  const detailKey = (node) => normalized(node.querySelector(':scope > summary')?.textContent).replace(/ · \d+$/, '');
  const controlKey = (node) => {
    const label = node.closest('label')?.cloneNode(true);
    label?.querySelectorAll('input, select, textarea, button').forEach((control) => control.remove());
    return [node.closest('form')?.className || '', node.tagName, node.type || '',
      node.name || node.getAttribute('aria-label') || (node.tagName === 'SUMMARY' ? detailKey(node.parentElement) : normalized(label?.textContent || node.textContent))].join('|');
  };
  const controlNodes = (root) => keyed(root, 'input, select, textarea, button, summary, .table-scroll', controlKey);
  function snapshot(root) {
    return {
      details: new Map(keyed(root, 'details', detailKey).map(([key, node]) => [key, node.open])),
      controls: new Map(controlNodes(root).map(([key, node]) => [key, {
        value: /^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName) && !node.hasAttribute('data-insight-controlled') ? node.value : undefined,
        checked: node.checked, start: node.selectionStart, end: node.selectionEnd,
        direction: node.selectionDirection, focused: node === document.activeElement,
        left: node.scrollLeft, top: node.scrollTop,
      }])),
    };
  }
  function restore(root, saved) {
    if (!saved) return;
    keyed(root, 'details', detailKey).forEach(([key, node]) => {
      if (saved.details.has(key)) node.open = saved.details.get(key);
    });
    controlNodes(root).forEach(([key, node]) => {
      const control = saved.controls.get(key);
      if (!control) return;
      if (control.value !== undefined && (node.tagName !== 'SELECT' || [...node.options].some((option) => option.value === control.value))) node.value = control.value;
      if (typeof control.checked === 'boolean') node.checked = control.checked;
      if (control.focused && !node.disabled) node.focus({ preventScroll: true });
      if (finite(control.start) && typeof node.setSelectionRange === 'function') node.setSelectionRange(control.start, control.end, control.direction);
      node.scrollLeft = control.left;
      node.scrollTop = control.top;
    });
  }

  // Request guards and rendered-control guards are separate: a pending refresh must not freeze the old UI.
  function panel(el, kind, fetchData, render, { player = true, draft = false } = {}) {
    if (!el?.isConnected) return Promise.resolve();
    const previous = panels.get(el);
    if (previous?.kind === kind && previous.valid()) return previous.run(fetchData, render);
    // Only Draft filters may differ here; navigation, identity, range and tab must still match.
    const carry = previous?.kind === kind && previous.carryable();
    const host = carry ? previous.host : document.createElement('section');
    if (!carry) {
      host.className = `insight insight-${kind}`;
      host.innerHTML = `<div class="insight-content"><p class="insight-muted">Loading ${esc(kind)}…</p></div>${statusHtml()}`;
      el.replaceChildren(host);
    }
    mounts.set(el, host);
    const mounted = context(el, host, player, draft), base = context(el, host, player);
    const state = { kind, host, loaded: carry && previous.loaded, fetchData, render, revision: 0 };
    const valid = () => mounted() && panels.get(el) === state;
    state.valid = valid;
    state.carryable = () => base() && panels.get(el) === state;
    panels.set(el, state);
    const content = host.querySelector('.insight-content'), feedback = host.querySelector('.insight-status');
    const run = async (loader = state.fetchData, painter = state.render) => {
      if (!valid()) return;
      state.fetchData = loader;
      state.render = painter;
      const request = (latest.get(kind) || 0) + 1;
      latest.set(kind, request);
      const current = () => valid() && latest.get(kind) === request;
      host.setAttribute('aria-busy', 'true');
      host.classList.toggle('insight-refreshing', !!state.loaded);
      status(feedback, state.loaded ? `Refreshing ${kind}…` : `Loading ${kind}…`);
      try {
        const data = await loader(current);
        if (!current()) return;
        // Capture immediately before redraw, including edits made while the request was pending.
        const saved = state.loaded ? snapshot(content) : null, revision = ++state.revision;
        painter(content, data, () => valid() && state.revision === revision);
        state.loaded = true;
        prepareTables(host);
        restore(content, saved);
        status(feedback);
      } catch (error) {
        if (current()) {
          if (!state.loaded) content.innerHTML = '<p class="insight-muted">No insights loaded yet. Retry below.</p>';
          status(feedback, `${error.message || 'Could not load insights.'}${state.loaded ? ' Showing previous insights.' : ''}`, true, true);
        }
      } finally {
        if (current()) {
          host.setAttribute('aria-busy', 'false');
          host.classList.remove('insight-refreshing');
        }
      }
    };
    state.run = run;
    feedback.querySelector('button').onclick = () => run();
    return run();
  }

  async function loadDraftInsights(el) {
    if (!el?.isConnected || !DATA?.puuid) return;
    const puuid = DATA.puuid;
    const query = new URLSearchParams({ role: view.player.role || '', range: view.player.range || META.default_range });
    if (view.player.opp) query.set('opp', view.player.opp);
    return panel(el, 'draft', (current) => api(`/api/player/${encodeURIComponent(puuid)}/draft?${query}`, undefined, current), renderDraft, { draft: true });
  }
  function renderDraft(el, data) {
    const matchups = list(data.matchups);
    // pool_games is the server's same-patch, selected-range own-pool evidence, not a global tier list.
    const counters = data.opponent == null ? [] : list(data.counters).filter((row) =>
      championId(row.champion_id) && row.opponent_id === data.opponent && count(row.pool_games) >= 3 && count(row.games) >= 15);
    el.innerHTML = `<header class="insight-head"><p class="insight-eyebrow">${esc(roleName(data.role))} · patch ${esc(data.patch || 'unknown')} · ${esc(data.tier || 'all tiers')}</p><h2>Draft matchups</h2></header>
      ${details('Takeaway', `<p>${data.opponent == null ? 'Choose a lane opponent in the existing draft controls to find options from your own champion pool.' : counters.length ? 'Start with champions you already play. These sampled matchup associations are options to review, not proof of a counter.' : 'No sufficiently sampled suggestions from your selected champion pool for this opponent. You can still review the records below.'}</p>`, true)}
      ${counters.length ? `<div class="insight-grid">${counters.map((row) => `<article class="insight-box">${championCell(row.champion_id, `${count(row.pool_games)} games in your pool`)}<p>${record(row)}</p><p class="insight-muted">Shrunk comparison score: ${rate(row.score)} — not the observed WR.</p>${details('Why this option', `<p>${esc(row.reason || 'Sampled matchup within your own pool.')}</p>`)}</article>`).join('')}</div>` : ''}
      ${matchups.length ? details(`Matchup records · ${matchups.length}`, `<table class="insight-table"><thead><tr><th>Champion</th><th>Opponent</th><th>Peer WR</th><th>Gold at 10</th><th>Gold at 15</th><th>Your record</th></tr></thead><tbody>${matchups.map((row) => `<tr><td>${championCell(row.champion_id)}</td><td>${championCell(row.opponent_id)}</td><td>${record(row)}</td><td>${gold(row.gold10)}</td><td>${gold(row.gold15)}</td><td>${record(row.you)}<small class="insight-sub">Your gold at 10: ${gold(row.you?.gold10)}<br>Your gold at 15: ${gold(row.you?.gold15)}</small></td></tr>`).join('')}</tbody></table><p class="insight-muted">Gold is this role minus the opposing role at exactly 10/15 minutes. Missing frames are not zero gold. Bot/support comparisons do not isolate a 1v1 effect.</p>`, matchups.length <= 8)
        : '<p class="insight-muted">No paired matchups in this patch, role and range yet. Try a broader range; no cross-patch or cross-tier fallback is used.</p>'}
      ${details('Samples and limitations', `<p>${esc(data.note || 'Cached ranked solo games only; small samples remain uncertain.')}</p>`)}
      ${details('Clash scouting', `<p>Look up a team without automatically loading player histories.</p><form class="insight-form insight-clash-form"><label>Team ID<input name="team_id" required maxlength="128" autocomplete="off"></label><label>Platform<select name="platform">${list(META.platforms).map((platform) => `<option value="${esc(platform)}"${platform === DATA?.profile?.platform ? ' selected' : ''}>${esc(platform)}</option>`).join('')}</select></label><button class="insight-button" type="submit">Look up team</button><button class="insight-button insight-secondary" type="button" data-sync disabled>Fetch missing histories</button></form><p class="insight-muted">Fetching histories makes additional Riot API requests for team members and can take time or hit rate limits. Only the explicit “Fetch missing histories” click requests sync=1.</p><div class="insight-clash-status">${statusHtml()}</div><div class="insight-clash-result"></div>`)}`;
    // Scouting scopes to this player's context, not lane filters; replaced forms still invalidate their requests.
    const host = el.parentElement;
    bindClash(el, context(host.parentElement, host));
  }
  function bindClash(el, current) {
    const form = el.querySelector('.insight-clash-form');
    const output = el.querySelector('.insight-clash-result');
    const feedback = el.querySelector('.insight-clash-status .insight-status');
    const buttons = [...form.querySelectorAll('button')];
    let request = 0, lastSync = false, lookedUp = false;
    const fields = () => [form.elements.platform.value, form.elements.team_id.value.trim()];
    const reset = () => { request++; lookedUp = false; buttons[0].disabled = false; buttons[1].disabled = true; output.replaceChildren(); status(feedback); };
    form.addEventListener('input', reset);
    const load = async (sync) => {
      if (!current() || !form.reportValidity()) return;
      const [platform, team] = fields(), index = ++request;
      const valid = () => current() && form.isConnected && index === request && fields()[0] === platform && fields()[1] === team;
      lastSync = sync;
      buttons.forEach((button) => { button.disabled = true; });
      status(feedback, sync ? 'Fetching team histories…' : 'Looking up team…');
      try {
        const data = await api(`/api/clash/${encodeURIComponent(platform)}/${encodeURIComponent(team)}?sync=${sync ? 1 : 0}`, undefined, valid);
        if (!valid()) return;
        lookedUp = true;
        output.innerHTML = clashHtml(data);
        prepareTables(output);
        status(feedback);
      } catch (error) {
        if (valid()) status(feedback, error.message, true, true);
      } finally {
        if (valid()) { buttons[0].disabled = false; buttons[1].disabled = !lookedUp; }
      }
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); load(false); });
    buttons[1].addEventListener('click', () => load(true));
    // A failed sync is retried only by another explicit click, never by polling.
    feedback.querySelector('button').addEventListener('click', () => load(lastSync));
  }
  function clashHtml(data) {
    const team = data.team || {};
    const pool = (rows) => list(rows).slice(0, 5).map((row) => `<li>${championCell(row.champion_id)}<span>${count(row.games)} games · ${rate(typeof row.wr === 'object' ? row.wr?.wr : row.wr)}</span></li>`).join('');
    return `<h3>${esc(team.name || 'Clash team')}${team.tag ? ` [${esc(team.tag)}]` : ''}</h3><p class="insight-muted">Clash tier: ${esc(team.tier ?? 'unknown')}${data.pending ? ' · Roster roles or cached pools are unresolved; this does not mean a sync is running.' : ''}</p>
      <div class="insight-grid">${list(data.members).map((member) => `<article class="insight-box"><h4>${esc(member.riot_id || 'Unknown player')}</h4><p>${esc(roleName(member.role))} · ${esc(member.tier || 'Rank unavailable')}</p>${member.pending ? '<p class="insight-muted">Role or cached pool unresolved</p>' : ''}<h4>Cached champion pool</h4><ul class="insight-pool">${pool(member.pool) || '<li>No sampled pool yet.</li>'}</ul>${list(member.pockets).length ? details('Pocket picks · not sampled pool', `<ul class="insight-pool">${list(member.pockets).map((row) => `<li>${championCell(row.champion_id)}${finite(row.points) ? `<span>${count(row.points)} mastery points</span>` : ''}</li>`).join('')}</ul>`) : ''}</article>`).join('')}</div>
      ${list(data.bans).length ? details('Ban candidates · pool coverage, not guaranteed impact', `<ul class="insight-pool">${list(data.bans).map((row) => `<li>${championCell(row.champion_id)}<span>Share ${rate(row.share)} · ${count(row.games)} games</span></li>`).join('')}</ul>`, true) : '<p class="insight-muted">No sampled ban candidates yet.</p>'}${details('Scouting scope and limitations', `<p>${esc(data.note || 'Cached assigned-role pools only. Ban share is an observed roster frequency, not a predicted Clash pick probability. Mastery pockets do not affect bans.')}</p>`)}`;
  }

  async function loadCoaching(el) {
    if (!el?.isConnected || !DATA?.puuid) return;
    const puuid = DATA.puuid, query = new URLSearchParams({ range: view.player.range || META.default_range });
    return panel(el, 'coaching', (current) => api(`/api/player/${encodeURIComponent(puuid)}/coaching?${query}`, undefined, current), renderCoaching);
  }
  function renderCoaching(el, data, current) {
    const available = list(data.roles).filter((row) => roles.includes(row.role));
    let selected = available.find((row) => row.role === view.player.coachRole) || available[0];
    el.innerHTML = `<header class="insight-head"><p class="insight-eyebrow">Patch ${esc(data.patch || 'unknown')} · ${esc(data.tier || 'no tier baseline')}</p><h2>Your next practice focus</h2><p><a class="insight-training" href="#/practice">Open my private training plan →</a></p></header>
      ${available.length ? `<label class="insight-role-picker">Compare a role<select aria-label="Coaching role" data-insight-controlled>${available.map((row) => `<option value="${esc(row.role)}"${row === selected ? ' selected' : ''}>${esc(roleName(row.role))} · ${count(row.games)} games</option>`).join('')}</select></label>` : ''}<div class="insight-role-content"></div>${forecastHtml(data.forecast)}`;
    const body = el.querySelector('.insight-role-content');
    const draw = () => {
      if (!current()) return;
      const focus = list(selected?.focus).slice(0, 3);
      const goals = list(data.goals).filter((goal) => !selected || goal.role === selected.role);
      body.innerHTML = selected ? `${details('Takeaway', `<p>${focus.length ? `For your next ten ${esc(roleName(selected.role))} games, focus on ${focus.map((metric) => esc(metric.label)).join(', ')}. Try one goal at a time and review the decisions, not just the number.` : 'There is no sufficiently sampled practice target for this role yet. That is not evidence that nothing can improve.'}</p><p class="insight-muted">${count(selected.games)} selected ${esc(roleName(selected.role))} role games. Targets are modest practice benchmarks, not promotion requirements.</p>`, true)}
        <div class="insight-grid">${focus.map((metric, index) => `<article class="insight-box"><h3>${index + 1}. ${esc(metric.label)}</h3><p>${esc(metric.advice || '')}</p><p>Your mean <b>${metricValue(metric, metric.you)}</b> → practice target <b>${metricValue(metric, metric.target)}</b> (${metric.better === -1 ? 'lower' : 'higher'} direction; context matters).</p><p class="insight-muted">Halfway toward the sampled ${esc(metric.target_tier || 'peer')} mean. ${count(metric.games)} player samples.</p>${drillLink(metric.key, selected.role, metric.label)}${data.can_edit === true && finite(metric.target) ? goalAction('start', index, 'Start goal', goals.some((goal) => goal.metric === metric.key)) : ''}</article>`).join('')}</div>
        ${fingerprintHtml(selected, data.tier)}
        ${details('Metric comparisons and sample counts', metricsHtml(selected, data))}
        ${details('How to use these comparisons', `<p>${esc(selected.takeaway || 'Cached role-specific comparisons; missing values are not zero.')}</p>`)}`
        : '<p class="insight-muted">No role-specific coaching games in this patch and range yet. Try a longer range.</p>';
      body.insertAdjacentHTML('beforeend', `<section class="insight-goals"><h3>Practice goals</h3>${data.can_edit !== true ? '<p class="insight-muted">Goal editing is only available for your linked account.</p>' : ''}${goals.length ? goals.map((goal, index) => goalHtml(goal, selected, index, data.can_edit === true)).join('') : '<p class="insight-muted">No saved goals for this role. Start a sampled practice target above when one is available.</p>'}</section>`);
      prepareTables(body);
      body.querySelectorAll('[data-goal-action]').forEach((button) => button.addEventListener('click', () => {
        const start = button.dataset.goalAction === 'start';
        const entry = (start ? focus : goals)[+button.dataset.index];
        if (!entry) return;
        mutateGoal(button, entry, start, selected?.role, data, current, draw, body);
      }));
    };
    el.querySelector('select')?.addEventListener('change', (event) => {
      selected = available.find((row) => row.role === event.target.value);
      view.player.coachRole = event.target.value;
      draw();
    });
    draw();
  }
  // A sampled gap is a starting point for a user-chosen plan, not a diagnosis or a guaranteed fix.
  const DRILLS = { cs_min: ['lasthit', 'Plan consistent farming practice'], cs10: ['lasthit', 'Plan consistent farming practice'],
    deaths: ['review', 'Review a positioning decision'] };
  const drillLink = (key, role, label) => DRILLS[key] ? `<p><a class="insight-drill" href="#/practice/${DRILLS[key][0]}?${esc(new URLSearchParams({ focus: label, role }).toString())}">${DRILLS[key][1]} →</a></p>` : '';
  const goalAction = (action, index, label, saved = false) => `<div class="insight-action"><button type="button" class="insight-button insight-goal-button" data-goal-action="${action}" data-index="${index}"${saved ? ' disabled' : ''}>${saved ? 'Goal already saved' : esc(label)}</button><p class="insight-action-status" role="status" aria-live="polite"></p></div>`;
  function goalHtml(goal, selected, index, editable) {
    const metric = list(selected?.metrics).find((entry) => entry.key === goal.metric) || { label: goal.metric };
    const progress = goal.progress;
    const tracked = progress && finite(progress.value) && finite(progress.games);
    const recent = metric.recent;
    return `<article class="insight-box insight-goal"><h4>${esc(roleName(goal.role))} · ${esc(metric.label)}</h4><p>Target <b>${metricValue(metric, goal.target)}</b> · started ${dated(goal.created, true)}. Review your next ten role games.</p>
      <p class="insight-muted">${tracked ? `Backend progress since this goal began: ${metricValue(metric, progress.value)} · ${count(progress.games)} valid samples.` : `Recent selected-range form (not progress since this goal began): ${metricValue(metric, recent?.value)} · ${count(recent?.games)} valid samples in the last ten selected role games. These may include games before the goal.`}</p>${editable ? goalAction('delete', index, 'Remove goal') : ''}</article>`;
  }
  async function mutateGoal(button, entry, start, selectedRole, data, current, draw, body) {
    if (!current() || button.disabled || !button.isConnected || data.can_edit !== true) return;
    const puuid = DATA.puuid, role = start ? selectedRole : entry.role, metric = start ? entry.key : entry.metric;
    const valid = () => current() && button.isConnected && body.contains(button) && DATA?.puuid === puuid;
    const feedback = button.parentElement.querySelector('p');
    const buttons = [...body.querySelectorAll('[data-goal-action]')];
    const disabled = buttons.map((item) => item.disabled);
    buttons.forEach((item) => { item.disabled = true; });
    feedback.textContent = start ? 'Saving goal…' : 'Removing goal…';
    try {
      const path = `/api/player/${encodeURIComponent(puuid)}/goals`;
      const options = start ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, metric, target: entry.target }) } : { method: 'DELETE' };
      const query = start ? '' : `?${new URLSearchParams({ role, metric })}`;
      const result = await api(path + query, options, valid);
      if (!valid()) return;
      if (!Array.isArray(result.goals)) throw new Error('The server did not return the saved goals. Retry to refresh.');
      data.goals = result.goals;
      draw();
    } catch (error) {
      if (!valid()) return;
      feedback.textContent = error.message || 'Could not update the goal.';
      feedback.classList.add('insight-error');
      button.textContent = start ? 'Retry start goal' : 'Retry remove goal';
    } finally {
      if (valid()) buttons.forEach((item, index) => { item.disabled = disabled[index]; });
    }
  }
  function fingerprintHtml(role, tier) {
    return details(`Playstyle fingerprint · vs ${tier || 'unavailable tier'}`, `<p>Role-specific, direction-adjusted percentiles of your mean versus sampled peer games. 50 is the middle of this sample, not a skill grade; higher counts are not always better decisions.</p><div class="insight-fingerprint">${list(role.fingerprint).map((axis) => {
      const value = finite(axis.percentile) ? Math.max(0, Math.min(100, axis.percentile)) : null;
      return `<div class="insight-axis"><div class="insight-axis-label"><span>${esc(axis.label)}</span><b>${value == null ? 'Not enough samples' : `${number(value, 0)} / 100`}</b></div><div class="insight-percentile"${value == null ? ' aria-hidden="true"' : ` role="meter" aria-label="${esc(axis.label)} percentile" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"`} >${value == null ? '' : `<span style="width:${value}%"></span>`}</div></div>`;
    }).join('')}</div><p class="insight-scale"><span>0 · lower</span><span>50</span><span>100 · higher</span></p>`, true);
  }
  function metricsHtml(role, data) {
    const metricSample = (metric, value, n) => sample(metricValue(metric, value), n);
    return `<table class="insight-table"><thead><tr><th>Metric</th><th>You</th><th>${esc(data.tier || 'No tier')} mean</th><th>${esc(data.next_tier || 'No next tier')} mean</th><th>Percentile</th><th>Recent / previous</th></tr></thead><tbody>${list(role.metrics).map((metric) => `<tr><th scope="row">${esc(metric.label)}</th><td>${metricSample(metric, metric.you, metric.games)}</td><td>${metricSample(metric, metric.current, metric.baseline_games)}</td><td>${metricSample(metric, metric.next, metric.next_games)}</td><td>${finite(metric.percentile) ? `${number(metric.percentile, 0)} / 100` : '–'}</td><td>${metricSample(metric, metric.recent?.value, metric.recent?.games)} / ${metricSample(metric, metric.previous?.value, metric.previous?.games)}</td></tr>`).join('')}</tbody></table><p class="insight-muted">n is valid participant-game samples for each metric. Recent/previous are fixed ten-role-game windows within the selected range, not goal-specific windows. Missing or undersampled means remain blank.</p>`;
  }
  function forecastHtml(forecast) {
    if (!forecast) return '';
    const reasons = { insufficient_observations: 'Not enough distinct rank observations yet.', insufficient_games: 'Not enough games between rank observations.', negative_pace: 'Observed displayed LP pace is negative; no promotion estimate.', zero_pace: 'Observed displayed LP pace is flat; no promotion estimate.', unranked: 'No ranked baseline is available.', stale_history: 'Rank history does not match the current profile.', dynamic_apex_target: 'Apex thresholds change; no fixed next-tier estimate.', invalid_profile: 'Current rank data is incomplete.', invalid_history: 'Rank history cannot support an estimate.' };
    const uncertainty = forecast.uncertainty || {};
    const target = forecast.target;
    const estimate = forecast.available === true && finite(forecast.estimated_games) && finite(forecast.lp_per_game) && forecast.lp_per_game > 0;
    return details('Displayed LP pace · conditional, not a promise', `<p>${estimate ? `If the observed displayed LP pace stayed the same, roughly <b>${count(forecast.estimated_games)} games</b> to ${esc(target?.tier || 'the next checkpoint')} ${esc(target?.division || '')}. This is not a promotion probability.` : esc(reasons[forecast.reason] || forecast.reason || 'No supported pace estimate yet.')}</p><p>${count(forecast.observations)} distinct observations · ${count(forecast.games)} games · ${number(forecast.lp_per_game)} displayed LP/game. ${target ? `${number(forecast.next_lp, 0)} displayed LP to the checkpoint.` : ''}</p><p class="insight-muted">Observed interval pace: ${number(uncertainty.lp_per_game_lo)} to ${number(uncertainty.lp_per_game_hi)} LP/game. ${estimate ? `Conditional games range: ${finite(uncertainty.estimated_games_lo) ? count(uncertainty.estimated_games_lo) : 'unknown'} to ${finite(uncertainty.estimated_games_hi) ? count(uncertainty.estimated_games_hi) : 'no finite slow-end estimate'}.` : ''} These are observed interval extremes, not confidence limits.</p><p class="insight-muted">No hidden MMR estimate or promised rank. Future gains, losses and rank rules can change. ${esc(forecast.note || '')}</p>`);
  }

  async function showOdds() {
    if (location.hash !== '#/odds') return;
    const app = document.querySelector('#app');
    if (!app) return;
    return panel(app, 'odds', (current) => api('/api/odds', undefined, current), (el, data) => {
      el.innerHTML = `<header class="insight-head"><p class="insight-eyebrow">Model transparency</p><h1>What these odds can tell you</h1><p>Probabilities are estimates, not guarantees. Read the held-out evidence before relying on them.</p></header><div class="insight-grid insight-scorecards">${scorecardHtml('pregame', data.pregame)}${scorecardHtml('ingame', data.ingame)}</div>`;
    }, { player: false });
  }
  function scorecardHtml(name, card = {}) {
    card = card || {};
    const report = card.report || {}, overall = report.overall || {}, split = report.split || {};
    const ready = card.ready === true;
    const validated = ready && report.ready === true && report.validation?.passed === true;
    const scores = (label, row) => `<tr><th scope="row">${esc(label)}</th><td>${number(row?.brier, 4)}</td><td>${number(row?.log_loss, 4)}</td></tr>`;
    const reliability = list(overall.calibration);
    return `<article class="insight-box insight-scorecard"><h2>${name === 'pregame' ? 'Pregame · known draft' : 'In-game · recorded timeline state'}</h2><p class="insight-readiness">${validated ? 'Ready · held-out validation passed' : ready ? 'Server reports ready · validation details unavailable' : 'Unavailable · no usable validated model'}</p>${!validated ? `<p>${esc(card.reason || report.reason || (ready ? 'Validation details were not supplied.' : 'Not enough validated cached evidence yet.'))}</p>` : ''}<p class="insight-muted">Last trained: ${dated(card.trained_at, true)}. ${name === 'pregame' ? 'Requires a known patch and all ten explicitly assigned roles. Not a prediction from current live-state gold or objectives.' : 'Repeated minute states from the same game are correlated, not independent games.'}</p>
      <dl class="insight-counts"><div><dt>Training games / samples</dt><dd>${count(report.train_games)} / ${count(report.train_samples)}</dd></div><div><dt>Chronological holdout games / samples</dt><dd>${count(report.test_games)} / ${count(report.test_samples)}</dd></div><div><dt>Scored holdout games / samples</dt><dd>${count(overall.games)} / ${count(overall.samples)}</dd></div></dl>
      ${details('Held-out scores and reliability', `<p>Lower Brier score and log loss are better. These measure probability quality, not a promised win-prediction accuracy.</p><table class="insight-table insight-small-table"><thead><tr><th>Held-out model / baseline</th><th>Brier</th><th>Log loss</th></tr></thead><tbody>${scores('Model', overall)}${scores('Frozen training win prior', overall.baseline)}${scores('50/50 baseline', { brier: overall.coin_brier, log_loss: overall.coin_log_loss })}</tbody></table>${reliability.length ? `<h3>Reliability · blue-side wins</h3><table class="insight-table"><thead><tr><th>Probability bin</th><th>Mean predicted</th><th>Actual win share</th><th>Samples</th><th>Distinct games</th></tr></thead><tbody>${reliability.map((bin) => `<tr><td>${rate(bin.lo)}–${rate(bin.hi)}</td><td>${rate(bin.predicted)}</td><td>${rate(bin.observed)}</td><td>${count(bin.samples)}</td><td>${count(bin.games)}</td></tr>`).join('')}</tbody></table><p class="insight-muted">Sample-weighted reliability, not fitted recalibration. Games may appear in more than one bin; do not add bin game counts to infer independent games.</p>` : '<p class="insight-muted">No held-out reliability samples supplied.</p>'}`, true)}
      ${details('Data split and limitations', `<p>${esc(split.method || 'Chronological split details unavailable.')}</p><p>Training starts: ${dated(split.train_first_start)}–${dated(split.train_last_start)}. Holdout starts: ${dated(split.test_first_start)}–${dated(split.test_last_start)}. Overlapping games excluded: ${count(split.excluded_overlapping_games)}.</p><p>${esc(report.feature_policy || '')} ${esc(report.fit_policy || '')}</p><p>Inputs: ${list(card.features || report.features).map((feature) => esc(feature)).join(', ') || 'not supplied'}.</p><ul>${list(report.limitations).map((limitation) => `<li>${esc(limitation)}</li>`).join('')}</ul><p>Cached solo-queue games are not a representative global sample. Rank and mastery are not silently substituted; historical ranks are unavailable.</p>`)}</article>`;
  }

  function pregameHtml(odds) {
    const usable = odds?.ready === true && finite(odds.blue) && finite(odds.red) && odds.blue >= 0 && odds.blue <= 1 && odds.red >= 0 && odds.red <= 1;
    const coverage = odds?.coverage;
    return `<div class="insight-pregame"><h3>Pregame odds · not current live-state odds</h3><p>${usable ? `<b>Blue ${rate(odds.blue)} · Red ${rate(odds.red)}</b>` : esc(odds?.reason || 'Assign all ten roles yourself before requesting an estimate. Missing roles are never inferred from champions, rank or identity.')}</p><p class="insight-muted">Based on the known draft and eligible earlier cached history, not what has happened in this live game. Rank, mastery and hidden identities are not substituted. <a href="#/odds">Read model evidence</a>.</p>${coverage ? details('Draft coverage', `<p>Supported draft slots: ${count(coverage.draft?.supported_slots)} / ${count(coverage.draft?.known_slots)}. Supported role matchups: ${count(coverage.matchups?.supported_roles)} / 5. Eligible identified players: ${count(coverage.players?.eligible)}.</p><p>${esc(coverage.source || '')}</p>`) : ''}</div>`;
  }
  function jungleHtml(players) {
    const sampled = players.filter((player) => player.jungle);
    return sampled.length ? details('Historical jungle habits · not a live route prediction', `<p>Only cached historical jungle samples. A player's past jungle games do not establish their role or route in this game.</p><div class="insight-grid">${sampled.map((player) => {
      const habits = player.jungle, proxy = habits.early_jungle_proxy || {};
      const starts = habits.early_jungle_side || habits.start || {}, first = habits.first_gank || {};
      return `<article class="insight-box">${championCell(player.champion_id, player.hidden ? 'Hidden player' : player.riot_id || 'Unknown player')}<p>${count(habits.games)} cached jungle games.</p><p>${esc(proxy.label || 'Early jungle side at 2:00 (nearest-camp proximity proxy, not starting buff)')}: red ${count(starts.red)}, blue ${count(starts.blue)} · ${count(proxy.observed)} classified, ${count(proxy.unknown)} unknown.</p><p>Enemy-side proximity samples: ${count(habits.invades)} (not confirmed invades).</p><p>${esc(first.label || 'First lane takedown before 10:00 (kill/assist, not all ganks)')}: ${count(first.games)} games${finite(first.median_t) ? ` · median ${esc(mmss(first.median_t))}` : ''}.</p><ul>${Object.entries(first.lanes || {}).map(([lane, games]) => `<li>${esc(lane)}: ${count(games)}</li>`).join('')}</ul><p class="insight-muted">Early lane takedowns per game: ${number(habits.lane_takedowns_per_game ?? habits.ganks_per_game)}. This misses ganks without kills/assists.</p></article>`;
    }).join('')}</div>`) : '<p class="insight-muted">No cached jungle habits supplied for this lineup.</p>';
  }
  function liveInsights(live) {
    if (!live?.in_game) return '';
    const players = list(live.players), disabled = live.odds_enabled === false;
    const known = players.filter((player) => [100, 200].includes(player.team) && championId(player.champion_id));
    const full = known.length === 10 && [100, 200].every((team) => known.filter((player) => player.team === team).length === 5);
    return `<section class="insight insight-live"><header class="insight-head"><h2>Before-the-game context</h2><p>Historical information only. Nothing here observes the current jungle path or live game state.</p></header><div class="insight-live-odds">${disabled ? '<div class="insight-pregame"><h3>Live odds disabled</h3><p>Live odds are disabled pending Riot use-case review. <a href="#/odds">Read model evidence</a>.</p></div>' : pregameHtml(live.odds)}</div>${disabled ? '' : details('Assign roles to request pregame odds', `<p>Choose each player's role yourself: one Top, Jungle, Mid, Bot and Support per team. No roles are prefilled from champion popularity or rank.</p>${full ? `<form class="insight-live-form"><div class="insight-grid">${[100, 200].map((team) => `<fieldset class="insight-fieldset"><legend>${team === 100 ? 'Blue' : 'Red'} side</legend>${known.filter((player) => player.team === team).map((player) => `<label class="insight-assignment">${championCell(player.champion_id, player.hidden ? 'Hidden player' : player.riot_id || 'Unknown player')}<select required data-team="${team}" data-champion="${player.champion_id}" aria-label="${esc(`${team === 100 ? 'Blue' : 'Red'} ${champ(player.champion_id).name} role`)}"><option value="">Choose role…</option>${roles.map((role) => `<option value="${role}">${esc(roleName(role))}</option>`).join('')}</select></label>`).join('')}</fieldset>`).join('')}</div><button type="submit" class="insight-button">Calculate pregame odds</button>${statusHtml()}</form>` : '<p class="insight-muted">All ten known champions and their real teams are required. No synthetic lineup will be sent.</p>'}`)}<div class="insight-live-habits">${jungleHtml(players)}</div></section>`;
  }
  function mountLiveInsights(el, live) {
    if (!el?.isConnected) return;
    if (!live?.in_game) { el.replaceChildren(); mounts.delete(el); liveMemory = null; return; }
    const players = list(live.players);
    const key = JSON.stringify([nav, location.hash, identity(), DATA?.puuid, view.player.range, view.player.tab, live.odds_enabled === false, live.game_id, live.started, players.map((player) => [player.team, player.champion_id]).sort()]);
    if (liveMemory?.key !== key) liveMemory = { key, assignments: new Map(), odds: null, open: false };
    const memory = liveMemory;
    const oldHost = mounts.get(el);
    if (oldHost?.parentElement === el && oldHost.dataset.liveKey === key) {
      oldHost.querySelector('.insight-live-habits').innerHTML = jungleHtml(players);
      return; // Keep user assignments and an in-flight request during same-game polling.
    }
    if (oldHost || !el.querySelector(':scope > .insight-live')) el.innerHTML = liveInsights(live);
    const host = el.querySelector(':scope > .insight-live');
    host.dataset.liveKey = key;
    mounts.set(el, host);
    const mounted = context(el, host);
    const valid = () => mounted() && liveMemory === memory && host.dataset.liveKey === key;
    const form = host.querySelector('.insight-live-form');
    prepareTables(host);
    if (!form) return;
    const disclosure = form.closest('details');
    disclosure.open = memory.open;
    disclosure.addEventListener('toggle', () => { if (valid()) memory.open = disclosure.open; });
    const selects = [...form.querySelectorAll('select')], submit = form.querySelector('button[type="submit"]');
    const output = host.querySelector('.insight-live-odds'), feedback = form.querySelector('.insight-status');
    if (memory.odds) output.innerHTML = pregameHtml(memory.odds);
    const retry = feedback.querySelector('button');
    let request = 0, refreshRequired = false;
    selects.forEach((select) => {
      const slot = `${select.dataset.team}:${select.dataset.champion}`;
      select.value = memory.assignments.get(slot) || '';
      select.addEventListener('change', () => {
        if (!valid() || refreshRequired) return;
        memory.assignments.set(slot, select.value);
        memory.odds = null;
        output.innerHTML = pregameHtml(null);
        status(feedback, 'Roles changed. Calculate again for this assignment.');
      });
    });
    const calculate = async () => {
      if (!valid() || refreshRequired || !form.reportValidity()) return;
      const assigned = selects.map((select) => ({ team: +select.dataset.team, champion_id: +select.dataset.champion, role: select.value }));
      if (![100, 200].every((team) => new Set(assigned.filter((row) => row.team === team).map((row) => row.role)).size === 5)) {
        status(feedback, 'Assign each role exactly once on each team.', false, true);
        return;
      }
      const puuid = DATA?.puuid;
      if (!puuid) { status(feedback, 'Open a player profile to request odds for its cached real game.', false, true); return; }
      const index = ++request, current = () => valid() && request === index;
      submit.disabled = true;
      selects.forEach((select) => { select.disabled = true; });
      status(feedback, 'Calculating pregame odds…');
      try {
        const body = { roles: assigned };
        if (live.game_id != null) body.game_id = live.game_id;
        const result = await api(`/api/live/${encodeURIComponent(puuid)}/odds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, current);
        if (!current()) return;
        memory.odds = result;
        output.innerHTML = pregameHtml(result);
        status(feedback);
      } catch (error) {
        if (current()) {
          refreshRequired = /game changed|no current game/i.test(error.message || '');
          if (refreshRequired) {
            memory.odds = null;
            output.innerHTML = pregameHtml({ ready: false, reason: error.message });
          }
          retry.textContent = refreshRequired ? 'Refresh live game' : 'Retry';
          status(feedback, error.message, true, true);
        }
      } finally {
        if (current()) { submit.disabled = refreshRequired; selects.forEach((select) => { select.disabled = refreshRequired; }); }
      }
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); calculate(); });
    retry.addEventListener('click', async () => {
      if (!valid()) return;
      if (!refreshRequired) return calculate();
      status(feedback, 'Refreshing the live game…');
      try {
        await tabLive();
        if (valid()) status(feedback, 'The view still shows the previous game. Refresh again before assigning roles.', true, true);
      } catch (error) {
        if (valid()) status(feedback, error.message, true, true);
      }
    });
  }

  Object.assign(window, { loadDraftInsights, loadCoaching, showOdds, liveInsights, mountLiveInsights });
})();
