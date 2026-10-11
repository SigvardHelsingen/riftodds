// Rift Odds — tiny hash-routed SPA.  #/            → patch landing
//                                    #/p/euw1/Name%23TAG/40 → player
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const pts = (x) => (x == null ? "–" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(0)} pts`);
const title = (s) => s[0] + s.slice(1).toLowerCase();
const day = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
// Riot's API reports the internal version (16.20); players know it by the year-based name (26.20)
const patchName = (v) => { const [major, minor] = String(v).split(".").map(Number); return major >= 15 && major < 20 ? `${major + 10}.${minor}` : v; };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const ROLE_NAMES = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support", UNKNOWN: "Unknown" };

let META = null;
const view = { landing: { tier: "", sort: "wr", role: "", all: false }, player: { tab: "champions", role: null } };
let PATCH = null;
let DATA = null;
let pollTimer = null;
let ME = null; // { username, account }
let nav = 0;    // bumped on every route; async renders bail out if it changed

const playerHash = (platform, riotId, range) => `#/p/${platform}/${encodeURIComponent(riotId)}/${range}`;
const myHash = () => ME?.account && playerHash(ME.account.platform, `${ME.account.game_name}#${ME.account.tag_line}`, view.player.range || META.default_range);

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") {
    showLogin(); // session expired or user removed
    throw new Error("Not logged in");
  }
  if (!r.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map((error) => error.msg).join("; ") : body.detail;
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return body;
}

const postJSON = (path, data) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

// ---------------------------------------------------------------- login
function showLogin() {
  nav++;
  ME = null;
  DATA = null;
  clearInterval(pollTimer);
  clearInterval(livePoll);
  $("#top-search").hidden = true;
  $("#user").hidden = true;
  $("#app").innerHTML = `
    <section class="login">
      <h1>Members<br><em>only.</em></h1>
      <form class="card" id="login-form">
        <label>Username<input name="username" autocomplete="username" maxlength="64" required autofocus></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="1024" required></label>
        <button class="btn">Log in</button>
        <p class="error small" id="login-error" aria-live="polite"></p>
      </form>
    </section>`;
  const form = $("#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelector("button").disabled = true;
    try {
      await postJSON("/api/login", { username: form.username.value, password: form.password.value });
      start();
    } catch (err) {
      $("#login-error").textContent = err.message;
      form.password.value = "";
      form.querySelector("button").disabled = false;
    }
  });
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
    <input name="riot" aria-label="Riot ID" placeholder="Name#TAG" required autocomplete="off" value="${esc(last.riotId || "")}">
    <select name="platform" aria-label="Region">${META.platforms.map((p) => `<option ${p === (last.platform || "euw1") ? "selected" : ""}>${p}</option>`).join("")}</select>
    <button class="btn" aria-label="Analyse player">${cls === "compact" ? "Go" : "Analyse"}</button></form>`;
}

function bindSearch(form) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const riotId = form.riot.value.trim();
    const platform = form.platform.value;
    if (!riotId.includes("#")) { form.riot.setCustomValidity("Use the full Riot ID, e.g. Name#EUW"); form.riot.reportValidity(); return; }
    localStorage.setItem("last", JSON.stringify({ riotId, platform }));
    location.hash = playerHash(platform, riotId, view.player.range || META.default_range);
  });
  form.riot.addEventListener("input", () => form.riot.setCustomValidity(""));
}

function prepareTables(root = $("#app")) {
  if (!root) return;
  $$("table", root).forEach((table) => {
    if (table.parentElement.classList.contains("table-scroll")) return;
    const heading = table.closest(".mh-team")?.querySelector(".mh-team-head b")?.textContent
      || table.closest(".card")?.querySelector("h2")?.textContent || "Statistics";
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", `${heading} table, scroll horizontally for more columns`);
    table.before(wrapper);
    wrapper.append(table);
    if (table.rows[0]?.cells.length > 3) {
      const hint = document.createElement("p");
      hint.className = "table-hint";
      hint.textContent = "Swipe the table to see all stats →";
      hint.setAttribute("aria-hidden", "true");
      wrapper.after(hint);
    }
  });
}

// ---------------------------------------------------------------- router
async function route() {
  nav++;
  clearInterval(pollTimer);
  clearInterval(livePoll);
  const m = (location.hash.slice(1) || "/").match(/^\/p\/([^/]+)\/([^/]+)(?:\/(\w+))?/);
  const top = $("#top-search");
  top.hidden = !m;
  if (m) {
    top.outerHTML = searchForm("compact").replace("<form", '<form id="top-search"');
    bindSearch($("#top-search"));
    showPlayer(m[1], decodeURIComponent(m[2]), m[3] || META.default_range);
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
        ${ME?.account ? `<a class="btn mine" href="${myHash()}">Open my profile · ${esc(ME.account.game_name)}#${esc(ME.account.tag_line)}</a>` : ""}
      </div>
      ${searchForm("big")}
    </section>
    <div id="patch-body"><div class="loading"><div class="spinner"></div>Loading patch stats…</div></div>`;
  bindSearch($(".search.big"));
  const token = nav;
  await loadPatch();
  if (token === nav) pollTimer = setInterval(loadPatch, 30000);
}

let patchRequest = 0;
async function loadPatch() {
  const token = nav;
  const request = ++patchRequest;
  try {
    const data = await api(`/api/patch${view.landing.tier ? `?tier=${view.landing.tier}` : ""}`);
    if (token !== nav || request !== patchRequest || !$("#patch-body")) return;
    PATCH = data;
    renderPatch();
  } catch (e) {
    if (token === nav && request === patchRequest && $("#patch-body")) {
      $("#patch-body").innerHTML = `<div class="card empty error">${esc(e.message)}</div>`;
    }
  }
}

function samplerLine(s) {
  if (!s || s.status === "off") return `<div class="sampler"><span class="dotlive off"></span>Background sampler is off (SAMPLER=0).</div>`;
  const label = { sampling: s.tier ? `Sampling ${title(s.tier)} games on ${s.platform}` : "Fetching timelines for sampled games",
    idle: "Sample complete for this patch", paused: "Paused while a player's history is fetched",
    error: "Sampler hit an error — retrying", "key rejected": "Sampler paused — Riot API key rejected" }[s.status] || s.status;
  return `<div class="sampler"><span class="dotlive ${s.status === "sampling" ? "" : "off"}"></span>${label}
    ${s.target ? `· ${s.matches ?? 0} / ${s.target} games ${bar((s.matches || 0) / s.target)}` : ""}</div>`;
}

function renderPatch() {
  const P = PATCH;
  const L = view.landing;
  const live = P.current_patch || P.patch;
  $("#hero-stamp").textContent = live ? `Patch ${patchName(live)}` : "Ranked solo";
  // right after a patch drops, the numbers still come from the previous patch: say so
  const stale = P.patch && live && P.patch !== live
    ? `<p class="patch-note"><b>Patch ${patchName(live)} is live.</b> The numbers below are from ${patchName(P.patch)} until enough
        ${patchName(live)} games are sampled (${P.current_patch_games} so far).</p>` : "";
  if (!P.matches) {
    $("#patch-body").innerHTML = `<div class="card empty"><h2>No games sampled yet${L.tier ? ` for ${title(L.tier)}` : ""}</h2>
      <p>The background sampler pulls recent ranked games from random players in every tier.
      Stats appear here as games come in; how fast depends on your API key's rate limit.</p></div>${samplerLine(P.sampler)}`;
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
    ${stale}
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
    ${leadCard(P.leads)}
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
  prepareTables($("#patch-body"));
}

