/* Personal, text-only training records. Local footage never leaves this page. */
(function (host) {
  'use strict';
  const MAX_SECONDS = 28800, PAGE = 50, MAX_PAGES = 5;
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = (value, max, label, required = false) => {
    if (typeof value !== 'string' || value.length > max || /\p{C}/u.test(max === 4000 ? value.replace(/[\t\r\n]/g, '') : value)) throw Error(`${label}: use text up to ${max} characters, without control characters.`);
    if (required && !value.trim()) throw Error(`${label} is required.`);
    return value;
  };
  const number = (value, min, max, label, integer = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw Error(`${label}: enter ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
    return value;
  };
  const numeric = value => typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const id = value => text(value, 160, 'Record ID', true);
  const reference = value => value === null ? null : id(value);
  const bounded = value => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 32768) throw Error('These notes exceed the 32 KiB record limit. Shorten the text or split the review.');
    return value;
  };
  function annotation(a) {
    if (!['arrow', 'circle', 'text'].includes(a.kind)) throw Error('Choose an arrow, circle or text annotation.');
    return { kind: a.kind, x: number(a.x, 0, 1, 'X'), y: number(a.y, 0, 1, 'Y'), x2: number(a.x2, 0, 1, 'End X'), y2: number(a.y2, 0, 1, 'End Y'), text: text(a.text, 160, 'Annotation text') };
  }
  function timeBasis(value = 'video') {
    if (!['video', 'match'].includes(value)) throw Error('Choose video or match clock timestamps.');
    return value;
  }
  const basisLabel = value => timeBasis(value) === 'match' ? 'Match clock' : 'Video clock';
  function clockOffset(videoSeconds, gameSeconds, duration) {
    number(duration, 0, Number.MAX_VALUE, 'Video duration');
    number(videoSeconds, 0, Math.min(duration, MAX_SECONDS), 'Current video time');
    number(gameSeconds, 0, MAX_SECONDS, 'Game time');
    return videoSeconds - gameSeconds;
  }
  function convertSeconds(seconds, from, to, offset) {
    from = timeBasis(from); to = timeBasis(to);
    number(seconds, 0, MAX_SECONDS, 'Timestamp');
    if (from === to) return seconds;
    if (offset === null || offset === undefined) throw Error('Align the match clock with your local video first. Calibration is local only.');
    number(offset, -MAX_SECONDS, MAX_SECONDS, 'Clock offset');
    return number(seconds + (to === 'video' ? offset : -offset), 0, MAX_SECONDS, 'Converted timestamp');
  }
  function playbackSeconds(seconds, basis, offset, duration) {
    const unavailable = 'This time is unavailable in the local recording; no seek was made.';
    let value;
    try { value = convertSeconds(seconds, basis, 'video', offset); }
    catch (e) { if (e.message.startsWith('Converted timestamp:')) throw Error(unavailable); throw e; }
    if (!Number.isFinite(duration) || value > duration) throw Error(unavailable);
    return value;
  }
  function convertReviewBasis(draft, to, offset) {
    const from = timeBasis(draft.time_basis);
    to = timeBasis(to);
    // Validate every conversion before returning anything the editor can apply.
    return { ...draft, time_basis: to, moments: draft.moments.map(m => ({ ...m, seconds: convertSeconds(m.seconds, from, to, offset) })) };
  }
  function reviewData(d) {
    if (!Array.isArray(d.moments) || d.moments.length > 50) throw Error('A review can contain at most 50 moments.');
    const label = text(d.source_label, 160, 'Source label');
    const match = text(d.match_id, 160, 'Match ID');
    if ([label, match].some(v => /[/\\]|^[a-zA-Z][a-zA-Z0-9+.-]*:|^~/.test(v))) throw Error('Use a short manual source label and match ID, not a URL or device path.');
    const ids = new Set();
    return bounded({ title: text(d.title, 120, 'Review title', true), match_id: match, source_label: label, time_basis: timeBasis(d.time_basis), moments: d.moments.map(m => {
      if (ids.has(m.id)) throw Error('Moment IDs must be unique.');
      ids.add(m.id);
      if (!Array.isArray(m.annotations) || m.annotations.length > 30) throw Error('A moment can contain at most 30 annotations.');
      const out = { id: id(m.id), seconds: number(m.seconds, 0, MAX_SECONDS, 'Timestamp'), title: text(m.title, 120, 'Moment title', true) };
      for (const key of ['known', 'options', 'decision', 'outcome', 'lesson']) out[key] = text(m[key], 4000, key);
      out.annotations = m.annotations.map(annotation);
      return out;
    }) });
  }
  function lessonData(d) {
    return bounded({ question: text(d.question, 4000, 'Question', true), answer: text(d.answer, 4000, 'Answer', true), source_review_id: reference(d.source_review_id), due: number(d.due, 0, 253402300799, 'Due date', true), interval_days: number(d.interval_days, 1, 365, 'Interval', true), repetitions: number(d.repetitions, 0, 1000, 'Repetitions', true) });
  }
  function puzzleData(d) {
    if (!Array.isArray(d.choices) || d.choices.length < 2 || d.choices.length > 5) throw Error('Use between two and five choices.');
    return bounded({ title: text(d.title, 120, 'Puzzle title', true), prompt: text(d.prompt, 4000, 'Prompt', true), context: text(d.context, 4000, 'Context'), choices: d.choices.map(c => ({ label: text(c.label, 160, 'Choice', true), tradeoff: text(c.tradeoff, 4000, 'Tradeoff') })), discussion: text(d.discussion, 4000, 'Discussion'), source_review_id: reference(d.source_review_id), seconds: d.seconds === null ? null : number(d.seconds, 0, MAX_SECONDS, 'Timestamp') });
  }
  function attemptData(d) {
    return bounded({ puzzle_id: id(d.puzzle_id), choice_index: number(d.choice_index, 0, 4, 'Choice', true), reason: text(d.reason, 4000, 'Reasoning'), reflection: text(d.reflection, 4000, 'Reflection') });
  }
  // Coordinates are relative to the contained video frame, excluding both letterbox bars.
  function frameRect(rect, width, height) {
    if (!(width > 0 && height > 0 && rect.width > 0 && rect.height > 0)) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    const w = width * scale, h = height * scale;
    return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, width: w, height: h };
  }
  function framePoint(frame, x, y) {
    if (!frame || x < frame.left || y < frame.top || x > frame.left + frame.width || y > frame.top + frame.height) return null;
    return { x: (x - frame.left) / frame.width, y: (y - frame.top) / frame.height };
  }
  const clamp = n => Math.max(0, Math.min(1, n));
  function moveMark(mark, dx, dy) {
    dx = Math.max(-Math.min(mark.x, mark.x2), Math.min(dx, 1 - Math.max(mark.x, mark.x2)));
    dy = Math.max(-Math.min(mark.y, mark.y2), Math.min(dy, 1 - Math.max(mark.y, mark.y2)));
    return { ...mark, x: mark.x + dx, x2: mark.x2 + dx, y: mark.y + dy, y2: mark.y2 + dy };
  }
  const stamp = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  const uid = () => host.crypto?.randomUUID ? host.crypto.randomUUID() : `moment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const moment = seconds => ({ id: uid(), seconds, title: '', known: '', options: '', decision: '', outcome: '', lesson: '', annotations: [] });
  const emptyReview = match => ({ title: '', match_id: match || '', source_label: '', time_basis: 'video', moments: [] });
  const emptyLesson = () => ({ question: '', answer: '', source_review_id: null, due: Math.floor(Date.now() / 1000), interval_days: 1, repetitions: 0 });
  const emptyPuzzle = () => ({ title: '', prompt: '', context: '', choices: [{ label: '', tradeoff: '' }, { label: '', tradeoff: '' }], discussion: '', source_review_id: null, seconds: null });
  const field = (label, html) => `<label>${esc(label)}${html}</label>`;
  const input = (key, label, max = 160, value = '', type = 'text') => field(label, `<input name="${esc(key)}" type="${type}" maxlength="${max}" value="${esc(value)}">`);
  const prose = (key, label, value = '', max = 4000) => field(label, `<textarea name="${esc(key)}" maxlength="${max}" rows="3">${esc(value)}</textarea>`);
  const button = (action, label, extra = '') => `<button type="button" class="btn" data-action="${action}" ${extra}>${label}</button>`;
  const head = (title, takeaway) => `<header class="training-head"><h2>${title}</h2><p>${takeaway}</p><a href="#/practice">Training home</a></header>`;
  function scope(root, ctx) {
    let disposed = false, version = 0, pending = false;
    const dirty = new Set(), listeners = [], callbacks = [];
    // The core watches forms. This sentinel includes edits made outside native forms
    // (moments, pointer marks) in its route/back-button draft guard as well.
    const guard = host.document.createElement('form');
    guard.hidden = true; guard.dataset.draftGuard = '';
    guard.innerHTML = '<input name="workspace_revision" value="0">';
    root.appendChild(guard);
    const current = () => !disposed && root.isConnected && ctx.current();
    const listen = (el, type, fn, options) => { const guarded = event => { if (current()) fn(event); }; el.addEventListener(type, guarded, options); listeners.push(() => el.removeEventListener(type, guarded, options)); };
    const status = (message, error = false) => { if (current()) { const out = root.querySelector('[data-status]'); if (out) { out.textContent = message; out.setAttribute('role', error ? 'alert' : 'status'); } } };
    const changed = (channel = 'form') => { dirty.add(typeof channel === 'string' ? channel : 'form'); version++; guard.elements.workspace_revision.value = String(version); const out = root.querySelector('[data-dirty]'); if (out) out.textContent = 'Unsaved changes'; };
    const clean = (channel = 'form') => {
      if (channel === '*') dirty.clear(); else dirty.delete(channel);
      const out = root.querySelector('[data-dirty]'); if (out) out.textContent = dirty.size ? 'Unsaved changes' : 'Saved / no unsaved changes';
      const savedVersion = version;
      if (!dirty.size) host.queueMicrotask(() => { if (current() && !dirty.size && version === savedVersion) for (const form of root.querySelectorAll('form')) ctx.markSaved?.(form); });
    };
    const discard = () => !dirty.size || host.confirm('Discard unsaved training notes? Your local video is not saved.');
    const error = e => status(`${e?.message || 'Request failed.'} Your form and local video have been kept. If this is a revision conflict (409), explicitly reload the saved record before retrying; reloading discards unsaved notes.`, true);
    async function task(el, fn) {
      if (!current() || pending) return;
      pending = true;
      version++; // An explicit action supersedes any earlier editor load, even without new typing.
      const focused = el === host.document.activeElement;
      if (el) el.disabled = true;
      try { await fn(); } catch (e) { if (current()) error(e); }
      finally {
        pending = false;
        if (current() && el?.isConnected) el.disabled = false;
        if (current() && focused && host.document.activeElement === host.document.body) {
          const target = el?.isConnected && !el.hidden ? el : root.querySelector('[data-status]');
          if (target) { if (target !== el) target.tabIndex = -1; target.focus({ preventScroll: true }); }
        }
      }
    }
    listen(host, 'beforeunload', event => { if (current() && (dirty.size || pending)) { event.preventDefault(); event.returnValue = ''; } });
    if (!ctx.markSaved) listen(host.document, 'click', event => {
      if (!current() || !dirty.size || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest('a[href], #logout');
      if (link && (link.id === 'logout' || (link.target !== '_blank' && link.href !== host.location.href)) && !discard()) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    if (ctx.guardDirty) callbacks.push(ctx.guardDirty(() => dirty.size > 0 || pending));
    ctx.cleanup(() => { disposed = true; for (const off of listeners.splice(0)) off(); for (const fn of callbacks.splice(0)) fn(); dirty.clear(); guard.remove(); });
    return { current, listen, status, changed, clean, discard, task, error, hasDirty: channel => dirty.has(channel), invalidate: () => ++version, onDispose: fn => callbacks.push(fn), get version() { return version; }, get pending() { return pending; } };
  }
  function pager(ctx, s, kind, teamId = null) {
    let records = teamId ? [] : [...(ctx.bootstrap.entries?.[kind] || [])].filter(e => !e.team_id);
    let more = teamId ? true : (ctx.bootstrap.limits?.has_more?.[kind] ?? records.length >= PAGE), loading = false;
    const put = (entry, local = true) => {
      if (entry.kind !== kind || (teamId ? entry.team_id !== teamId : entry.team_id != null)) return;
      const index = records.findIndex(r => r.id === entry.id);
      if (index < 0) { if (local) records.unshift(entry); else records.push(entry); }
      else if (!(records[index].revision > entry.revision)) records[index] = entry;
    };
    async function next() {
      if (loading || !more || !s.current()) return false;
      loading = true;
      try {
        // Rescan to the first unseen page: another tab can insert/delete records
        // ahead of an offset. Requests remain bounded by member/team storage limits.
        const known = new Set(records.map(entry => entry.id));
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await ctx.request(`/api/training/entries/${kind}?offset=${page * PAGE}&limit=${PAGE}${teamId ? `&team_id=${encodeURIComponent(teamId)}` : ''}`);
          if (!s.current()) return false;
          if (!Array.isArray(result.entries)) throw Error('Invalid record list response.');
          for (const entry of result.entries) put(entry, false);
          more = !!result.has_more && result.entries.length > 0;
          if (!more || records.some(entry => !known.has(entry.id))) return true;
        }
        throw Error('The list limit was reached. Reload saved data before loading more records.');
      } finally { loading = false; }
    }
    async function find(recordId) {
      const found = records.find(r => r.id === recordId); if (found) return found;
      for (let page = 0; page < MAX_PAGES && more; page++) {
        if (!await next() || !s.current()) return null;
        const entry = records.find(r => r.id === recordId); if (entry) return entry;
      }
      return null;
    }
    // Explicit reload scans server pages, never a possibly stale bootstrap record.
    async function fresh(recordId) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await ctx.request(`/api/training/entries/${kind}?offset=${page * PAGE}&limit=${PAGE}${teamId ? `&team_id=${encodeURIComponent(teamId)}` : ''}`);
        if (!s.current()) return null;
        if (!Array.isArray(result.entries)) throw Error('Invalid record list response.');
        for (const entry of result.entries) {
          put(entry, false);
          if (entry.id === recordId && entry.kind === kind && (teamId ? entry.team_id === teamId : entry.team_id == null)) return records.find(record => record.id === recordId);
        }
        if (!result.has_more || !result.entries.length) return null;
      }
      throw Error('The list limit was reached. Open the record from its workspace list.');
    }
    return { get records() { return records; }, get more() { return more; }, next, find, fresh, put, drop: entry => { records = records.filter(r => r.id !== entry.id); } };
  }
  function syncEntry(ctx, kind, entry) {
    const list = ctx.bootstrap.entries?.[kind];
    if (!list || entry.kind !== kind || entry.team_id != null) return;
    const i = list.findIndex(r => r.id === entry.id);
    if (i < 0) list.unshift(entry); else if (!(list[i].revision > entry.revision)) list[i] = entry;
  }
  function teams(ctx) {
    // Bootstrap teams are accepted teams; pending invitations are a separate list.
    return (ctx.bootstrap.teams || []).filter(t => t.status !== 'invited' && t.membership_status !== 'invited');
  }
  function sharing(ctx, noun) {
    return `<details class="training-details"><summary>Share a new notes-only copy with a team</summary><p>Everyone in the selected accepted team can read this copy. Only saved ${noun} notes and annotation coordinates are copied — never footage, a local file, its name or its path. Your personal record stays unchanged. Review your notes for private information first.</p>${field('Accepted team', `<select name="share-team"><option value="">Choose a team</option>${teams(ctx).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>`)}${button('share', 'Share saved notes as a new copy')}</details>`;
  }
  async function share(ctx, s, root, kind, entry) {
    if (!entry || entry.team_id) throw Error('Save a personal record before sharing.');
    const teamId = root.querySelector('[name="share-team"]').value;
    if (!teams(ctx).some(t => t.id === teamId)) throw Error('Select an accepted team first.');
    if (!host.confirm('Create a separate notes-only copy visible to everyone in this team? No footage is shared. Your personal record is unchanged.')) return;
    const data = clone(entry.data);
    if (kind === 'puzzles') data.source_review_id = null; // A shared copy must not expose a private reference.
    await ctx.save(kind, kind === 'reviews' ? reviewData(data) : puzzleData(data), null, teamId);
    if (!s.current()) return;
    s.status('A new team copy was saved. Your personal record and local footage are unchanged.');
  }
  function listRows(records, kind) {
    if (!records.length) return '<p class="training-muted">No saved records in this list yet.</p>';
    return `<ul class="training-list">${records.map(entry => `<li>${button('load', esc(entry.data.title || entry.data.question || 'Untitled'), `data-id="${esc(entry.id)}"`)} <small>Revision ${esc(entry.revision)}${kind === 'lessons' ? ` · due ${esc(new Date(entry.data.due * 1000).toLocaleString())}` : ''}</small></li>`).join('')}</ul>`;
  }
  const footer = '<p data-dirty class="training-muted">No unsaved changes</p><p data-status class="training-status" role="status" aria-live="polite"></p>';

  function renderReview(root, ctx) {
    const teamId = ctx.params.get('team') || ctx.params.get('team_id');
    if (teamId) return renderTeamReview(root, ctx, teamId);
    root.innerHTML = `${head('Video review', 'Separate what you knew at the time from what happened next.')}<div class="training-grid"><section class="training-card"><h3>Local video workspace</h3><p>Choose your own video to review locally. Nothing is uploaded or analysed. Re-select the file next visit; only your typed notes and annotations are saved. The filename is never copied into a source label.</p>${field('Local video (optional)', '<input type="file" accept="video/*" data-video-file>')}<div class="training-video" data-stage tabindex="0" aria-label="Local video player; keyboard shortcuts in help below"><video controls playsinline preload="metadata" aria-label="Your local video"></video><svg class="training-overlay" data-overlay tabindex="0" role="img" aria-label="Annotations for the selected moment; use numeric controls below" xmlns="http://www.w3.org/2000/svg"></svg></div><div class="training-actions">${button('play', 'Play / pause')}${button('back', 'Back 5 seconds')}${button('forward', 'Forward 5 seconds')}${field('Seek to video seconds', '<input name="seek" type="number" min="0" max="28800" step="0.1" value="0">')}${button('seek', 'Seek')}${button('detach', 'Forget local video')}</div><p data-time class="training-muted">No local video selected.</p><details class="training-details" data-clock-sync><summary>Align match clock with local video</summary><p>Pause at a known game time, enter that game time in seconds, then align. Video time = game time + local offset. Calibration is never saved and resets when the video, review or match changes.</p>${field('Game time at current playback (seconds)', '<input name="anchor-seconds" type="number" min="0" max="28800" step="any" value="0">')}${button('align-clock', 'Align at current playback')}${button('clear-clock', 'Clear alignment')}<p data-sync-status role="status" aria-live="polite">Not aligned. Match-clock playback needs a local anchor.</p></details><details class="training-details" data-review-context><summary>Cached match context (match clock)</summary><p>Optional events for your currently linked account only. No footage or Riot data is fetched. Prompts invite reflection, not mistake verdicts or winning recommendations.</p>${button('load-context', 'Load cached match events')}<p data-context-status role="status" aria-live="polite">Nothing loaded. Enter a match ID, then load explicitly.</p><div data-context-content></div></details><details class="training-details"><summary>Keyboard and annotation help</summary><p>Focus the player outside its native controls: Space or K plays/pauses, arrows seek 5 seconds, J/L seek 10 seconds, Home/End go to start/end, 0–9 seek by tenths, M mutes, Up/Down adjust volume. Native video controls also work. Numeric seek and annotation fields work without a mouse. With the annotation overlay focused, arrows move the selected mark (Shift: larger step), Delete removes it. Annotations use the displayed video frame, not its black bars; circle coordinates are centre and edge. Marks belong to the selected moment, even if playback moves on.</p></details></section><section class="training-card"><h3 data-editor-title>New review</h3><form class="training-form" data-review-form>${input('title', 'Review title', 120)}${input('match_id', 'Match ID (optional)', 160)}${input('source_label', 'Manual source label (optional; no path or URL)', 160)}${field('Moment time basis', '<select name="time_basis"><option value="video">Video clock</option><option value="match">Match clock</option></select>')}<p>Existing moments default to video clock. Changing basis converts all moment timestamps after confirmation; it never just relabels them. Saved derived lessons and puzzles keep their original clock labels.</p><div class="training-actions"><button class="btn" type="submit">Save review</button>${button('reload', 'Reload saved review')}${button('new', 'New review')}${button('delete', 'Delete saved review')}</div></form>${footer}${sharing(ctx, 'review')}</section></div><section class="training-card"><h3>Timestamped moments</h3><div class="training-actions">${field('New moment at seconds (video clock)', '<input name="moment-seconds" type="number" min="0" max="28800" step="0.1" value="0">')}${button('use-time', 'Use current playback time')}${button('add-moment', 'Add moment')}</div><div data-moments></div><div data-moment-editor></div></section><section class="training-card"><h3>Your personal reviews</h3><div data-list></div>${button('more', 'Load more personal reviews')}</section>`;
    const s = scope(root, ctx), p = pager(ctx, s, 'reviews');
    let existing = null, draft = emptyReview(ctx.id ? '' : (ctx.params.get('match') || '').slice(0, 160)), selected = -1, markIndex = -1, objectURL = null, drag = null;
    const form = root.querySelector('[data-review-form]'), editor = root.querySelector('[data-moment-editor]'), video = root.querySelector('video'), file = root.querySelector('[data-video-file]'), stage = root.querySelector('[data-stage]'), svg = root.querySelector('[data-overlay]');
    const ns = 'http://www.w3.org/2000/svg', derivedEntries = new WeakMap();
    let offset = null, cachedContext = null, contextEpoch = 0, contextLoading = false, momentInputTouched = false;
    let requestedFocus = !ctx.id && draft.match_id ? { match: draft.match_id, at: numeric(ctx.params.get('at')), prompt: ctx.params.get('prompt') || '' } : null;
    const contextStatus = message => { root.querySelector('[data-context-status]').textContent = message; };
    function invalidateContext(clear = false) {
      contextEpoch++;
      if (contextLoading) contextStatus('Inputs changed while loading. Load cached match events again when ready.');
      contextLoading = false;
      if (clear) { cachedContext = null; root.querySelector('[data-context-content]').replaceChildren(); contextStatus('Nothing loaded. Load cached match events explicitly for this match.'); }
    }
    function resetClock() {
      offset = null;
      root.querySelector('[name="anchor-seconds"]').value = '0';
      root.querySelector('[data-sync-status]').textContent = 'Not aligned. Match-clock playback needs a local anchor.';
    }
    function releaseDrag() {
      if (drag && svg.hasPointerCapture(drag.pointer)) svg.releasePointerCapture(drag.pointer);
      drag = null;
    }
    stage.style.position = 'relative';
    video.style.width = '100%'; video.style.maxHeight = '65vh'; video.style.objectFit = 'contain'; video.style.objectPosition = '50% 50%'; video.style.display = 'block'; video.style.border = '0'; video.style.padding = '0';
    Object.assign(svg.style, { position: 'absolute', display: 'none', touchAction: 'none', pointerEvents: 'none' });
    const currentMoment = () => draft?.moments[selected];
    function dropVideo() {
      releaseDrag(); resetClock();
      video.pause(); video.removeAttribute('src'); video.load();
      if (objectURL) host.URL.revokeObjectURL(objectURL);
      objectURL = null; file.value = ''; svg.style.display = 'none';
    }
    s.onDispose(() => { invalidateContext(true); dropVideo(); requestedFocus = null; draft = null; existing = null; svg.replaceChildren(); });
    function frame() { return objectURL ? frameRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight) : null; }
    function draw() {
      if (!s.current()) return;
      const f = frame(), m = currentMoment();
      svg.replaceChildren();
      if (!f || !m) { svg.style.display = 'none'; return; }
      const box = stage.getBoundingClientRect();
      Object.assign(svg.style, { display: 'block', left: `${f.left - box.left - stage.clientLeft + stage.scrollLeft}px`, top: `${f.top - box.top - stage.clientTop + stage.scrollTop}px`, width: `${f.width}px`, height: `${f.height}px`, pointerEvents: editor.querySelector('[name="tool"]')?.value === 'off' ? 'none' : 'auto' });
      svg.setAttribute('viewBox', `0 0 ${f.width} ${f.height}`);
      function node(tag, attrs, value) { const el = host.document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (value !== undefined) el.textContent = value; svg.appendChild(el); return el; }
      m.annotations.forEach((a, i) => {
        const x = a.x * f.width, y = a.y * f.height, x2 = a.x2 * f.width, y2 = a.y2 * f.height;
        const attrs = { stroke: i === markIndex ? '#ffdf70' : '#ffffff', 'stroke-width': 3, fill: 'none', 'data-mark': i };
        if (a.kind === 'circle') node('circle', { ...attrs, cx: x, cy: y, r: Math.hypot(x2 - x, y2 - y) });
        else if (a.kind === 'text') node('text', { ...attrs, x, y, fill: attrs.stroke, stroke: '#111111', 'stroke-width': .6, 'font-size': 18, 'paint-order': 'stroke' }, a.text || 'Text');
        else {
          node('line', { ...attrs, x1: x, y1: y, x2, y2 });
          const angle = Math.atan2(y2 - y, x2 - x), size = 12;
          node('polyline', { ...attrs, points: `${x2 - size * Math.cos(angle - .5)},${y2 - size * Math.sin(angle - .5)} ${x2},${y2} ${x2 - size * Math.cos(angle + .5)},${y2 - size * Math.sin(angle + .5)}` });
        }
      });
    }
    function seek(seconds, basis = 'video', transport = false) {
      if (!objectURL || !Number.isFinite(video.duration)) { s.status('Select a playable local video first. Your notes can still be edited without one.'); return; }
      try {
        video.currentTime = playbackSeconds(transport ? Math.max(0, Math.min(seconds, video.duration, MAX_SECONDS)) : seconds, basis, offset, video.duration);
      } catch (e) { s.status(e.message, true); }
    }
    function updateBasisLabel() {
      const control = root.querySelector('[name="moment-seconds"]');
      control.parentElement.firstChild.textContent = `New moment at seconds (${basisLabel(draft.time_basis).toLowerCase()})`;
    }
    function renderContext() {
      const out = root.querySelector('[data-context-content]'), data = cachedContext;
      if (!data) { out.replaceChildren(); return; }
      const focus = requestedFocus?.match === draft.match_id ? requestedFocus : null;
      const rows = (items, kind) => items.map((item, index) => {
        const requested = !!focus && (focus.prompt ? kind === 'prompts' && item.id === focus.prompt : Number.isFinite(focus.at) && item.seconds === focus.at);
        return `<li data-context-row${requested ? ' aria-current="true"' : ''}><p>${requested ? '<strong>Requested focus · </strong>' : ''}${stamp(item.seconds)} (${item.seconds} seconds · Match clock) — ${esc(kind === 'prompts' ? item.title : item.label)}</p>${kind === 'prompts' ? `<p>${esc(item.question)}</p><p>${esc(item.evidence)}</p>` : ''}<div class="training-actions">${button('context-jump', 'Jump in local video', `data-kind="${kind}" data-index="${index}"`)}${button('context-moment', 'Create review moment', `data-kind="${kind}" data-index="${index}"`)}</div></li>`;
      }).join('');
      out.innerHTML = `<p>${esc(data.note || 'Cached observations are not a cause attribution or mistake verdict.')}</p>${data.available ? `<h4>Reflection prompts</h4>${data.prompts.length ? `<ol class="training-list">${rows(data.prompts, 'prompts')}</ol>` : '<p>No reflection prompts in this cached timeline.</p>'}<h4>Cached events</h4>${data.events.length ? `<ol class="training-list">${rows(data.events, 'events')}</ol>` : '<p>No usable events in this cached timeline.</p>'}` : '<p>A usable cached timeline is unavailable; nothing was fetched from Riot.</p>'}`;
    }
    async function loadContext() {
      const matchId = draft.match_id;
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(matchId)) { contextStatus('Enter a match ID before loading cached events.'); return; }
      const epoch = ++contextEpoch, version = s.version;
      const latest = () => s.current() && epoch === contextEpoch && version === s.version && draft.match_id === matchId;
      contextLoading = true; contextStatus('Loading cached match events…');
      try {
        const result = await ctx.request(`/api/training/review-context/${encodeURIComponent(matchId)}`);
        if (!latest()) return;
        if (result?.match?.match_id !== matchId || typeof result.available !== 'boolean' || !Array.isArray(result.events) || !Array.isArray(result.prompts)) throw Error('Invalid cached context.');
        const events = result.available ? result.events.slice(0, 80).map(e => ({ seconds: number(e.seconds, 0, MAX_SECONDS, 'Event time'), label: text(e.label, 4000, 'Event label') })) : [];
        const prompts = result.available ? result.prompts.slice(0, 3).map(p => {
          if (p.match_id !== matchId) throw Error('Invalid prompt match.');
          return { id: id(p.id), seconds: number(p.seconds, 0, MAX_SECONDS, 'Prompt time'), title: text(p.title, 120, 'Prompt title', true), question: text(p.question, 4000, 'Prompt question'), evidence: text(p.evidence, 4000, 'Prompt evidence') };
        }) : [];
        cachedContext = { available: result.available, events, prompts, note: typeof result.note === 'string' ? result.note : '' };
        renderContext();
        contextStatus(result.available ? 'Cached match-clock context loaded. Nothing was added to your notes; choose Create review moment explicitly.' : 'A usable cached timeline is unavailable; nothing was fetched. Your notes are unchanged.');
      } catch (e) {
        if (!latest()) return;
        cachedContext = null; renderContext();
        // Never echo endpoint errors: they must not disclose another account or match.
        contextStatus(e?.status === 404 || e?.statusCode === 404 ? 'Cached context unavailable for the currently linked account. Your typed notes are unchanged.' : 'Cached match context could not be loaded. Your typed notes are unchanged; retry when ready.');
      } finally { if (epoch === contextEpoch) { contextLoading = false; if (s.current() && version !== s.version) contextStatus('The editor changed while loading. Load cached match events again when ready.'); } }
    }
    function useContext(control, create) {
      const item = cachedContext?.[control.dataset.kind]?.[Number(control.dataset.index)];
      if (!item || !cachedContext.available) throw Error('Load cached match context again before using it.');
      if (!create) { seek(item.seconds, 'match'); return; }
      const seconds = convertSeconds(item.seconds, 'match', draft.time_basis, offset);
      if (draft.moments.length >= 50) throw Error('A review can contain at most 50 moments.');
      if (!abandonMomentTools()) return;
      const added = moment(seconds);
      added.title = (item.title || item.label).slice(0, 120);
      added.known = '';
      added.outcome = item.evidence || `Cached event at ${stamp(item.seconds)} (Match clock): ${item.label}. This is an observation, not a mistake verdict.`;
      added.options = item.question || '';
      releaseDrag(); draft.moments.push(added); selected = draft.moments.length - 1;
      s.changed(); lists(); momentEditor(); editor.querySelector('[name="moment-title"]').focus();
      s.status('Review moment added to the unsaved draft. Existing moments and annotations were kept.');
    }
    function lists() {
      root.querySelector('[data-list]').innerHTML = listRows(p.records, 'reviews');
      root.querySelector('[data-moments]').innerHTML = draft.moments.length ? `<ol class="training-list">${draft.moments.map((m, i) => `<li>${button('moment', `${stamp(m.seconds)} · ${basisLabel(draft.time_basis)} — ${esc(m.title || 'Untitled moment')}`, `data-index="${i}" aria-pressed="${i === selected}"`)}</li>`).join('')}</ol>` : '<p class="training-muted">Add a timestamp to capture a decision. Notes also work without a video.</p>';
      root.querySelector('[data-action="more"]').hidden = !p.more;
    }
    function markFields() {
      const a = currentMoment()?.annotations[markIndex];
      for (const key of ['kind', 'x', 'y', 'x2', 'y2', 'text']) {
        const el = editor.querySelector(`[name="ann-${key}"]`);
        if (el) el.value = a ? a[key] : ({ kind: 'arrow', x: .3, y: .3, x2: .6, y2: .6, text: '' })[key];
      }
      const out = editor.querySelector('[data-mark-selection]'); if (out) out.textContent = a ? `Editing annotation ${markIndex + 1}` : 'New annotation';
      const marks = editor.querySelector('[data-mark-list]');
      if (marks) marks.innerHTML = `<ul class="training-list">${(currentMoment()?.annotations || []).map((a, i) => `<li>${button('select-mark', `${i + 1}. ${esc(a.kind)} (${a.x.toFixed(3)}, ${a.y.toFixed(3)}) → (${a.x2.toFixed(3)}, ${a.y2.toFixed(3)}) ${esc(a.text)}`, `data-index="${i}" aria-pressed="${i === markIndex}"`)}</li>`).join('')}</ul>`;
    }
    function momentEditor() {
      const m = currentMoment(); markIndex = -1;
      if (!m) { editor.innerHTML = ''; draw(); return; }
      editor.innerHTML = `<div class="training-form">${field(`Moment timestamp (seconds · ${basisLabel(draft.time_basis)})`, `<input name="seconds" data-moment-field type="number" min="0" max="28800" step="0.1" value="${m.seconds}">`)}${input('moment-title', 'Moment title', 120, m.title)}${prose('known', 'What was known at the time?', m.known)}${prose('options', 'What options were available?', m.options)}${prose('decision', 'What did you decide, and why?', m.decision)}${prose('outcome', 'What happened? (An outcome is not proof the decision was right.)', m.outcome)}${prose('lesson', 'What would you test or remember next time?', m.lesson)}<div class="training-actions">${button('seek-moment', 'Seek to this moment')}${button('delete-moment', 'Delete this moment')}${button('make-lesson', 'Create a lesson from this saved moment')}${button('make-puzzle', 'Create a puzzle from this saved moment')}</div><details class="training-details"><summary>Annotations: draw, move or edit numerically</summary>${field('Pointer tool', '<select name="tool"><option value="off">Playback (overlay off)</option value="select">Select / move annotation</option><option value="arrow">Draw arrow</option><option value="circle">Draw circle (centre to edge)</option><option value="text">Place text</option></select>')}<p data-mark-selection>New annotation</p>${field('Annotation kind', '<select name="ann-kind"><option>arrow</option><option>circle</option><option>text</option></select>')}<div class="training-inline">${['x', 'y', 'x2', 'y2'].map(k => field(k === 'x2' ? 'End / edge X (0–1)' : k === 'y2' ? 'End / edge Y (0–1)' : `${k.toUpperCase()} (0–1)`, `<input name="ann-${k}" type="number" min="0" max="1" step="0.001" value="0.3">`)).join('')}</div>${input('ann-text', 'Annotation text (plain text)', 160)}<div class="training-actions">${button('apply-mark', 'Add / update annotation')}${button('new-mark', 'Start another annotation')}${button('delete-mark', 'Delete selected annotation')}</div><div data-mark-list></div></details></div><div data-derived></div>`;
      markFields(); draw();
    }
    function fill() {
      draft.time_basis = timeBasis(draft.time_basis);
      for (const key of ['title', 'match_id', 'source_label', 'time_basis']) form.elements[key].value = draft[key];
      updateBasisLabel(); momentInputTouched = false;
      root.querySelector('[data-editor-title]').textContent = existing ? `Editing saved review · revision ${existing.revision}` : 'New review';
      lists(); momentEditor();
    }
    async function load(recordId, fresh = false) {
      if (s.pending || !s.discard()) return;
      const version = s.invalidate();
      const entry = fresh ? await p.fresh(recordId) : await p.find(recordId);
      if (!s.current()) return;
      if (s.version !== version) { s.status('The record was fetched, but your new edits were kept. Choose Load again to replace them.'); return; }
      if (!entry) throw Error('That review was not found or is no longer accessible.');
      releaseDrag(); resetClock(); invalidateContext(true); requestedFocus = null;
      existing = entry; draft = clone(entry.data); selected = draft.moments.length ? 0 : -1; fill(); s.clean('*');
      s.status('Saved review loaded. Select the matching local video yourself; no footage was stored.');
    }
    function savedMoment() {
      const m = currentMoment(), saved = existing?.data.moments.find(x => x.id === m?.id);
      if (!saved || timeBasis(draft.time_basis) !== timeBasis(existing.data.time_basis) || JSON.stringify(m) !== JSON.stringify(saved)) throw Error('Save this moment before deriving a lesson or puzzle. Only saved notes will be used.');
      return saved;
    }
    function abandonAnnotation() {
      if (s.hasDirty('annotation') && !host.confirm('Discard the unapplied numeric annotation fields? Use Add / update annotation to include them in your notes.')) return false;
      s.clean('annotation'); return true;
    }
    function abandonMomentTools() { return abandonAnnotation() && abandonDerived(); }
    function abandonDerived() {
      if (editor.querySelector('[data-derived-form]') && !host.confirm('Discard the unfinished lesson or puzzle form for this moment?')) return false;
      s.clean('derived'); return true;
    }
    function derived(kind) {
      const m = savedMoment(), out = editor.querySelector('[data-derived]');
      if (!abandonDerived()) return;
      if (kind === 'lessons') out.innerHTML = `<h4>New personal lesson</h4><p>This creates a separate personal lesson, linked to the saved review. Edit the question and answer, then explicitly save.</p><form data-derived-form="lessons" class="training-form">${prose('question', 'Question', `At ${stamp(m.seconds)} (${basisLabel(draft.time_basis)}), ${m.title}: what would you consider?`)}${prose('answer', 'Answer / reminder', m.lesson || m.decision)}<button class="btn" type="submit">Save new lesson</button>${button('cancel-derived', 'Cancel')}</form>`;
      else out.innerHTML = `<h4>New personal decision puzzle</h4><p>Use the saved moment as context; author at least two reasonable alternatives and their tradeoffs. No video or filename is included.</p><form data-derived-form="puzzles" class="training-form">${puzzleFields({ ...emptyPuzzle(), title: m.title, prompt: m.options || 'What would you consider doing here, and why?', context: `Review moment: ${stamp(m.seconds)} (${m.seconds} seconds · ${basisLabel(draft.time_basis)}).\n${m.known}`, discussion: m.lesson || m.outcome })}<button class="btn" type="submit">Save new puzzle</button>${button('cancel-derived', 'Cancel')}</form>`;
      s.changed('derived');
    }
    s.listen(form, 'input', event => { const key = event.target.name; if (['title', 'match_id', 'source_label'].includes(key)) {
      if (key === 'match_id' && draft.match_id !== event.target.value) { resetClock(); invalidateContext(true); requestedFocus = null; }
      draft[key] = event.target.value; s.changed();
    } });
    s.listen(root, 'input', event => { if (event.target.name === 'moment-seconds') momentInputTouched = true; invalidateContext(); });
    s.listen(form.elements.time_basis, 'change', () => {
      const to = form.elements.time_basis.value;
      if (to === draft.time_basis) return;
      try {
        const converted = convertReviewBasis(draft, to, offset);
        const proposed = numeric(root.querySelector('[name="moment-seconds"]').value);
        const newSeconds = momentInputTouched ? convertSeconds(proposed, draft.time_basis, to, offset) : 0;
        if (!host.confirm(`Convert all ${draft.moments.length} moment timestamps from ${basisLabel(draft.time_basis)} to ${basisLabel(to)}? Saved lessons and puzzles are separate records and keep their original clock. Nothing is saved until you save this review.`) || !abandonMomentTools()) return;
        releaseDrag(); draft = converted; root.querySelector('[name="moment-seconds"]').value = String(newSeconds);
        s.changed(); updateBasisLabel(); lists(); momentEditor();
      } catch (e) { s.status(e.message, true); }
      finally { form.elements.time_basis.value = draft.time_basis; }
    });
    s.listen(form, 'submit', event => {
      event.preventDefault(); s.task(event.submitter, async () => {
        const data = reviewData(draft), version = s.version;
        const entry = await ctx.save('reviews', data, existing);
        if (!s.current()) return;
        existing = entry; p.put(entry); if (version === s.version) s.clean();
        root.querySelector('[data-editor-title]').textContent = `Editing saved review · revision ${entry.revision}`; lists(); s.status('Review notes saved. Local footage was not sent.');
      });
    });
    s.listen(file, 'change', () => {
      if (!s.current()) return;
      const chosen = file.files?.[0];
      if (!chosen) return;
      if (chosen.type && !chosen.type.startsWith('video/')) { s.status('Choose a video file supported by your browser.', true); file.value = ''; return; }
      // Keep no File reference or filename in state, requests, labels or persistence.
      releaseDrag(); resetClock();
      video.pause(); video.removeAttribute('src'); video.load();
      if (objectURL) host.URL.revokeObjectURL(objectURL);
      objectURL = host.URL.createObjectURL(chosen); video.src = objectURL; video.load();
      s.status('Video opened only on this device. Notes and manual source label are unchanged.');
    });
    for (const event of ['loadedmetadata', 'resize']) s.listen(video, event, draw);
    s.listen(video, 'timeupdate', () => { root.querySelector('[data-time]').textContent = `Video clock ${stamp(video.currentTime)} (${video.currentTime.toFixed(1)} seconds)`; });
    s.listen(video, 'error', () => { if (objectURL) s.status('This browser could not play that local file. Try a supported video; your notes are unchanged.', true); });
    s.listen(host, 'resize', draw);
    if (host.ResizeObserver) { const observer = new host.ResizeObserver(draw); observer.observe(stage); s.onDispose(() => observer.disconnect()); }
    s.listen(stage, 'keydown', event => {
      if (event.target !== stage || !objectURL || event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase(); let handled = true;
      if (key === ' ' || key === 'k') togglePlay();
      else if (key === 'arrowleft' || key === 'j') seek(video.currentTime - (key === 'j' ? 10 : 5), 'video', true);
      else if (key === 'arrowright' || key === 'l') seek(video.currentTime + (key === 'l' ? 10 : 5), 'video', true);
      else if (key === 'home') seek(0);
      else if (key === 'end') seek(video.duration);
      else if (/^[0-9]$/.test(key)) seek(video.duration * Number(key) / 10);
      else if (key === 'm') video.muted = !video.muted;
      else if (key === 'arrowup' || key === 'arrowdown') video.volume = clamp(video.volume + (key === 'arrowup' ? .05 : -.05));
      else handled = false;
      if (handled) event.preventDefault();
    });
    function togglePlay() { if (!objectURL) { s.status('Choose a local video first.'); return; } if (video.paused) { const playing = video.play(); if (playing?.catch) playing.catch(e => { if (s.current()) s.status(`Playback could not start: ${e.message}`, true); }); } else video.pause(); }
    s.listen(editor, 'input', event => {
      const m = currentMoment(), key = event.target.name; if (!m) return;
      if (key === 'seconds') { m.seconds = numeric(event.target.value); s.changed(); }
      else if (key === 'moment-title') { m.title = event.target.value; s.changed(); }
      else if (['known', 'options', 'decision', 'outcome', 'lesson'].includes(key)) { m[key] = event.target.value; s.changed(); }
      else if (event.target.closest('[data-derived-form]')) s.changed('derived');
      else if (key?.startsWith('ann-')) s.changed('annotation');
    });
    s.listen(editor, 'change', event => { if (event.target.name === 'tool') draw(); else if (['seconds', 'moment-title'].includes(event.target.name)) lists(); });
    s.listen(editor, 'submit', event => {
      const derivedForm = event.target.closest('[data-derived-form]'); if (!derivedForm) return;
      event.preventDefault(); s.task(event.submitter, async () => {
        const m = savedMoment(), kind = derivedForm.dataset.derivedForm, version = s.version;
        const data = kind === 'lessons' ? lessonData({ ...emptyLesson(), question: derivedForm.elements.question.value, answer: derivedForm.elements.answer.value, source_review_id: existing.id }) : puzzleData({ ...readPuzzle(derivedForm), source_review_id: existing.id, seconds: m.seconds });
        const entry = await ctx.save(kind, data, derivedEntries.get(derivedForm) || null);
        if (!s.current()) return;
        derivedEntries.set(derivedForm, entry);
        if (version === s.version) { derivedForm.remove(); s.clean('derived'); }
        else if (derivedForm.isConnected) derivedForm.querySelector('[type="submit"]').textContent = 'Save changes to this new record';
        s.status(`New personal ${kind === 'lessons' ? 'lesson' : 'puzzle'} saved. Open ${kind} from Training home to practice.`);
      });
    });
    s.listen(svg, 'pointerdown', event => {
      if (!s.current() || event.button !== 0) return;
      const m = currentMoment(), f = frame(), point = framePoint(f, event.clientX, event.clientY), tool = editor.querySelector('[name="tool"]')?.value;
      if (!m || !point || tool === 'off') return;
      event.preventDefault(); video.pause(); svg.focus();
      if (tool === 'select') {
        if (!abandonAnnotation()) return;
        const hit = event.target.closest('[data-mark]');
        if (!hit) return;
        markIndex = Number(hit.dataset.mark); drag = { pointer: event.pointerId, point, before: clone(m.annotations[markIndex]), index: markIndex, tool };
      } else {
        if (m.annotations.length >= 30) { s.status('This moment already has 30 annotations.', true); return; }
        const a = annotation({ kind: tool, ...point, x2: point.x, y2: point.y, text: editor.querySelector('[name="ann-text"]').value });
        m.annotations.push(a); markIndex = m.annotations.length - 1; drag = { pointer: event.pointerId, point, index: markIndex, tool }; s.changed();
      }
      s.clean('annotation'); svg.setPointerCapture(event.pointerId); markFields(); draw();
    });
    s.listen(svg, 'pointermove', event => {
      if (!drag || drag.pointer !== event.pointerId) return;
      const point = framePoint(frame(), event.clientX, event.clientY), m = currentMoment(); if (!point || !m) return;
      m.annotations[drag.index] = drag.tool === 'select' ? moveMark(drag.before, point.x - drag.point.x, point.y - drag.point.y) : { ...m.annotations[drag.index], x2: point.x, y2: point.y };
      s.changed(); markFields(); draw();
    });
    const release = event => { if (drag?.pointer === event.pointerId) { if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId); drag = null; } };
    s.listen(svg, 'pointerup', release); s.listen(svg, 'pointercancel', release); s.listen(svg, 'lostpointercapture', () => { drag = null; });
    s.listen(svg, 'keydown', event => {
      const m = currentMoment(), a = m?.annotations[markIndex]; if (!a) return;
      if (event.key === 'Delete' || event.key === 'Backspace') { m.annotations.splice(markIndex, 1); markIndex = -1; }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { const step = event.shiftKey ? .05 : .01; m.annotations[markIndex] = moveMark(a, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0); }
      else return;
      event.preventDefault(); event.stopPropagation(); s.changed(); markFields(); draw();
    });
    s.listen(root, 'click', event => {
      const el = event.target.closest('[data-action]'); if (!el || !root.contains(el)) return;
      const action = el.dataset.action;
      if (action === 'load') { if (s.pending) return; load(el.dataset.id).catch(s.error); return; }
      if (action === 'reload') { if (existing && !s.pending) load(existing.id, true).catch(s.error); else s.status('Load or save a review first.'); return; }
      if (action === 'new') { if (!s.pending && s.discard()) { s.invalidate(); releaseDrag(); resetClock(); invalidateContext(true); requestedFocus = null; existing = null; draft = emptyReview(''); selected = -1; fill(); s.clean('*'); } return; }
      if (action === 'play') return togglePlay();
      if (action === 'back' || action === 'forward') return seek(video.currentTime + (action === 'back' ? -5 : 5), 'video', true);
      if (action === 'detach') { dropVideo(); root.querySelector('[data-time]').textContent = 'Local video forgotten. Notes kept.'; return; }
      try {
        if (action === 'seek') return seek(number(numeric(root.querySelector('[name="seek"]').value), 0, MAX_SECONDS, 'Seek time'));
        if (action === 'load-context') { loadContext(); return; }
        if (action === 'context-jump' || action === 'context-moment') { useContext(el, action === 'context-moment'); return; }
        if (action === 'clear-clock') { resetClock(); return; }
        if (action === 'align-clock') {
          if (!objectURL || !Number.isFinite(video.duration)) throw Error('Select a playable local video before aligning.');
          offset = clockOffset(video.currentTime, numeric(root.querySelector('[name="anchor-seconds"]').value), video.duration);
          root.querySelector('[data-sync-status]').textContent = `Aligned locally: video = match clock ${offset < 0 ? '−' : '+'} ${Math.abs(offset).toFixed(1)} seconds. This offset is not saved.`;
          return;
        }
        if (action === 'use-time') {
          if (!objectURL || !Number.isFinite(video.duration)) throw Error('Select a playable local video first.');
          root.querySelector('[name="moment-seconds"]').value = String(convertSeconds(video.currentTime, 'video', draft.time_basis, offset)); momentInputTouched = true; return;
        }
        if (action === 'add-choice' || action === 'remove-choice') { const target = el.closest('[data-derived-form="puzzles"]'); if (target && changeChoices(target, action === 'add-choice')) s.changed('derived'); return; }
        if (action === 'add-moment') { if (!abandonMomentTools()) return; if (draft.moments.length >= 50) throw Error('A review can contain at most 50 moments.'); draft.moments.push(moment(number(numeric(root.querySelector('[name="moment-seconds"]').value), 0, MAX_SECONDS, 'Timestamp'))); selected = draft.moments.length - 1; s.changed(); lists(); momentEditor(); editor.querySelector('[name="moment-title"]').focus(); return; }
        if (action === 'moment') { if (!abandonMomentTools()) return; selected = Number(el.dataset.index); lists(); momentEditor(); seek(currentMoment().seconds, draft.time_basis); editor.querySelector('[name="moment-title"]').focus(); return; }
        if (action === 'seek-moment') return seek(currentMoment().seconds, draft.time_basis);
        if (action === 'delete-moment') { if (!abandonMomentTools()) return; if (host.confirm('Delete this moment and its annotations from the draft? Save the review to persist deletion.')) { draft.moments.splice(selected, 1); selected = draft.moments.length ? 0 : -1; s.changed(); lists(); momentEditor(); } return; }
        if (action === 'make-lesson' || action === 'make-puzzle') return derived(action === 'make-lesson' ? 'lessons' : 'puzzles');
        if (action === 'cancel-derived') { if (abandonDerived()) editor.querySelector('[data-derived]').replaceChildren(); return; }
        if (action === 'select-mark') { if (!abandonAnnotation()) return; markIndex = Number(el.dataset.index); markFields(); draw(); return; }
        if (action === 'new-mark') { if (!abandonAnnotation()) return; markIndex = -1; markFields(); draw(); return; }
        if (action === 'delete-mark') { if (!abandonAnnotation()) return; if (markIndex >= 0) { currentMoment().annotations.splice(markIndex, 1); markIndex = -1; s.changed(); markFields(); draw(); } return; }
        if (action === 'apply-mark') {
          const a = { kind: editor.querySelector('[name="ann-kind"]').value, text: editor.querySelector('[name="ann-text"]').value };
          for (const k of ['x', 'y', 'x2', 'y2']) a[k] = numeric(editor.querySelector(`[name="ann-${k}"]`).value);
          const valid = annotation(a), marks = currentMoment().annotations;
          if (markIndex < 0) { if (marks.length >= 30) throw Error('A moment can contain at most 30 annotations.'); marks.push(valid); markIndex = marks.length - 1; } else marks[markIndex] = valid;
          s.changed(); s.clean('annotation'); markFields(); draw(); return;
        }
      } catch (e) { s.error(e); return; }
      s.task(el, async () => {
        if (action === 'more') { await p.next(); if (s.current()) lists(); }
        else if (action === 'share') await share(ctx, s, root, 'reviews', existing);
        else if (action === 'delete') {
          if (!existing) throw Error('Load or save a review first.');
          if (!host.confirm('Permanently delete this saved review? Separate lessons and puzzles are not deleted.')) return;
          const target = existing; await ctx.remove(target); if (!s.current()) return;
          p.drop(target); existing = null; s.changed(); lists(); root.querySelector('[data-editor-title]').textContent = 'Deleted from server · draft kept'; s.status('Saved review deleted. Your current draft and local video remain available.');
        }
      });
    });
    fill();
    if (ctx.id) load(ctx.id).catch(s.error);
  }

  async function renderTeamReview(root, ctx, teamId) {
    root.innerHTML = `${head('Team review notes', 'This is a shared notes-only copy, not anyone’s footage.')}<p><a href="#/practice/team/${encodeURIComponent(teamId)}">Back to team workspace</a></p><div data-team-notes></div>${footer}`;
    const s = scope(root, ctx), p = pager(ctx, s, 'reviews', teamId);
    try {
      const entry = ctx.id ? await p.find(ctx.id) : (await p.next(), p.records[0]);
      if (!s.current()) return;
      if (!entry) throw Error('This team review was not found or you no longer have access.');
      const d = entry.data;
      root.querySelector('[data-team-notes]').innerHTML = `<section class="training-card"><h3>${esc(d.title)}</h3><p>Manual source label: ${esc(d.source_label || 'Not supplied')} · Match: ${esc(d.match_id || 'Not supplied')}</p>${d.moments.map(m => `<details class="training-details"><summary>${stamp(m.seconds)} · ${basisLabel(d.time_basis)} — ${esc(m.title)}</summary>${['known', 'options', 'decision', 'outcome', 'lesson'].map(k => `<h4>${esc(k)}</h4><p style="white-space:pre-wrap">${esc(m[k])}</p>`).join('')}<h4>Normalized annotation coordinates</h4><ul>${m.annotations.map(a => `<li>${esc(a.kind)}: (${a.x}, ${a.y}) → (${a.x2}, ${a.y2}) ${esc(a.text)}</li>`).join('')}</ul></details>`).join('')}</section>`;
    } catch (e) { if (s.current()) s.error(e); }
  }

  function renderLessons(root, ctx) {
    root.innerHTML = `${head('Recall lessons', 'Try recalling the answer before revealing it; the server schedules your next review.')}<section class="training-card"><h3>Due lessons</h3><p class="training-muted">Due and upcoming lists cover the records loaded below. Load older lessons to include older due dates.</p><div data-due></div><div data-recall></div></section><section class="training-card"><h3 data-editor-title>New personal lesson</h3><form class="training-form" data-lesson-form>${prose('question', 'Question')}${prose('answer', 'Answer / reminder')}<div class="training-actions"><button class="btn" type="submit">Save lesson</button>${button('new', 'New lesson')}${button('reload', 'Reload saved lesson')}${button('delete', 'Delete saved lesson')}</div></form>${footer}</section><section class="training-card"><h3>All loaded personal lessons</h3><div data-list></div>${button('more', 'Load older personal lessons')}</section>`;
    const s = scope(root, ctx), p = pager(ctx, s, 'lessons'), form = root.querySelector('[data-lesson-form]');
    let existing = null, schedule = emptyLesson(), recalling = null, revealed = false;
    function drawLists() {
      const now = Math.floor(Date.now() / 1000), due = p.records.filter(e => e.data.due <= now).sort((a, b) => a.data.due - b.data.due);
      root.querySelector('[data-due]').innerHTML = due.length ? `<ul class="training-list">${due.map(e => `<li>${button('recall', esc(e.data.question), `data-id="${esc(e.id)}"`)}</li>`).join('')}</ul>` : '<p>No due lessons among the loaded records. Upcoming lessons are listed below.</p>';
      root.querySelector('[data-list]').innerHTML = listRows(p.records, 'lessons'); root.querySelector('[data-action="more"]').hidden = !p.more;
    }
    function recall() {
      const out = root.querySelector('[data-recall]');
      if (!recalling) { out.replaceChildren(); return; }
      out.innerHTML = `<section class="training-card"><h4>${esc(recalling.data.question)}</h4><p>Think of your answer before revealing the reminder.</p>${revealed ? `<p style="white-space:pre-wrap">${esc(recalling.data.answer)}</p><p>Rate your recall, not whether this decision always wins.</p><div class="training-actions">${['again', 'good', 'easy'].map(r => button('grade', r[0].toUpperCase() + r.slice(1), `data-rating="${r}"`)).join('')}</div>` : button('reveal', 'Reveal answer')}${button('reload-recall', 'Reload this lesson from server')}</section>`;
    }
    function fill(entry) {
      s.invalidate();
      existing = entry; schedule = entry ? clone(entry.data) : emptyLesson();
      form.elements.question.value = schedule.question; form.elements.answer.value = schedule.answer;
      root.querySelector('[data-editor-title]').textContent = entry ? `Edit lesson · revision ${entry.revision}` : 'New personal lesson'; s.clean();
    }
    async function load(recordId, fresh = false) {
      if (s.pending || !s.discard()) return;
      const version = s.invalidate(), entry = fresh ? await p.fresh(recordId) : await p.find(recordId);
      if (!s.current()) return;
      if (version !== s.version) { s.status('Your new edits were kept. Load again to replace them.'); return; }
      if (!entry) throw Error('Lesson not found or no longer accessible.');
      fill(entry);
    }
    s.listen(form, 'input', s.changed);
    s.listen(form, 'submit', event => { event.preventDefault(); s.task(event.submitter, async () => {
      const version = s.version, data = lessonData({ ...schedule, question: form.elements.question.value, answer: form.elements.answer.value });
      const entry = await ctx.save('lessons', data, existing); if (!s.current()) return;
      existing = entry; schedule = clone(entry.data); p.put(entry); if (version === s.version) s.clean(); drawLists(); s.status('Personal lesson saved. Scheduling is retained when you edit.');
    }); });
    s.listen(root, 'click', event => {
      const el = event.target.closest('[data-action]'); if (!el) return;
      const action = el.dataset.action;
      if (action === 'load') { load(el.dataset.id).catch(s.error); return; }
      if (action === 'reload') { if (existing) load(existing.id, true).catch(s.error); else s.status('Load or save a lesson first.'); return; }
      if (action === 'new') { if (!s.pending && s.discard()) fill(null); return; }
      if (action === 'recall') { if (!s.pending) { recalling = p.records.find(e => e.id === el.dataset.id); revealed = false; recall(); } return; }
      if (action === 'reveal') { revealed = true; recall(); return; }
      s.task(el, async () => {
        if (action === 'more') { await p.next(); if (s.current()) drawLists(); }
        else if (action === 'reload-recall') {
          if (!recalling || !host.confirm('Load the latest saved question, answer and schedule for this recall card?')) return;
          const target = recalling.id, entry = await p.fresh(target);
          if (!s.current()) return;
          if (!entry) throw Error('This lesson is no longer accessible.');
          recalling = entry; revealed = false; recall(); drawLists(); s.status('Latest lesson loaded. Recall it again before grading.');
        }
        else if (action === 'grade') {
          if (!recalling || !revealed) return;
          const target = recalling;
          const result = await ctx.request(`/api/training/lessons/${encodeURIComponent(target.id)}/grade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: target.revision, rating: el.dataset.rating }) });
          if (!s.current()) return;
          p.put(result.entry); syncEntry(ctx, 'lessons', result.entry);
          if (existing?.id === target.id) { existing = result.entry; schedule = clone(result.entry.data); }
          recalling = null; revealed = false; recall(); drawLists(); s.status(`Recall recorded. Next due: ${new Date(result.entry.data.due * 1000).toLocaleString()}.`);
        } else if (action === 'delete') {
          if (!existing) throw Error('Load a saved lesson first.');
          if (!host.confirm('Permanently delete this personal lesson?')) return;
          const target = existing; await ctx.remove(target); if (!s.current()) return;
          p.drop(target); existing = null; schedule = emptyLesson(); s.changed(); if (recalling?.id === target.id) { recalling = null; recall(); } drawLists(); s.status('Saved lesson deleted. The form is kept as an unsaved new lesson.');
        }
      });
    });
    drawLists();
  }

  function puzzleFields(d) {
    return `${input('title', 'Puzzle title', 120, d.title)}${prose('prompt', 'Decision prompt', d.prompt)}${prose('context', 'Known context (no hindsight)', d.context)}<div data-choices>${d.choices.map((c, i) => `<fieldset><legend>Choice ${i + 1}</legend>${input(`choice-${i}`, 'Choice label', 160, c.label)}${prose(`tradeoff-${i}`, 'When might this be reasonable, and what does it risk?', c.tradeoff)}</fieldset>`).join('')}</div><div class="training-actions">${button('add-choice', 'Add choice (max 5)')}${button('remove-choice', 'Remove last choice (min 2)')}</div>${prose('discussion', 'Discussion: context-dependent alternatives, not a universal correct answer', d.discussion)}`;
  }
  function readPuzzle(form) {
    const choices = [...form.querySelectorAll('[data-choices] fieldset')].map((_, i) => ({ label: form.elements[`choice-${i}`].value, tradeoff: form.elements[`tradeoff-${i}`].value }));
    return { ...emptyPuzzle(), title: form.elements.title.value, prompt: form.elements.prompt.value, context: form.elements.context.value, discussion: form.elements.discussion.value, choices };
  }
  function changeChoices(form, add) {
    const list = form.querySelector('[data-choices]'), count = list.children.length;
    if (add && count < 5) list.insertAdjacentHTML('beforeend', `<fieldset><legend>Choice ${count + 1}</legend>${input(`choice-${count}`, 'Choice label', 160)}${prose(`tradeoff-${count}`, 'When might this be reasonable, and what does it risk?')}</fieldset>`);
    else if (!add && count > 2 && host.confirm('Remove the last choice and its tradeoff?')) list.lastElementChild.remove();
    else return false;
    return true;
  }
  function catalogEntries(ctx) {
    return (ctx.bootstrap.catalog?.starter_puzzles || []).map(p => ({ id: p.id, data: p.data || p, catalog: true, team_id: null }));
  }
  function renderPuzzles(root, ctx) {
    root.innerHTML = `${head('Decision puzzles', 'Explain a choice before comparing tradeoffs. Several decisions can be reasonable; there is no universal correct score.')}<section class="training-card"><h3>Authored text-only starters and your puzzles</h3><p>No third-party footage or rights-dependent clips are used.</p><div data-catalog></div><div data-list></div>${button('more', 'Load more personal puzzles')}</section><section class="training-card" data-attempt></section><details class="training-card training-details" data-author><summary>Write or edit a personal puzzle</summary><h3 data-editor-title>New personal puzzle</h3><form class="training-form" data-puzzle-form>${puzzleFields(emptyPuzzle())}<div class="training-actions"><button class="btn" type="submit">Save puzzle</button>${button('new', 'New puzzle')}${button('reload', 'Reload saved puzzle')}${button('delete', 'Delete saved puzzle')}</div></form>${sharing(ctx, 'puzzle')}</details>${footer}`;
    const s = scope(root, ctx), p = pager(ctx, s, 'puzzles'), a = pager(ctx, s, 'attempts'), catalog = catalogEntries(ctx), form = root.querySelector('[data-puzzle-form]'), attemptRoot = root.querySelector('[data-attempt]');
    let existing = null, source = { source_review_id: null, seconds: null }, active = null, revealed = false, attemptSaved = false, attemptVersion = 0, attemptEntry = null;
    let attempt = { choice_index: -1, reason: '', reflection: '' };
    function lists() {
      const rows = (records, own) => `<ul class="training-list">${records.map(e => `<li>${button('practice', esc(e.data.title), `data-id="${esc(e.id)}"`)}${own ? ` ${button('load', 'Edit', `data-id="${esc(e.id)}"`)}` : ''}</li>`).join('')}</ul>`;
      root.querySelector('[data-catalog]').innerHTML = `<h4>Starter scenarios</h4>${catalog.length ? rows(catalog, false) : '<p>The starter catalog is unavailable. You can author a personal text-only puzzle below.</p>'}`;
      root.querySelector('[data-list]').innerHTML = `<h4>Your saved puzzles</h4>${p.records.length ? rows(p.records, true) : '<p>No personal puzzles yet.</p>'}`; root.querySelector('[data-action="more"]').hidden = !p.more;
    }
    function history() {
      const out = attemptRoot.querySelector('[data-attempt-history]'); if (!out || !active) return;
      const previous = a.records.filter(e => e.data.puzzle_id === active.id);
      out.innerHTML = `<details class="training-details"><summary>Previous saved reasoning (${previous.length} loaded)</summary><ul class="training-list">${previous.map(e => `<li><p>Choice ${e.data.choice_index + 1}: ${esc(e.data.reason)}</p><p>Reflection: ${esc(e.data.reflection || 'Not supplied')}</p></li>`).join('')}</ul>${button('more-attempts', 'Load older attempts', a.more ? '' : 'hidden')}</details>`;
    }
    function practice(entry) {
      if (active && !attemptSaved && (attempt.choice_index >= 0 || attempt.reason || attempt.reflection) && !host.confirm('Discard the unsaved attempt and open another puzzle?')) return;
      active = entry; revealed = false; attemptSaved = false; attemptEntry = null; attemptVersion++; attempt = { choice_index: -1, reason: '', reflection: '' }; s.clean('attempt');
      const d = entry.data;
      attemptRoot.innerHTML = `<h3>${esc(d.title)}</h3><p style="white-space:pre-wrap">${esc(d.context)}</p><p style="white-space:pre-wrap">${esc(d.prompt)}</p><form class="training-form" data-attempt-form><fieldset><legend>Choose an option, then explain your reasoning</legend>${d.choices.map((c, i) => field(c.label, `<input type="radio" name="choice" value="${i}">`)).join('')}</fieldset>${prose('reason', 'Why this choice? What assumptions are you making?')}<div class="training-actions">${button('reveal', 'Reveal tradeoffs and discussion')}</div><div data-discussion></div></form><div data-attempt-history></div>`;
      history();
    }
    function reveal() {
      text(attempt.reason, 4000, 'Reasoning before reveal', true);
      attemptData({ puzzle_id: active.id, ...attempt });
      if (attempt.choice_index >= active.data.choices.length) throw Error('Choose one of the available options.');
      revealed = true;
      const d = active.data;
      attemptRoot.querySelector('[data-discussion]').innerHTML = `<h4>Tradeoffs, not an answer key</h4>${d.choices.map(c => `<h5>${esc(c.label)}</h5><p style="white-space:pre-wrap">${esc(c.tradeoff)}</p>`).join('')}<h4>Discussion</h4><p style="white-space:pre-wrap">${esc(d.discussion)}</p>${prose('reflection', 'After comparing: what would change your mind?', attempt.reflection)}<button class="btn" type="submit">Save personal attempt</button><p data-attempt-status role="status"></p>`;
      attemptRoot.querySelector('[data-action="reveal"]').hidden = true;
      // Lock the pre-reveal choice/reason so a saved attempt faithfully records the initial reasoning.
      for (const el of attemptRoot.querySelectorAll('[name="choice"], [name="reason"]')) el.disabled = true;
    }
    function fill(entry) {
      s.invalidate();
      existing = entry; source = entry ? { source_review_id: entry.data.source_review_id, seconds: entry.data.seconds } : { source_review_id: null, seconds: null };
      form.innerHTML = `${puzzleFields(entry ? entry.data : emptyPuzzle())}<div class="training-actions"><button class="btn" type="submit">Save puzzle</button>${button('new', 'New puzzle')}${button('reload', 'Reload saved puzzle')}${button('delete', 'Delete saved puzzle')}</div>`;
      root.querySelector('[data-editor-title]').textContent = entry ? `Editing personal puzzle · revision ${entry.revision}` : 'New personal puzzle'; root.querySelector('[data-author]').open = true; s.clean();
    }
    async function load(recordId, fresh = false) {
      if (s.pending || !s.discard()) return;
      const version = s.invalidate(), entry = fresh ? await p.fresh(recordId) : await p.find(recordId);
      if (!s.current()) return;
      if (version !== s.version) { s.status('Your new edits were kept. Load again to replace them.'); return; }
      if (!entry) throw Error('Puzzle not found or no longer accessible.');
      fill(entry);
    }
    s.listen(form, 'input', s.changed);
    s.listen(form, 'submit', event => { event.preventDefault(); s.task(event.submitter, async () => {
      const version = s.version, data = puzzleData({ ...readPuzzle(form), ...source });
      const entry = await ctx.save('puzzles', data, existing); if (!s.current()) return;
      existing = entry; p.put(entry); if (version === s.version) s.clean(); lists(); s.status('Personal puzzle saved. Practice it from the list above.');
    }); });
    s.listen(attemptRoot, 'input', event => {
      if (event.target.name === 'choice' && !revealed) attempt.choice_index = numeric(event.target.value);
      else if (event.target.name === 'reason' && !revealed) attempt.reason = event.target.value;
      else if (event.target.name === 'reflection') attempt.reflection = event.target.value;
      else return;
      attemptSaved = false; attemptVersion++; s.changed('attempt');
      const submit = attemptRoot.querySelector('[type="submit"]'); if (submit) submit.hidden = false;
    });
    s.listen(attemptRoot, 'submit', event => { event.preventDefault(); s.task(event.submitter, async () => {
      if (!active || !revealed) throw Error('Explain your choice before revealing and saving an attempt.');
      const target = active.id, version = attemptVersion;
      const entry = await ctx.save('attempts', attemptData({ puzzle_id: target, ...attempt }), attemptEntry);
      if (!s.current()) return;
      a.put(entry); attemptEntry = entry;
      if (active?.id === target && attemptVersion === version) { attemptSaved = true; s.clean('attempt'); attemptRoot.querySelector('[data-attempt-status]').textContent = 'Personal attempt saved. No correctness score was assigned.'; event.submitter.hidden = true; }
      history(); s.status('Reasoning and reflection saved privately.');
    }); });
    s.listen(root, 'click', event => {
      const el = event.target.closest('[data-action]'); if (!el) return;
      const action = el.dataset.action;
      try {
        if (action === 'practice') { if (!s.pending) practice([...catalog, ...p.records].find(e => e.id === el.dataset.id)); return; }
        if (action === 'reveal') { reveal(); return; }
        if (action === 'add-choice' || action === 'remove-choice') { if (changeChoices(form, action === 'add-choice')) s.changed(); return; }
        if (action === 'load') { load(el.dataset.id).catch(s.error); return; }
        if (action === 'reload') { if (existing) load(existing.id, true).catch(s.error); else s.status('Load or save a puzzle first.'); return; }
        if (action === 'new') { if (!s.pending && s.discard()) fill(null); return; }
      } catch (e) { s.error(e); return; }
      s.task(el, async () => {
        if (action === 'more') { await p.next(); if (s.current()) lists(); }
        else if (action === 'more-attempts') { await a.next(); if (s.current()) history(); }
        else if (action === 'share') await share(ctx, s, root, 'puzzles', existing);
        else if (action === 'delete') {
          if (!existing) throw Error('Load a saved personal puzzle first.');
          if (!host.confirm('Permanently delete this puzzle? Previously saved attempts are separate personal records.')) return;
          const target = existing; await ctx.remove(target); if (!s.current()) return;
          p.drop(target); existing = null; source = { source_review_id: null, seconds: null }; s.changed(); lists(); s.status('Saved puzzle deleted. Your form remains as an unsaved new puzzle.');
        }
      });
    });
    lists(); attemptRoot.innerHTML = '<p>Select a text-only starter or a saved personal puzzle to begin.</p>';
  }

  // Pure helpers make privacy, schema and letterbox geometry testable without a server.
  if (typeof module === 'object' && module.exports) module.exports = { timeBasis, clockOffset, convertSeconds, playbackSeconds, convertReviewBasis, annotation, reviewData, lessonData, puzzleData, attemptData, frameRect, framePoint, moveMark, stamp, renderReview, renderLessons, renderPuzzles };
  if (host.Training) {
    host.Training.register('review', renderReview);
    host.Training.register('lessons', renderLessons);
    host.Training.register('puzzles', renderPuzzles);
  }
})(typeof window === 'object' ? window : globalThis);
