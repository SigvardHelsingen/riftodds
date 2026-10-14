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
const mmss = (secs) => { const s = Math.round(secs); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
// the IANA zone lets the server bucket each game by the local time it was played (daylight saving included)
const tzQuery = () => `tz=${new Date().getTimezoneOffset()}&tzname=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || "")}`;
const ordinal = (n) => `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n] || "th"}`;

const ROLE_NAMES = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support", UNKNOWN: "Unknown" };

let META = null;
const view = { landing: { tier: "", sort: "wr", role: "", query: "", all: false, builds: new Set() }, player: { tab: "champions", role: null, queue: "420" },
  admin: { days: 30, user: "" } };
let PATCH = null;
let DATA = null;
let pollTimer = null;
let ME = null; // { username, account }
let nav = 0;    // bumped on every route; async renders bail out if it changed

const playerHash = (platform, riotId, range) => `#/p/${platform}/${encodeURIComponent(riotId)}/${range}`;
const myHash = () => ME?.account && playerHash(ME.account.platform, `${ME.account.game_name}#${ME.account.tag_line}`, view.player.range || META.default_range);

async function api(path, opts, current) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/login") {
    if (!current || current()) showLogin(); // session expired or user removed; obsolete requests must not change routes
    throw new Error("Not logged in");
  }
  if (!r.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map((error) => error.msg).join("; ") : body.detail;
    throw new Error(detail || `HTTP ${r.status}`);
  }
  return body;
}

const postJSON = (path, data, current) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }, current);

// ---------------------------------------------------------------- login
function showLogin() {
  nav++;
  randomBuildResult = null;
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
    <button class="btn" aria-label="Analyze player">${cls === "compact" ? "Go" : "Analyze"}</button></form>`;
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
  } else if (location.hash === "#/odds") {
    showOdds();
  } else if (location.hash === "#/admin") {
    showAdmin();
  } else {
    showLanding();
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- landing
async function showLanding() {
  $("#app").innerHTML = `
    <section class="hero">
      <div class="hero-top"><span class="stamp" id="hero-stamp">Ranked solo</span><span>Ranked solo queue · probabilities, not tier lists · <a href="#/odds">How the odds work</a></span></div>
      <h1>What are<br>the <em>odds?</em></h1>
      <div class="side">
        <p class="lede">Look up a player to see how they pick, tilt and win. Or read the board below: what decides games on this patch.</p>
        ${ME?.account ? `<a class="btn mine" href="${myHash()}">Open my profile · ${esc(ME.account.game_name)}#${esc(ME.account.tag_line)}</a>` : ""}
      </div>
      ${searchForm("big")}
    </section>
    ${randomBuildCard()}
    <div id="patch-body"><div class="loading"><div class="spinner"></div>Loading patch stats…</div></div>`;
  bindSearch($(".search.big"));
  $("#random-roll").addEventListener("click", rollRandomBuild);
  const token = nav;
  await loadPatch();
  if (token === nav) pollTimer = setInterval(loadPatch, 30000);
}

let randomBuildResult = null;
let randomBuildRequest = 0;
const DICE = `<svg class="random-dice" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
  <rect x="6" y="6" width="28" height="28" rx="6" transform="rotate(-8 20 20)"/>
  <circle cx="13" cy="13" r="2"/><circle cx="26" cy="12" r="2"/><circle cx="20" cy="20" r="2"/>
  <circle cx="14" cy="28" r="2"/><circle cx="27" cy="27" r="2"/></svg>`;

function randomBuildHtml(result) {
  return `<div class="random-champion"><img src="${esc(result.champion.icon)}" alt="${esc(result.champion.name)} portrait" width="80" height="80">
      <div><span class="random-label">Your champion</span><h3>${esc(result.champion.name)}</h3>
        <span class="random-lane">${ROLE_NAMES[result.role]}</span><span class="muted small">Now that's a plan. Sort of.</span></div></div>
    <ul class="random-items" aria-label="Six random items, not build order">${result.items.map((item) => `<li>
      <img src="${esc(item.icon)}" alt="" width="40" height="40"><span>${esc(item.name)}${item.boots ? `<small>Boots</small>` : ""}</span>
    </li>`).join("")}</ul>`;
}

function randomBuildCard() {
  return `<section class="random-build" id="random-build" aria-labelledby="random-title" aria-busy="false">
    <div class="random-head"><div><span class="random-label">Just for fun</span><h2 id="random-title">Let the dice pick.</h2>
      <p>Random champion. Random lane. Six random items. Zero promises.</p></div>
      <button type="button" class="btn random-roll" id="random-roll">${DICE}<span>${randomBuildResult ? "Reroll" : "Roll champion + build"}</span></button></div>
    <div class="random-result" id="random-result" role="region" aria-label="Your random champion, lane and items" ${randomBuildResult ? "" : "hidden"}>${randomBuildResult ? randomBuildHtml(randomBuildResult) : ""}</div>
    <p class="random-status small" id="random-status" role="status" aria-live="polite" aria-atomic="true">${randomBuildResult ? "Your last roll. Feeling lucky again?" : ""}</p>
  </section>`;
}

async function rollRandomBuild() {
  const card = $("#random-build");
  if (!card || !ME) return;
  const button = $("#random-roll", card);
  if (button.disabled) return;
  const token = nav;
  const request = ++randomBuildRequest;
  const current = () => token === nav && request === randomBuildRequest && ME && card === $("#random-build");
  const status = $("#random-status", card);
  const label = $("span", button);
  button.disabled = true;
  label.textContent = "Rolling…";
  card.setAttribute("aria-busy", "true");
  card.classList.add("is-rolling");
  status.classList.remove("error");
  status.textContent = "Rolling a champion and six items…";
  const pause = reducedMotion() ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 400));
  try {
    const result = await postJSON("/api/random-build", {}, current);
    await pause;
    if (!current()) return;
    randomBuildResult = result;
    const output = $("#random-result", card);
    output.innerHTML = randomBuildHtml(result);
    output.hidden = false;
    output.classList.remove("is-revealing");
    void output.offsetWidth;
    output.classList.add("is-revealing");
    status.textContent = `Rolled ${ROLE_NAMES[result.role]} ${result.champion.name} and six random items. Want another?`;
  } catch (error) {
    await pause;
    if (!current()) return;
    status.classList.add("error");
    status.textContent = `Couldn't roll just now. ${error.message}${randomBuildResult ? " Your last roll is still here." : " Try again in a moment."}`;
  } finally {
    if (current()) {
      button.disabled = false;
      label.textContent = randomBuildResult ? "Reroll" : "Roll champion + build";
      card.setAttribute("aria-busy", "false");
      card.classList.remove("is-rolling");
    }
  }
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

  const presence = [...P.champions].sort((a, b) => b.pick_rate + b.ban_rate - (a.pick_rate + a.ban_rate)).slice(0, 6);
  // the 30 s refresh redraws everything: keep someone typing in the champion search where they were
  const search = $("#champ-search");
  const typing = search && search === document.activeElement ? [search.selectionStart, search.selectionEnd] : null;

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
        <p>${L.sort === "wr" ? `Champions with fewer than ${champMinGames(P)} games are hidden when sorting by win rate, unless you search for them.`
          : `${P.champions.filter((c) => !L.role || c.role === L.role).length} champions.`}
        Select a champion to see its most successful build.</p></div>
        <div class="chips" id="sort-chips">${[["wr", "Win rate"], ["pick", "Pick rate"], ["ban", "Ban rate"]].map(([v, l]) => `<button class="chip ${L.sort === v ? "active" : ""}" data-v="${v}">${l}</button>`).join("")}</div>
      </div>
      <div class="champ-filters">
        <div class="chips" id="role-chips">${[["", "All roles"], ...META.roles.map((r) => [r, ROLE_NAMES[r]])].map(([v, l]) => `<button class="chip ${L.role === v ? "active" : ""}" data-v="${v}">${l}</button>`).join("")}</div>
        <input type="search" id="champ-search" placeholder="Search champions" aria-label="Search champions" aria-controls="champ-table"
          autocomplete="off" spellcheck="false" value="${esc(L.query)}">
        <p class="sr-only" id="champ-found" role="status" aria-live="polite"></p>
      </div>
      ${WR_LEGEND()}
      <div id="champ-table"></div>
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
  $("#champ-search").addEventListener("input", (e) => { L.query = e.target.value; renderChampTable(); });
  renderChampTable();
  prepareTables($("#patch-body"));
  if (typing) {
    $("#champ-search").focus();
    $("#champ-search").setSelectionRange(...typing);
  }
}

const champMinGames = (P) => Math.max(10, Math.round(P.matches * 0.01));
const searchKey = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");  // "kaisa" finds Kai'Sa, "nunu" Nunu & Willump