function leadCard(leads) {
  if (!leads || !leads.games) return "";
  return `<div class="card section">
    <div class="card-head"><div><h2>How safe is a lead at 15?</h2>
      <p>P(win | team gold difference at 15:00), from ${leads.games.toLocaleString()} games with timelines.</p></div></div>
    <table><thead><tr><th>Gold at 15</th><th>How often</th><th>Win rate</th><th class="num"></th><th class="num">Fair odds</th></tr></thead>
    <tbody>${leads.curve.map((b) => `<tr><td><b>${b.label}</b></td>
      <td style="width:22%">${barCell(b.share ?? 0, pct(b.share))}</td>
      <td style="width:34%" title="${esc(wrTip(b))}">${bar(b.wr ?? 0, { tick: 0.5, thick: true })}</td>
      <td class="num"><b>${pct(b.wr, 1)}</b></td>
      <td class="num muted">${b.wr ? `@ ${(1 / b.wr).toFixed(2)}` : "–"}</td></tr>`).join("")}</tbody></table>
    ${legend([["sq", "background:var(--mag)", "Share of teams / win rate"], ["line", "background:var(--ink)", "50%"]])}
  </div>`;
}

// ---------------------------------------------------------------- player
async function showPlayer(platform, riotId, range) {
  view.player.range = range;
  view.player.role = null;
  view.player.opp = "";
  view.player.liveForm = false;
  view.player.matchesShown = 20;
  view.player.open = new Set();
  const [name] = riotId.split("#");
  const label = META.ranges.find((r) => r.key === range)?.label.toLowerCase() || "recent games";
  $("#app").innerHTML = `<div class="loading"><div class="spinner"></div>
    Looking up ${esc(name)} (${esc(label)}) — the newest games show in a few seconds, the rest fill in.</div>`;
  const token = nav;
  try {
    const data = await api(`/api/player?platform=${platform}&riot_id=${encodeURIComponent(riotId)}&range=${range}&tz=${new Date().getTimezoneOffset()}`);
    if (token !== nav) return;
    DATA = data;
    renderPlayer();
    if (DATA.sync?.running) pollSync(DATA.puuid);
  } catch (e) {
    if (token !== nav) return;
    $("#app").innerHTML = `<div class="card empty section"><h2 class="error">Couldn't load ${esc(riotId)}</h2><p>${esc(e.message)}</p></div>`;
  }
}

