// Rift Odds — tiny hash-routed SPA.  #/            → patch landing
//                                    #/p/euw1/Name%23TAG/40 → player
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const pts = (x) => (x == null ? "–" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(0)} pts`);
const title = (s) => s[0] + s.slice(1).toLowerCase();
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const ROLE_NAMES = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support", UNKNOWN: "Unknown" };
const COUNTS = [20, 40, 70, 100];

let META = null;
const view = { landing: { tier: "", sort: "wr", role: "", all: false }, player: { tab: "champions", role: null } };
let PATCH = null;
let DATA = null;
let pollTimer = null;

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
  return body;
}

// ---------------------------------------------------------------- shared pieces
const champ = (id) => META.champions[id] || { name: `#${id}`, icon: "" };
const icon = (id) => `<img src="${champ(id).icon}" alt="" loading="lazy" title="${esc(champ(id).name)}">`;
const champCell = (id, sub = "") =>
  `<span class="champ">${icon(id)}<span>${esc(champ(id).name)}${sub ? `<br><span class="role">${sub}</span>` : ""}</span></span>`;
const wrTip = (w) => (w.games ? `${w.wins}W ${w.games - w.wins}L · ${pct(w.wr)} · 90% likely ${pct(w.lo)}–${pct(w.hi)}` : "no games");
const wrText = (w) => (w.games ? `${pct(w.wr)} <span class="muted small">${w.games}</span>` : `<span class="muted">–</span>`);

function wrBar(w, ref) {
  const refDot = ref && ref.games ? `<div class="dot ref-dot" style="left:${ref.wr * 100}%" title="${esc(wrTip(ref))}"></div>` : "";
  if (!w.games) return `<div class="wrbar"><div class="track"></div><div class="ref"></div>${refDot}</div>`;
  return `<div class="wrbar" title="${esc(wrTip(w))}"><div class="track"></div><div class="ref"></div>
    <div class="ci" style="left:${w.lo * 100}%;width:${(w.hi - w.lo) * 100}%"></div>
    ${refDot}<div class="dot" style="left:${w.wr * 100}%"></div></div>`;
}

const bar = (frac, { tick = null, thick = false } = {}) =>
  `<div class="bar${thick ? " thick" : ""}"><div class="fill" style="width:${Math.min(1, Math.max(0, frac)) * 100}%"></div>${tick == null ? "" : `<div class="tick" style="left:${tick * 100}%"></div>`}</div>`;
const barCell = (frac, text, opts) => `<div class="barcell">${bar(frac, opts)}<span class="v">${text}</span></div>`;

function dbar(d, maxAbs) {
  if (d == null) return `<div class="dbar"><div class="axis"></div></div>`;
  const w = (Math.min(Math.abs(d), maxAbs) / maxAbs) * 50;
  return `<div class="dbar" title="${pts(d)}"><div class="axis"></div><div class="fill ${d >= 0 ? "pos" : "neg"}" style="width:${w}%"></div></div>`;
}

const tile = (label, value, sub = "", cls = "") =>
  `<div class="tile ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

const cell = (label, value, sub) =>
  `<div class="cell"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

const legend = (items) => `<div class="legend">${items.map(([cls, style, text]) => `<span><i class="${cls}" style="${style}"></i>${text}</span>`).join("")}</div>`;
const WR_LEGEND = (refLabel) => legend([
  ["", "background:var(--you)", "Win rate"],
  ["band", "", "90% credible interval"],
  ...(refLabel ? [["", "background:var(--ref)", refLabel]] : []),
  ["line", "background:var(--ref)", "50%"],
]);

function searchForm(cls) {
  const last = JSON.parse(localStorage.getItem("last") || "{}");
  return `<form class="search ${cls}">
    <input name="riot" placeholder="Riot ID — Name#TAG" required autocomplete="off" value="${esc(last.riotId || "")}">
    <select name="platform">${META.platforms.map((p) => `<option ${p === (last.platform || "euw1") ? "selected" : ""}>${p}</option>`).join("")}</select>
    <button class="btn">Analyse</button></form>`;
}