// the landing champion table, redrawn on its own so typing in the search box keeps focus
function renderChampTable() {
  const el = $("#champ-table");
  if (!el) return;
  const P = PATCH;
  const L = view.landing;
  const focused = document.activeElement?.closest("#champ-table .champ-btn")?.dataset.build;
  const minGames = champMinGames(P);
  const rows = P.champions.filter((c) => !L.role || c.role === L.role);
  const sorters = { wr: (c) => c.wr, pick: (c) => c.pick_rate, ban: (c) => c.ban_rate };
  rows.sort((a, b) => sorters[L.sort](b) - sorters[L.sort](a));
  const ranked = L.sort === "wr" ? rows.filter((c) => c.games >= minGames) : rows;
  const rank = new Map(ranked.map((c, i) => [c.champion_id, i + 1]));
  const query = searchKey(L.query);
  // a search finds every champion with games, including those too thinly sampled to rank by win rate
  const found = query ? rows.filter((c) => searchKey(champ(c.champion_id).name).includes(query)) : ranked;
  const shown = query || L.all ? found : found.slice(0, 15);
  const maxPick = Math.max(...P.champions.map((c) => c.pick_rate), 0.01);
  const maxBan = Math.max(...P.champions.map((c) => c.ban_rate), 0.01);
  const where = L.role ? ` in ${ROLE_NAMES[L.role]}` : "";
  const empty = query ? `No champion matching “${esc(L.query.trim())}” has games${where} on this patch yet.`
    : L.sort === "wr" ? `No champion has ${minGames}+ games yet — sort by pick rate, or check back as the sampler collects more.` : "No games yet.";
  el.innerHTML = `<table>
      <thead><tr><th></th><th>Champion</th><th>Win rate</th><th class="num"></th><th>Pick rate</th><th>Ban rate</th><th class="num">Games</th></tr></thead>
      <tbody>${shown.map((c) => {
        const sub = c.role ? `${ROLE_NAMES[c.role]}${c.role_share < 0.9 ? ` · ${pct(c.role_share)}` : ""}` : "";
        const open = !!c.role && L.builds.has(c.champion_id);
        return `<tr class="${open ? "open" : ""}"><td class="rank" ${rank.has(c.champion_id) ? "" : `title="Fewer than ${minGames} games: not ranked by win rate"`}>${rank.get(c.champion_id) ?? "–"}</td>
        <td>${c.role ? buildToggle(c.champion_id, open, sub) : champCell(c.champion_id, sub)}</td>
        <td style="width:24%">${wrBar(c)}</td><td class="num" title="${esc(wrTip(c))}">${pct(c.wr, 1)}</td>
        <td style="width:15%">${barCell(c.pick_rate / maxPick, pct(c.pick_rate, 1))}</td>
        <td style="width:15%">${barCell(c.ban_rate / maxBan, pct(c.ban_rate, 1))}</td>
        <td class="num muted">${c.games}</td></tr>
        ${open ? buildRow(c.champion_id, c.role, 7) : ""}`;
      }).join("") || `<tr><td colspan="7" class="empty">${empty}</td></tr>`}</tbody>
    </table>
    ${!query && ranked.length > 15 ? `<div class="table-foot"><button class="btn ghost" id="show-all">${L.all ? "Show top 15" : `Show all ${ranked.length}`}</button></div>` : ""}`;
  $("#champ-found").textContent = query ? `${found.length} champion${found.length === 1 ? "" : "s"} found` : "";
  $("#show-all", el)?.addEventListener("click", () => { L.all = !L.all; renderChampTable(); });
  $$(".champ-btn", el).forEach((b) => b.addEventListener("click", () => {
    const id = +b.dataset.build;
    L.builds.has(id) ? L.builds.delete(id) : L.builds.add(id);
    renderChampTable();
  }));
  $$("[data-build-slot]", el).forEach(loadBuildSlot);
  prepareTables(el);
  if (focused) $(`#champ-table .champ-btn[data-build="${focused}"]`)?.focus();
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
  view.player.mh = null;  // loaded match-history rows: { key, rows, next, total, error }
  view.player.trendGame = null;  // match_id of the game open beside the form chart
  view.player.picks = null;      // suggested picks for this player/range: { key, data }
  view.player.open = new Set();
  view.player.builds = new Set();  // champions whose build is folded out in the Draft tab
  const [name] = riotId.split("#");
  const label = META.ranges.find((r) => r.key === range)?.label.toLowerCase() || "recent games";
  $("#app").innerHTML = `<div class="loading"><div class="spinner"></div>
    Looking up ${esc(name)} (${esc(label)}) — the newest games show in a few seconds, the rest fill in.</div>`;
  const token = nav;
  try {
    const data = await api(`/api/player?platform=${platform}&riot_id=${encodeURIComponent(riotId)}&range=${range}&${tzQuery()}`);
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
  const data = await api(`/api/player?platform=${p.platform}&riot_id=${encodeURIComponent(`${p.name}#${p.tag}`)}&range=${view.player.range}&${tzQuery()}`).catch(() => null);
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
  const data = await api(`/api/player/${DATA.puuid}/analysis?range=${view.player.range}&${tzQuery()}`);
  if (token !== nav) return;
  DATA = { ...data, live: DATA.live };  // the live flag only comes with the full lookup
  view.player.picks = null;
  renderPlayer({ preserveTab: true });
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
    : `Stats below cover ${DATA.games_analyzed} game${DATA.games_analyzed === 1 ? "" : "s"} so far`;
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

function renderPlayer({ preserveTab = false } = {}) {
  const savedTab = preserveTab ? $("#tab-body") : null;
  const savedKind = $(".tabs .active")?.dataset.tab;
  const focused = savedTab?.contains(document.activeElement) ? document.activeElement : null;
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
        ${DATA.first_game ? `<div class="coverage">Analyzing <b>${DATA.games_analyzed}</b> games · ${day(DATA.first_game)} – ${day(DATA.last_game)}${
          DATA.overview ? ` · <b>${ROLE_NAMES[DATA.overview.roles[0].role] || ""}</b> main, plays like ${DATA.overview.roles[0].pool.effective_pool.toFixed(1)} champions` : ""}</div>` : ""}
      </div>
      <div class="actions">
        ${isMe ? `<span class="me-tag" title="Linked to your login">Your account</span><button class="btn ghost" id="unlink">Unlink</button>`
               : `<button class="btn ghost" id="link">This is me</button>`}
        <select id="range" aria-label="Game range" title="Which ranked solo games to analyze">
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

  const o = DATA.overview;
  let summary;
  if (!o) {
    summary = `<section class="card section trend" id="trend" aria-label="Form over time"></section>`
      + (DATA.sync?.running
        ? `<div class="loading"><div class="spinner"></div>Waiting for the first ranked solo games to arrive…</div>`
        : `<div class="card empty section"><h2>No ranked solo games in this range</h2><p>Try a longer range, or browse other match types below.</p></div>`);
  } else {
    const m = o.momentum;
    const cb = DATA.leads.comeback;
    const tilt = m.after_win.games && m.after_loss.games ? m.after_win.wr - m.after_loss.wr : null;
    const best = DATA.vs_rank.rows.filter((r) => r.p_better != null && r.player.games >= 3).sort((a, b) => b.p_better - a.p_better)[0];
    summary = `
    <div class="tiles">
      ${tile(`Win rate · ${o.record.games} games`, pct(o.record.wr), `90% likely true win rate ${pct(o.record.lo)}–${pct(o.record.hi)}`, "indigo")}
      ${cb.you.games ? tile("Comeback rate", pct(cb.you.wr), `wins when 1k+ gold behind at 15 (${cb.you.games} games)${rankRate(cb.rank, title(p.tier))}`, "peach")
                     : tile("Comeback rate", "–", DATA.sync?.running ? "Timelines are still being fetched" : "No games 1k+ behind at 15", "peach")}
      ${tile("Tilt swing", pts(tilt), tilt == null ? "Not enough back-to-back games" : `win rate after a win vs after a loss`, "plum")}
      ${best ? tile(`Best vs ${p.tier === "UNRANKED" ? "rank" : title(p.tier)}`, `${icon(best.champion_id)}<span class="sm">${esc(champ(best.champion_id).name)}</span>`,
        `${pts(best.delta)} vs rank · ${pct(best.p_better)} sure you're better`) : tile("Best vs rank", "–", "Not enough data yet")}
    </div>
    ${DATA.series?.length ? `<section class="card section trend" id="trend" aria-label="Form over time"></section>` : ""}`;
  }
  const tabs = [...(DATA.live ? [["live", "Live game"]] : []),
    ...(o ? [["champions", "Champions"], ["picks", "Suggested picks"]] : []), ["matches", "Matches"],
    ...(o ? [["draft", "Draft"], ["habits", "Coaching & habits"], ["wincons", "Win conditions"]] : [])];
  if (!tabs.some(([tab]) => tab === view.player.tab)) view.player.tab = o ? "champions" : "matches";
  $("#player-body").innerHTML = `${summary}
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
  renderTrend();
  if (savedTab && savedKind === view.player.tab && ["draft", "habits", "live"].includes(savedKind)
        && (savedKind !== "draft" || DATA.overview.roles.some((r) => r.role !== "UNKNOWN"))) {
    $("#tab-body").replaceWith(savedTab);
    focused?.focus({ preventScroll: true });
    if (view.player.tab === "habits") {
      renderHabitTables();
      loadCoaching($("#coaching-insights"));
    }
    if (view.player.tab === "draft") {
      const changedRole = renderDraftRoles();
      $("#draft-pockets").innerHTML = draftPocketsHtml();
      changedRole ? fillOpponents() : updatePick();
      loadDraftInsights($("#draft-insights"));
    }
  } else renderTab();
}

function renderTab() {
  clearInterval(livePoll);
  if (view.player.tab !== "matches") {
    matchesRequest++;
    if (view.player.mh) view.player.mh.busy = null;
  }
  ({ live: tabLive, champions: tabChampions, picks: tabPicks, matches: tabMatches, draft: tabDraft, habits: tabHabits, wincons: tabWincons })[view.player.tab]();
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
const kpts = (n) => (n >= 999.5e3 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

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
    <div class="roles" id="draft-roles"></div>
    <div class="card">
      <div class="card-head"><div><h2>Pick predictor</h2><p id="pick-role-description"></p></div></div>
      <div class="controls">
        <label for="pick-opp">Lane opponent</label><select id="pick-opp"><option value="">Any opponent</option></select>
        <label for="pick-alpha" title="How strongly to lean on the overall role picks when there are few games vs this opponent">Smoothing <span style="text-transform:none">α</span></label>
        <input id="pick-alpha" type="number" min="0" max="50" step="1" value="${view.player.alpha ?? 5}">
      </div>
      <div id="pick-out"><div class="loading"><div class="spinner"></div></div></div>
    </div>
    <div id="draft-insights" class="section"></div>
    <div id="draft-pockets">${draftPocketsHtml()}</div>`;
  renderDraftRoles();
  $("#pick-opp").addEventListener("change", (e) => {
      view.player.opp = e.target.value;
      updatePick();
      loadDraftInsights($("#draft-insights"));
    });
  $("#pick-alpha").addEventListener("change", (e) => { view.player.alpha = e.target.value; updatePick(); });
  fillOpponents();
  loadDraftInsights($("#draft-insights"));
}

function renderDraftRoles() {
  const el = $("#draft-roles");
  if (!el) return false;
  const roles = DATA.overview.roles.filter((r) => r.role !== "UNKNOWN");
  const focusedRole = document.activeElement?.closest("#draft-roles .role-card")?.dataset.role;
  const changed = !roles.some((r) => r.role === view.player.role);
  if (changed) {
    view.player.role = roles[0]?.role;
    view.player.opp = "";
    view.player.builds.clear();
    $("#pick-opp").value = "";
  }
  el.innerHTML = roles.map((r) => `<button class="role-card ${r.role === view.player.role ? "active" : ""}" data-role="${r.role}" aria-pressed="${r.role === view.player.role}">
    <div class="top"><span class="rname">${ROLE_NAMES[r.role]}</span><span class="share">${pct(r.share)}</span></div>
    <div class="meta">${r.games} games · ${pct(r.wr)} WR · plays like ${r.pool.effective_pool.toFixed(1)} champs</div>
    <div class="icons">${r.pool.top.map((t) => icon(t.champion_id)).join("")}</div></button>`).join("");
  $("#pick-role-description").textContent = `What will they pick in ${ROLE_NAMES[view.player.role]}? Choose a lane opponent to condition on the matchup. Select a champion to see its most successful build.`;
  $$(".role-card", el).forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.role === view.player.role) return;
    view.player.role = b.dataset.role;
    view.player.opp = "";
    view.player.builds.clear();
    $("#pick-opp").value = "";
    renderDraftRoles();
    fillOpponents();
    loadDraftInsights($("#draft-insights"));
  }));
  if (focusedRole) $(`[data-role="${focusedRole}"]`, el)?.focus({ preventScroll: true });
  return changed;
}

function draftPocketsHtml() {
  return DATA.mastery.pockets.length ? `<div class="card section">
    <div class="card-head"><div><h2>Pocket picks</h2><p>High mastery, but not played in this range. Not in the predictor above — but they know these.</p></div></div>
    <div class="pockets">${DATA.mastery.pockets.map((m) => `<div class="pocket">${icon(m.champion_id)}<div><b>${esc(champ(m.champion_id).name)}</b>
      <div class="muted small">${kpts(m.points)} pts · M${m.level} · last played ${day(m.last_play)}</div></div></div>`).join("")}</div>
    </div>` : "";
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
  const focused = document.activeElement?.closest("#pick-out .champ-btn")?.dataset.build;  // kept across re-renders
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
    ${res.rows.map((r) => {
      const open = view.player.builds.has(r.champion_id);
      return `<tr class="${open ? "open" : ""}"><td>${buildToggle(r.champion_id, open)}</td>
      <td style="width:50%" title="${pct(p(r), 1)}${hasOpp ? ` · usual ${pct(r.p_role, 1)}` : ""}">${barCell(p(r), pct(p(r), 1), { tick: hasOpp ? r.p_role : null, thick: true })}</td>
      <td class="num">${hasOpp ? `${r.games_vs} <span class="muted small">/ ${r.games}</span>` : r.games}</td>
      <td class="num" title="${esc(wrTip(hasOpp ? r.wr_vs : r.wr))}">${wrText(hasOpp ? r.wr_vs : r.wr)}</td></tr>
      ${open ? buildRow(r.champion_id, res.role, 4, META.tiers.includes(DATA.profile.tier) ? DATA.profile.tier : "") : ""}`;
    }).join("")}</tbody></table>`;
  $$("#pick-out .champ-btn").forEach((b) => b.addEventListener("click", () => {
    const id = +b.dataset.build;
    view.player.builds.has(id) ? view.player.builds.delete(id) : view.player.builds.add(id);
    renderPick(res);
  }));
  $$("#pick-out [data-build-slot]").forEach(loadBuildSlot);
  prepareTables($("#pick-out"));
  if (focused) $(`#pick-out .champ-btn[data-build="${focused}"]`)?.focus();
}

function wrTable(head, rows) {
  return `<table><thead><tr><th>${head}</th><th>Win rate</th><th class="num"></th></tr></thead><tbody>
    ${rows.map(([label, w]) => `<tr><td>${label}</td><td style="width:50%">${wrBar(w)}</td><td class="num" title="${esc(wrTip(w))}">${wrText(w)}</td></tr>`).join("")}</tbody></table>`;
}

function tabHabits() {
  $("#tab-body").innerHTML = `<div id="coaching-insights"></div>
    <details class="insight-details section"><summary>Session habits and win-rate patterns</summary><div class="insight-detail-body" id="habit-tables"></div></details>`;
  renderHabitTables();
  loadCoaching($("#coaching-insights"));
}

function renderHabitTables() {
  const o = DATA.overview;
  const m = o.momentum;
  const card = (h, sub, body) => `<div class="card"><div class="card-head"><div><h2>${h}</h2><p>${sub}</p></div></div>${body}</div>`;
  $("#habit-tables").innerHTML = `${WR_LEGEND()}
    <div class="grid-2">
      ${card("After the last game", "Next-game win rate within a session (games under 30 min apart).",
        wrTable("Previous game", [["After a win", m.after_win], ["After a loss", m.after_loss], ["After 2 losses in a row", m.after_2_losses]]) +
        `<p class="muted small" style="margin:12px 0 0">Switches champion after a loss <b>${pct(m.swap_after_loss.p)}</b> of the time, vs ${pct(m.swap_after_win.p)} after a win.</p>`)}
      ${card("Game in session", `${m.sessions} sessions, ${m.avg_session_len.toFixed(1)} games each on average.`,
        wrTable("Game", m.by_game_in_session.map((w) => [w.label, w])))}
      ${card("Time of day", "Your local time when the game started.", wrTable("Time", o.time_of_day.map((w) => [w.label, w])))}
      ${card("Game length", "Early finishers or late-game closers?", wrTable("Length", o.duration.map((w) => [w.label, w])))}
    </div>`;
  prepareTables($("#habit-tables"));
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

// ---------------------------------------------------------------- form chart (profile)
const ROLL = 10;  // games in the rolling average
const perMin = (key) => (g) => g[key] / (g.duration / 60);
const whole = (v) => Math.round(v).toLocaleString();
const TREND_STATS = [  // fmt formats a magnitude; `signed` stats get their sign added
  { key: "wr", label: "Win rate", value: (g) => +g.win, fmt: (v) => pct(v), unit: [0, 1], per: (g) => (g.win ? "Win" : "Loss") },
  { key: "kda", label: "KDA", value: (g) => (g.kills + g.assists) / Math.max(1, g.deaths), fmt: (v) => v.toFixed(1),
    per: (g) => `${((g.kills + g.assists) / Math.max(1, g.deaths)).toFixed(1)} · ${g.kills}/${g.deaths}/${g.assists}` },
  { key: "kp", label: "Kill participation", value: (g) => (g.team_kills ? (g.kills + g.assists) / g.team_kills : null), fmt: (v) => pct(v), unit: [0, 1] },
  { key: "cs", label: "CS / min", value: perMin("cs"), fmt: (v) => v.toFixed(1) },
  { key: "gold", label: "Gold / min", value: perMin("gold"), fmt: whole },
  { key: "damage", label: "Damage / min", value: perMin("damage"), fmt: whole },
  { key: "vision", label: "Vision / min", value: perMin("vision"), fmt: (v) => v.toFixed(2) },
  { key: "deaths", label: "Deaths", value: (g) => g.deaths, fmt: (v) => String(Math.round(v * 10) / 10), lowerIsBetter: true },
  { key: "lane", label: "Lane gold @15", value: (g) => g.lane_diff15, fmt: whole, signed: true },
];
const RANK_STAT = { key: "rank", label: "Rank" };
const CHART_STATS = [RANK_STAT, ...TREND_STATS];
// rank is the default view; players who are unranked with nothing recorded start on win rate
const trendStat = () => CHART_STATS.find((s) => s.key === view.player.trendStat)
  || (DATA.profile.tier !== "UNRANKED" || DATA.ranks?.length ? RANK_STAT : TREND_STATS[0]);
const GAMES_DESC = `Every ranked solo game in the range, oldest to newest. The line is the average of the last ${ROLL} games. Click a game to open it.`;
const RANK_DESC = "Solo queue rank over time. Riot keeps no LP history, so Rift Odds records every change it sees: on each lookup and "
  + "live game, and every 20 minutes for linked and recently viewed players. Dots along the bottom are this range's games.";
const showValue = (stat, v) => (stat.signed ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${stat.fmt(Math.abs(v))}` : stat.fmt(v));
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let trendResize = null;
let trendDrawn = "";  // the last animated puuid/range/stat: data refreshes redraw without replaying the animation

// games with a value for `stat` (oldest first), each with the average of the last ROLL of them
function trendPoints(stat) {
  const out = (DATA.series || []).map((g) => ({ g, v: stat.value(g) })).filter((p) => p.v != null && Number.isFinite(p.v));
  let sum = 0;
  out.forEach((p, i) => {
    sum += p.v - (i >= ROLL ? out[i - ROLL].v : 0);
    p.avg = sum / Math.min(i + 1, ROLL);
  });
  return out;
}

// round axis steps (1, 2, 2.5, 5 × 10^k) covering lo..hi
function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st >= raw);
  const ticks = [];
  for (let k = Math.floor(lo / step); k <= Math.ceil(hi / step); k++) ticks.push(+(k * step).toFixed(10));
  return ticks;
}

function renderTrend() {
  const el = $("#trend");
  if (!el) return;
  const stat = trendStat();
  const table = !!view.player.trendTable;
  const open = !!view.player.trendGame;
  el.innerHTML = `
    <div class="card-head"><div><h2>Form over time</h2><p id="trend-desc"></p></div>
      <button class="btn ghost" id="trend-view" aria-pressed="${table}">${table ? "Show chart" : "Show table"}</button></div>
    <div class="chips trend-stats" role="group" aria-label="Statistic">${CHART_STATS.map((st) => `<button class="chip ${st === stat ? "active" : ""}"
      data-stat="${st.key}" aria-pressed="${st === stat}">${st.label}</button>`).join("")}</div>
    <div class="trend-body ${open ? "open" : ""}" id="trend-body">
      <div class="trend-main">
        <div class="trend-figures" id="trend-figures"></div>
        <div class="trend-plot" id="trend-plot"></div>
        <div id="trend-legend"></div>
      </div>
      <aside class="trend-game" id="trend-game" aria-label="Selected game" ${open ? "" : "inert"}><div class="trend-game-inner" id="trend-game-inner"></div></aside>
    </div>`;
  $$(".trend-stats .chip", el).forEach((b) => b.addEventListener("click", () => {
    view.player.trendStat = b.dataset.stat;
    $$(".trend-stats .chip", el).forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", x === b); });
    drawTrend();
    markTrendStat();
  }));
  $("#trend-view").addEventListener("click", () => { view.player.trendTable = !table; trendDrawn = ""; renderTrend(); });
  drawTrend();
  if (open) renderTrendGame();
}

function drawTrend() {
  const plot = $("#trend-plot");
  if (!plot) return;
  const stat = trendStat();
  const table = !!view.player.trendTable;
  const key = `${DATA.puuid}|${view.player.range}|${stat.key}|${table}`;
  const animate = key !== trendDrawn && !reducedMotion();
  trendDrawn = key;
  trendResize?.disconnect();
  plot.redraw = null;
  $("#trend-desc").textContent = stat === RANK_STAT ? RANK_DESC : GAMES_DESC;
  $("#trend-legend").innerHTML = table ? "" : legend(stat === RANK_STAT
    ? [["stroke", "background:var(--mag)", "Rank"], ["", "background:var(--pos)", "Won game"], ["ring", "", "Lost game"]]
    : [["", "background:var(--pos)", "Win"], ["ring", "", "Loss"], ["stroke", "background:var(--mag)", `${ROLL}-game average`]]);
  if (stat === RANK_STAT) return drawRank(plot, animate);
  const pts = trendPoints(stat);
  trendFigures(stat, pts, animate);
  if (pts.length < 2) {
    plot.innerHTML = `<p class="muted trend-empty">${stat.key === "lane" ? "Lane gold needs game timelines — they're still being fetched or aren't available yet."
      : "Not enough games with this stat yet."}</p>`;
    return;
  }
  if (table) return trendTable(plot, stat, pts);
  plot.classList.toggle("animate", animate);
  drawTrendSvg(plot, stat, pts, animate);
  followWidth(plot, () => drawTrendSvg(plot, stat, pts, false));
}

// redraw at the plot's width: the card resizing, or the game panel sliding open beside the chart (pushing it left)
function followWidth(plot, draw) {
  plot.redraw = () => { plot.classList.remove("animate"); draw(); };
  trendResize = new ResizeObserver(() => { if ($("#trend-plot") === plot && plot.clientWidth !== +plot.dataset.w) plot.redraw(); });
  trendResize.observe(plot);
}

// ---- rank view: Riot keeps no LP history, so the server records each change it sees
const LADDER_TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const APEX = ["MASTER", "GRANDMASTER", "CHALLENGER"];
const DIVISIONS = ["IV", "III", "II", "I"];
const isRanked = (r) => LADDER_TIERS.includes(r.tier) || APEX.includes(r.tier);
// one scale for every rank: 100 per division from Iron IV up; Master and above continue on LP alone
const ladder = (r) => (APEX.includes(r.tier) ? 2800 + r.lp : LADDER_TIERS.indexOf(r.tier) * 400 + DIVISIONS.indexOf(r.division) * 100 + r.lp);
const ladderTick = (v) => (v >= 2800 ? (v === 2800 ? "Master" : `Master +${v - 2800}`)
  : `${title(LADDER_TIERS[Math.floor(v / 400)])} ${DIVISIONS[Math.floor((v % 400) / 100)]}`);
const rankName = (r) => (APEX.includes(r.tier) ? title(r.tier) : `${title(r.tier)} ${r.division}`);
const lpDiff = (d) => `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} LP`;
const stamp = (ms) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// recorded ranks in the range, plus the last one before it (the rank going into the range)
function rankPoints() {
  const all = (DATA.ranks || []).filter(isRanked).map((r) => ({ ...r, t: r.at * 1000, v: ladder(r) }));
  const from = DATA.first_game || 0;
  const before = all.filter((r) => r.t < from);
  const pts = all.filter((r) => r.t >= from);
  if (before.length) pts.unshift({ ...before.at(-1), t: from, carried: true });
  return pts;
}

function drawRank(plot, animate) {
  const pts = rankPoints();
  rankFigures(pts, animate);
  if (!pts.length) {
    plot.innerHTML = `<p class="muted trend-empty">${DATA.profile.tier === "UNRANKED" ? "Not ranked in solo queue this season, so there's no rank to chart."
      : "No rank recorded yet. Rift Odds records every change it sees from now on."}</p>`;
    return;
  }
  if (view.player.trendTable) return rankTable(plot, pts);
  plot.classList.toggle("animate", animate);
  drawRankSvg(plot, pts, animate);
  followWidth(plot, () => drawRankSvg(plot, pts, false));
}

function drawRankSvg(plot, pts, animate) {
  const W = plot.clientWidth || 640;
  const H = matchMedia("(max-width: 640px)").matches ? 210 : 250;
  const m = { l: 96, r: 14, t: 10, b: 46 };  // the bottom band holds the game dots and the dates
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const games = DATA.series || [];
  const checked = (DATA.profile.rank_checked || 0) * 1000;
  const last = pts.at(-1);
  const t0 = Math.min(pts[0].t, games[0]?.game_start ?? Infinity);
  let t1 = Math.max(last.t, checked, games.at(-1)?.game_start ?? 0);
  if (t1 <= t0) t1 = t0 + 86400000;
  const values = pts.map((p) => p.v);
  let lo = Math.floor(Math.min(...values) / 100) * 100;
  let hi = Math.floor(Math.max(...values) / 100) * 100 + 100;
  if (hi - lo < 300) { lo = Math.max(0, lo - 100); hi = Math.max(hi, lo + 300); }
  const step = hi - lo <= 600 ? 100 : hi - lo <= 2400 ? 400 : 800;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  // the rank holds from the last change to the last check
  const line = checked > last.t ? [...pts, { t: Math.min(checked, t1), v: last.v }] : pts;
  const real = pts.filter((p) => !p.carried);
  const marks = real.length ? real : pts;
  const sel = games.find((g) => g.match_id === view.player.trendGame);
  const nDates = W < 520 ? 3 : 5;
  // a few days: label weekday and time; longer: dates. Never the same label twice.
  const short = t1 - t0 < 3 * 86400000
    ? (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })
    : (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const dates = Array.from({ length: nDates }, (_, k) => t0 + ((t1 - t0) * k) / (nDates - 1))
    .filter((t, k, all) => k === 0 || short(t) !== short(all[k - 1]));
  const refocus = plot.contains(document.activeElement) ? (plot.at ?? marks.length - 1) : null;
  plot.dataset.w = W;
  plot.classList.remove("dense");
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${ticks.map((v) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text x="${m.l - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${ladderTick(v)}</text>`).join("")}
      ${sel ? `<rect class="sel-band" x="${x(sel.game_start) - 8}" y="${m.t}" width="16" height="${ih + 22}" rx="8"/>` : ""}
      ${games.filter((g) => g.game_start >= t0 && g.game_start <= t1).map((g, i, all) => `<circle class="dot ${g.win ? "win" : "loss"}"
        cx="${x(g.game_start)}" cy="${m.t + ih + 14}" r="3" style="--d:${animate ? Math.round((i / all.length) * 700) : 0}ms"/>`).join("")}
      ${dates.map((t, k) => `<text x="${x(t)}" y="${H - 6}" text-anchor="${k === 0 ? "start" : k === dates.length - 1 ? "end" : "middle"}">${short(t)}</text>`).join("")}
      <path class="avg rank-line" pathLength="1" d="${line.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}"/>
      ${real.map((p, i) => `<circle class="rank-dot" cx="${x(p.t)}" cy="${y(p.v)}" r="4" style="--d:${animate ? 300 + Math.round((i / real.length) * 700) : 0}ms"/>`).join("")}
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
      <circle class="focus-dot" r="8" visibility="hidden"/>
    </svg>
    <div class="trend-hit" tabindex="0" role="slider" aria-label="Rank over time — arrow keys move between recorded ranks"
      aria-valuemin="1" aria-valuemax="${marks.length}" style="left:${m.l}px;top:${m.t}px;width:${iw}px;height:${ih}px"></div>
    <div class="trend-tip" hidden aria-live="polite"></div>`;

  const hit = $(".trend-hit", plot);
  const tip = $(".trend-tip", plot);
  const cross = $(".cross", plot);
  const ring = $(".focus-dot", plot);
  let at = null;
  const show = (i) => {
    at = plot.at = Math.max(0, Math.min(marks.length - 1, i));
    const p = marks[at];
    const prev = pts[pts.indexOf(p) - 1];
    cross.setAttribute("x1", x(p.t)); cross.setAttribute("x2", x(p.t)); cross.setAttribute("visibility", "visible");
    ring.setAttribute("cx", x(p.t)); ring.setAttribute("cy", y(p.v)); ring.setAttribute("visibility", "visible");
    const value = document.createElement("b");
    value.textContent = `${rankName(p)} · ${p.lp} LP`;
    const change = document.createElement("div");
    change.textContent = p.carried ? "Rank going into this range" : prev ? `${lpDiff(p.v - prev.v)} since the last change` : "First recorded rank";
    const record = document.createElement("div");
    record.textContent = `Season record ${p.wins}W ${p.losses}L`;
    const when = document.createElement("div");
    when.className = "muted";
    when.textContent = p.carried ? `Recorded before ${day(p.t)}` : stamp(p.t);
    tip.replaceChildren(value, change, record, when);
    tip.hidden = false;
    const left = x(p.t) + 14;
    tip.style.left = `${left + tip.offsetWidth > W ? x(p.t) - 14 - tip.offsetWidth : left}px`;
    tip.style.top = `${m.t}px`;
    hit.setAttribute("aria-valuenow", at + 1);
    hit.setAttribute("aria-valuetext", `${value.textContent}, ${change.textContent}, ${when.textContent}`);
  };
  const hide = () => { at = plot.at = null; tip.hidden = true; cross.setAttribute("visibility", "hidden"); ring.setAttribute("visibility", "hidden"); };
  const nearest = (px) => marks.reduce((best, p, i) => (Math.abs(x(p.t) - px) < Math.abs(x(marks[best].t) - px) ? i : best), 0);
  const pick = (e) => show(nearest(e.clientX - hit.getBoundingClientRect().left + m.l));
  hit.addEventListener("pointermove", pick);
  hit.addEventListener("pointerdown", pick);
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(at ?? marks.length - 1));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (step) show((at ?? marks.length - 1) + step);
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(marks.length - 1);
    else if (e.key === "Escape") hide();
    else return;
    e.preventDefault();
  });
  if (refocus != null) { hit.focus({ preventScroll: true }); show(Math.min(refocus, marks.length - 1)); }
}

function rankFigures(pts, animate) {
  const el = $("#trend-figures");
  if (!el) return;
  const p = DATA.profile;
  const now = isRanked(p) ? { tier: p.tier, division: p.division, lp: p.lp } : pts.at(-1);
  if (!now) { el.innerHTML = ""; return; }
  const first = pts[0];
  const peak = pts.reduce((a, b) => (b.v > a.v ? b : a), first || { ...now, v: ladder(now), t: Date.now() });
  const change = first && pts.length > 1 ? ladder(now) - first.v : null;
  el.innerHTML = figure("Current rank", esc(rankName(now)), `${now.lp} LP${p.rank_checked ? ` · checked ${ago(p.rank_checked * 1000)}` : ""}`)
    + figure("Change in range", change == null ? "–" : `<span data-count="${change}">${lpDiff(change)}</span>`,
      change == null ? `recording since ${day(first?.t ?? Date.now())}` : `since ${day(first.t)}`)
    + figure("Peak in range", esc(rankName(peak)), `${peak.lp} LP · ${day(peak.t)}`);
  if (animate) $$("[data-count]", el).forEach((span) => countUp(span, +span.dataset.count, (v) => lpDiff(Math.round(v))));
}

function rankTable(plot, pts) {
  plot.classList.remove("animate");
  const rows = pts.map((p, i) => ({ ...p, change: i ? p.v - pts[i - 1].v : null })).reverse();
  plot.innerHTML = `<table class="trend-table"><thead><tr><th>When</th><th>Rank</th><th class="num">LP</th>
      <th class="num">Change</th><th class="num">Season record</th></tr></thead>
    <tbody>${rows.map((p) => `<tr><td>${p.carried ? "Start of range" : esc(stamp(p.t))}</td><td>${esc(rankName(p))}</td>
      <td class="num">${p.lp}</td><td class="num">${p.change == null ? "–" : lpDiff(p.change)}</td>
      <td class="num">${p.wins}W ${p.losses}L</td></tr>`).join("")}</tbody></table>`;
  prepareTables(plot);
}

function drawTrendSvg(plot, stat, pts, animate) {
  const W = plot.clientWidth || 640;
  const H = matchMedia("(max-width: 640px)").matches ? 210 : 250;
  const m = { l: 52, r: 12, t: 10, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = pts.length;
  const values = pts.map((p) => p.v);
  let [lo, hi] = stat.unit || [Math.min(...values), Math.max(...values)];
  if (stat.signed) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const ticks = niceTicks(lo, hi);
  [lo, hi] = [ticks[0], ticks.at(-1)];
  const x = (i) => m.l + (i / (n - 1)) * iw;
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const dense = n > 100;
  const r = dense ? 2.5 : 4;
  const ticksX = W < 520 ? 3 : 5;
  const labelsAt = [...new Set(Array.from({ length: ticksX }, (_, k) => Math.round((k * (n - 1)) / (ticksX - 1))))];
  const short = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const sel = pts.findIndex((p) => p.g.match_id === view.player.trendGame);
  const refocus = plot.contains(document.activeElement) ? (plot.at ?? n - 1) : null;  // redraws keep keyboard focus
  plot.dataset.w = W;
  plot.classList.toggle("dense", dense);
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${ticks.map((t) => `<line class="${stat.signed && t === 0 ? "zero" : "grid"}" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="ytick" x="${m.l - 8}" y="${y(t)}" text-anchor="end" dominant-baseline="middle">${showValue(stat, t)}</text>`).join("")}
      ${sel < 0 ? "" : `<rect class="sel-band" x="${x(sel) - 8}" y="${m.t}" width="16" height="${ih}" rx="8"/>`}
      ${labelsAt.map((i, k) => `<text class="xtick" x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? "start" : k === labelsAt.length - 1 ? "end" : "middle"}">${short(pts[i].g.game_start)}</text>`).join("")}
      ${pts.map((p, i) => `<circle class="dot ${p.g.win ? "win" : "loss"}" cx="${x(i)}" cy="${y(p.v)}" r="${r}" style="--d:${animate ? Math.round((i / n) * 700) : 0}ms"/>`).join("")}
      <path class="avg" pathLength="1" d="${pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join("")}"/>
      <circle class="avg-end" cx="${x(n - 1)}" cy="${y(pts[n - 1].avg)}" r="4"/>
      ${sel < 0 ? "" : `<circle class="sel-dot" cx="${x(sel)}" cy="${y(pts[sel].v)}" r="${r + 5}"/>`}
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
      <circle class="focus-dot" r="${r + 4}" visibility="hidden"/>
    </svg>
    <div class="trend-hit" tabindex="0" role="slider" aria-label="${esc(stat.label)} by game — arrow keys move between games, Enter opens one"
      aria-valuemin="1" aria-valuemax="${n}" style="left:${m.l}px;top:${m.t}px;width:${iw}px;height:${ih}px"></div>
    <div class="trend-tip" hidden aria-live="polite"></div>`;

  const hit = $(".trend-hit", plot);
  const tip = $(".trend-tip", plot);
  const cross = $(".cross", plot);
  const ring = $(".focus-dot", plot);
  let at = null;
  const show = (i) => {
    at = plot.at = Math.max(0, Math.min(n - 1, i));
    const p = pts[at];
    cross.setAttribute("x1", x(at)); cross.setAttribute("x2", x(at)); cross.setAttribute("visibility", "visible");
    ring.setAttribute("cx", x(at)); ring.setAttribute("cy", y(p.v)); ring.setAttribute("visibility", "visible");
    // labels are data: build with textContent, never innerHTML
    const value = document.createElement("b");
    value.textContent = stat.per ? stat.per(p.g) : showValue(stat, p.v);
    const avg = document.createElement("div");
    const key = document.createElement("i");
    key.className = "key";
    avg.append(key, `${Math.min(at + 1, ROLL)}-game average ${showValue(stat, p.avg)}`);
    const who = document.createElement("div");
    who.textContent = `${champ(p.g.champion_id).name} · ${p.g.win ? "Win" : "Loss"}`;
    const when = document.createElement("div");
    when.className = "muted";
    when.textContent = `Game ${at + 1} of ${n} · ${day(p.g.game_start)}`;
    tip.replaceChildren(value, avg, who, when);
    tip.hidden = false;
    const left = x(at) + 14;
    tip.style.left = `${left + tip.offsetWidth > W ? x(at) - 14 - tip.offsetWidth : left}px`;
    tip.style.top = `${m.t}px`;
    hit.setAttribute("aria-valuenow", at + 1);
    hit.setAttribute("aria-valuetext", `${value.textContent}, ${who.textContent}, ${when.textContent}`);
  };
  const hide = () => { at = plot.at = null; tip.hidden = true; cross.setAttribute("visibility", "hidden"); ring.setAttribute("visibility", "hidden"); };
  const pick = (e) => show(Math.round(((e.clientX - hit.getBoundingClientRect().left) / iw) * (n - 1)));
  hit.addEventListener("pointermove", pick);
  hit.addEventListener("pointerdown", pick);  // a tap on touch screens
  hit.addEventListener("click", (e) => { pick(e); selectTrendGame(pts[at].g.match_id); });
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(at ?? n - 1));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -ROLL, PageUp: ROLL }[e.key];
    if (step) show((at ?? n - 1) + step);
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(n - 1);
    else if (e.key === "Enter" || e.key === " ") { if (at != null) selectTrendGame(pts[at].g.match_id); }
    else if (e.key === "Escape") { hide(); if (view.player.trendGame) selectTrendGame(view.player.trendGame); }
    else return;
    e.preventDefault();
  });
  if (refocus != null) { hit.focus({ preventScroll: true }); show(Math.min(refocus, n - 1)); }
}

function trendFigures(stat, points, animate) {
  const el = $("#trend-figures");
  if (!el) return;
  if (!points.length) { el.innerHTML = ""; return; }
  const mean = (ps) => ps.reduce((a, p) => a + p.v, 0) / ps.length;
  const recent = points.slice(-ROLL);
  const avg = mean(points);
  const last = mean(recent);
  const d = last - avg;
  const better = stat.lowerIsBetter ? d < 0 : d > 0;
  const delta = Math.abs(d) < 1e-9 ? "Same as the range average"
    : `${d > 0 ? "▲" : "▼"} ${stat.unit ? pts(d).replace("+", "") : stat.fmt(Math.abs(d))} vs the range average · ${better ? "better" : "worse"}`;
  let third;
  if (stat.key === "wr") {  // a best single game means nothing for a win rate: show the current streak
    const won = !!points.at(-1).g.win;
    const streak = points.length - 1 - points.findLastIndex((p) => !!p.g.win !== won);
    third = figure("Current streak", `${streak} ${won ? (streak > 1 ? "wins" : "win") : streak > 1 ? "losses" : "loss"}`, "");
  } else {
    const best = points.reduce((b, p) => ((stat.lowerIsBetter ? p.v < b.v : p.v > b.v) ? p : b));
    third = figure("Best game", `${icon(best.g.champion_id)}<span>${showValue(stat, best.v)}</span>`,
      `${esc(champ(best.g.champion_id).name)} · ${day(best.g.game_start)}`);
  }
  el.innerHTML = figure("Range average", `<span data-count="${avg}">${showValue(stat, avg)}</span>`, `${points.length} game${points.length > 1 ? "s" : ""}`)
    + figure(`Last ${recent.length}`, `<span data-count="${last}">${showValue(stat, last)}</span>`, delta) + third;
  if (animate) $$("[data-count]", el).forEach((span) => countUp(span, +span.dataset.count, (v) => showValue(stat, v)));
}

const figure = (label, value, sub) =>
  `<div class="trend-figure"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

function countUp(el, to, format, ms = 700) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = format(to * (1 - (1 - t) ** 3));
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// the chart's table twin: every value without hovering
function trendTable(plot, stat, pts) {
  plot.classList.remove("animate");
  plot.innerHTML = `<table class="trend-table"><thead><tr><th>Date</th><th>Champion</th><th>Result</th>
      <th class="num">${esc(stat.label)}</th><th class="num">${ROLL}-game average</th></tr></thead>
    <tbody>${pts.slice().reverse().map((p) => `<tr class="${p.g.match_id === view.player.trendGame ? "me" : ""}">
      <td><button class="linkish" data-mid="${esc(p.g.match_id)}">${day(p.g.game_start)}</button></td><td>${champCell(p.g.champion_id)}</td>
      <td>${p.g.win ? "Win" : "Loss"}</td><td class="num">${esc(stat.per ? stat.per(p.g) : showValue(stat, p.v))}</td>
      <td class="num">${showValue(stat, p.avg)}</td></tr>`).join("")}</tbody></table>`;
  prepareTables(plot);
  $$("[data-mid]", plot).forEach((b) => b.addEventListener("click", () => {
    selectTrendGame(b.dataset.mid);
    $$("tr", plot).forEach((tr) => tr.classList.toggle("me", tr.contains(b) && view.player.trendGame === b.dataset.mid));
  }));
}

// ---- the game panel beside (or under) the chart
const matchCache = new Map();  // matches never change: fetch each scoreboard once
function matchDetail(mid) {
  if (!matchCache.has(mid)) matchCache.set(mid, api(`/api/match/${mid}`).catch((e) => { matchCache.delete(mid); throw e; }));
  return matchCache.get(mid);
}
const wideTrend = () => matchMedia("(min-width: 1000px)").matches;

function selectTrendGame(mid) {
  const body = $("#trend-body");
  if (!body) return;
  view.player.trendGame = mid === view.player.trendGame ? null : mid;  // the open game again closes it
  const open = !!view.player.trendGame;
  body.classList.toggle("open", open);
  $("#trend-game").inert = !open;
  if (open) renderTrendGame(true);
  $("#trend-plot").redraw?.();  // moves the selection mark (a sliding panel also redraws via the resize observer)
  if (open && !wideTrend()) {  // it folds out below the chart: bring it into view once it has opened
    setTimeout(() => $("#trend-game")?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }), 480);
  }
}

function markTrendStat() {
  const key = trendStat().key;
  $$("#trend-game [data-keys]").forEach((el) => el.classList.toggle("current", el.dataset.keys.split(" ").includes(key)));
}

async function renderTrendGame(swap = false) {
  const inner = $("#trend-game-inner");
  const mid = view.player.trendGame;
  const g = DATA.series.find((s) => s.match_id === mid);
  if (!inner || !g) return;
  const min = g.duration / 60;
  const kp = g.team_kills ? (g.kills + g.assists) / g.team_kills : null;
  const cell = (keys, label, value, sub) =>
    `<div class="tg-stat" data-keys="${keys}"><div class="label">${label}</div><b>${value}</b><span>${sub}</span></div>`;
  inner.innerHTML = `
    <button class="tg-close" id="tg-close" aria-label="Close game details">×</button>
    <div class="tg-head ${g.win ? "win" : "loss"}" data-keys="wr"><img src="${champ(g.champion_id).icon}" alt="">
      <div><div class="tg-result">${g.win ? "Victory" : "Defeat"}</div>
        <div><b>${esc(champ(g.champion_id).name)}</b>${ROLE_NAMES[g.position] ? ` · ${ROLE_NAMES[g.position]}` : ""}</div>
        <div class="muted small">${day(g.game_start)} · ${mmss(g.duration)} · ${ago(g.game_start)}</div></div></div>
    <div class="tg-stats">
      ${cell("kda deaths", "KDA", ((g.kills + g.assists) / Math.max(1, g.deaths)).toFixed(1), `${g.kills} / ${g.deaths} / ${g.assists}`)}
      ${cell("kp", "Kill part.", pct(kp), `of ${g.team_kills ?? "–"} kills`)}
      ${cell("cs", "CS", g.cs, `${(g.cs / min).toFixed(1)} / min`)}
      ${cell("gold", "Gold", kpts(g.gold), `${whole(g.gold / min)} / min`)}
      ${cell("damage", "Damage", kpts(g.damage), `${whole(g.damage / min)} / min`)}
      ${cell("vision", "Vision", g.vision, `${(g.vision / min).toFixed(2)} / min`)}
      ${cell("lane", "Lane @15", golddiff(g.lane_diff15), "vs opponent")}
      ${cell("", "Team @15", golddiff(g.team_diff15), "vs their team")}
    </div>
    <div id="tg-more"><div class="loading"><div class="spinner"></div></div></div>`;
  $("#tg-close").addEventListener("click", () => { selectTrendGame(mid); $(".trend-hit")?.focus({ preventScroll: true }); });
  markTrendStat();
  if (swap) { inner.classList.remove("swap"); void inner.offsetWidth; inner.classList.add("swap"); }  // restart the fade

  const m = await matchDetail(mid).catch((e) => ({ error: e.message }));
  const more = $("#tg-more");
  if (!more || view.player.trendGame !== mid) return;
  if (m.error) { more.innerHTML = `<p class="error small">${esc(m.error)}</p>`; return; }
  const me = m.teams.flatMap((t) => t.players).find((p) => p.puuid === DATA.puuid);
  const sides = { 100: "Blue", 200: "Red" };
  more.innerHTML = `
    ${me ? `<div class="tg-items">${(me.spells || []).map(spellIcon).join("")}${items(me.items)}</div>` : ""}
    ${m.teams.map((t) => `<div class="tg-team"><span class="tg-side">${sides[t.team_id] || "Team"} · ${t.win ? "W" : "L"}</span>
      ${t.players.map((p) => `<a href="${playerHash(m.platform, p.riot_id, view.player.range)}" class="${p.puuid === DATA.puuid ? "me" : ""}"
        title="${esc(`${p.riot_id} · ${champ(p.champion_id).name} · ${p.kills}/${p.deaths}/${p.assists}`)}"
        aria-label="${esc(`${p.riot_id}, ${champ(p.champion_id).name}, ${p.kills}/${p.deaths}/${p.assists}`)}"><img src="${champ(p.champion_id).icon}" alt=""></a>`).join("")}</div>`).join("")}
    <p class="muted small tg-foot">${[m.queue && esc(m.queue), m.patch && `Patch ${patchName(m.patch)}`].filter(Boolean).join(" · ")}</p>
    ${storySection(mid)}`;
  loadStory($(".story", more), { compact: true });
}

// ---------------------------------------------------------------- game story (from the match timeline)
const storyCache = new Map();  // bounded, short-lived: timelines and validated models can arrive later
function matchStory(mid, puuid, current) {
  const key = `${mid}|${puuid}`;
  const cached = storyCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.promise;
  const promise = api(`/api/match/${encodeURIComponent(mid)}/story?puuid=${encodeURIComponent(puuid)}`, undefined, current)
    .catch((e) => { storyCache.delete(key); return { error: e.message }; });
  storyCache.delete(key);
  storyCache.set(key, { at: Date.now(), promise });
  while (storyCache.size > 64) storyCache.delete(storyCache.keys().next().value);
  return promise;
}
const storyResize = new ResizeObserver((entries) => entries.forEach(({ target }) => {
  if (!target.isConnected) { storyResize.unobserve(target); return; }
  if (target.clientWidth !== +target.dataset.w) target.redraw?.();
}));
const clock = (t) => mmss(t);
const signedK = (n) => (n == null ? "–" : `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}k` : Math.abs(Math.round(n))}`);
const SKILL_KEYS = "QWER";
const storyPlayer = (s, pid) => s.players.find((p) => p.participant_id === pid);
const storyChamp = (s, pid) => (pid ? champ(storyPlayer(s, pid)?.champion_id).name : "a turret or minion");
// what happened in one event, in words (used by tooltips, the swing sentence and the table)
function eventText(s, e) {
  if (e.kind === "execution") return `${storyChamp(s, e.victim)} was executed`;
  if (e.kind === "kill") return `${storyChamp(s, e.killer)} killed ${storyChamp(s, e.victim)}`;
  return `${e.side === "us" ? "You" : "They"} took ${e.label.toLowerCase().startsWith("voidgrub") ? e.label.toLowerCase() : `the ${e.label.toLowerCase()}`}`;
}
function swingText(s) {
  const t = s.turning;
  if (!t) return "";
  const kills = t.events.filter((e) => e.kind === "kill");
  const ours = kills.filter((e) => e.side === "us").length;
  const parts = t.events.filter((e) => e.kind !== "kill").map((e) => eventText(s, e));
  if (kills.length) parts.push(`${kills.length === 1 ? "a kill" : `${kills.length} kills`}${kills.length > 1 ? ` (${ours}–${kills.length - ours})` : ""}`);
  const what = parts.length ? parts.join(", ") : "no tracked fights or objectives in this interval";
  return `<b>The biggest estimated swing</b> came around ${clock(t.minute * 60)} — ${esc(what)}. Estimated win chance moved from <b>${pct(t.from)}</b> to <b>${pct(t.to)}</b>. This describes the interval, not which event caused the change.`;
}

function storySection(mid) {
  return `<section class="story" data-story="${esc(mid)}" aria-label="How the game went"><div class="loading"><div class="spinner"></div></div></section>`;
}

async function loadStory(el, { compact = false } = {}) {
  const mid = el.dataset.story;
  const puuid = DATA.puuid;
  const token = nav;
  const current = () => token === nav && ME && el.isConnected && el.dataset.story === mid && DATA?.puuid === puuid;
  const s = await matchStory(mid, puuid, current);
  if (!current()) return;
  if (s.error || !s.available) {
    el.innerHTML = `<p class="${s.error ? "error" : "muted"} small">${esc(s.error || s.reason || "No game story cached yet.")}</p>
      ${s.error || s.can_fetch ? `<button class="btn ghost story-fetch">${s.error ? "Retry story" : "Load game story · 1 Riot request"}</button><p class="small" role="status" aria-live="polite"></p>` : ""}`;
    $(".story-fetch", el)?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        if (!s.error) await postJSON(`/api/match/${encodeURIComponent(mid)}/timeline`, {}, current);
        if (!current()) return;
        storyCache.delete(`${mid}|${puuid}`);
        await loadStory(el, { compact });
      } catch (error) {
        if (current()) {
          $("[role=status]", el).textContent = error.message;
          $(".story-fetch", el).disabled = false;
        }
      }
    });
    return;
  }
  const hasChance = s.minutes.some((m) => m.chance != null);
  const me = s.me ? storyPlayer(s, s.me) : null;
  el.innerHTML = `
    <div class="story-head"><b>${hasChance ? "Your win chance, minute by minute" : "Your team's gold lead, minute by minute"}</b>
      <button class="btn ghost story-toggle" aria-pressed="false">Show table</button></div>
    ${hasChance && s.turning ? `<p class="story-swing">${swingText(s)}</p>` : ""}
    ${hasChance ? "" : `<p class="muted small story-note">${esc(s.odds_reason || "Win chances appear only after a model passes its held-out evaluation.")} <a href="#/odds">How the odds work</a></p>`}
    <div class="story-grid ${compact ? "compact" : ""}">
      <div><div class="story-plot"></div>${compact ? "" : `<p class="muted small">Events: dots are kills, diamonds are objectives, triangles are buildings. Rows show which team took them; grey dots are executions.</p>`}</div>
      ${me && !compact ? `<figure class="story-map"><div class="map-box"></div>
        <figcaption>${legend([["", "background:var(--pos)", "Your kills"], ["ring", "", "Your deaths"]])}<span class="muted small">Your base is bottom-left.</span></figcaption></figure>` : ""}
    </div>
    ${me && !compact ? storyBuild(s, me) : ""}
    ${hasChance ? `<p class="muted small story-note">Retrospective estimates, not predictions recorded during this game. No causal attribution or betting use. <a href="#/odds">Held-out accuracy and reliability</a></p>` : ""}`;
  const plot = $(".story-plot", el);
  drawStory(plot, s, compact);
  plot.redraw = () => drawStory(plot, s, compact);
  storyResize.observe(plot);
  if (me && !compact) {
    const flip = (p) => (s.team === 200 ? { ...p, x: 15000 - p.x, y: 15000 - p.y } : p);
    $(".map-box", el).innerHTML = mapSvg([
      ...(s.kills || []).map((e) => ({ ...flip(e), kind: "kill", tip: `${clock(e.t)} · you killed ${storyChamp(s, e.victim)}` })),
      ...(s.deaths || []).map((e) => ({ ...flip(e), kind: "death", tip: `${clock(e.t)} · killed by ${storyChamp(s, e.killer)}` })),
    ]);
  }
  $(".story-toggle", el)?.addEventListener("click", (e) => {
    const table = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", table);
    e.currentTarget.textContent = table ? "Show chart" : "Show table";
    plot.dataset.table = table ? "1" : "";
    drawStory(plot, s, compact);
  });
}

function storyBuild(s, me) {
  const skills = s.skills || "";
  const order = skills.length >= 9 ? skillLetters(skills) : "";
  const completeMaxes = [1, 2, 3].every((c) => [...skills].filter((v) => +v === c).length === 5);
  if (!s.build.length && !s.start.length && !skills) return "";
  return `<div class="story-build">
    ${s.first_shop != null ? `<div class="build-line"><span class="build-label">First shop</span><span class="small">${clock(s.first_shop)} · first later purchase, not necessarily first recall</span></div>` : ""}
    ${s.start.length ? `<div class="build-line"><span class="build-label">Start</span><span class="build-icons">${s.start.map(([, id]) => itemImg(id)).join("")}</span></div>` : ""}
    ${s.build.length ? `<div class="build-line"><span class="build-label">Build</span><span class="build-icons build-steps">${s.build.map(([t, id]) =>
      `<span class="build-step">${itemImg(id)}<small>${Math.round(t / 60)} min</small></span>`).join('<span class="build-arrow" aria-hidden="true">›</span>')}</span></div>` : ""}
    ${skills ? `<div class="build-line"><span class="build-label">Skills</span>${order ? `<span>${skillOrder(order)}<small class="muted">${completeMaxes ? "Observed max order" : "Partial ability priority"}</small></span>` : ""}
      <span class="skill-seq" title="Every ability point, in order">${[...skills].map((c) => `<span class="${c === "4" ? "ult" : ""}">${SKILL_KEYS[c - 1]}</span>`).join("")}</span></div>` : ""}
  </div>`;
}
// "QEW": the order abilities were maxed (the server does this for builds; one game's skills here)
function skillLetters(skills) {
  const points = { 1: 0, 2: 0, 3: 0 };
  const maxed = [];
  for (const c of skills) if (c in points && ++points[c] === 5) maxed.push(c);
  const rest = ["1", "2", "3"].filter((c) => !maxed.includes(c)).sort((a, b) => points[b] - points[a] || skills.indexOf(a) - skills.indexOf(b));
  return [...maxed, ...rest].map((c) => SKILL_KEYS[c - 1]).join("");
}
const skillOrder = (letters) => `<span class="skill-order" aria-label="Max order ${[...letters].join(", then ")}">${[...letters].map((l) => `<kbd>${l}</kbd>`).join('<span aria-hidden="true">›</span>')}</span>`;

function drawStory(plot, s, compact) {
  const hasChance = s.minutes.some((m) => m.chance != null);
  const value = (m) => (hasChance ? m.chance : m.gold);
  const pts = s.minutes.filter((m) => value(m) != null);
  if (plot.dataset.table) return storyTable(plot, s, hasChance);
  if (!pts.length) { plot.innerHTML = `<p class="muted small">No complete minute snapshots for this game yet.</p>`; plot.dataset.w = plot.clientWidth; return; }
  const refocus = plot.contains(document.activeElement);
  const W = plot.clientWidth || 600;
  const H = compact ? 150 : matchMedia("(max-width: 640px)").matches ? 190 : 220;
  const m = { l: compact ? 38 : 46, r: 10, t: 8, b: compact ? 44 : 58 };  // the bottom band: event rows, then minutes
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const end = Math.max(1, s.minutes.at(-1).m);
  const x = (minute) => m.l + (minute / end) * iw;
  let lo = 0, hi = 1;
  if (!hasChance) {
    const top = Math.max(1000, ...pts.map((p) => Math.abs(p.gold)));
    const t = niceTicks(-top, top);
    [lo, hi] = [t[0], t.at(-1)];
  }
  const y = (v) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const ticks = hasChance ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(lo, hi);
  const fmt = hasChance ? (v) => pct(v) : (v) => signedK(v);
  const rows = { us: m.t + ih + 13, them: m.t + ih + 26 };
  const swing = s.turning;
  const marks = s.events.map((e) => {
    const cx = x(e.t / 60);
    const cy = rows[e.side] ?? (rows.us + rows.them) / 2;
    if (e.kind === "kill" || e.kind === "execution") return `<circle class="ev ev-kill ${e.side}" cx="${cx}" cy="${cy}" r="2.5"/>`;
    if (e.kind === "building") return `<path class="ev ev-building ${e.side}" d="M${cx - 4},${cy + 3.5}L${cx},${cy - 4}L${cx + 4},${cy + 3.5}Z"/>`;
    return `<rect class="ev ev-monster ${e.side}" x="${cx - 3.5}" y="${cy - 3.5}" width="7" height="7" transform="rotate(45 ${cx} ${cy})"/>`;
  }).join("");
  const minuteTicks = niceTicks(0, end, W < 420 ? 3 : 6).filter((t) => t >= 0 && t <= end);
  plot.dataset.w = W;
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      ${swing && hasChance ? `<rect class="sel-band" x="${x(swing.minute - 1)}" y="${m.t}" width="${Math.max(4, x(swing.minute) - x(swing.minute - 1))}" height="${ih}"/>` : ""}
      ${ticks.map((v) => `<line class="${v === (hasChance ? 0.5 : 0) ? "zero" : "grid"}" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text x="${m.l - 6}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${fmt(v)}</text>`).join("")}
      <text x="${m.l - 6}" y="${rows.us}" text-anchor="end" dominant-baseline="middle">You</text>
      <text x="${m.l - 6}" y="${rows.them}" text-anchor="end" dominant-baseline="middle">Them</text>
      ${marks}
      ${minuteTicks.map((t) => `<text x="${x(t)}" y="${H - 4}" text-anchor="middle">${t}′</text>`).join("")}
      <path class="avg" d="${pts.map((p, i) => `${i ? "L" : "M"}${x(p.m).toFixed(1)},${y(value(p)).toFixed(1)}`).join("")}"/>
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
      <circle class="focus-dot" r="5" visibility="hidden"/>
    </svg>
    <div class="story-hit" tabindex="0" role="slider" aria-label="${hasChance ? "Win chance" : "Gold lead"} by minute — arrow keys move between minutes"
      aria-valuemin="0" aria-valuemax="${pts.length - 1}" style="left:${m.l}px;top:${m.t}px;width:${iw}px;height:${ih + 32}px"></div>
    <div class="trend-tip" hidden aria-live="polite"></div>`;
  const hit = $(".story-hit", plot);
  const tip = $(".trend-tip", plot);
  const cross = $(".cross", plot);
  const ring = $(".focus-dot", plot);
  let at = null;
  const show = (i) => {
    at = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[at];
    const prev = pts[at - 1];
    cross.setAttribute("x1", x(p.m)); cross.setAttribute("x2", x(p.m)); cross.setAttribute("visibility", "visible");
    ring.setAttribute("cx", x(p.m)); ring.setAttribute("cy", y(value(p))); ring.setAttribute("visibility", "visible");
    const head = document.createElement("b");
    head.textContent = p.final && hasChance ? (p.chance === 1 ? "Victory" : "Defeat") : hasChance ? `${pct(p.chance)} win chance` : `${signedK(p.gold)} gold`;
    const lines = [head];
    const add = (text, cls = "") => { const d = document.createElement("div"); d.textContent = text; if (cls) d.className = cls; lines.push(d); };
    if (!p.final) add(`${hasChance ? `Gold ${signedK(p.gold)} · ` : ""}kills ${p.kills[0]}–${p.kills[1]}`);
    const happened = s.events.filter((e) => e.t > (prev ? prev.m * 60 : -1) && e.t <= p.m * 60);
    happened.slice(0, 4).forEach((e) => add(`${clock(e.t)} ${eventText(s, e)}`));
    if (happened.length > 4) add(`and ${happened.length - 4} more`, "muted");
    add(clock(p.m * 60), "muted");
    tip.replaceChildren(...lines);
    tip.hidden = false;
    const left = x(p.m) + 14;
    tip.style.left = `${left + tip.offsetWidth > W ? Math.max(0, x(p.m) - 14 - tip.offsetWidth) : left}px`;
    tip.style.top = `${m.t}px`;
    hit.setAttribute("aria-valuenow", at);
    hit.setAttribute("aria-valuetext", lines.map((l) => l.textContent).join(", "));
  };
  const hide = () => { at = null; tip.hidden = true; cross.setAttribute("visibility", "hidden"); ring.setAttribute("visibility", "hidden"); };
  const nearest = (px) => pts.reduce((best, p, i) => (Math.abs(x(p.m) - px) < Math.abs(x(pts[best].m) - px) ? i : best), 0);
  const pick = (e) => show(nearest(e.clientX - hit.getBoundingClientRect().left + m.l));
  hit.addEventListener("pointermove", pick);
  hit.addEventListener("pointerdown", pick);
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(at ?? (swing ? pts.findIndex((p) => p.m === swing.minute) : pts.length - 1)));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 }[e.key];
    if (step) show((at ?? pts.length - 1) + step);
    else if (e.key === "Home") show(0);
    else if (e.key === "End") show(pts.length - 1);
    else if (e.key === "Escape") hide();
    else return;
    e.preventDefault();
  });
  if (refocus) hit.focus({ preventScroll: true });
}

// the chart's table twin: every minute without hovering
function storyTable(plot, s, hasChance) {
  plot.dataset.w = plot.clientWidth;
  const rows = s.minutes;
  plot.innerHTML = `<table class="trend-table"><thead><tr><th>Minute</th>${hasChance ? '<th class="num">Win chance</th>' : ""}
      <th class="num">Gold</th><th class="num">Kills</th><th>What happened</th></tr></thead>
    <tbody>${rows.map((m, i) => {
      const happened = s.events.filter((e) => e.t > (i ? rows[i - 1].m * 60 : -1) && e.t <= m.m * 60);
      return `<tr class="${s.turning?.minute === m.m ? "me" : ""}"><td class="num">${clock(m.m * 60)}${m.final ? " · result" : ""}</td>${hasChance ? `<td class="num">${pct(m.chance)}</td>` : ""}
        <td class="num">${signedK(m.gold)}</td><td class="num">${m.kills[0]}–${m.kills[1]}</td>
        <td class="small">${happened.map((e) => esc(eventText(s, e))).join(" · ") || '<span class="muted">–</span>'}</td></tr>`;
    }).join("")}</tbody></table>`;
  prepareTables(plot);
}

// a schematic Summoner's Rift: the player's base bottom-left; points in map units (0–15000)
function mapSvg(points, { size = 220 } = {}) {
  const k = size / 15000;
  const X = (v) => (v * k).toFixed(1);
  const Y = (v) => (size - v * k).toFixed(1);
  const lane = (pts) => `M${pts.map(([a, b]) => `${X(a)},${Y(b)}`).join("L")}`;
  return `<svg class="rift-map" viewBox="0 0 ${size} ${size}" role="img" aria-label="Map of Summoner's Rift with ${points.length} marked event${points.length === 1 ? "" : "s"}">
    <rect class="map-ground" x="0" y="0" width="${size}" height="${size}" rx="8"/>
    <path class="map-river" d="${lane([[1800, 13000], [13000, 1800]])}"/>
    <path class="map-lane" d="${lane([[1300, 4000], [1300, 13700], [11000, 13700]])}"/>
    <path class="map-lane" d="${lane([[4000, 1300], [13700, 1300], [13700, 11000]])}"/>
    <path class="map-lane" d="${lane([[3600, 3600], [11400, 11400]])}"/>
    <path class="map-base mine" d="M0,${Y(0)}L0,${Y(4600)}A${(4600 * k).toFixed(1)},${(4600 * k).toFixed(1)} 0 0 0 ${X(4600)},${Y(0)}Z"/>
    <path class="map-base theirs" d="M${size},0L${size},${(4600 * k).toFixed(1)}A${(4600 * k).toFixed(1)},${(4600 * k).toFixed(1)} 0 0 1 ${X(10400)},0Z"/>
    ${points.filter((p) => p.x != null && p.y != null).map((p) => `<g class="map-pt ${p.kind}" tabindex="0" aria-label="${esc(p.tip || "")}"><title>${esc(p.tip || "")}</title>
      <circle class="hit" cx="${X(p.x)}" cy="${Y(p.y)}" r="12"/><circle class="mark" cx="${X(p.x)}" cy="${Y(p.y)}" r="4"/></g>`).join("")}
  </svg>`;
}

// ---------------------------------------------------------------- builds & suggested picks
const itemImg = (id) => {
  const name = META.items?.[id] || `Item ${id}`;
  return `<img src="${ITEM_CDN()}${id}.png" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`;
};
const runeImg = (id) => (META.runes?.[id]
  ? `<img src="${META.runes[id].icon}" alt="${esc(META.runes[id].name)}" title="${esc(META.runes[id].name)}" loading="lazy">` : "");
const buildWr = (o) => `<span class="build-wr" title="${esc(wrTip(o))}"><b>${pct(o.wr)}</b> win rate · ${o.games} game${o.games === 1 ? "" : "s"}</span>`;
const BUILD_NOTE = "With timelines, purchase order and typical completion times are shown. Otherwise core items come from final inventories, not purchase order. Item win rates are associations, not proof an item causes wins.";

function buildHtml(b) {
  if (!b?.games) return `<p class="muted small">No build data for this champion on this patch yet.</p>`;
  const line = (label, icons, o, name = "") =>
    `<div class="build-line"><span class="build-label">${label}</span><span class="build-icons">${icons}</span>${name}${buildWr(o)}</div>`;
  const [core, ...alternatives] = b.core;
  const rune = b.runes[0];
  const order = b.order;
  const ordered = order?.core?.[0];
  const skill = order?.skills?.[0];
  return `<div class="build">
    ${ordered ? line("Buy order", ordered.items.map((id, i) => `<span class="build-step">${itemImg(id)}<small>${ordered.minutes[i] == null ? "Time unavailable" : `${ordered.minutes[i]} min`}</small></span>`).join('<span class="build-arrow" aria-hidden="true">›</span>'), ordered)
      : core ? line("Core items", core.items.map(itemImg).join(""), core) : ""}
    ${!ordered && order?.first?.[0] ? line("First item", itemImg(order.first[0].item), order.first[0], `<span class="small">Typically ${order.first[0].minute ?? "–"} min</span>`) : ""}
    ${order?.start?.[0] ? line("Start", order.start[0].items.map(itemImg).join(""), order.start[0]) : ""}
    ${order?.first_shop ? `<div class="build-line"><span class="build-label">First shop</span><span class="small">${order.first_shop.minute == null ? "Timing unavailable" : `Typically ${order.first_shop.minute} min`} · ${order.first_shop.games} timeline games. ${esc(order.first_shop.label)}</span></div>` : ""}
    ${skill ? line("Skills", skillOrder(skill.order), skill, `<span class="small">${esc(skill.label || "Partial ability priority")}${skill.first ? ` · first three: ${esc(skill.first)}` : ""}</span>`) : ""}
    ${b.boots[0] ? line("Boots", itemImg(b.boots[0].item), b.boots[0]) : ""}
    ${b.support?.[0] ? line("Support item", itemImg(b.support[0].item), b.support[0]) : ""}
    ${rune ? line("Runes", runeImg(rune.keystone) + runeImg(rune.primary) + runeImg(rune.secondary), rune,
      `<span class="build-name">${esc(META.runes?.[rune.keystone]?.name || "")}</span>`) : ""}
    ${b.spells[0] ? line("Spells", b.spells[0].spells.map(spellIcon).join(""), b.spells[0]) : ""}
    ${alternatives.map((c) => line("Alternative", c.items.map(itemImg).join(""), c)).join("")}
    ${b.situational.length ? `<div class="build-line"><span class="build-label">Also built</span><span class="build-icons">${b.situational.map((o) =>
      `<span class="build-sit" title="${esc(`${META.items?.[o.item] || ""} · ${pct(o.share)} of games · ${wrTip(o)}`)}">${itemImg(o.item)}<small>${pct(o.wr)}</small></span>`).join("")}</span></div>` : ""}
  </div>`;
}

// a champion cell that folds its build out underneath, and that fold-out row
function buildToggle(id, open, sub = "") {
  return `<button class="champ-btn" data-build="${id}" aria-expanded="${open}">${champCell(id, sub)}
    <span class="build-cue" aria-hidden="true">${open ? "▴" : "▾"} Build</span></button>`;
}
// `tier` set (even to "") = a player's tier, or every tier while it's thinly sampled; unset = the landing tier filter
function buildRow(id, role, cols, tier) {
  return `<tr class="build-row"><td colspan="${cols}"><div class="build-slot" data-build-slot="${id}" data-role="${role}"
    ${tier == null ? "" : `data-tier="${tier}"`}><div class="loading"><div class="spinner"></div></div></div></td></tr>`;
}

const buildCache = new Map();  // champion|role|tier|fallback|patch -> pending or finished build
async function loadBuildSlot(el) {
  const { buildSlot: champion, role } = el.dataset;
  const fallback = "tier" in el.dataset;
  const tier = fallback ? el.dataset.tier : view.landing.tier;
  const key = `${champion}|${role}|${tier}|${fallback}|${PATCH?.patch}`;  // PATCH is only loaded by the landing page
  if (!buildCache.has(key)) {
    buildCache.set(key, api(`/api/builds/${champion}?role=${role}${tier ? `&tier=${tier}` : ""}${fallback ? "&fallback=1" : ""}`)
      .catch((e) => { buildCache.delete(key); return { error: e.message }; }));
  }
  const b = await buildCache.get(key);
  if (!el.isConnected) return;
  el.innerHTML = b.error ? `<p class="error small">${esc(b.error)}</p>`
    : `<p class="muted small build-note">The most successful ${ROLE_NAMES[role]} build on patch ${patchName(b.patch)}${b.tier ? ` in ${title(b.tier)}` : ""},
        from ${b.games} game${b.games === 1 ? "" : "s"}. ${BUILD_NOTE}</p>${buildHtml(b)}`;
}

async function tabPicks() {
  const token = nav;
  const { puuid } = DATA;
  const key = `${puuid}|${view.player.range}`;
  if (view.player.picks?.key === key) return renderPicks(view.player.picks.data);
  $("#tab-body").innerHTML = `<div class="loading"><div class="spinner"></div>Finding the best picks for your roles…</div>`;
  const data = await api(`/api/player/${puuid}/picks?range=${view.player.range}`).catch((e) => ({ error: e.message }));
  if (token !== nav || view.player.tab !== "picks" || DATA.puuid !== puuid) return;
  if (!data.error) view.player.picks = { key, data };
  renderPicks(data);
}

function renderPicks(res) {
  const el = $("#tab-body");
  if (res.error) { el.innerHTML = `<div class="card empty"><p class="error">${esc(res.error)}</p></div>`; return; }
  if (!res.roles.length) { el.innerHTML = `<div class="card empty"><h2>No games with a known role in this range yet</h2></div>`; return; }
  const population = res.tier ? `${title(res.tier)} games` : "games from every tier";
  el.innerHTML = res.roles.map((r) => {
    const role = ROLE_NAMES[r.role];
    const average = { games: r.games, wins: Math.round(r.average * r.games), wr: r.average, lo: r.average, hi: r.average };
    return `<div class="card section">
      <div class="card-head"><div><h2>Suggested ${role} picks</h2>
        <p>${role} is ${pct(r.share)} of your games. The highest win rates for ${role} on patch ${patchName(res.patch)}, from
          ${r.games.toLocaleString()} sampled ${role} players in ${population}. Small samples are pulled towards the ${role}
          average (${pct(r.average, 1)}) before ranking. ${BUILD_NOTE}</p></div></div>
      ${r.picks.length ? `${WR_LEGEND(`${role} average`)}<div class="picks">${r.picks.map((p, i) => pickCard(p, i, role, average)).join("")}</div>`
        : `<p class="muted">Not enough sampled ${role} games on this patch yet. The background sampler adds more over time.</p>`}
    </div>`;
  }).join("");
}

function pickCard(p, i, role, average) {
  const m = DATA.mastery.by_champion[p.champion_id];
  const tags = [p.you.games ? `You: ${p.you.wins}W ${p.you.games - p.you.wins}L (${pct(p.you.wr)})` : "New to you",
    m ? `Mastery ${m.level} · ${kpts(m.points)} pts` : ""].filter(Boolean);
  return `<article class="pick-card">
    <div class="pick-head"><span class="pick-rank">${i + 1}</span>${icon(p.champion_id)}<div>
      <b>${esc(champ(p.champion_id).name)}</b>
      <div class="muted small">${pct(p.wr, 1)} win rate · ${p.games} games · ${pct(p.pick_share)} of ${role} players</div></div></div>
    ${wrBar(p, average)}
    <div class="pick-tags">${tags.map((t) => `<span>${t}</span>`).join("")}</div>
    ${buildHtml(p.build)}
  </article>`;
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

const SOLO = "420";
const MH_PAGE = 20;
const SESSION_GAP_MS = 30 * 60 * 1000;

let matchesRequest = 0;
const matchesContext = () => {
  if (!META.queues.some((type) => type.key === view.player.queue)) view.player.queue = SOLO;
  const { puuid } = DATA;
  const { range, queue } = view.player;
  return { puuid, range, queue, key: `${puuid}|${range}|${queue}` };
};
const mergeMatches = (rows, added) => {
  const seen = new Set();
  return [...rows, ...added].filter((g) => !seen.has(g.match_id) && seen.add(g.match_id))
    .sort((a, b) => b.game_start - a.game_start);
};
const matchesCurrent = (context, token, request, mh) => token === nav && request === matchesRequest
  && view.player.tab === "matches" && DATA?.puuid === context.puuid && matchesContext().key === context.key
  && view.player.mh === mh && mh.key === context.key;

// Keep the request context fixed, and keep good pages if a later page fails.
async function fetchMatches(context, offset, count, current) {
  const out = { rows: [], next: offset, total: null, error: null };
  while (out.next != null && out.next - offset < count && current()) {
    const start = out.next;
    const limit = Math.min(100, count - (start - offset));
    try {
      const res = await api(`/api/player/${context.puuid}/matches?range=${context.range}&queue=${context.queue}&offset=${start}&limit=${limit}`);
      if (!current()) break;
      out.rows.push(...res.rows);
      out.total = res.total ?? out.total;
      if (res.next != null && (!Number.isInteger(res.next) || res.next <= start)) {
        out.error = res.error || "Match history cursor did not advance. Please retry.";
        break;
      }
      out.next = res.next;
      if (res.error) {
        out.error = res.error;
        out.next = start;
        break;
      }
    } catch (e) {
      out.error = e.message;
      break;
    }
  }
  return out;
}

async function tabMatches({ force = false } = {}) {
  const context = matchesContext();
  let mh = view.player.mh;
  if (!mh || mh.key !== context.key) {
    mh = view.player.mh = { key: context.key, rows: [], next: null, total: null, error: null, loaded: false, busy: null, retry: null };
  }
  // Ranked sync can add games; other queues are refreshed explicitly.
  if (mh.busy || (mh.loaded && context.queue !== SOLO && !force)) return renderMatches();
  const token = nav;
  const request = ++matchesRequest;
  const current = () => matchesCurrent(context, token, request, mh);
  mh.busy = "load";
  renderMatches();
  const res = await fetchMatches(context, 0, Math.max(MH_PAGE, mh.rows.length), current);
  if (!current()) return;
  Object.assign(mh, { ...res, rows: mergeMatches(res.rows, res.error ? mh.rows : []), total: res.total ?? mh.total,
    loaded: true, busy: null, retry: res.error ? "load" : null });
  renderMatches();
}

async function moreMatches() {
  const context = matchesContext();
  const mh = view.player.mh;
  if (!mh || mh.key !== context.key || mh.busy || mh.next == null) return;
  const token = nav;
  const request = ++matchesRequest;
  const current = () => matchesCurrent(context, token, request, mh);
  mh.busy = "more";
  renderMatches();
  const res = await fetchMatches(context, mh.next, MH_PAGE, current);
  if (!current()) return;
  Object.assign(mh, { ...res, rows: mergeMatches(mh.rows, res.rows), total: res.total ?? mh.total,
    busy: null, retry: res.error ? "more" : null });
  renderMatches();
}

// games less than 30 min apart form a session; rows are newest first
function sessionsOf(rows) {
  const out = [];
  for (const g of rows) {
    const s = out.at(-1);
    if (s && s.start - (g.game_start + g.duration * 1000) <= SESSION_GAP_MS) s.games.push(g);
    else out.push({ games: [g] });
    out.at(-1).start = g.game_start;
  }
  return out;
}

function matchRow(g, queue) {
  const kda = g.deaths ? ((g.kills + g.assists) / g.deaths).toFixed(1) : "Perfect";
  const open = view.player.open.has(g.match_id);
  const sub = [g.queue && esc(g.queue), g.placement ? `${ordinal(g.placement)} place` : ROLE_NAMES[g.position],
    queue !== "all" && g.level && `lvl ${g.level}`].filter(Boolean).join(" · ") || "–";
  return `<button class="mh-row ${g.win ? "win" : "loss"} ${open ? "open" : ""}" data-mid="${g.match_id}" aria-expanded="${open}">
      <span class="mh-res"${g.placement ? ` style="font-size:12px" title="${ordinal(g.placement)} place"` : ""}>${g.placement ? ordinal(g.placement) : g.win ? "W" : "L"}</span>
      <span class="mh-champ">${icon(g.champion_id)}<span class="spells">${g.spells.map(spellIcon).join("")}</span>
        <span><b>${esc(champ(g.champion_id).name)}</b><small>${sub}</small></span></span>
      <span class="mh-vs">${g.opp_champ ? `<small>vs</small>${icon(g.opp_champ)}` : ""}</span>
      <span class="mh-stat mh-kda"><b>${g.kills} / ${g.deaths} / ${g.assists}</b><small>${kda}${g.deaths ? " KDA" : ""}${g.kill_participation != null ? ` · ${pct(g.kill_participation)} KP` : ""}</small></span>
      <span class="mh-stat mh-cs"><b>${g.cs} CS</b><small>${(g.cs / (g.duration / 60)).toFixed(1)} / min</small></span>
      <span class="mh-stat mh-gold" title="Gold difference at 15:00 — vs your lane opponent, and your team vs theirs"><b>${golddiff(g.lane_diff15)}</b><small>lane @15 · team ${golddiff(g.team_diff15)}</small></span>
      ${items(g.items)}
      <span class="mh-stat mh-when right"><b>${mmss(g.duration)}</b><small>${ago(g.game_start)}</small></span>
    </button>
    <div class="mh-detail" id="d-${g.match_id}" ${open ? "" : "hidden"}></div>`;
}

function renderMatches() {
  const el = $("#tab-body");
  const context = matchesContext();
  const { queue } = context;
  const types = META.queues;
  const label = types.find((t) => t.key === queue)?.label || "";
  const chips = `<div class="chips mh-queues" role="group" aria-label="Match type">${types.map((t) => `<button class="chip ${t.key === queue ? "active" : ""}"
      data-q="${t.key}" aria-pressed="${t.key === queue}">${esc(t.label)}</button>`).join("")}</div>
    <p class="muted small mh-note">${queue === SOLO ? `Ranked solo games in the selected range — the games behind the stats.`
      : "Newest games first, fetched from Riot a page at a time. The range only applies to ranked solo."}</p>`;
  const mh = view.player.mh?.key === context.key ? view.player.mh : null;
  let body = mh?.error ? `<p class="error small">${esc(mh.error)}</p>` : "";
  if (!mh || (!mh.loaded && mh.busy)) body += `<div class="loading"><div class="spinner"></div>Loading ${esc(label)} matches…</div>`;
  else if (!mh.rows.length) {
    body += `<div class="card empty"><h2>${mh.error ? "Couldn't load matches" : mh.next != null ? "No matches on this page"
      : `No ${esc(label)} games ${queue === SOLO ? "in this range " : ""}yet`}</h2></div>`;
  } else {
    body += `<div class="mh">${sessionsOf(mh.rows).map((s) => {
      const wins = s.games.filter((g) => g.win).length;
      return `<div class="mh-session">Session · ${sessionLabel(s.start)}<span>${s.games.length} game${s.games.length > 1 ? "s" : ""} · ${wins}W ${s.games.length - wins}L</span></div>
        ${s.games.map((g) => matchRow(g, queue)).join("")}`;
    }).join("")}</div>`;
  }
  if (mh) body += `<div class="table-foot">
    <button class="btn ghost" id="mh-refresh" ${mh.busy ? "disabled" : ""}>${mh.busy === "load" ? "Loading…" : "Refresh matches"}</button>
    ${mh.error ? `<button class="btn ghost" id="mh-retry" ${mh.busy ? "disabled" : ""}>Retry</button>` : ""}
    ${mh.next != null ? `<button class="btn ghost" id="mh-more" ${mh.busy ? "disabled" : ""}>${mh.busy === "more" ? "Loading…" : `Show more${mh.total != null ? ` (${mh.rows.length} of ${mh.total})` : ""}`}</button>` : ""}</div>`;
  el.innerHTML = chips + body;
  $$(".mh-queues .chip", el).forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.q === view.player.queue) return;
    view.player.queue = b.dataset.q;
    tabMatches();
  }));
  $$(".mh-row", el).forEach((b) => b.addEventListener("click", () => toggleMatch(b)));
  $("#mh-refresh")?.addEventListener("click", () => tabMatches({ force: true }));
  $("#mh-retry")?.addEventListener("click", () => mh.retry === "more" ? moreMatches() : tabMatches({ force: true }));
  $("#mh-more")?.addEventListener("click", moreMatches);
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
  const token = nav, puuid = DATA.puuid;
  const current = () => el.isConnected && nav === token && DATA?.puuid === puuid && ME;
  const m = await api(`/api/match/${mid}`, undefined, current).catch((e) => ({ error: e.message }));
  if (!current()) return;
  if (m.error) { el.innerHTML = `<p class="error">${esc(m.error)}</p>`; return; }
  el.dataset.loaded = "1";
  const maxDmg = Math.max(...m.teams.flatMap((t) => t.players.map((p) => p.damage)), 1);
  const sides = m.teams.some((t) => t.placement != null) ? {} : { 100: ["blue", "Blue side"], 200: ["red", "Red side"] };
  el.innerHTML = m.teams.map((t) => `<div class="mh-team ${sides[t.team_id]?.[0] || ""}">
    <div class="mh-team-head"><b>${t.placement ? `${ordinal(t.placement)} place` : t.win ? "Victory" : "Defeat"}</b><span>${[sides[t.team_id]?.[1], `${t.kills} kills`,
      t.towers != null && `${t.towers} towers`, t.dragons != null && `${t.dragons} dragons`, t.barons != null && `${t.barons} barons`,
      t.gold15 != null && `${kpts(t.gold15)} gold at 15`].filter(Boolean).join(" · ")}</span>
      <span class="bans" title="Bans">${t.bans.map(icon).join("")}</span></div>
    <table><thead><tr><th>Player</th><th class="num">KDA</th><th class="num">CS</th><th>Damage</th><th class="num">Gold @15</th><th>Items</th></tr></thead>
    <tbody>${t.players.map((p) => `<tr class="${p.puuid === DATA.puuid ? "me" : ""}">
      <td>${champCell(p.champion_id, `<a href="${playerHash(m.platform, p.riot_id, view.player.range)}">${esc(p.riot_id)}</a>`)}</td>
      <td class="num">${p.kills}/${p.deaths}/${p.assists}</td>
      <td class="num">${p.cs}</td>
      <td style="width:20%">${barCell(p.damage / maxDmg, kpts(p.damage))}</td>
      <td class="num">${p.gold15 == null ? "–" : kpts(p.gold15)}</td>
      <td>${items(p.items)}</td></tr>`).join("")}</tbody></table></div>`).join("");
  el.insertAdjacentHTML("afterbegin", storySection(mid));
  loadStory($(".story", el));
  prepareTables(el);
}

// ---------------------------------------------------------------- live game
let livePoll = null;
let liveRequest = 0;

async function tabLive() {
  if (!$("#live-insights")) $("#tab-body").innerHTML = `<div class="loading"><div class="spinner"></div>Loading the live game…</div>`;
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
  const gameKey = JSON.stringify([live.game_id, live.started, live.players.map((p) => [p.team, p.champion_id]).sort()]);
  const retained = el.dataset.liveGame === gameKey ? $("#live-insights", el) : null;
  const focused = retained?.contains(document.activeElement) ? document.activeElement : null;
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
    ${side(100, "Blue side")}${side(200, "Red side")}<div id="live-insights" class="section"></div>`;
  $("#live-form")?.addEventListener("click", () => { view.player.liveForm = true; tabLive(); });
  if (retained) $("#live-insights", el).replaceWith(retained);
  el.dataset.liveGame = gameKey;
  mountLiveInsights($("#live-insights"), live);
  focused?.focus({ preventScroll: true });
  prepareTables(el);
}