// The first response only waits a few seconds; the sync keeps going in the background.
// Poll its progress and re-render as games arrive (every quarter of the way, min. 10 games),
// once more when matches are done (timelines follow), and at the end.
function pollSync(puuid) {
  clearInterval(pollTimer);
  let shown = { phase: DATA.sync?.phase, done: DATA.sync?.done ?? 0 };
  pollTimer = setInterval(async () => {
    if (DATA?.puuid !== puuid) return clearInterval(pollTimer);
    const sync = await api(`/api/sync/${puuid}`).catch(() => null);
    if (!sync || DATA?.puuid !== puuid) return;
    DATA.sync = sync;
    if (!sync.running) {
      clearInterval(pollTimer);
      return sync.phase === "paused" ? resumeSync() : refreshAnalysis();
    }
    const busy = document.activeElement?.closest?.("#app select, #app input");  // don't yank an open control
    const matchesDone = shown.phase === "matches" && sync.phase !== "matches";
    const grew = sync.phase === "matches" && sync.done - (shown.phase === "matches" ? shown.done : 0) >= Math.max(10, Math.ceil(sync.total / 4));
    if (!busy && (matchesDone || grew)) {
      shown = { phase: sync.phase, done: sync.done };
      return refreshAnalysis();
    }
    if (sync.phase !== shown.phase && !matchesDone) shown = { phase: sync.phase, done: 0 };
    renderSync();
  }, 2500);
}

// A sync stops when nobody polls it for a few minutes (e.g. a background tab). Pick it back up.
async function resumeSync() {
  const p = DATA.profile;
  const token = nav;
  const data = await api(`/api/player?platform=${p.platform}&riot_id=${encodeURIComponent(`${p.name}#${p.tag}`)}&range=${view.player.range}&tz=${new Date().getTimezoneOffset()}`).catch(() => null);
  if (!data || token !== nav) return;
  DATA = data;
  renderPlayer();
  if (DATA.sync?.running) pollSync(DATA.puuid);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && DATA?.sync?.phase === "paused" && !DATA.sync.running && location.hash.startsWith("#/p/")) resumeSync();
});

async function refreshAnalysis() {
  const token = nav;
  const data = await api(`/api/player/${DATA.puuid}/analysis?range=${view.player.range}&tz=${new Date().getTimezoneOffset()}`);
  if (token !== nav) return;
  DATA = { ...data, live: DATA.live };  // the live flag only comes with the full lookup
  renderPlayer();
}

function renderSync() {
  const el = $("#sync");
  const s = DATA.sync;
  if (!el) return;
  if (!s || (!s.running && !s.error)) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle("is-error", !!s.error);
  if (s.error) {
    el.innerHTML = `<div class="cell lead"><div class="label">History stopped</div><div class="sub">${esc(s.error)}</div></div>
      <div class="cell act"><button class="btn" id="sync-now">Retry</button></div>`;
    $("#sync-now").addEventListener("click", resumeSync);
    return;
  }
  // a ruled strip like the landing board: what's happening | count + bar | time left | action
  const total = s.total ?? 0;
  const what = { listing: "Listing games", matches: "Games", timelines: "Timelines" }[s.phase] || "Working";
  const note = s.phase === "timelines" ? "Gold-lead stats fill in when it's done"
    : `Stats below cover ${DATA.games_analysed} game${DATA.games_analysed === 1 ? "" : "s"} so far`;
  const left = eta(s);
  el.innerHTML = `
    <div class="cell lead"><div class="label"><span class="live-dot"></span>Loading history</div><div class="sub">${note}</div></div>
    <div class="cell count"><div class="label">${what}</div>
      <div class="value">${s.total == null ? "…" : `${s.done}<span>/${total}</span>`}</div>${bar(total ? s.done / total : 0, { thick: true })}</div>
    <div class="cell"><div class="label">Time left</div><div class="value">${left || "…"}</div></div>
    <div class="cell act"><button class="btn" id="sync-now">Update now</button></div>`;
  $("#sync-now").addEventListener("click", refreshAnalysis);
}

// rough time left from the last ~30 s of progress in the current phase
const etaSamples = [];
function eta(s) {
  const now = Date.now();
  if (etaSamples.length && (etaSamples.at(-1).phase !== s.phase || etaSamples.at(-1).done > s.done)) etaSamples.length = 0;
  etaSamples.push({ t: now, done: s.done, phase: s.phase });
  while (etaSamples.length > 2 && now - etaSamples[0].t > 30000) etaSamples.shift();
  const first = etaSamples[0];
  const rate = (s.done - first.done) / ((now - first.t) / 1000);
  if (!s.total || !(rate > 0)) return "";
  const secs = (s.total - s.done) / rate;
  return secs < 90 ? `${Math.max(5, Math.round(secs / 5) * 5)}s` : `~${Math.round(secs / 60)}m`;
}

function rangeOptions(kind) {
  return META.ranges.filter((r) => r.kind === kind)
    .map((r) => `<option value="${r.key}" ${r.key === view.player.range ? "selected" : ""}>${esc(r.label)}</option>`).join("");
}