function bindSearch(form) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const riotId = form.riot.value.trim();
    const platform = form.platform.value;
    if (!riotId.includes("#")) { form.riot.setCustomValidity("Use the full Riot ID, e.g. Name#EUW"); form.riot.reportValidity(); return; }
    localStorage.setItem("last", JSON.stringify({ riotId, platform }));
    location.hash = `#/p/${platform}/${encodeURIComponent(riotId)}/${view.player.count || 40}`;
  });
  form.riot.addEventListener("input", () => form.riot.setCustomValidity(""));
}

// ---------------------------------------------------------------- router
async function route() {
  clearInterval(pollTimer);
  const m = (location.hash.slice(1) || "/").match(/^\/p\/([^/]+)\/([^/]+)(?:\/(\d+))?/);
  const top = $("#top-search");
  top.hidden = !m;
  if (m) {
    top.outerHTML = searchForm("compact").replace("<form", '<form id="top-search"');
    bindSearch($("#top-search"));
    showPlayer(m[1], decodeURIComponent(m[2]), +(m[3] || 40));
  } else {
    showLanding();
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- landing
async function showLanding() {
  $("#app").innerHTML = `
    <section class="hero">
      <div class="hero-top"><span class="stamp" id="hero-stamp">Ranked solo</span><span>Ranked solo queue · probabilities, not tier lists</span></div>
      <h1>What are<br>the <em>odds?</em></h1>
      <div class="side">
        <p class="lede">Look up a player to see how they pick, tilt and win. Or read the board below: what decides games on this patch.</p>
      </div>
      ${searchForm("big")}
    </section>
    <div id="patch-body"><div class="loading"><div class="spinner"></div>Loading patch stats…</div></div>`;
  bindSearch($(".search.big"));
  await loadPatch();
  pollTimer = setInterval(loadPatch, 30000);
}

async function loadPatch() {
  try {
    PATCH = await api(`/api/patch${view.landing.tier ? `?tier=${view.landing.tier}` : ""}`);
    renderPatch();
  } catch (e) {
    $("#patch-body").innerHTML = `<div class="card empty error">${esc(e.message)}</div>`;
  }
}

function samplerLine(s) {
  if (!s || s.status === "off") return `<div class="sampler"><span class="dotlive off"></span>Background sampler is off (SAMPLER=0).</div>`;
  const label = { sampling: `Sampling ${s.tier ? title(s.tier) : ""} games on ${s.platform}`, idle: "Sample complete for this patch",
    error: "Sampler hit an error — retrying", "key rejected": "Sampler paused — Riot API key rejected" }[s.status] || s.status;
  return `<div class="sampler"><span class="dotlive ${s.status === "sampling" ? "" : "off"}"></span>${label}
    ${s.target ? `· ${s.matches ?? 0} / ${s.target} games ${bar((s.matches || 0) / s.target)}` : ""}</div>`;
}

function renderPatch() {
  const P = PATCH;
  const L = view.landing;
  $("#hero-stamp").textContent = P.patch ? `Patch ${P.patch}` : "Ranked solo";
  if (!P.matches) {
    $("#patch-body").innerHTML = `<div class="card empty"><h2>No games sampled yet${L.tier ? ` for ${title(L.tier)}` : ""}</h2>
      <p>The background sampler pulls recent ranked games from random players in every tier.
      Stats appear here as games come in (about 20–25 per minute with a development key).</p></div>${samplerLine(P.sampler)}`;
    return;
  }
  const totalByTier = Object.fromEntries(P.tiers.map((t) => [t.tier, t.matches]));
  const tierChips = [["", "All tiers", P.tiers.reduce((a, t) => a + t.matches, 0)], ...META.tiers.filter((t) => totalByTier[t]).map((t) => [t, title(t), totalByTier[t]])];
  const top = P.objectives[0];

  // champion table
  const minGames = Math.max(10, Math.round(P.matches * 0.01));
  let rows = P.champions.filter((c) => !L.role || c.role === L.role);
  const sorters = { wr: (c) => c.wr, pick: (c) => c.pick_rate, ban: (c) => c.ban_rate };
  if (L.sort === "wr") rows = rows.filter((c) => c.games >= minGames);
  rows.sort((a, b) => sorters[L.sort](b) - sorters[L.sort](a));
  const shown = L.all ? rows : rows.slice(0, 15);
  const maxPick = Math.max(...P.champions.map((c) => c.pick_rate), 0.01);
  const maxBan = Math.max(...P.champions.map((c) => c.ban_rate), 0.01);
  const presence = [...P.champions].sort((a, b) => b.pick_rate + b.ban_rate - (a.pick_rate + a.ban_rate)).slice(0, 6);

  $("#patch-body").innerHTML = `
    <div class="chips section" id="tier-chips"><span class="chips-label">Tier</span>${tierChips.map(([v, l, n]) => `<button class="chip ${L.tier === v ? "active" : ""}" data-v="${v}">${l}<span class="count">${n}</span></button>`).join("")}</div>

    <div class="board" style="margin-top:14px">
      ${cell(`${top.label} wins`, pct(top.wr), "the most decisive objective this patch")}
      ${cell("Blue side wins", pct(P.blue_side.wr, 1), `90% likely ${pct(P.blue_side.lo, 1)}–${pct(P.blue_side.hi, 1)}`)}
      ${cell("Average game", mmss(P.avg_duration), "minutes")}
      ${cell("Games on the board", P.matches.toLocaleString(), L.tier ? title(L.tier) : "all tiers")}
    </div>

    <div class="grid-2 section">
      <div class="card">
        <div class="card-head"><div><h2>Objective → win</h2><p>P(win | your team took it first), with the fair decimal odds.</p></div></div>
        ${P.objectives.map((o) => `<div class="odds-row" title="${esc(wrTip(o))}"><span class="label">${o.label}</span>
          <span class="p">${pct(o.wr, 1)}</span>${bar(o.wr, { tick: 0.5, thick: true })}<span class="fair">@ ${o.wr ? (1 / o.wr).toFixed(2) : "–"}</span></div>`).join("")}
        ${legend([["line", "background:var(--ink)", "50% — a coin flip"]])}
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Highest presence</h2><p>Picked or banned in this share of games</p></div></div>
        <table><tbody>${presence.map((c) => `<tr><td>${champCell(c.champion_id, c.role ? ROLE_NAMES[c.role] : "")}</td>
          <td style="width:55%">${barCell(c.pick_rate + c.ban_rate, pct(c.pick_rate + c.ban_rate))}</td></tr>`).join("")}</tbody></table>
      </div>
    </div>

    <div class="card section">
      <div class="card-head"><div><h2>Champions</h2>
        <p>${L.sort === "wr" ? `Champions with fewer than ${minGames} games are hidden when sorting by win rate.` : `${rows.length} champions`}</p></div>
        <div class="chips" id="sort-chips">${[["wr", "Win rate"], ["pick", "Pick rate"], ["ban", "Ban rate"]].map(([v, l]) => `<button class="chip ${L.sort === v ? "active" : ""}" data-v="${v}">${l}</button>`).join("")}</div>
      </div>
      <div class="chips" id="role-chips" style="margin-bottom:16px">${[["", "All roles"], ...META.roles.map((r) => [r, ROLE_NAMES[r]])].map(([v, l]) => `<button class="chip ${L.role === v ? "active" : ""}" data-v="${v}">${l}</button>`).join("")}</div>
      ${WR_LEGEND()}
      <table>
        <thead><tr><th></th><th>Champion</th><th>Win rate</th><th class="num"></th><th>Pick rate</th><th>Ban rate</th><th class="num">Games</th></tr></thead>
        <tbody>${shown.map((c, i) => `<tr><td class="rank">${i + 1}</td>
          <td>${champCell(c.champion_id, c.role ? `${ROLE_NAMES[c.role]}${c.role_share < 0.9 ? ` · ${pct(c.role_share)}` : ""}` : "")}</td>
          <td style="width:24%">${wrBar(c)}</td><td class="num" title="${esc(wrTip(c))}">${pct(c.wr, 1)}</td>
          <td style="width:15%">${barCell(c.pick_rate / maxPick, pct(c.pick_rate, 1))}</td>
          <td style="width:15%">${barCell(c.ban_rate / maxBan, pct(c.ban_rate, 1))}</td>
          <td class="num muted">${c.games}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">${L.sort === "wr" ? `No champion has ${minGames}+ games yet — sort by pick rate, or check back as the sampler collects more.` : "No games yet."}</td></tr>`}</tbody>
      </table>
      ${rows.length > 15 ? `<div class="table-foot"><button class="btn ghost" id="show-all">${L.all ? "Show top 15" : `Show all ${rows.length}`}</button></div>` : ""}
    </div>
    ${samplerLine(P.sampler)}`;

  const chipGroup = (sel, key, refetch) => $$(`${sel} .chip`).forEach((b) => b.addEventListener("click", () => {
    L[key] = b.dataset.v;
    L.all = false;
    refetch ? loadPatch() : renderPatch();
  }));
  chipGroup("#tier-chips", "tier", true);
  chipGroup("#sort-chips", "sort");
  chipGroup("#role-chips", "role");
  $("#show-all")?.addEventListener("click", () => { L.all = !L.all; renderPatch(); });
}

// ---------------------------------------------------------------- player
async function showPlayer(platform, riotId, count) {
  view.player.count = count;
  view.player.role = null;
  const [name] = riotId.split("#");
  $("#app").innerHTML = `<div class="loading"><div class="spinner"></div>
    Fetching ${esc(name)}'s last ${count} ranked games… the first load can take a minute with a development key.</div>`;
  try {
    const tz = new Date().getTimezoneOffset();
    DATA = await api(`/api/player?platform=${platform}&riot_id=${encodeURIComponent(riotId)}&count=${count}&tz=${tz}`);
    renderPlayer();
  } catch (e) {
    $("#app").innerHTML = `<div class="card empty section"><h2 class="error">Couldn't load ${esc(riotId)}</h2><p>${esc(e.message)}</p></div>`;
  }
}

function renderPlayer() {
  const p = DATA.profile;
  const rankText = p.tier === "UNRANKED" ? "<b>Unranked</b>" : `<b>${title(p.tier)} ${p.division}</b> · ${p.lp} LP`;
  const season = p.season_wins + p.season_losses;
  $("#app").innerHTML = `
    <section class="player-head">
      <div class="badge">${p.tier === "UNRANKED" ? "–" : p.tier[0]}</div>
      <div class="who">
        <div class="name">${esc(p.name)} <span>#${esc(p.tag)}</span></div>
        <div class="rank">${rankText}${season ? ` · season ${p.season_wins}W ${p.season_losses}L (${pct(p.season_wins / season)})` : ""} · ${p.platform}</div>
      </div>
      <div class="actions">
        <select id="count" title="Ranked solo games to analyse">${COUNTS.map((c) => `<option value="${c}" ${c === view.player.count ? "selected" : ""}>Last ${c} games</option>`).join("")}</select>
        <button class="btn ghost" id="refresh">Refresh</button>
      </div>
    </section>
    <div id="player-body"></div>`;
  $("#count").addEventListener("change", (e) => { location.hash = `#/p/${p.platform}/${encodeURIComponent(`${p.name}#${p.tag}`)}/${e.target.value}`; });
  $("#refresh").addEventListener("click", route);

  if (!DATA.overview) {
    $("#player-body").innerHTML = `<div class="card empty"><h2>No ranked solo games in this window</h2><p>Try a larger game count.</p></div>`;
    return;
  }
  const o = DATA.overview;
  const m = o.momentum;
  const main = o.roles[0];
  const tilt = m.after_win.games && m.after_loss.games ? m.after_win.wr - m.after_loss.wr : null;
  const best = DATA.vs_rank.rows.filter((r) => r.p_better != null && r.player.games >= 3).sort((a, b) => b.p_better - a.p_better)[0];
  const tabs = [["champions", "Champions"], ["draft", "Draft"], ["habits", "Habits"], ["wincons", "Win conditions"]];

  $("#player-body").innerHTML = `
    <div class="tiles">
      ${tile(`Win rate · last ${o.record.games}`, pct(o.record.wr), `90% likely true win rate ${pct(o.record.lo)}–${pct(o.record.hi)}`, "indigo")}
      ${tile("Main role", `${ROLE_NAMES[main.role] || main.role}`, `${pct(main.share)} of games · plays like ${main.pool.effective_pool.toFixed(1)} champions`, "peach")}
      ${tile("Tilt swing", pts(tilt), tilt == null ? "Not enough back-to-back games" : `win rate after a win vs after a loss`, "plum")}
      ${best ? tile(`Best vs ${p.tier === "UNRANKED" ? "rank" : title(p.tier)}`, `${icon(best.champion_id)}<span class="sm">${esc(champ(best.champion_id).name)}</span>`,
        `${pts(best.delta)} vs rank · ${pct(best.p_better)} sure you're better`) : tile("Best vs rank", "–", "Not enough data yet")}
    </div>
    <nav class="tabs">${tabs.map(([v, l]) => `<button data-tab="${v}" class="${view.player.tab === v ? "active" : ""}">${l}</button>`).join("")}</nav>
    <div id="tab-body"></div>`;
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    view.player.tab = b.dataset.tab;
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    renderTab();
  }));
  renderTab();
}

function renderTab() {
  ({ champions: tabChampions, draft: tabDraft, habits: tabHabits, wincons: tabWincons })[view.player.tab]();
}

function tabChampions() {
  const v = DATA.vs_rank;
  const tier = v.tier === "UNRANKED" ? "Unranked" : title(v.tier);
  const maxAbs = Math.max(0.15, ...v.rows.filter((r) => r.delta != null).map((r) => Math.abs(r.delta)));
  $("#tab-body").innerHTML = `<div class="card">
    <div class="card-head"><div><h2>Your champions vs ${tier}</h2>
      <p>${tier} win rates come from ${v.sample_matches} cached ${tier} games (excluding you). P(better) is the chance your true win rate beats the rank's.</p></div>
      ${v.tier === "UNRANKED" ? "" : `<button class="btn ghost" id="grow">Sample more ${tier} games</button>`}</div>
    ${WR_LEGEND(`${tier} average`)}
    <table><thead><tr><th>Champion</th><th class="num">Games</th><th>Win rate</th><th class="num">You</th><th class="num">${tier}</th><th>Difference</th><th class="num">P(better)</th></tr></thead>
    <tbody>${v.rows.map((r) => `<tr><td>${champCell(r.champion_id)}</td><td class="num">${r.player.games}</td>
      <td style="width:26%">${wrBar(r.player, r.baseline)}</td>
      <td class="num" title="${esc(wrTip(r.player))}">${pct(r.player.wr)}</td>
      <td class="num" title="${esc(wrTip(r.baseline))}">${r.baseline.games ? `${pct(r.baseline.wr)} <span class="muted small">${r.baseline.games}</span>` : `<span class="muted">no data</span>`}</td>
      <td style="width:18%"><div class="barcell">${dbar(r.delta, maxAbs)}<span class="v delta">${r.delta == null ? "" : pts(r.delta).replace(" pts", "")}</span></div></td>
      <td class="num"><b>${r.p_better == null ? "–" : pct(r.p_better)}</b></td></tr>`).join("")}</tbody></table>
    <p id="grow-status" class="muted small"></p></div>`;
  $("#grow")?.addEventListener("click", growSample);
}

async function growSample() {
  const p = DATA.profile;
  $("#grow").disabled = true;
  $("#grow-status").textContent = "Sampling about 25 games from random players in your tier — this can take a minute…";
  try {
    const res = await api(`/api/sample?platform=${p.platform}&tier=${p.tier}&division=${p.division}&players=4&per_player=6`, { method: "POST" });
    $("#grow-status").textContent = `Added ${res.newly_fetched} games. Refreshing…`;
    route();
  } catch (e) {
    $("#grow-status").textContent = e.message;
    $("#grow").disabled = false;
  }
}

function tabDraft() {
  const roles = DATA.overview.roles.filter((r) => r.role !== "UNKNOWN");
  if (!roles.length) { $("#tab-body").innerHTML = `<div class="card empty">No games with a known role.</div>`; return; }
  view.player.role = view.player.role && roles.some((r) => r.role === view.player.role) ? view.player.role : roles[0].role;
  $("#tab-body").innerHTML = `
    <div class="roles">${roles.map((r) => `<button class="role-card ${r.role === view.player.role ? "active" : ""}" data-role="${r.role}">
      <div class="top"><span class="rname">${ROLE_NAMES[r.role]}</span><span class="share">${pct(r.share)}</span></div>
      <div class="meta">${r.games} games · ${pct(r.wr)} WR · plays like ${r.pool.effective_pool.toFixed(1)} champs</div>
      <div class="icons">${r.pool.top.map((t) => icon(t.champion_id)).join("")}</div></button>`).join("")}</div>
    <div class="card">
      <div class="card-head"><div><h2>Pick predictor</h2><p>What will they pick in ${ROLE_NAMES[view.player.role]}? Choose a lane opponent to condition on the matchup.</p></div></div>
      <div class="controls">
        <label for="pick-opp">Lane opponent</label><select id="pick-opp"><option value="">Any opponent</option></select>
        <label for="pick-alpha" title="How strongly to lean on the overall role picks when there are few games vs this opponent">Smoothing <span style="text-transform:none">α</span></label>
        <input id="pick-alpha" type="number" min="0" max="50" step="1" value="5" style="width:72px">
      </div>
      <div id="pick-out"><div class="loading"><div class="spinner"></div></div></div>
    </div>`;
  $$(".role-card").forEach((b) => b.addEventListener("click", () => { view.player.role = b.dataset.role; tabDraft(); }));
  $("#pick-opp").addEventListener("change", updatePick);
  $("#pick-alpha").addEventListener("change", updatePick);
  fillOpponents();
}

function fetchPick() {
  const q = new URLSearchParams({ puuid: DATA.puuid, role: view.player.role, alpha: $("#pick-alpha").value || 0, match_ids: DATA.match_ids.join(",") });
  if ($("#pick-opp").value) q.set("opp", $("#pick-opp").value);
  return api(`/api/pick?${q}`);
}

async function fillOpponents() {
  const res = await fetchPick();
  const seen = new Set(res.opponents.map((o) => o.champion_id));
  const all = Object.entries(META.champions).sort((a, b) => a[1].name.localeCompare(b[1].name));
  $("#pick-opp").innerHTML = `<option value="">Any opponent</option>
    <optgroup label="Faced in this role">${res.opponents.map((o) => `<option value="${o.champion_id}">${esc(champ(o.champion_id).name)} (${o.games})</option>`).join("")}</optgroup>
    <optgroup label="All champions">${all.filter(([id]) => !seen.has(+id)).map(([id, c]) => `<option value="${id}">${esc(c.name)}</option>`).join("")}</optgroup>`;
  renderPick(res);
}

async function updatePick() { renderPick(await fetchPick()); }

function renderPick(res) {
  const hasOpp = res.opp != null;
  const oppName = hasOpp ? esc(champ(res.opp).name) : "";
  const role = ROLE_NAMES[res.role];
  const p = (r) => (hasOpp ? r.p_vs : r.p_role);
  const top = res.rows[0];
  const basis = hasOpp
    ? (res.games_vs_opp ? `Based on ${res.games_vs_opp} game${res.games_vs_opp > 1 ? "s" : ""} vs ${oppName}, blended with their usual ${role} picks.` : `No games vs ${oppName} yet, so this is their usual ${role} pick rate.`)
    : `Based on ${res.games} ${role} games.`;
  $("#pick-out").innerHTML = (top ? `<div class="callout">Most likely pick${hasOpp ? ` into <b>${oppName}</b>` : ""}: <b>${esc(champ(top.champion_id).name)}</b> at <b>${pct(p(top))}</b>.
      Banning it removes that much of their ${role} pool. <span class="muted">${basis}</span></div>` : "") +
    legend([["sq", "background:var(--mag)", hasOpp ? `P(pick | ${role}, vs ${oppName})` : `P(pick | ${role})`],
      ...(hasOpp ? [["line", "background:var(--ink)", `P(pick | ${role}) — usual rate`]] : [])]) +
    `<table><thead><tr><th>Champion</th><th>Probability</th><th class="num">Games</th><th class="num">${hasOpp ? "WR vs opp" : "Win rate"}</th></tr></thead><tbody>
    ${res.rows.map((r) => `<tr><td>${champCell(r.champion_id)}</td>
      <td style="width:50%" title="${pct(p(r), 1)}${hasOpp ? ` · usual ${pct(r.p_role, 1)}` : ""}">${barCell(p(r), pct(p(r), 1), { tick: hasOpp ? r.p_role : null, thick: true })}</td>
      <td class="num">${hasOpp ? `${r.games_vs} <span class="muted small">/ ${r.games}</span>` : r.games}</td>
      <td class="num" title="${esc(wrTip(hasOpp ? r.wr_vs : r.wr))}">${wrText(hasOpp ? r.wr_vs : r.wr)}</td></tr>`).join("")}</tbody></table>`;
}

function wrTable(head, rows) {
  return `<table><thead><tr><th>${head}</th><th>Win rate</th><th class="num"></th></tr></thead><tbody>
    ${rows.map(([label, w]) => `<tr><td>${label}</td><td style="width:50%">${wrBar(w)}</td><td class="num" title="${esc(wrTip(w))}">${wrText(w)}</td></tr>`).join("")}</tbody></table>`;
}

function tabHabits() {
  const o = DATA.overview;
  const m = o.momentum;
  const card = (h, sub, body) => `<div class="card"><div class="card-head"><div><h2>${h}</h2><p>${sub}</p></div></div>${body}</div>`;
  $("#tab-body").innerHTML = `${WR_LEGEND()}
    <div class="grid-2">
      ${card("After the last game", "Next-game win rate within a session (games under 30 min apart).",
        wrTable("Previous game", [["After a win", m.after_win], ["After a loss", m.after_loss], ["After 2 losses in a row", m.after_2_losses]]) +
        `<p class="muted small" style="margin:12px 0 0">Switches champion after a loss <b>${pct(m.swap_after_loss.p)}</b> of the time, vs ${pct(m.swap_after_win.p)} after a win.</p>`)}
      ${card("Game in session", `${m.sessions} sessions, ${m.avg_session_len.toFixed(1)} games each on average.`,
        wrTable("Game", m.by_game_in_session.map((w) => [w.label, w])))}
      ${card("Time of day", "Your local time when the game started.", wrTable("Time", o.time_of_day.map((w) => [w.label, w])))}
      ${card("Game length", "Early finishers or late-game closers?", wrTable("Length", o.duration.map((w) => [w.label, w])))}
    </div>`;
}

function tabWincons() {
  const rows = DATA.overview.conversion.map((c) => ({ ...c, swing: c.yes.games && c.no.games ? c.yes.wr - c.no.wr : null }));
  const maxAbs = Math.max(0.2, ...rows.filter((r) => r.swing != null).map((r) => Math.abs(r.swing)));
  $("#tab-body").innerHTML = `<div class="card">
    <div class="card-head"><div><h2>What wins your games</h2><p>P(win | it happened) vs P(win | it didn't). The swing is how much it matters for this player.</p></div></div>
    ${legend([["", "background:var(--pos)", "Raises win chance"], ["", "background:var(--neg)", "Lowers win chance"]])}
    <table><thead><tr><th>Condition</th><th class="num">If yes</th><th class="num">If no</th><th>Swing</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.label}</td>
      <td class="num" title="${esc(wrTip(r.yes))}">${wrText(r.yes)}</td>
      <td class="num" title="${esc(wrTip(r.no))}">${wrText(r.no)}</td>
      <td style="width:34%"><div class="barcell">${dbar(r.swing, maxAbs)}<span class="v delta">${r.swing == null ? "–" : pts(r.swing).replace(" pts", "")}</span></div></td></tr>`).join("")}
    </tbody></table></div>`;
}

// ---------------------------------------------------------------- boot
(async () => {
  META = await api("/api/meta");
  window.addEventListener("hashchange", route);
  route();
})();
