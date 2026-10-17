// Private, member-authored teamwork. The training core owns routing, sessions and dirty navigation guards.
// ctx.request must retain HTTP error.status/statusCode: access-removal 404 and revision-conflict 409 are distinct.
(() => {
  'use strict';
  const T = window.Training;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const kinds = ['reviews', 'puzzles', 'boards'];
  const singular = { reviews: 'review', puzzles: 'puzzle', boards: 'strategy board' };
  const enc = encodeURIComponent;
  const target = 'style="display:inline-block;min-height:44px;min-width:44px;max-width:100%;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere"';
  const disclosure = 'style="min-height:44px;min-width:44px;max-width:100%"';
  const button = (action, label, extra = '') => `<button type="button" class="btn" data-action="${action}" ${target} ${extra}>${esc(label)}</button>`;
  const field = (label, html) => `<label style="display:grid;gap:6px;min-width:0">${esc(label)}${html}</label>`;
  const input = (name, value = '', attrs = '') => `<input name="${name}" value="${esc(value)}" ${target} ${attrs}>`;
  const prose = (name, value = '', max = 4000, attrs = '') => `<textarea name="${name}" rows="3" maxlength="${max}" ${attrs} style="min-height:88px;min-width:44px;width:100%;max-width:100%;box-sizing:border-box">${esc(value)}</textarea>`;
  const number = (name, value, max = 1, step = 'any') => input(name, value, `type="number" min="0" max="${max}" step="${step}" required`);
  const options = (values, selected) => values.map((value) => `<option value="${value}"${value === selected ? ' selected' : ''}>${esc(value)}</option>`).join('');
  const select = (name, values, selected) => `<select name="${name}" ${target}>${options(values, selected)}</select>`;
  const text = (value) => `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(value)}</p>`;
  const code = (error) => Number(error?.status ?? error?.statusCode ?? error?.response?.status) || Number(/^HTTP (\d{3})\b/.exec(error?.message || '')?.[1]);
  const stale = new Error('Obsolete training view');
  const identity = () => typeof ME !== 'undefined' ? ME?.username : null;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const blankMoment = (id) => ({ id, seconds: 0, title: '', known: '', options: '', decision: '', outcome: '', lesson: '', annotations: [] });

  T.register('team', (root, ctx) => {
    const username = identity();
    const host = document.createElement('section');
    host.className = 'training';
    host.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere';
    root.replaceChildren(host);
    let alive = true, generation = 0, busy = false, sequence = 0;
    let team = null, draft = null, pages = {}, selectedId = ctx.id ? String(ctx.id) : null;
    let bootstrap = ctx.bootstrap;
    const current = (version = generation) => alive && version === generation && ctx.current() && host.isConnected && identity() === username;
    const guard = (version) => { if (!current(version)) throw stale; };
    const uid = () => `mark-${Date.now().toString(36)}-${++sequence}`;
    const teamPath = (id = selectedId) => `/api/training/teams/${enc(id)}`;
    const memberPath = (id, member) => `${teamPath(id)}/members/${enc(member)}`;
    const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const say = (message, error = false) => {
      if (!current()) return;
      const status = host.querySelector('[data-status]');
      if (status) { status.textContent = message; status.setAttribute('role', error ? 'alert' : 'status'); }
      ctx.status(message, error);
    };
    const purgeBootstrap = (id) => {
      if (!bootstrap) return;
      bootstrap.teams = (bootstrap.teams || []).filter((item) => String(item.id) !== String(id));
      bootstrap.invitations = (bootstrap.invitations || []).filter((item) => String(item.id ?? item.team_id) !== String(id));
      // Team records must never remain reachable via the core's personal-entry cache.
      for (const kind of kinds) {
        if (Array.isArray(bootstrap.entries?.[kind])) bootstrap.entries[kind] = bootstrap.entries[kind].filter((entry) => String(entry.team_id) !== String(id));
      }
    };
    const clearShared = () => {
      team = null;
      if (draft) { draft.data = null; draft.entry = null; draft.form?.replaceChildren(); }
      draft = null;
      for (const page of Object.values(pages)) page.entries.length = 0;
      pages = {};
    };
    const forget = (id) => {
      ++generation;
      purgeBootstrap(id);
      clearShared();
      host.innerHTML = `<h1>Private team workspace</h1>${back()}<p data-status role="alert"></p>`;
      say('This team or document is no longer accessible. Shared notes and drafts have been cleared. Return to your teams and refresh the list.', true);
    };
    const fail = (error) => {
      if (!current() || error === stale) return;
      if (code(error) === 404 && selectedId) { forget(selectedId); return; }
      const limited = /storage|capacity|limit|cannot receive another/i.test(error?.message || '');
      say(code(error) === 409 && !limited && selectedId
        ? `The saved revision changed.${draft ? ' Your unsaved draft is still here.' : ''} Refresh team explicitly, then reopen the saved document; confirm only when you are ready to discard any draft.`
        : `${error?.message || 'The request failed.'} Your unsaved inputs have been kept.`, true);
    };
    const request = async (path, opts) => {
      const version = generation;
      try {
        const result = await ctx.request(path, opts);
        if (!current(version)) throw stale;
        return result;
      } catch (error) {
        if (!current(version)) throw stale;
        throw error;
      }
    };
    const run = async (fn, control) => {
      if (!current()) return;
      if (busy) { say('Please wait for the current action to finish.'); return; }
      busy = true;
      host.setAttribute('aria-busy', 'true');
      const focused = control === document.activeElement;
      const formKind = control?.closest('form')?.dataset.form;
      if (control) control.disabled = true;
      try { await fn(); } catch (error) { fail(error); }
      finally {
        busy = false;
        if (current()) host.setAttribute('aria-busy', 'false');
        if (current() && control?.isConnected && control.dataset.action !== 'add-mark') control.disabled = false;
        if (current() && focused && document.activeElement === document.body) {
          const replacement = control.isConnected ? control : formKind ? host.querySelector(`form[data-form="${formKind}"] button[type="submit"]`) : null;
          replacement?.focus();
        }
      }
    };
    const back = () => `<a class="btn" href="#/practice/team" ${target}>Your private teams</a>`;
    const inviteDirty = () => [...host.querySelectorAll('form[data-form="invite"] input')].some((input) => input.value !== input.defaultValue);
    const confirmDiscard = (includeInvite = false) => (!draft?.dirty && (!includeInvite || !inviteDirty())) || window.confirm('Discard unsaved changes to this private team document or invitation?');
    ctx.guardDirty?.(() => !!draft?.dirty || inviteDirty());
    const activeMember = (value) => value?.owner === username || value?.members?.some((member) => member.username === username && member.status === 'active');
    const mayEdit = (entry) => activeMember(team) && (!entry || entry.kind === 'boards' || entry.owner === username);
    const mayDelete = (entry) => activeMember(team) && (entry.owner === username || team.owner === username);
    const keepTeam = (value) => {
      if (!bootstrap) return;
      bootstrap.teams = [...(bootstrap.teams || []).filter((item) => String(item.id) !== String(value.id)), value];
      bootstrap.invitations = (bootstrap.invitations || []).filter((item) => String(item.id ?? item.team_id) !== String(value.id));
    };
    const verify = async (entry = null, deleting = false) => {
      const version = generation;
      const reply = await request(teamPath());
      guard(version);
      if (!activeMember(reply.team) || String(reply.team.id) !== selectedId) throw Object.assign(new Error('Team access removed'), { status: 404 });
      team = reply.team;
      keepTeam(team);
      renderMembers();
      if (entry && !(deleting ? mayDelete(entry) : mayEdit(entry))) throw new Error('Your current team permissions do not allow this change. Your draft has been kept.');
    };
    const dirty = () => {
      if (!draft) return;
      draft.dirty = true;
      draft.form.dataset.trainingDirty = 'true';
    };
    const changed = (form) => form.dispatchEvent(new Event('input', { bubbles: true }));

    function homeLists() {
      const teams = (bootstrap?.teams || []).filter(activeMember);
      host.querySelector('[data-teams]').innerHTML = teams.length ? teams.map((value) => `<li><a class="btn" ${target} href="#/practice/team/${enc(value.id)}">${esc(value.name)}</a>${text(`Private team · owner: ${value.owner}`)}</li>`).join('') : '<li>No accepted teams yet.</li>';
      const invites = bootstrap?.invitations || [];
      host.querySelector('[data-invites]').innerHTML = invites.length ? invites.map((invite, index) => `<li>${text(`${invite.name ?? invite.team_name ?? 'Private team'} · invited by ${invite.owner ?? invite.invited_by ?? 'team owner'}`)}<div class="training-actions">${button('accept', 'Accept invitation', `data-invite="${index}"`)} ${button('decline', 'Decline invitation', `data-invite="${index}"`)}</div></li>`).join('') : '<li>No pending invitations.</li>';
    }
    function home() {
      host.innerHTML = `<header class="training-head"><h1>Your private teams</h1><p>Share authored notes and strategy diagrams only with people who explicitly accept your invitation. Nothing here is public.</p><a class="btn" ${target} href="#/practice">Training workspace</a></header>
        <p class="training-status" data-status role="status" aria-live="polite"></p>
        <section class="training-card"><h2>Create a private team</h2><form class="training-form" data-form="create">${field('Team name', input('name', '', 'maxlength="120" required autocomplete="off"'))}<button class="btn" type="submit" ${target}>Create private team</button></form></section>
        <section class="training-card"><h2>Accepted teams</h2><ul class="training-list" data-teams></ul></section>
        <section class="training-card"><h2>Pending invitations</h2><p class="training-muted">Acceptance shares access to the team's documents. No roster or notes are shown before you accept.</p><ul class="training-list" data-invites></ul></section>
        ${button('refresh-home', 'Refresh team list')}`;
      homeLists();
    }
    function renderMembers() {
      const area = host.querySelector('[data-members]');
      if (!area || !team) return;
      const owner = team.owner === username;
      const previousForm = area.querySelector('form[data-form="invite"]');
      const previous = previousForm?.querySelector('[name="username"]');
      const focused = previous === document.activeElement;
      const selection = focused ? [previous.selectionStart, previous.selectionEnd] : null;
      area.innerHTML = `<p>Owner: ${esc(team.owner)}. Invitations require explicit acceptance.</p><ul class="training-list">${(team.members || []).map((member, index) => `<li>${text(`${member.username} · ${member.status === 'active' ? 'accepted member' : 'invitation pending'}`)}${owner && member.username !== username ? button('revoke', member.status === 'active' ? `Revoke ${member.username}` : `Cancel invitation for ${member.username}`, `data-member="${index}"`) : ''}</li>`).join('')}</ul>
        ${owner ? `<form class="training-form" data-form="invite">${field('Invite an existing member by username', input('username', '', 'maxlength="64" required autocomplete="off" autocapitalize="none" spellcheck="false"'))}<button class="btn" type="submit" ${target}>Send private invitation</button></form><p>As owner, delete the team rather than leave it.</p>${button('delete-team', 'Delete private team…')}` : button('leave', 'Leave private team…')}`;
      const replacement = area.querySelector('form[data-form="invite"]');
      // Retain the actual form so the core's saved baseline, selection and any
      // typing during a permission check survive this asynchronous roster update.
      if (replacement && previousForm) {
        replacement.replaceWith(previousForm);
        if (focused) { previous.focus(); previous.setSelectionRange(...selection); }
      }
    }
    function teamShell() {
      host.innerHTML = `<header class="training-head"><h1>${esc(team.name)} · private teamwork</h1><p>Collaborate on shared boards and discuss choices, not guaranteed answers. These notes are visible only to accepted teammates, never on public profiles.</p><div class="training-actions">${back()} ${button('refresh-team', 'Refresh team…')}</div></header>
        <p class="training-status" data-status role="status" aria-live="polite"></p>
        <details class="training-details"><summary ${disclosure}>Members and invitations</summary><div data-members></div></details>
        <div class="training-actions">${kinds.map((kind) => button('new', `New team ${singular[kind]}`, `data-kind="${kind}"`)).join(' ')}</div>
        <section class="training-card" data-editor aria-label="Private team document"></section>
        ${kinds.map((kind) => `<section class="training-card" data-list-kind="${kind}"><h2>Private team ${kind === 'boards' ? 'strategy boards' : kind}</h2><p class="training-muted">${kind === 'boards' ? 'All accepted teammates can edit. Only the creator or team owner can delete.' : 'Only the creator can edit; the creator or team owner can delete.'}</p><ul class="training-list" data-entries></ul><p data-list-status role="status" aria-live="polite">Loading newest documents…</p>${button('older', 'Load older', `data-kind="${kind}" hidden`)}</section>`).join('')}`;
      renderMembers();
    }
    async function loadTeam() {
      ++generation;
      clearShared();
      host.innerHTML = `<h1>Private team workspace</h1>${back()}<p data-status role="status">Checking current membership…</p>`;
      const version = generation;
      await verify();
      guard(version);
      teamShell();
      for (const kind of kinds) pages[kind] = { entries: [], more: true, loading: false, loaded: false };
      await Promise.all(kinds.map((kind) => loadPage(kind)));
    }
    function renderList(kind) {
      const area = host.querySelector(`[data-list-kind="${kind}"]`), page = pages[kind];
      if (!area || !page) return;
      area.querySelector('[data-entries]').innerHTML = page.entries.map((entry, index) => `<li>${button('open', entry.data.title || `Untitled team ${singular[kind]}`, `data-kind="${kind}" data-entry="${index}"`)}${text(`By ${entry.owner} · revision ${entry.revision} · private to this team`)}</li>`).join('');
      area.querySelector('[data-list-status]').textContent = page.loading ? 'Loading…' : !page.loaded ? 'Documents could not be loaded. Retry below; unavailable is not an empty list.' : page.entries.length ? `${page.entries.length} loaded${page.more ? '; older documents may be available.' : '; end of list.'}` : 'No documents in this list yet.';
      const older = area.querySelector('[data-action="older"]');
      older.hidden = !page.more;
      older.disabled = page.loading;
      older.textContent = page.loaded ? 'Load older' : 'Retry document list';
    }
    async function loadPage(kind) {
      const page = pages[kind];
      if (!page || page.loading || !page.more) return;
      const version = generation;
      page.loading = true;
      renderList(kind);
      try {
        // Always use the explicitly paginated lists; GET team may carry only its newest documents.
        const known = new Set(page.entries.map((entry) => entry.id));
        // Other teammates can shift offsets too. Rescan bounded pages to avoid
        // skipping a document after an earlier record was removed remotely.
        for (let offset = 0; offset < 200; offset += 50) {
          const reply = await request(`/api/training/entries/${kind}?team_id=${enc(selectedId)}&offset=${offset}&limit=50`);
          guard(version);
          if (!Array.isArray(reply.entries)) throw new Error('Invalid team document list response.');
          const entries = reply.entries.slice(0, 50);
          for (const entry of entries) {
            if (entry.kind !== kind || String(entry.team_id) !== selectedId || !entry.data) continue;
            const index = page.entries.findIndex((item) => item.id === entry.id);
            if (index < 0) page.entries.push(entry);
            else if (!(page.entries[index].revision > entry.revision)) page.entries[index] = entry;
          }
          page.more = entries.length > 0 && (reply.has_more === true || (reply.has_more == null && entries.length === 50));
          page.loaded = true;
          if (!page.more || page.entries.some((entry) => !known.has(entry.id))) break;
        }
      } catch (error) { if (current(version)) fail(error); }
      finally {
        if (current(version)) { page.loading = false; renderList(kind); }
      }
    }
    function annotationsTable(marks, review = false) {
      if (!marks?.length) return '<p>No annotations.</p>';
      return `<div class="training-table" role="region" aria-label="Annotation coordinates" tabindex="0" style="max-width:100%;overflow-x:auto"><table><caption>Annotation coordinates, normalized from 0 to 1</caption><thead><tr>${['#', 'Kind', 'X', 'Y', 'End X', 'End Y', review ? 'Text' : 'Label', ...(review ? [] : ['Side'])].map((label) => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${marks.map((mark, index) => `<tr>${[index + 1, mark.kind, mark.x, mark.y, mark.x2, mark.y2, review ? mark.text : mark.label, ...(review ? [] : [mark.team])].map((value) => `<td style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    const reviewClock = data => data.time_basis === 'match' ? 'Match clock' : 'Video clock';
    function reviewView(data) {
      return text(data.match_id ? `Match label: ${data.match_id}` : 'No match label') + text(data.source_label ? `User-supplied source label: ${data.source_label}` : 'Text notes only; no video is stored or fetched.') + (data.moments || []).map((moment) => `<details class="training-details"><summary ${disclosure}>${esc(moment.title || 'Review moment')} · ${esc(moment.seconds)} seconds · ${reviewClock(data)}</summary>${['known', 'options', 'decision', 'outcome', 'lesson'].map((key) => `<h3>${{ known: 'What was known then', options: 'Options and tradeoffs', decision: 'Decision made', outcome: 'Observed outcome', lesson: 'Takeaway to discuss' }[key]}</h3>${text(moment[key])}`).join('')}${annotationsTable(moment.annotations, true)}</details>`).join('');
    }
    function puzzleView(data) {
      return `<h3>Situation</h3>${text(data.prompt)}<h3>Context and uncertainty</h3>${text(data.context)}<ol class="training-list">${(data.choices || []).map((choice) => `<li><h3>${esc(choice.label)}</h3>${text(choice.tradeoff)}</li>`).join('')}</ol><h3>Team discussion</h3>${text(data.discussion)}${data.seconds == null ? '' : text(`Review moment: ${data.seconds} seconds`)}<p class="training-muted">Several choices may be reasonable. Tradeoffs are discussion notes, not a scored or guaranteed winning answer.</p>`;
    }
    function boardSVG(marks) {
      const valid = (mark) => [mark.x, mark.y, mark.x2, mark.y2].every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
      const shapes = marks.map((mark, index) => {
        if (!valid(mark)) return '';
        const x = 50 + mark.x * 900, y = 50 + mark.y * 900, x2 = 50 + mark.x2 * 900, y2 = 50 + mark.y2 * 900;
        const color = mark.team === 'blue' ? '#2463a6' : mark.team === 'red' ? '#b33349' : 'currentColor';
        let shape = '';
        if (mark.kind === 'arrow') {
          const angle = Math.atan2(y2 - y, x2 - x), a = angle + .5, b = angle - .5;
          shape = `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke-width="6"/><path d="M${x2 - 24 * Math.cos(a)} ${y2 - 24 * Math.sin(a)} L${x2} ${y2} L${x2 - 24 * Math.cos(b)} ${y2 - 24 * Math.sin(b)}" fill="none" stroke-width="6"/>`;
        } else if (mark.kind === 'ward') shape = `<path d="M${x} ${y - 16} l16 16 -16 16 -16 -16 Z" fill="none" stroke-width="5"/>`;
        else if (mark.kind === 'position') shape = `<circle cx="${x}" cy="${y}" r="16" fill="none" stroke-width="5"/>`;
        return `<g stroke="${color}" fill="${color}">${shape}<text x="${Math.min(x + 22, 850)}" y="${Math.max(y - 20, 30)}" stroke="none" font-size="24">${index + 1}: ${esc(mark.label || mark.kind)}</text></g>`;
      }).join('');
      return `<svg xmlns="http://www.w3.org/2000/svg" class="training-board" viewBox="0 0 1000 1000" role="img" aria-label="Original strategy diagram; full annotation coordinates below" style="display:block;width:100%;max-width:680px;height:auto;touch-action:pan-y"><title>Original private strategy schematic, not a game map</title><desc>Three abstract lanes and a river over a coordinate grid. Origin is top left. All annotations have a numbered table and numeric controls.</desc><rect x="50" y="50" width="900" height="900" fill="none" stroke="currentColor"/>${Array.from({ length: 11 }, (_, index) => { const n = 50 + index * 90; return `<path d="M${n} 50V950 M50 ${n}H950" stroke="currentColor" opacity="0.15"/><text x="${n}" y="985" text-anchor="middle" fill="currentColor" font-size="20">${(index / 10).toFixed(1)}</text>`; }).join('')}<path d="M130 850V150H850 M130 850L850 150 M130 850H850V150" fill="none" stroke="currentColor" stroke-width="14" opacity="0.22"/><path d="M70 250C400 220 300 800 930 750" fill="none" stroke="currentColor" stroke-width="35" opacity="0.12"/><g fill="currentColor" font-size="25"><text x="180" y="125">Outer lane</text><text x="440" y="450">Middle lane</text><text x="500" y="900">Outer lane</text><text x="530" y="680">River (schematic)</text><text x="5" y="45">Y=0</text><text x="5" y="945">Y=1</text></g>${shapes}</svg>`;
    }
    function boardView(data) {
      return `${text(data.notes)}${boardSVG(data.marks || [])}${annotationsTable(data.marks)}<p class="training-muted">Original strategy diagram, not a playable League map. Manually authored positions only; no live game information or Riot requests.</p>`;
    }
    function momentForm(moment, basis = 'video') {
      return `<fieldset data-moment="${esc(moment.id)}" style="min-width:0"><legend>Review moment</legend>${field('Moment title', input('moment_title', moment.title, 'maxlength="120" required'))}${field(`Seconds (${reviewClock({ time_basis: basis })}; 0–28800)`, number('seconds', moment.seconds, 28800))}${['known', 'options', 'decision', 'outcome', 'lesson'].map((key) => field({ known: 'What was known then', options: 'Options and tradeoffs', decision: 'Decision made', outcome: 'Observed outcome', lesson: 'Takeaway to discuss' }[key], prose(key, moment[key]))).join('')}<details class="training-details"><summary ${disclosure}>Existing review annotations (retained on save)</summary>${annotationsTable(moment.annotations, true)}<p>Use a shared strategy board for editable diagrams.</p></details>${button('remove-moment', 'Remove review moment')}</fieldset>`;
    }
    function choiceForm(choice) {
      return `<fieldset data-choice style="min-width:0"><legend>Reasonable option</legend>${field('Choice label', input('label', choice.label, 'maxlength="160" required'))}${field('Tradeoffs and uncertainty', prose('tradeoff', choice.tradeoff))}${button('remove-choice', 'Remove choice')}</fieldset>`;
    }
    function markRow(mark, index) {
      return `<tr data-mark="${esc(mark.id)}"><th scope="row">${index + 1}</th><td>${field(`Annotation ${index + 1} kind`, select('kind', ['arrow', 'position', 'ward', 'text'], mark.kind))}</td>${['x', 'y', 'x2', 'y2'].map((key) => `<td>${field(`Annotation ${index + 1} ${key}`, number(key, mark[key]))}</td>`).join('')}<td>${field(`Annotation ${index + 1} label`, input('label', mark.label, 'maxlength="160"'))}</td><td>${field(`Annotation ${index + 1} side`, select('team', ['blue', 'red', 'neutral'], mark.team))}</td><td>${button('remove-mark', `Remove annotation ${index + 1}`)}</td></tr>`;
    }
    function boardForm(data) {
      return `${field('Discussion notes', prose('notes', data.notes))}<p>Original strategy diagram only: abstract lanes, river and grid, not a playable League clone. No live tracking, Riot calls or video.</p><div data-diagram>${boardSVG(data.marks)}</div><p>Coordinates run from 0 to 1; X increases right and Y increases down. All marks are editable with the keyboard below. Pointer placement is optional.</p><div class="training-inline">${field('New annotation kind', select('new_kind', ['arrow', 'position', 'ward', 'text'], 'arrow'))}${button('add-mark', 'Add annotation')}</div><div class="training-inline">${field('Annotation for optional pointer placement', '<select name="selected_mark" style="min-height:44px;min-width:44px;max-width:100%"></select>')}${field('Place start or endpoint', select('point_target', ['start', 'end'], 'start'))}</div><div class="training-table" role="region" aria-label="Editable annotation coordinates; scroll horizontally for all controls" tabindex="0" style="max-width:100%;overflow-x:auto"><table><caption>Annotation table — exact normalized coordinates, no hover required</caption><thead><tr>${['#', 'Kind', 'X', 'Y', 'End X', 'End Y', 'Label', 'Side', 'Remove'].map((value) => `<th scope="col">${value}</th>`).join('')}</tr></thead><tbody data-marks>${data.marks.map(markRow).join('')}</tbody></table></div><p data-mark-count aria-live="polite"></p>`;
    }
    function editor(kind, entry = null) {
      const area = host.querySelector('[data-editor]');
      if (!area || !team) return;
      if (draft) { draft.data = null; draft.entry = null; }
      draft = null;
      const editable = mayEdit(entry);
      const title = entry?.data.title || `New private team ${singular[kind]}`;
      const heading = `<h2>${esc(title)}</h2><p>Private to accepted teammates${entry ? ` · created by ${esc(entry.owner)} · revision ${esc(entry.revision)}` : ' · creating a new shared document, not publishing a personal note'}.</p>`;
      if (!editable) {
        area.innerHTML = `${heading}${kind === 'boards' ? boardView(entry.data) : kind === 'reviews' ? reviewView(entry.data) : puzzleView(entry.data)}<p>Only the creator can edit this ${esc(singular[kind])}.</p>${mayDelete(entry) ? button('delete-doc', 'Delete team document…', `data-kind="${kind}" data-id="${esc(entry.id)}"`) : ''}${button('close', 'Close document')}`;
        return;
      }
      const data = clone(entry?.data || (kind === 'boards' ? { title: '', notes: '', marks: [] } : kind === 'puzzles' ? { title: '', prompt: '', context: '', choices: [{ label: '', tradeoff: '' }, { label: '', tradeoff: '' }], discussion: '', source_review_id: null, seconds: null } : { title: '', match_id: '', source_label: '', time_basis: 'video', moments: [blankMoment(uid())] }));
      let content;
      if (kind === 'boards') content = boardForm(data);
      else if (kind === 'puzzles') content = `${field('Situation to discuss', prose('prompt', data.prompt, 4000, 'required'))}${field('Context and uncertainty', prose('context', data.context))}<p>Offer 2–5 context-dependent choices, not a single guaranteed winning answer.</p><div data-choices>${data.choices.map(choiceForm).join('')}</div>${button('add-choice', 'Add choice')}${field('Team discussion', prose('discussion', data.discussion))}${field('Review moment in seconds (optional; zero is valid)', input('puzzle_seconds', data.seconds ?? '', 'type="number" min="0" max="28800" step="any"'))}`;
      else content = `${field('Match label (optional)', input('match_id', data.match_id, 'maxlength="160"'))}${field('User-supplied source label (not a file path or URL)', input('source_label', data.source_label, 'maxlength="160"'))}<p>Written review notes only. Timestamps use ${reviewClock(data)}; the original basis is retained on save. No personal cached context or footage is fetched. Do not enter device paths, URLs or private video content.</p><div data-moments>${data.moments.map(moment => momentForm(moment, data.time_basis)).join('')}</div>${button('add-moment', 'Add review moment')}`;
      area.innerHTML = `${heading}<form class="training-form" data-form="document" data-training-dirty="false"><fieldset data-fields style="min-width:0;border:0;padding:0;margin:0"><legend class="training-muted">${entry ? 'Edit shared document' : 'New shared document'}</legend>${field('Title', input('title', data.title, 'maxlength="120" required'))}${content}<div class="training-actions"><button class="btn" type="submit" ${target}>Save team ${esc(singular[kind])}</button>${entry && mayDelete(entry) ? button('delete-doc', 'Delete team document…', `data-kind="${kind}" data-id="${esc(entry.id)}"`) : ''}${button('close', 'Close document')}</div></fieldset></form>`;
      draft = { kind, entry, data, dirty: false, form: area.querySelector('form') };
      if (kind === 'boards') updateBoard();
    }
    const value = (node, name) => node.querySelector(`[name="${name}"]`).value;
    const numeric = (node, name) => node.querySelector(`[name="${name}"]`).valueAsNumber;
    function readMarks() {
      return [...draft.form.querySelectorAll('[data-mark]')].map((row) => ({ id: row.dataset.mark, kind: value(row, 'kind'), x: numeric(row, 'x'), y: numeric(row, 'y'), x2: numeric(row, 'x2'), y2: numeric(row, 'y2'), label: value(row, 'label'), team: value(row, 'team') }));
    }
    function updateBoard() {
      if (!draft || draft.kind !== 'boards') return;
      const form = draft.form, marks = readMarks();
      form.querySelector('[data-diagram]').innerHTML = boardSVG(marks);
      const picker = form.querySelector('[name="selected_mark"]'), selected = picker.value;
      picker.innerHTML = marks.map((mark, index) => `<option value="${esc(mark.id)}">${index + 1}: ${esc(mark.label || mark.kind)}</option>`).join('');
      if (marks.some((mark) => mark.id === selected)) picker.value = selected;
      picker.disabled = !marks.length;
      form.querySelector('[data-mark-count]').textContent = `${marks.length} of 100 annotations. Numeric controls and labels are saved with the diagram.`;
      form.querySelector('[data-action="add-mark"]').disabled = marks.length >= 100;
    }
    function readDocument() {
      const { form, kind, data } = draft;
      const title = value(form, 'title');
      if (kind === 'boards') return { title, notes: value(form, 'notes'), marks: readMarks() };
      if (kind === 'puzzles') return { title, prompt: value(form, 'prompt'), context: value(form, 'context'), choices: [...form.querySelectorAll('[data-choice]')].map((row) => ({ label: value(row, 'label'), tradeoff: value(row, 'tradeoff') })), discussion: value(form, 'discussion'), source_review_id: data.source_review_id ?? null, seconds: value(form, 'puzzle_seconds') === '' ? null : numeric(form, 'puzzle_seconds') };
      return { title, match_id: value(form, 'match_id'), source_label: value(form, 'source_label'), time_basis: data.time_basis ?? 'video', moments: [...form.querySelectorAll('[data-moment]')].map((row) => ({ id: row.dataset.moment, seconds: numeric(row, 'seconds'), title: value(row, 'moment_title'), ...Object.fromEntries(['known', 'options', 'decision', 'outcome', 'lesson'].map((key) => [key, value(row, key)])), annotations: data.moments.find((moment) => moment.id === row.dataset.moment)?.annotations || [] })) };
    }
    async function saveDocument(form) {
      if (!draft || form !== draft.form || !form.reportValidity()) return;
      const version = generation, editing = draft, data = readDocument();
      const focusedIndex = [...form.elements].indexOf(document.activeElement);
      const fields = form.querySelector('[data-fields]');
      fields.disabled = true;
      say('Saving privately…');
      try {
        await verify(editing.entry);
        guard(version);
        const entry = await ctx.save(editing.kind, data, editing.entry, selectedId);
        if (!current(version) || draft !== editing) return;
        if (entry.kind !== editing.kind || String(entry.team_id) !== selectedId) throw new Error('Unexpected document scope returned. Your draft has been kept.');
        const page = pages[entry.kind], index = page.entries.findIndex((item) => item.id === entry.id);
        if (index < 0) page.entries.unshift(entry);
        else page.entries[index] = entry;
        renderList(entry.kind);
        const restoreFocus = document.activeElement === document.body || form.contains(document.activeElement);
        editor(entry.kind, entry);
        if (restoreFocus) draft.form.elements[focusedIndex]?.focus();
        // Native form lifecycle events let the core reset its generic input-based dirty guard.
        draft.form.dispatchEvent(new Event('reset', { bubbles: true }));
        const savedDraft = draft;
        queueMicrotask(() => { if (current(version) && draft === savedDraft) ctx.markSaved?.(savedDraft.form); });
        say('Saved privately to this team.');
      } catch (error) {
        guard(version);
        throw error;
      } finally {
        if (current(version) && fields.isConnected) {
          fields.disabled = false;
          if (document.activeElement === document.body) form.elements[focusedIndex]?.focus();
        }
      }
    }
    function closeEditor() {
      if (draft) { draft.data = null; draft.entry = null; }
      draft = null;
      host.querySelector('[data-editor]')?.replaceChildren();
    }
    async function action(control) {
      const version = generation;
      const action = control.dataset.action;
      if (action === 'refresh-home') {
        const next = await ctx.refresh();
        guard(version);
        bootstrap = next;
        homeLists();
        say('Team list refreshed.');
      } else if (action === 'accept' || action === 'decline') {
        const invite = bootstrap.invitations[Number(control.dataset.invite)];
        if (!invite) return;
        const id = String(invite.id ?? invite.team_id);
        try {
          if (action === 'accept') {
            const reply = await request(`${teamPath(id)}/accept`, json({}));
            guard(version);
            keepTeam(reply.team);
          } else {
            await request(memberPath(id, username), { method: 'DELETE' });
            guard(version);
            purgeBootstrap(id);
          }
        } catch (error) {
          guard(version);
          if (code(error) !== 404) throw error;
          purgeBootstrap(id);
          homeLists();
          say('This invitation is no longer available. It has been removed from your list.');
          return;
        }
        homeLists();
        say(action === 'accept' ? 'Invitation accepted. You can now open the private team.' : 'Invitation declined.');
      } else if (action === 'refresh-team') {
        if (confirmDiscard(true)) await loadTeam();
      } else if (action === 'new' || action === 'open') {
        const kind = control.dataset.kind;
        const entry = action === 'open' ? pages[kind]?.entries[Number(control.dataset.entry)] : null;
        if (!kinds.includes(kind) || (action === 'open' && !entry)) return;
        // Even cached notes need a fresh accepted-membership check before being reopened.
        await verify();
        guard(version);
        // Ask at replacement time, including any typing during the permission request.
        if (!confirmDiscard()) return;
        editor(kind, entry);
        say('This document is private to accepted teammates.');
        draft?.form.querySelector('[name="title"]')?.focus();
      } else if (action === 'close') {
        if (confirmDiscard()) closeEditor();
      } else if (action === 'revoke' || action === 'leave' || action === 'delete-team') {
        const id = selectedId;
        const member = action === 'revoke' ? team.members[Number(control.dataset.member)] : null;
        if (action === 'revoke' && (team.owner !== username || !member || member.username === username)) return;
        if (action === 'delete-team' && team.owner !== username) return;
        if (action === 'leave' && team.owner === username) return;
        const question = action === 'delete-team' ? 'Delete this private team and ALL its shared documents and invitations? This cannot be undone.' : action === 'leave' ? 'Leave this private team? Your access to its documents will end and any unsaved team draft will be discarded.' : `Revoke ${member.username}'s membership or pending invitation? They will lose access to this team's documents.`;
        if (!window.confirm(question)) return;
        try {
          await request(action === 'delete-team' ? teamPath() : memberPath(id, member?.username || username), { method: 'DELETE' });
        } catch (error) {
          guard(version);
          if (action !== 'revoke' || code(error) !== 404) throw error;
          await verify();
          guard(version);
          say('That membership or invitation is no longer present. Current team access was checked; your draft has been kept.');
          return;
        }
        guard(version);
        if (action === 'revoke') {
          team.members = team.members.filter((item) => item.username !== member.username);
          keepTeam(team);
          renderMembers();
          say('Membership or invitation revoked.');
        } else {
          purgeBootstrap(id);
          ++generation;
          clearShared();
          selectedId = null;
          home();
          say(action === 'leave' ? 'You left the private team. Its shared data has been cleared.' : 'The private team and its shared documents were deleted.');
        }
      } else if (action === 'older') {
        await loadPage(control.dataset.kind);
      } else if (action === 'delete-doc') {
        const kind = control.dataset.kind;
        const entry = pages[kind]?.entries.find((item) => String(item.id) === control.dataset.id);
        if (!entry || !mayDelete(entry) || !window.confirm('Delete this shared team document? This cannot be undone. Any unsaved changes will also be discarded.')) return;
        const editing = draft, before = editing ? JSON.stringify(readDocument()) : null;
        say('Deleting shared document…');
        await verify(entry, true);
        guard(version);
        await ctx.remove(entry);
        if (!current(version)) return;
        const page = pages[kind];
        page.entries = page.entries.filter((item) => item.id !== entry.id);
        const newerEdits = editing && draft === editing && JSON.stringify(readDocument()) !== before;
        if (newerEdits) {
          editing.entry = null;
          editing.data = clone(readDocument());
          dirty();
          const area = host.querySelector('[data-editor]');
          area.querySelector('h2').textContent = 'Unsaved document — original deleted';
          area.querySelector('p').textContent = 'New edits were kept locally. Save explicitly as a new team document.';
          editing.form.querySelector('[data-action="delete-doc"]')?.remove();
          editing.form.querySelector('[type="submit"]').textContent = 'Save as a new team document';
        } else closeEditor();
        renderList(kind);
        say(`Shared document deleted.${newerEdits ? ' New edits made while waiting have been kept; save explicitly to persist them.' : ''}`);
      } else if (action === 'add-mark' && draft?.kind === 'boards') {
        const rows = draft.form.querySelector('[data-marks]');
        if (rows.children.length >= 100) { say('A board can contain at most 100 annotations.', true); return; }
        const mark = { id: uid(), kind: value(draft.form, 'new_kind'), x: .25, y: .5, x2: .75, y2: .5, label: '', team: 'neutral' };
        rows.insertAdjacentHTML('beforeend', markRow(mark, rows.children.length));
        changed(draft.form);
        draft.form.querySelector('[name="selected_mark"]').value = mark.id;
        rows.lastElementChild.querySelector('[name="label"]').focus();
      } else if (action === 'remove-mark' && draft?.kind === 'boards') {
        const row = control.closest('[data-mark]'), next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        // Renumber labels without replacing the remaining inputs (including invalid, unsaved values).
        [...draft.form.querySelectorAll('[data-mark]')].forEach((item, index) => {
          item.querySelector('th').textContent = index + 1;
          item.querySelector('[data-action="remove-mark"]').textContent = `Remove annotation ${index + 1}`;
          for (const label of item.querySelectorAll('label')) label.firstChild.textContent = `Annotation ${index + 1} ${label.querySelector('input,select').name}`;
        });
        changed(draft.form);
        (next?.querySelector('input') || draft.form.querySelector('[data-action="add-mark"]')).focus();
      } else if (action === 'add-choice' && draft?.kind === 'puzzles') {
        const rows = draft.form.querySelector('[data-choices]');
        if (rows.children.length >= 5) { say('Use 2–5 choices.', true); return; }
        rows.insertAdjacentHTML('beforeend', choiceForm({ label: '', tradeoff: '' }));
        changed(draft.form);
        rows.lastElementChild.querySelector('input').focus();
      } else if (action === 'remove-choice' && draft?.kind === 'puzzles') {
        if (draft.form.querySelectorAll('[data-choice]').length <= 2) { say('Keep at least two reasonable choices.', true); return; }
        control.closest('[data-choice]').remove();
        changed(draft.form);
        draft.form.querySelector('[data-action="add-choice"]').focus();
      } else if (action === 'add-moment' && draft?.kind === 'reviews') {
        const rows = draft.form.querySelector('[data-moments]');
        if (rows.children.length >= 50) { say('A review can contain at most 50 moments.', true); return; }
        const moment = blankMoment(uid());
        draft.data.moments.push(moment);
        rows.insertAdjacentHTML('beforeend', momentForm(moment, draft.data.time_basis));
        changed(draft.form);
        rows.lastElementChild.querySelector('input').focus();
      } else if (action === 'remove-moment' && draft?.kind === 'reviews') {
        control.closest('[data-moment]').remove();
        changed(draft.form);
        draft.form.querySelector('[data-action="add-moment"]').focus();
      }
    }
    const onClick = (event) => {
      const control = event.target.closest('button[data-action]');
      if (control && host.contains(control)) { event.preventDefault(); void run(() => action(control), control); return; }
      const svg = event.target.closest('[data-diagram] svg');
      if (!svg || !draft || draft.kind !== 'boards' || busy) return;
      const id = value(draft.form, 'selected_mark');
      const row = [...draft.form.querySelectorAll('[data-mark]')].find((item) => item.dataset.mark === id);
      if (!row) { say('Add an annotation first, or use the keyboard-accessible numeric controls below.'); return; }
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
      const end = value(draft.form, 'point_target') === 'end';
      row.querySelector(`[name="${end ? 'x2' : 'x'}"]`).value = Math.max(0, Math.min(1, (point.x - 50) / 900)).toFixed(3);
      row.querySelector(`[name="${end ? 'y2' : 'y'}"]`).value = Math.max(0, Math.min(1, (point.y - 50) / 900)).toFixed(3);
      changed(draft.form);
      if (value(row, 'kind') === 'arrow') draft.form.querySelector('[name="point_target"]').value = end ? 'start' : 'end';
    };
    const onInput = (event) => {
      if (!current() || !draft || !draft.form.contains(event.target)) return;
      dirty();
      if (draft.kind === 'boards') updateBoard();
    };
    const onSubmit = (event) => {
      const form = event.target.closest('form[data-form]');
      if (!form || !host.contains(form)) return;
      event.preventDefault();
      void run(async () => {
        const version = generation;
        if (form.dataset.form === 'document') { await saveDocument(form); return; }
        if (!form.reportValidity()) return;
        if (form.dataset.form === 'create') {
          const name = value(form, 'name');
          const reply = await request('/api/training/teams', json({ name }));
          guard(version);
          keepTeam(reply.team);
          if (value(form, 'name') === name) form.reset();
          homeLists();
          say('Private team created. Open it to invite existing members.');
        } else if (form.dataset.form === 'invite' && team?.owner === username) {
          const invited = value(form, 'username');
          try {
            await request(`${teamPath()}/invite`, json({ username: invited }));
          } catch (error) {
            guard(version);
            if (code(error) !== 404) throw error;
            // Unknown usernames are also 404; do not erase a valid team's unsaved notes.
            // Recheck membership to distinguish this from the owner losing team access.
            await verify();
            guard(version);
            say('That member could not be invited. Check the existing member username; your inputs have been kept.', true);
            return;
          }
          guard(version);
          // Keep other unsaved document inputs intact; only the roster is refreshed.
          await verify();
          guard(version);
          const inviteForm = host.querySelector('[data-form="invite"]');
          if (inviteForm && value(inviteForm, 'username') === invited) inviteForm.reset();
          inviteForm?.querySelector('input')?.focus();
          say('Invitation sent. This member must accept before seeing team documents.');
        }
      }, form.querySelector('button[type="submit"]'));
    };
    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onInput);
    host.addEventListener('submit', onSubmit);
    ctx.cleanup(() => {
      alive = false;
      ++generation;
      // Purge route-local DOM, record references and any accidental shared bootstrap entries on logout/navigation.
      if (selectedId && bootstrap?.entries) {
        for (const kind of kinds) if (Array.isArray(bootstrap.entries[kind])) bootstrap.entries[kind] = bootstrap.entries[kind].filter((entry) => String(entry.team_id) !== selectedId);
      }
      clearShared();
      bootstrap = null;
      selectedId = null;
      host.removeEventListener('click', onClick);
      host.removeEventListener('input', onInput);
      host.removeEventListener('change', onInput);
      host.removeEventListener('submit', onSubmit);
      host.replaceChildren();
      host.remove();
    });
    if (!username) { host.innerHTML = '<p>Sign in again to open private teamwork.</p>'; return; }
    if (selectedId) void run(loadTeam);
    else home();
  });
})();