function renderPlayer() {
  const p = DATA.profile;
  const isMe = ME?.account?.puuid === DATA.puuid;
  const rankText = p.tier === "UNRANKED" ? "<b>Unranked</b>" : `<b>${title(p.tier)} ${p.division}</b> · ${p.lp} LP`;
  const season = p.season_wins + p.season_losses;
  $("#app").innerHTML = `
    <section class="player-head">
      ${p.icon ? `<div class="avatar"><img src="${p.icon}" alt="">${p.level ? `<span class="lvl">${p.level}</span>` : ""}</div>`
               : `<div class="badge">${p.tier === "UNRANKED" ? "–" : p.tier[0]}</div>`}
      <div class="who">
        <div class="name ${(p.name + p.tag).length > 13 ? "long" : ""}">${esc(p.name)} <span>#${esc(p.tag)}</span></div>
        <div class="rank">${rankText}${season ? ` · season ${p.season_wins}W ${p.season_losses}L (${pct(p.season_wins / season)})` : ""} · ${p.platform}</div>
        ${DATA.first_game ? `<div class="coverage">Analysing <b>${DATA.games_analysed}</b> games · ${day(DATA.first_game)} – ${day(DATA.last_game)}${
          DATA.overview ? ` · <b>${ROLE_NAMES[DATA.overview.roles[0].role] || ""}</b> main, plays like ${DATA.overview.roles[0].pool.effective_pool.toFixed(1)} champions` : ""}</div>` : ""}
      </div>
      <div class="actions">
        ${isMe ? `<span class="me-tag" title="Linked to your login">Your account</span><button class="btn ghost" id="unlink">Unlink</button>`
               : `<button class="btn ghost" id="link">This is me</button>`}
        <select id="range" aria-label="Game range" title="Which ranked solo games to analyse">
          <optgroup label="Games">${rangeOptions("count")}</optgroup>
          <optgroup label="Time">${rangeOptions("time")}</optgroup>
        </select>
        <button class="btn ghost" id="refresh">Refresh</button>
      </div>
    </section>
    ${DATA.live ? `<button class="live-banner" id="live-banner"><span class="live-dot"></span><b>Live now</b> · ${esc(DATA.live.queue)}
        ${DATA.live.champion_id ? `· ${icon(DATA.live.champion_id)} ${esc(champ(DATA.live.champion_id).name)}` : ""}
        ${DATA.live.started ? `· ${Math.max(0, Math.round((Date.now() - DATA.live.started) / 60000))} min in` : "· loading in"}
        <span class="go">See all ten players →</span></button>` : ""}
    <div class="syncbar" id="sync" hidden></div>
    <div id="player-body"></div>`;
  $("#live-banner")?.addEventListener("click", () => { view.player.tab = "live"; renderPlayer(); });
  $("#range").addEventListener("change", (e) => { location.hash = playerHash(p.platform, `${p.name}#${p.tag}`, e.target.value); });
  $("#refresh").addEventListener("click", route);
  $("#link")?.addEventListener("click", async () => {
    ME.account = await api("/api/me/account", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ puuid: DATA.puuid }) });
    renderUser();
    renderPlayer();
  });
  $("#unlink")?.addEventListener("click", async () => {
    await api("/api/me/account", { method: "DELETE" });
    ME.account = null;
    renderUser();
    renderPlayer();
  });
  renderSync();

  if (!DATA.overview) {
    $("#player-body").innerHTML = DATA.sync?.running
      ? `<div class="loading"><div class="spinner"></div>Waiting for the first games to arrive…</div>`
      : `<div class="card empty"><h2>No ranked solo games in this range</h2><p>Try a longer range.</p></div>`;
    return;
  }
  const o = DATA.overview;
  const m = o.momentum;
  const cb = DATA.leads.comeback;
  const tilt = m.after_win.games && m.after_loss.games ? m.after_win.wr - m.after_loss.wr : null;
  const best = DATA.vs_rank.rows.filter((r) => r.p_better != null && r.player.games >= 3).sort((a, b) => b.p_better - a.p_better)[0];
  const tabs = [...(DATA.live ? [["live", "Live game"]] : []), ["champions", "Champions"], ["matches", "Matches"], ["draft", "Draft"], ["habits", "Habits"], ["wincons", "Win conditions"]];
  if (view.player.tab === "live" && !DATA.live) view.player.tab = "champions";

  $("#player-body").innerHTML = `
    <div class="tiles">
      ${tile(`Win rate · ${o.record.games} games`, pct(o.record.wr), `90% likely true win rate ${pct(o.record.lo)}–${pct(o.record.hi)}`, "indigo")}
      ${cb.you.games ? tile("Comeback rate", pct(cb.you.wr), `wins when 1k+ gold behind at 15 (${cb.you.games} games)${rankRate(cb.rank, title(p.tier))}`, "peach")
                     : tile("Comeback rate", "–", DATA.sync?.running ? "Timelines are still being fetched" : "No games 1k+ behind at 15", "peach")}
      ${tile("Tilt swing", pts(tilt), tilt == null ? "Not enough back-to-back games" : `win rate after a win vs after a loss`, "plum")}
      ${best ? tile(`Best vs ${p.tier === "UNRANKED" ? "rank" : title(p.tier)}`, `${icon(best.champion_id)}<span class="sm">${esc(champ(best.champion_id).name)}</span>`,
        `${pts(best.delta)} vs rank · ${pct(best.p_better)} sure you're better`) : tile("Best vs rank", "–", "Not enough data yet")}
    </div>
    <nav class="tabs" aria-label="Player statistics">${tabs.map(([v, l]) => `<button data-tab="${v}" aria-pressed="${view.player.tab === v}" class="${view.player.tab === v ? "active" : ""}">${l}</button>`).join("")}</nav>
    <div id="tab-body"></div>`;
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => {
    view.player.tab = b.dataset.tab;
    $$(".tabs button").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-pressed", x === b);
    });
    renderTab();
  }));
  renderTab();
}

function renderTab() {
  clearInterval(livePoll);
  ({ live: tabLive, champions: tabChampions, matches: tabMatches, draft: tabDraft, habits: tabHabits, wincons: tabWincons })[view.player.tab]();
  prepareTables($("#tab-body"));
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
    <table><thead><tr><th>Champion</th><th class="num">Mastery</th><th class="num">Games</th><th>Win rate</th><th class="num">You</th><th class="num">${tier}</th><th>Difference</th><th class="num">P(better)</th></tr></thead>
    <tbody>${v.rows.map((r) => `<tr><td>${champCell(r.champion_id)}</td><td class="num">${masteryText(r.champion_id)}</td><td class="num">${r.player.games}</td>
      <td style="width:26%">${wrBar(r.player, r.baseline)}</td>
      <td class="num" title="${esc(wrTip(r.player))}">${pct(r.player.wr)}</td>
      <td class="num" title="${esc(wrTip(r.baseline))}">${r.baseline.games ? `${pct(r.baseline.wr)} <span class="muted small">${r.baseline.games}</span>` : `<span class="muted">no data</span>`}</td>
      <td style="width:18%"><div class="barcell">${dbar(r.delta, maxAbs)}<span class="v delta">${r.delta == null ? "" : pts(r.delta).replace(" pts", "")}</span></div></td>
      <td class="num"><b>${r.p_better == null ? "–" : pct(r.p_better)}</b></td></tr>`).join("")}</tbody></table>
    <p id="grow-status" class="muted small"></p></div>`;
  $("#grow")?.addEventListener("click", growSample);
}