// ---------------------------------------------------------------- admin
const ACTIVITY = { login: "Logged in", lookup: "Looked up", link: "Linked account", unlink: "Unlinked account", sample: "Sampled games" };

async function showAdmin() {
  const token = nav;
  if (!$("#admin")) $("#app").innerHTML = `<div class="loading"><div class="spinner"></div>Loading member activity…</div>`;
  try {
    const data = await api(`/api/admin/activity?days=${view.admin.days}`);
    if (token === nav) renderAdmin(data);
  } catch (e) {
    if (token === nav) $("#app").innerHTML = `<div class="card empty section"><h2 class="error">${esc(e.message)}</h2></div>`;
  }
}

function renderAdmin(data) {
  const A = view.admin;
  const total = (kind) => data.users.reduce((n, u) => n + (u.counts[kind] || 0), 0);
  const active = data.users.filter((u) => u.last_seen && Date.now() - u.last_seen * 1000 < 86400000).length;
  const admins = data.users.filter((u) => u.role === "admin").length;
  const events = data.events.filter((e) => !A.user || e.username === A.user);
  const when = (sec) => (sec ? `<span title="${esc(new Date(sec * 1000).toLocaleString())}">${ago(sec * 1000)}</span>` : `<span class="muted">never</span>`);
  $("#app").innerHTML = `
    <section class="admin-head" id="admin">
      <h1>Member<br><em>activity.</em></h1>
      <div class="chips" id="admin-days" role="group" aria-label="Period"><span class="chips-label">Period</span>${[7, 30, 90].map((d) =>
        `<button class="chip ${A.days === d ? "active" : ""}" data-days="${d}" aria-pressed="${A.days === d}">${d} days</button>`).join("")}</div>
    </section>
    <div class="tiles">
      ${tile("Members", data.users.length, `${admins} admin${admins === 1 ? "" : "s"}`, "indigo")}
      ${tile("Active today", active, "seen in the last 24 hours", "peach")}
      ${tile("Logins", total("login"), `last ${data.days} days`, "plum")}
      ${tile("Lookups", total("lookup"), `players looked up, last ${data.days} days`)}
    </div>
    <div class="card section">
      <div class="card-head"><div><h2>Members</h2><p>Select a member to see only their activity. Roles are set on the server
        with <code>auth.py role &lt;username&gt; admin</code> (or <code>member</code>).</p></div></div>
      <table><thead><tr><th>Member</th><th>Role</th><th>Last seen</th><th class="num">Logins</th><th class="num">Lookups</th>
        <th class="num">Sessions</th><th>Linked account</th><th>Joined</th></tr></thead>
      <tbody>${data.users.map((u) => `<tr class="${A.user === u.username ? "me" : ""}">
        <td><button class="linkish" data-user="${esc(u.username)}" aria-pressed="${A.user === u.username}">${esc(u.username)}</button></td>
        <td>${u.role === "admin" ? `<span class="me-tag">Admin</span>` : "Member"}</td>
        <td>${when(u.last_seen)}</td>
        <td class="num">${u.counts.login || 0}</td><td class="num">${u.counts.lookup || 0}</td><td class="num">${u.sessions}</td>
        <td>${u.account ? esc(u.account) : `<span class="muted">–</span>`}</td>
        <td>${u.created ? day(u.created * 1000) : "–"}</td></tr>`).join("")}</tbody></table>
    </div>
    <div class="card section">
      <div class="card-head"><div><h2>${A.user ? `Activity · ${esc(A.user)}` : "Recent activity"}</h2>
        <p>Logins, player lookups and account changes in the last ${data.days} days, newest first.</p></div>
        ${A.user ? `<button class="btn ghost" id="admin-everyone">Show everyone</button>` : ""}</div>
      ${events.length ? `<table><thead><tr><th>When</th><th>Member</th><th>What</th><th>Details</th></tr></thead>
        <tbody>${events.map((e) => `<tr><td>${when(e.at)}</td><td>${esc(e.username)}</td><td>${ACTIVITY[e.kind] || esc(e.kind)}</td>
          <td>${esc(e.detail || "")}</td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No activity in this period.</p>`}
    </div>`;
  $$("#admin-days .chip").forEach((b) => b.addEventListener("click", () => { A.days = +b.dataset.days; showAdmin(); }));
  $$("[data-user]").forEach((b) => b.addEventListener("click", () => { A.user = A.user === b.dataset.user ? "" : b.dataset.user; renderAdmin(data); }));
  $("#admin-everyone")?.addEventListener("click", () => { A.user = ""; renderAdmin(data); });
  prepareTables();
}

// ---------------------------------------------------------------- boot
function renderUser() {
  $("#user").hidden = false;
  $("#username").textContent = ME.username;
  $("#admin-link").hidden = ME.role !== "admin";
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
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
