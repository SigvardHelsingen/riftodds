/* Offline strategy notebook and explicit-assumption mechanics calculators.
 * The diagram is original, schematic and not a playable map or a live-game feed.
 * Only explicitly saved board notes/marks leave this browser, through Training's authenticated API.
 */
(() => {
  'use strict';
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kinds = ['position', 'arrow', 'ward', 'text'];
  const teams = ['blue', 'red', 'neutral'];
  const id = () => globalThis.crypto?.randomUUID?.() || `board-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function resistanceMultiplier(resistance) {
    if (!finite(resistance) || resistance < -100 || resistance > 1000) throw new Error('Resistance must be a finite number from −100 to 1000.');
    return resistance >= 0 ? 100 / (100 + resistance) : 2 - 100 / (100 - resistance);
  }
  function mechanics({ damage, health, resistance, cooldown, haste }) {
    for (const [key, max] of [['damage', 10000], ['health', 100000], ['cooldown', 600], ['haste', 1000]]) {
      const n = { damage, health, cooldown, haste }[key];
      if (!finite(n) || n < 0 || n > max) throw new Error(`${key} must be a finite number from 0 to ${max}.`);
    }
    const multiplier = resistanceMultiplier(resistance), dealt = damage * multiplier;
    const ratio = health / dealt, nearest = Math.round(ratio);
    // Allow a few relative rounding errors from the resistance, damage and ratio operations.
    const rounded = Math.abs(ratio - nearest) <= 4 * Number.EPSILON * Math.abs(ratio) ? nearest : Math.ceil(ratio);
    return { multiplier, dealt, effectiveHealth: health / multiplier, hits: health === 0 ? 0 : dealt > 0 ? Math.max(1, rounded) : null,
      cooldown: cooldown / (1 + haste / 100) };
  }
  function validMark(mark) {
    return mark && typeof mark.id === 'string' && kinds.includes(mark.kind) && teams.includes(mark.team)
      && ['x', 'y', 'x2', 'y2'].every((key) => finite(mark[key]) && mark[key] >= 0 && mark[key] <= 1)
      && typeof mark.label === 'string' && mark.label.length <= 160;
  }
  function moveMark(mark, dx, dy) {
    if (!validMark(mark) || !finite(dx) || !finite(dy)) throw new Error('Invalid diagram mark.');
    const x = clamp(dx, -Math.min(mark.x, mark.x2), 1 - Math.max(mark.x, mark.x2));
    const y = clamp(dy, -Math.min(mark.y, mark.y2), 1 - Math.max(mark.y, mark.y2));
    return { ...mark, x: mark.x + x, y: mark.y + y, x2: mark.x2 + x, y2: mark.y2 + y };
  }
  function diagram(marks, selected = '') {
    const shapes = marks.filter(validMark).map((mark, i) => {
      const x = mark.x * 1000, y = mark.y * 600, x2 = mark.x2 * 1000, y2 = mark.y2 * 600;
      const color = mark.team === 'blue' ? 'var(--you)' : mark.team === 'red' ? 'var(--plum)' : 'var(--ink)';
      const stroke = mark.id === selected ? 7 : 4;
      let shape;
      if (mark.kind === 'arrow') {
        const a = Math.atan2(y2 - y, x2 - x), r = 19;
        shape = `<path d="M${x} ${y}L${x2} ${y2}M${x2 - Math.cos(a - .5) * r} ${y2 - Math.sin(a - .5) * r}L${x2} ${y2}L${x2 - Math.cos(a + .5) * r} ${y2 - Math.sin(a + .5) * r}"/>`;
      } else if (mark.kind === 'ward') shape = `<path d="M${x - 18} ${y}Q${x} ${y - 25} ${x + 18} ${y}Q${x} ${y + 25} ${x - 18} ${y}"/><circle cx="${x}" cy="${y}" r="5"/>`;
      else if (mark.kind === 'text') shape = `<path d="M${x - 9} ${y - 10}H${x + 9}M${x} ${y - 10}V${y + 10}"/>`;
      else shape = `<circle cx="${x}" cy="${y}" r="18"/><text x="${x}" y="${y + 6}" text-anchor="middle" stroke="none" fill="${color}" font-size="16">${i + 1}</text>`;
      return `<g stroke="${color}" stroke-width="${stroke}" fill="none">${shape}<text x="${x + 24}" y="${y - 16}" stroke="none" fill="${color}" font-size="19">${esc(mark.label)}</text></g>`;
    }).join('');
    return `<svg viewBox="0 0 1000 600" class="training-board" tabindex="0" role="img" aria-label="Original strategy diagram. With a selected mark, arrow keys move it; hold Shift for a larger step. All coordinates are editable below.">
      <rect width="1000" height="600" fill="var(--paper)"/>
      <path d="M70 530L70 70L930 70M70 530L930 530L930 70M70 530L930 70" fill="none" stroke="var(--track)" stroke-width="28"/>
      <path d="M260 0Q390 200 500 300T740 600" fill="none" stroke="var(--ref)" stroke-width="22" stroke-dasharray="10 9"/>
      <text x="35" y="575" fill="var(--muted)" font-size="20">Own side</text><text x="840" y="40" fill="var(--muted)" font-size="20">Other side</text>
      <text x="370" y="45" fill="var(--muted)" font-size="17">Schematic only · not live positions</text>${shapes}</svg>`;
  }
  const exported = { resistanceMultiplier, mechanics, validMark, moveMark, diagram };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (typeof window !== 'object' || !window.Training) return;
  const T = window.Training;
  const field = (label, html) => `<label>${esc(label)}${html}</label>`;
  const input = (name, value, extra = '') => `<input name="${name}" value="${esc(value)}" ${extra}>`;
  const options = (items, selected) => items.map((value) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(value)}</option>`).join('');
  const button = (label, action, extra = '') => `<button type="button" class="btn ghost" data-lab-action="${action}" ${extra}>${esc(label)}</button>`;
  const blank = () => ({ title: 'Objective setup', notes: '', marks: [] });
  const json = (value) => JSON.stringify(value);
  const dataEqual = (a, b) => json(a) === json(b);

  T.register('lab', (root, ctx) => {
    let draft = blank(), saved = clone(draft), existing = null, selected = '', busy = false, version = 0, cleanForm = '', drawn = '';
    let boards = [...ctx.bootstrap.entries.boards], more = ctx.bootstrap.limits.has_more?.boards === true;
    const removeGuard = ctx.guardDirty(() => !dataEqual(draft, saved) || editorSnapshot() !== cleanForm);
    ctx.cleanup(removeGuard);
    root.classList.add('training-lab');
    root.innerHTML = `<section class="training-card"><h2>Explain your plan before the next game</h2>
      <p>Sketch an objective setup or write a matchup note. This is your own strategy notebook—not a live assistant or a simulated game.</p><a href="#/practice">Back to my training focus</a></section>
      <section class="training-card"><h2>Personal strategy board</h2><p>Private until you explicitly copy a saved board to a team. Click the diagram to position the selected mark; Shift-click sets its arrow endpoint. Keyboard and numeric alternatives are below.</p>
      <div data-lab-editor></div><p data-lab-status class="training-status" role="status" aria-live="polite"></p></section>
      <details class="training-details" open><summary>Saved personal boards and matchup notes</summary><div data-lab-list></div><div class="training-actions">${button('Create another board', 'new')}${button('Load older boards', 'older')}${button('Reload saved data', 'reload')}</div></details>
      <details class="training-details"><summary>Mechanics calculations · explicit assumptions</summary><div data-lab-calculator></div></details>
      <details class="training-details"><summary>What this workspace does not know</summary><p>The diagram is an original schematic, not exact map geometry. No positions are imported or tracked. Calculators use only the numbers you enter; they do not model item passives, penetration, shields, damage reductions, critical strikes, ability-specific rules, or patch-dependent interactions. This is for offline understanding, not build orders or instructions during a game.</p><p>For patch or matchup notes, record the patch and your assumptions in the board notes. Turn a useful takeaway into a <a href="#/practice/lessons">personal recall question</a>.</p></details>`;
    const editor = root.querySelector('[data-lab-editor]');
    function say(message, error = false) {
      if (!ctx.current()) return;
      const output = root.querySelector('[data-lab-status]');
      output.textContent = message; output.classList.toggle('error', error);
      ctx.status(message, error);
    }
    function editorSnapshot() {
      const form = editor.querySelector('form');
      return form ? json([...form.elements].filter((el) => el.name).map((el) => [el.name, el.value])) : '';
    }
    function discard() { return (dataEqual(draft, saved) && editorSnapshot() === cleanForm) || window.confirm('Discard unsaved board changes? Saved boards are kept.'); }
    function listBoards() {
      root.querySelector('[data-lab-list]').innerHTML = boards.length ? `<ul class="training-list">${boards.map((entry) => `<li><button type="button" class="btn ghost" data-lab-open="${esc(entry.id)}">${esc(entry.data.title)}</button><span> · ${entry.data.marks.length} marks · revision ${entry.revision}</span></li>`).join('')}</ul>` : '<p>No personal boards saved yet.</p>';
      root.querySelector('[data-lab-action="older"]').hidden = !more;
    }
    function markFields(mark, i) {
      return `<fieldset data-lab-mark="${esc(mark.id)}"><legend>Mark ${i + 1}</legend><div class="training-grid">
        ${field('Kind', `<select name="kind">${options(kinds, mark.kind)}</select>`)}${field('Team color', `<select name="team">${options(teams, mark.team)}</select>`)}
        ${field('Label', input('label', mark.label, 'maxlength="160"'))}
        ${['x', 'y', 'x2', 'y2'].map((key) => field(`${key.toUpperCase()} (%)`, input(key, Number((mark[key] * 100).toFixed(3)), 'type="number" min="0" max="100" step="0.001" required'))).join('')}</div>
        <div class="training-actions">${button(selected === mark.id ? 'Selected mark' : 'Select mark', 'select', `data-mark="${esc(mark.id)}" aria-pressed="${selected === mark.id}"`)}${button('Remove mark', 'remove-mark', `data-mark="${esc(mark.id)}"`)}</div></fieldset>`;
    }
    function renderEditor() {
      editor.innerHTML = `<form class="training-form" data-lab-form>
        ${field('Board title', input('title', draft.title, 'required maxlength="120"'))}
        ${field('Strategy, patch and assumptions', `<textarea name="notes" maxlength="4000" rows="4">${esc(draft.notes)}</textarea>`)}
        <div data-lab-diagram>${drawn = diagram(draft.marks, selected)}</div>
        <p class="training-muted">Selected marks move by 1% with arrow keys, or 5% with Shift. X/Y identify the start; X2/Y2 identify the end of an arrow. Changes are not saved automatically.</p>
        <div class="training-actions">${button('Add mark', 'add-mark', draft.marks.length >= 100 ? 'disabled' : '')}</div>
        <div data-lab-marks>${draft.marks.map(markFields).join('')}</div><p>${draft.marks.length} of 100 available marks</p>
        <div class="training-actions" data-lab-save-actions><button type="submit" class="btn"></button></div></form><div data-lab-sharing></div>`;
      updateSavedControls();
    }
    function updateSavedControls() {
      const actions = editor.querySelector('[data-lab-save-actions]'), deletion = actions.querySelector('[data-lab-action="delete"]');
      actions.querySelector('[type="submit"]').textContent = existing ? 'Save board changes' : 'Save personal board';
      if (existing && !deletion) actions.insertAdjacentHTML('beforeend', button('Delete this board', 'delete'));
      else if (!existing) deletion?.remove();
      const sharing = editor.querySelector('[data-lab-sharing]');
      if (!existing) sharing.replaceChildren();
      else if (!sharing.firstElementChild) sharing.innerHTML = `<details class="training-details"><summary>Copy this saved board to a private team</summary><p>The title, notes and all marks will be copied to accepted teammates. Your personal original remains private; the copy has an independent revision.</p>
        ${field('Destination team', `<select data-lab-team><option value="">Choose a team</option>${(ctx.bootstrap.teams || []).map((team) => `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('')}</select>`)}
        ${button('Share saved copy', 'share')}</details>`;
    }
    function readEditor() {
      const form = editor.querySelector('form');
      const marks = [...form.querySelectorAll('[data-lab-mark]')].map((row) => {
        const n = (key) => { const text = row.querySelector(`[name="${key}"]`).value; if (text.trim() === '') throw new Error('Every coordinate needs a number from 0 to 100.'); return Number(text) / 100; };
        const mark = { id: row.dataset.labMark, kind: row.querySelector('[name="kind"]').value, team: row.querySelector('[name="team"]').value,
          label: row.querySelector('[name="label"]').value, x: n('x'), y: n('y'), x2: n('x2'), y2: n('y2') };
        if (!validMark(mark)) throw new Error('Coordinates must be between 0 and 100 and labels at most 160 characters.');
        return mark;
      });
      return { title: form.elements.title.value, notes: form.elements.notes.value, marks };
    }
    // A field's change event fires on blur, after its input event already redrew the diagram.
    // Rebuilding identical markup then would detach the SVG the user is focusing or clicking.
    function diagramOnly() {
      const container = editor.querySelector('[data-lab-diagram]'), markup = diagram(draft.marks, selected);
      if (markup !== drawn || !container.firstElementChild) {
        const focused = document.activeElement === container.firstElementChild;
        container.innerHTML = markup; drawn = markup;
        if (focused) container.firstElementChild.focus({ preventScroll: true });
      }
      for (const control of editor.querySelectorAll('[data-lab-action="select"]')) {
        const active = control.dataset.mark === selected;
        control.setAttribute('aria-pressed', String(active)); control.textContent = active ? 'Selected mark' : 'Select mark';
      }
    }
    function synchronizeMark(mark) {
      const row = [...editor.querySelectorAll('[data-lab-mark]')].find((row) => row.dataset.labMark === mark.id);
      for (const key of ['x', 'y', 'x2', 'y2']) row.querySelector(`[name="${key}"]`).value = Number((mark[key] * 100).toFixed(3));
      draft = readEditor(); ++version; diagramOnly();
      row.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function open(entry = null) {
      existing = entry; draft = entry ? clone(entry.data) : blank(); saved = clone(draft); selected = draft.marks[0]?.id || ''; ++version;
      renderEditor(); cleanForm = editorSnapshot();
      queueMicrotask(() => { if (ctx.current()) ctx.markSaved(editor.querySelector('form')); });
    }
    async function run(control, task) {
      if (!ctx.current() || busy) return;
      const focused = document.activeElement === control;
      busy = true; if (control) control.disabled = true;
      try { await task(); } catch (error) { if (ctx.current() && error.name !== 'AbortError') say(`${error.message} Your entered board is still here. For a revision conflict (409), copy your edits before explicitly reloading saved data.`, true); }
      finally {
        busy = false;
        if (ctx.current() && control?.isConnected) {
          control.disabled = false;
          if (focused && document.activeElement === document.body) control.focus({ preventScroll: true });
        }
      }
    }
    const onInput = (event) => {
      if (!ctx.current() || !event.target.closest('[data-lab-form]')) return;
      ++version;
      try {
        draft = readEditor(); diagramOnly();
        const clean = dataEqual(draft, saved) && editorSnapshot() === cleanForm;
        if (clean) ctx.markSaved(editor.querySelector('form'));
        say(clean ? 'No unsaved board changes.' : 'Unsaved board changes.');
      } catch (error) { say(error.message, true); }
    };
    const onSubmit = (event) => {
      if (!event.target.matches('[data-lab-form]')) return;
      event.preventDefault();
      const form = event.target;
      if (!form.reportValidity()) return;
      run(form.querySelector('[type="submit"]'), async () => {
        const payload = readEditor(), submitted = clone(payload), submittedForm = editorSnapshot(), entry = await ctx.save('boards', payload, existing);
        if (!ctx.current()) return;
        existing = entry; boards = [entry, ...boards.filter((row) => row.id !== entry.id)];
        saved = submitted; cleanForm = submittedForm;
        // Keep the form and focus intact, even if newer coordinates are temporarily invalid.
        updateSavedControls();
        if (editorSnapshot() === cleanForm && dataEqual(readEditor(), submitted)) {
          draft = clone(submitted); ctx.markSaved(editor.querySelector('form')); say('Personal strategy board saved.');
        } else say('Board saved. Newer changes typed during the request are still unsaved.');
        listBoards();
      });
    };
    const onClick = (event) => {
      const openButton = event.target.closest('[data-lab-open]');
      if (openButton) { if (!busy && discard()) { open(boards.find((entry) => entry.id === openButton.dataset.labOpen)); say('Opened saved board.'); } return; }
      const control = event.target.closest('[data-lab-action]');
      if (control) {
        const action = control.dataset.labAction;
        if (action === 'select') { selected = control.dataset.mark; diagramOnly(); return; }
        if (busy && !['add-mark', 'remove-mark'].includes(action)) return;
        if (action === 'add-mark' || action === 'remove-mark') {
          try { draft = readEditor(); } catch (error) { say(error.message, true); return; }
          if (action === 'add-mark' && draft.marks.length < 100) {
            const mark = { id: id(), kind: 'position', x: .4, y: .6, x2: .55, y2: .45, label: '', team: 'blue' };
            draft.marks.push(mark); selected = mark.id;
          } else if (action === 'remove-mark') {
            if (!window.confirm('Remove this diagram mark? Save the board to persist the removal.')) return;
            draft.marks = draft.marks.filter((mark) => mark.id !== control.dataset.mark); selected = draft.marks[0]?.id || '';
          }
          ++version; renderEditor(); say('Unsaved board changes.');
          editor.querySelector('[data-lab-action="add-mark"]')?.focus({ preventScroll: true });
          return;
        }
        if (action === 'new') { if (discard()) { open(); say('New private board.'); } return; }
        if (action === 'share') return run(control, async () => {
          if (!existing || !dataEqual(readEditor(), saved)) throw new Error('Save your current changes before sharing a copy.');
          const teamId = editor.querySelector('[data-lab-team]').value;
          if (!teamId) throw new Error('Choose a team first.');
          if (!window.confirm('Copy this saved board, including its notes and all marks, to the selected team?')) return;
          await ctx.save('boards', clone(existing.data), null, teamId);
          if (ctx.current()) say('A saved copy was shared with the selected team. Your original remains private.');
        });
        if (action === 'delete') return run(control, async () => {
          if (!existing || !window.confirm('Delete this saved personal board? Team copies are independent and will not be deleted.')) return;
          const removing = existing, before = version;
          await ctx.remove(removing);
          if (!ctx.current()) return;
          boards = boards.filter((entry) => entry.id !== removing.id);
          if (version === before) open();
          else { existing = null; saved = blank(); updateSavedControls(); say('Saved board deleted. Newer edits remain here as an unsaved new board.'); }
          listBoards();
        });
        if (action === 'reload' || action === 'older') return run(control, async () => {
          if (action === 'reload' && !discard()) return;
          const started = version, selectedId = existing?.id, results = new Map();
          if (action === 'reload') await ctx.refresh();
          for (let offset = 0; offset < 200; offset += 50) {
            const page = await ctx.request(`/api/training/entries/boards?offset=${offset}&limit=50`);
            if (!ctx.current()) return;
            page.entries.forEach((entry) => results.set(entry.id, entry));
            more = !!page.has_more;
            if (!more) break;
          }
          boards = [...results.values()]; listBoards();
          if (action === 'reload' && version === started) { open(boards.find((entry) => entry.id === selectedId) || null); say('Reloaded saved boards.'); }
          else say(action === 'reload' ? 'Saved data loaded; newer edits were kept instead of replacing your editor.' : 'Loaded all available personal boards.');
        });
        return;
      }
      const svg = event.target.closest('[data-lab-diagram] svg');
      if (!svg || !selected || event.detail === 0) return;
      try {
        draft = readEditor();
        const matrix = svg.getScreenCTM(); if (!matrix) return;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        const x = clamp(point.x / 1000, 0, 1), y = clamp(point.y / 600, 0, 1), mark = draft.marks.find((row) => row.id === selected);
        if (event.shiftKey) { mark.x2 = x; mark.y2 = y; } else { mark.x = x; mark.y = y; }
        synchronizeMark(mark);
      } catch (error) { say(error.message, true); }
    };
    const onKey = (event) => {
      if (!event.target.matches('[data-lab-diagram] svg') || !selected || event.ctrlKey || event.metaKey || event.altKey) return;
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!directions[event.key]) return;
      event.preventDefault();
      try {
        draft = readEditor(); const mark = draft.marks.find((row) => row.id === selected), step = event.shiftKey ? .05 : .01;
        synchronizeMark(moveMark(mark, directions[event.key][0] * step, directions[event.key][1] * step));
        editor.querySelector('[data-lab-diagram] svg').focus({ preventScroll: true });
      } catch (error) { say(error.message, true); }
    };
    root.addEventListener('input', onInput); root.addEventListener('change', onInput); root.addEventListener('submit', onSubmit);
    root.addEventListener('click', onClick); root.addEventListener('keydown', onKey);
    ctx.cleanup(() => {
      root.removeEventListener('input', onInput); root.removeEventListener('change', onInput); root.removeEventListener('submit', onSubmit);
      root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey);
      boards = []; draft = saved = blank(); existing = null;
    });
    open(); listBoards();
    renderCalculator(root.querySelector('[data-lab-calculator]'), ctx);
  });

  function renderCalculator(root, ctx) {
    root.innerHTML = `<p>Compare two resistance/haste assumptions with the same raw hit and target health. These are simple formulas, not a champion combat simulator. Results are not saved automatically.</p>
      <div class="training-grid" data-calc-inputs>${[
        ['damage', 'Raw physical damage per hit', 100, 0, 10000], ['health', 'Target health', 1000, 0, 100000], ['cooldown', 'Base cooldown (seconds)', 10, 0, 600],
        ['armorA', 'Scenario A armor', 50, -100, 1000], ['armorB', 'Scenario B armor', 100, -100, 1000],
        ['hasteA', 'Scenario A ability haste', 0, 0, 1000], ['hasteB', 'Scenario B ability haste', 30, 0, 1000]
      ].map(([name, label, value, min, max]) => field(label, input(name, value, `type="number" min="${min}" max="${max}" step="any" required`))).join('')}</div>
      <p data-calc-takeaway></p><div class="table-scroll" tabindex="0" role="region" aria-label="Numeric scenario comparison"><table class="training-table"><caption>Calculated results from the entered assumptions</caption>
      <thead><tr><th scope="col">Measure</th><th scope="col">Scenario A</th><th scope="col">Scenario B</th></tr></thead><tbody data-calc-results></tbody></table></div>
      <p class="training-muted">Resistance uses 100 / (100 + armor) for nonnegative armor and 2 − 100 / (100 − armor) below zero. Haste-adjusted cooldown is base cooldown / (1 + haste / 100). Effective health here applies only to repeated physical damage under these assumptions.</p>`;
    const format = (n) => n == null ? 'Unavailable' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    function draw() {
      if (!ctx.current()) return;
      try {
        const values = {};
        root.querySelectorAll('input').forEach((input) => {
          if (input.value.trim() === '' || !input.checkValidity()) throw new Error('Enter valid numbers for every assumption; an empty value is not zero.');
          values[input.name] = Number(input.value);
        });
        const a = mechanics({ damage: values.damage, health: values.health, cooldown: values.cooldown, resistance: values.armorA, haste: values.hasteA });
        const b = mechanics({ damage: values.damage, health: values.health, cooldown: values.cooldown, resistance: values.armorB, haste: values.hasteB });
        root.querySelector('[data-calc-takeaway]').textContent = `The same ${format(values.damage)} raw physical damage becomes ${format(a.dealt)} in A and ${format(b.dealt)} in B. This compares only the entered assumptions.`;
        root.querySelector('[data-calc-results]').innerHTML = [['Damage per hit', 'dealt'], ['Physical effective health', 'effectiveHealth'], ['Hits to reach zero health', 'hits'], ['Cooldown (seconds)', 'cooldown']]
          .map(([label, key]) => `<tr><th scope="row">${label}</th><td>${esc(format(a[key]))}</td><td>${esc(format(b[key]))}</td></tr>`).join('');
      } catch (error) {
        root.querySelector('[data-calc-takeaway]').textContent = error.message;
        root.querySelector('[data-calc-results]').innerHTML = '<tr><td colspan="3">No supported comparison until the inputs are complete.</td></tr>';
      }
    }
    root.addEventListener('input', draw); ctx.cleanup(() => root.removeEventListener('input', draw)); draw();
  }
})();