function masteryText(champId) {
  const m = DATA.mastery.by_champion[champId];
  return m ? `${kpts(m.points)} <span class="muted small">M${m.level}</span>` : `<span class="muted">–</span>`;
}
// rank comparisons only once the rank sample can say something
const MIN_RANK_GAMES = 20;
const rankRate = (w, tier, min = MIN_RANK_GAMES) => (w.games >= min ? ` · ${tier} ${pct(w.wr)}` : "");
const kpts = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

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
        <input id="pick-alpha" type="number" min="0" max="50" step="1" value="${view.player.alpha ?? 5}">
      </div>
      <div id="pick-out"><div class="loading"><div class="spinner"></div></div></div>
    </div>
    ${DATA.mastery.pockets.length ? `<div class="card section">
      <div class="card-head"><div><h2>Pocket picks</h2><p>High mastery, but not played in this range. Not in the predictor above — but they know these.</p></div></div>
      <div class="pockets">${DATA.mastery.pockets.map((m) => `<div class="pocket">${icon(m.champion_id)}<div><b>${esc(champ(m.champion_id).name)}</b>
        <div class="muted small">${kpts(m.points)} pts · M${m.level} · last played ${day(m.last_play)}</div></div></div>`).join("")}</div>
    </div>` : ""}`;
  $$(".role-card").forEach((b) => b.addEventListener("click", () => { view.player.role = b.dataset.role; view.player.opp = ""; tabDraft(); }));
  $("#pick-opp").addEventListener("change", (e) => { view.player.opp = e.target.value; updatePick(); });
  $("#pick-alpha").addEventListener("change", (e) => { view.player.alpha = e.target.value; updatePick(); });
  fillOpponents();
}

function fetchPick() {
  const q = new URLSearchParams({ puuid: DATA.puuid, role: view.player.role, alpha: $("#pick-alpha").value || 0, range: view.player.range });
  if ($("#pick-opp").value) q.set("opp", $("#pick-opp").value);
  return api(`/api/pick?${q}`);
}

function fillOpponents() {
  const opp = view.player.opp;
  $("#pick-opp").innerHTML = opp ? `<option value="${esc(opp)}" selected></option>` : "";  // so the first fetch keeps it
  return updatePick(true);
}

let pickRequest = 0;
async function updatePick(fill = false) {
  const output = $("#pick-out");
  if (!output) return;
  const token = nav;
  const request = ++pickRequest;
  const opp = view.player.opp;
  const current = () => token === nav && request === pickRequest && output.isConnected && view.player.tab === "draft";
  try {
    const res = await fetchPick();
    if (!current()) return;
    if (fill) {
      const seen = new Set(res.opponents.map((o) => o.champion_id));
      const all = Object.entries(META.champions).sort((a, b) => a[1].name.localeCompare(b[1].name));
      $("#pick-opp").innerHTML = `<option value="">Any opponent</option>
        <optgroup label="Faced in this role">${res.opponents.map((o) => `<option value="${o.champion_id}">${esc(champ(o.champion_id).name)} (${o.games})</option>`).join("")}</optgroup>
        <optgroup label="All champions">${all.filter(([id]) => !seen.has(+id)).map(([id, c]) => `<option value="${id}">${esc(c.name)}</option>`).join("")}</optgroup>`;
      $("#pick-opp").value = opp;
    }
    renderPick(res);
  } catch (e) {
    if (current()) output.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

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
  prepareTables($("#pick-out"));
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
    </tbody></table></div>
    ${playerLeadCard()}`;
}

function playerLeadCard() {
  const L = DATA.leads;
  const tier = DATA.profile.tier === "UNRANKED" ? "Rank" : title(DATA.profile.tier);
  if (!L.games_with_timeline) {
    return `<div class="card section empty"><h2>Gold leads at 15</h2><p>${DATA.sync?.running ? "Timelines are still being fetched — this fills in when they're done."
      : "No timelines for these games yet."}</p></div>`;
  }
  const lane = L.lane;
  return `<div class="card section">
    <div class="card-head"><div><h2>How safe are your leads?</h2>
      <p>P(win | your team's gold difference at 15:00), across ${L.games_with_timeline} of your games${L.rank_games >= MIN_RANK_GAMES
        ? `, against ${L.rank_games.toLocaleString()} ${tier} games` : `. The ${tier} comparison appears once the sampler has ${MIN_RANK_GAMES}+ ${tier} games with timelines (${L.rank_games} so far)`}.</p></div></div>
    <div class="tiles" style="margin-bottom:18px">
      ${tile("Comeback rate", pct(L.comeback.you.wr), `wins when 1k+ behind (${L.comeback.you.games} games)${rankRate(L.comeback.rank, tier)}`)}
      ${tile("Close-out rate", pct(L.close_out.you.wr), `wins when 1k+ ahead (${L.close_out.you.games} games)${rankRate(L.close_out.rank, tier)}`)}
      ${tile("Lane lead at 15", pct(lane.ahead_share), `ahead of the lane opponent · average ${lane.avg_diff == null ? "–" : `${lane.avg_diff > 0 ? "+" : ""}${Math.round(lane.avg_diff)} gold`}`)}
    </div>
    ${WR_LEGEND(`${tier} average`)}
    <table><thead><tr><th>Gold at 15</th><th class="num">How often</th><th>Win rate</th><th class="num">You</th><th class="num">${tier}</th></tr></thead>
    <tbody>${L.curve.map((b) => `<tr><td><b>${b.label}</b></td><td class="num">${pct(b.share)}</td>
      <td style="width:38%">${wrBar(b.you, b.rank.games >= 10 ? b.rank : null)}</td>
      <td class="num" title="${esc(wrTip(b.you))}">${wrText(b.you)}</td>
      <td class="num" title="${esc(wrTip(b.rank))}">${b.rank.games >= 10 ? `${pct(b.rank.wr)} <span class="muted small">${b.rank.games}</span>` : "–"}</td></tr>`).join("")}</tbody></table>
  </div>`;
}

// ---------------------------------------------------------------- match history
const ITEM_CDN = () => `https://ddragon.leagueoflegends.com/cdn/${META.ddragon}/img/item/`;
const itemIcon = (id) => (id ? `<img src="${ITEM_CDN()}${id}.png" alt="" loading="lazy">` : `<span class="slot"></span>`);
const spellIcon = (id) => (META.spells[id] ? `<img src="${META.spells[id]}" alt="" loading="lazy">` : `<span class="slot"></span>`);
const items = (ids) => `<span class="items">${ids.map(itemIcon).join("")}</span>`;
const ago = (ms) => {
  const min = (Date.now() - ms) / 60000;
  return min < 60 ? `${Math.max(1, Math.round(min))} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago`
    : min < 2880 ? "yesterday" : `${Math.round(min / 1440)} days ago`;
};
// gold difference with a direction glyph, so the sign never relies on colour
const golddiff = (n) => (n == null ? "–" : `${n > 0 ? "▲" : n < 0 ? "▼" : "="} ${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}k` : Math.abs(Math.round(n))}`);
const sessionLabel = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function tabMatches() {
  const token = nav;
  const puuid = DATA.puuid;
  if (!$("#tab-body .mh")) $("#tab-body").innerHTML = `<div class="loading"><div class="spinner"></div>Loading matches…</div>`;
  const res = await api(`/api/player/${puuid}/matches?range=${view.player.range}&limit=${view.player.matchesShown}`)
    .catch((e) => ({ error: e.message }));
  if (token !== nav || view.player.tab !== "matches" || DATA.puuid !== puuid) return;
  renderMatches(res);
}

function renderMatches(res) {
  const el = $("#tab-body");
  if (res.error) { el.innerHTML = `<div class="card empty"><p class="error">${esc(res.error)}</p></div>`; return; }
  if (!res.rows.length) { el.innerHTML = `<div class="card empty"><h2>No games in this range yet</h2></div>`; return; }
  let html = `<div class="mh">`;
  let session = null;
  for (const g of res.rows) {
    if (g.session.id !== session) {  // a header for each run of games played less than 30 min apart
      session = g.session.id;
      const s = g.session;
      html += `<div class="mh-session">Session · ${sessionLabel(s.start)}<span>${s.games} game${s.games > 1 ? "s" : ""} · ${s.wins}W ${s.games - s.wins}L</span></div>`;
    }
    const kda = g.deaths ? ((g.kills + g.assists) / g.deaths).toFixed(1) : "Perfect";
    const open = view.player.open.has(g.match_id);
    html += `<button class="mh-row ${g.win ? "win" : "loss"} ${open ? "open" : ""}" data-mid="${g.match_id}" aria-expanded="${open}">
      <span class="mh-res">${g.win ? "W" : "L"}</span>
      <span class="mh-champ">${icon(g.champion_id)}<span class="spells">${g.spells.map(spellIcon).join("")}</span>
        <span><b>${esc(champ(g.champion_id).name)}</b><small>${ROLE_NAMES[g.position] || "–"}${g.level ? ` · lvl ${g.level}` : ""}</small></span></span>
      <span class="mh-vs">${g.opp_champ ? `<small>vs</small>${icon(g.opp_champ)}` : ""}</span>
      <span class="mh-stat mh-kda"><b>${g.kills} / ${g.deaths} / ${g.assists}</b><small>${kda}${g.deaths ? " KDA" : ""}${g.kill_participation != null ? ` · ${pct(g.kill_participation)} KP` : ""}</small></span>
      <span class="mh-stat mh-cs"><b>${g.cs} CS</b><small>${(g.cs / (g.duration / 60)).toFixed(1)} / min</small></span>
      <span class="mh-stat mh-gold" title="Gold difference at 15:00 — vs your lane opponent, and your team vs theirs"><b>${golddiff(g.lane_diff15)}</b><small>lane @15 · team ${golddiff(g.team_diff15)}</small></span>
      ${items(g.items)}
      <span class="mh-stat mh-when right"><b>${mmss(g.duration)}</b><small>${ago(g.game_start)}</small></span>
    </button>
    <div class="mh-detail" id="d-${g.match_id}" ${open ? "" : "hidden"}></div>`;
  }
  html += `</div>`;
  if (res.total > res.rows.length) html += `<div class="table-foot"><button class="btn ghost" id="mh-more">Show more (${res.rows.length} of ${res.total})</button></div>`;
  el.innerHTML = html;
  $$(".mh-row").forEach((b) => b.addEventListener("click", () => toggleMatch(b)));
  $("#mh-more")?.addEventListener("click", () => { view.player.matchesShown += 20; tabMatches(); });
  view.player.open.forEach((mid) => loadMatchDetail(mid));
}

function toggleMatch(row) {
  const mid = row.dataset.mid;
  const open = !view.player.open.has(mid);
  open ? view.player.open.add(mid) : view.player.open.delete(mid);
  row.classList.toggle("open", open);
  row.setAttribute("aria-expanded", open);
  $(`#d-${CSS.escape(mid)}`).hidden = !open;
  if (open) loadMatchDetail(mid);
}

async function loadMatchDetail(mid) {
  const el = $(`#d-${CSS.escape(mid)}`);
  if (!el || el.dataset.loaded) return;
  el.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  const m = await api(`/api/match/${mid}`).catch((e) => ({ error: e.message }));
  if (m.error) { el.innerHTML = `<p class="error">${esc(m.error)}</p>`; return; }
  el.dataset.loaded = "1";
  const maxDmg = Math.max(...m.teams.flatMap((t) => t.players.map((p) => p.damage)), 1);
  el.innerHTML = m.teams.map((t) => `<div class="mh-team ${t.team_id === 100 ? "blue" : "red"}">
    <div class="mh-team-head"><b>${t.win ? "Victory" : "Defeat"}</b><span>${t.team_id === 100 ? "Blue" : "Red"} side · ${t.kills} kills · ${t.towers} towers · ${t.dragons} dragons · ${t.barons} barons${t.gold15 != null ? ` · ${kpts(t.gold15)} gold at 15` : ""}</span>
      <span class="bans" title="Bans">${t.bans.map(icon).join("")}</span></div>
    <table><thead><tr><th>Player</th><th class="num">KDA</th><th class="num">CS</th><th>Damage</th><th class="num">Gold @15</th><th>Items</th></tr></thead>
    <tbody>${t.players.map((p) => `<tr class="${p.puuid === DATA.puuid ? "me" : ""}">
      <td>${champCell(p.champion_id, `<a href="${playerHash(m.platform, p.riot_id, view.player.range)}">${esc(p.riot_id)}</a>`)}</td>
      <td class="num">${p.kills}/${p.deaths}/${p.assists}</td>
      <td class="num">${p.cs}</td>
      <td style="width:20%">${barCell(p.damage / maxDmg, kpts(p.damage))}</td>
      <td class="num">${p.gold15 == null ? "–" : kpts(p.gold15)}</td>
      <td>${items(p.items)}</td></tr>`).join("")}</tbody></table></div>`).join("");
  prepareTables(el);
}

// ---------------------------------------------------------------- live game
let livePoll = null;
let liveRequest = 0;

async function tabLive() {
  $("#tab-body").innerHTML = `<div class="loading"><div class="spinner"></div>Loading the live game…</div>`;
  const token = nav;
  const puuid = DATA.puuid;
  const request = ++liveRequest;
  let timer;
  const load = async () => {
    const live = await api(`/api/live/${puuid}?form=${view.player.liveForm ? 1 : 0}`).catch((e) => ({ error: e.message }));
    if (token !== nav || request !== liveRequest || view.player.tab !== "live" || DATA?.puuid !== puuid) return clearInterval(timer);
    renderLive(live);
    if (live.error || !live.in_game || !live.pending) clearInterval(timer);
  };
  clearInterval(livePoll);
  livePoll = timer = setInterval(load, 5000);
  await load();
}

function renderLive(live) {
  const el = $("#tab-body");
  if (!el) return;
  if (live.error) { el.innerHTML = `<div class="card empty"><p class="error">${esc(live.error)}</p></div>`; return; }
  if (!live.in_game) { el.innerHTML = `<div class="card empty"><h2>Not in a game anymore</h2><p>The game has ended — refresh to include it.</p></div>`; return; }
  const team = (id) => live.players.filter((p) => p.team === id);
  const bans = (id) => live.bans.filter((b) => b.team === id).map((b) => icon(b.champion_id)).join("");
  const rankText = (p) => p.tier === "UNRANKED" ? `<span class="muted">Unranked</span>` : `${title(p.tier)} ${p.division} <span class="muted small">${p.lp} LP</span>`;
  const side = (id, name) => `<div class="card live-team ${id === 100 ? "blue" : "red"}">
    <div class="card-head"><h2>${name}</h2><div class="bans" title="Bans">${bans(id)}</div></div>
    <table><thead><tr><th>Player</th><th>Rank</th><th class="num">Mastery</th><th class="num">Form · last ${live.form_games}</th><th class="num">On this champ</th></tr></thead>
    <tbody>${team(id).map((p) => p.hidden
      ? `<tr><td>${champCell(p.champion_id, "Hidden player")}</td><td colspan="4" class="muted small">Hides their identity in live games</td></tr>`
      : `<tr class="${p.is_me ? "me" : ""}">
      <td>${champCell(p.champion_id, esc(p.riot_id))}</td>
      <td>${rankText(p)}</td>
      <td class="num">${p.mastery_points == null ? "–" : `${kpts(p.mastery_points)} <span class="muted small">M${p.mastery_level}</span>`}</td>
      <td class="num" title="${esc(wrTip(p.form))}">${p.loading && !p.form.games ? `<span class="muted">loading…</span>` : p.cached_games ? wrText(p.form) : `<span class="muted">not loaded</span>`}</td>
      <td class="num" title="${esc(wrTip(p.on_champ))}">${p.on_champ.games ? wrText(p.on_champ)
        : p.loading ? `<span class="muted">loading…</span>` : p.cached_games ? `<span class="muted">none in ${p.cached_games}</span>` : "–"}</td></tr>`).join("")}</tbody></table>
  </div>`;
  el.innerHTML = `<div class="callout"><b>${esc(live.queue)}</b>${live.started ? ` · ${Math.round((Date.now() - live.started) / 60000)} min in` : " · loading in"}.
      Form and champion records come from each player's cached ranked solo games${live.pending ? ` — <b>still fetching for ${live.pending} player${live.pending > 1 ? "s" : ""}</b>, this updates by itself` : ""}.
      ${live.without_history && !live.pending ? `<button class="btn ghost" id="live-form">Load recent form for ${live.without_history} player${live.without_history > 1 ? "s" : ""}</button>
        <span class="muted small">≈${live.without_history * (live.form_games + 1)} API requests</span>` : ""}</div>
    ${side(100, "Blue side")}${side(200, "Red side")}`;
  $("#live-form")?.addEventListener("click", () => { view.player.liveForm = true; tabLive(); });
  prepareTables(el);
}

// ---------------------------------------------------------------- boot
function renderUser() {
  $("#user").hidden = false;
  $("#username").textContent = ME.username;
  const mine = $("#my-profile");
  mine.hidden = !ME.account;
  if (ME.account) mine.href = myHash();
}

async function start() {
  try {
    ME = await api("/api/me");
    META = await api("/api/meta");
    renderUser();
    // a fresh visit with a linked account goes straight to it; "#/" still shows the patch page
    if (!location.hash && ME.account) location.hash = myHash();
    else route();
  } catch {
    // api() already showed the login view on 401
  }
}

$("#logout").addEventListener("click", async () => {
  await postJSON("/api/logout", {});
  showLogin();
});
window.addEventListener("hashchange", () => ME && META && route());
start();
