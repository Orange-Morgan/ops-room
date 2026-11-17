// The ops board. Plain JavaScript, no build step.
// It polls GET /api/state every couple of seconds and redraws what changed.

const POLL_MS = 2000;
const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  seenRequests: new Set(),
  seenEvents: new Set(),
  doneMissions: new Set(),
  maxStock: {},
  firstLoad: true,
  editingSetup: false,
  lastRender: {}
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-cell-client": "board", ...(init.headers ?? {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function load() {
  try {
    const data = await api("/api/state");
    setOnline(true);
    render(data);
  } catch (e) {
    setOnline(false, e.message);
  }
}

let timer;
function schedule() {
  clearTimeout(timer);
  if (!document.hidden) timer = setTimeout(async () => {
    await load();
    schedule();
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load().then(schedule);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(data) {
  state.data = data;
  renderIfChanged("cell", [data.cell.callsign, data.cell.role, data.cell.setUp], () => renderCell(data.cell));
  renderIfChanged("banner", [data.banner, data.conditions], () => renderBanner(data));
  renderIfChanged("partner", [data.partner, data.cell.role], () => renderPartner(data.partner));
  renderIfChanged("held", data.requests.filter((r) => r.status === "held"), renderHeld);
  renderIfChanged("sites", [data.sites, data.cell.role], () => renderSites(data.sites));
  renderIfChanged("requests", [data.requests, data.cell.role, data.conditions], () => renderBoard(data.requests));
  renderIfChanged("missions", data.missions, renderMissions);
  renderIfChanged("stores", data.stores, renderStores);
  renderIfChanged("events", data.events, renderFeed);
  renderIfChanged("stats", [data.stats, data.excon], () => renderStats(data.stats, data.excon));
  // Ticket ages change every render, so refresh them in place.
  document.querySelectorAll("[data-age]").forEach((el) => (el.textContent = ago(el.dataset.age)));
  state.firstLoad = false;
}

function renderIfChanged(key, value, fn) {
  const json = JSON.stringify(value);
  if (state.lastRender[key] === json) return;
  state.lastRender[key] = json;
  fn(value);
}

function renderCell(cell) {
  document.title = `${cell.callsign} · Exercise ORANGE CLOUD`;
  $("#callsign").textContent = cell.callsign;
  $("#role").textContent = cell.roleLabel;
  $("#role").dataset.role = cell.role;
  $("#role").hidden = false;
  $("#change-setup").hidden = !cell.setUp;
  if (!state.editingSetup) $("#setup").hidden = cell.setUp;
  if (!cell.setUp && !$("#setup-callsign").value) $("#setup-callsign").value = cell.callsign;
}

function renderBanner(data) {
  const cut = data.conditions.roadsCut.map((id) => data.sites.find((s) => s.id === id)?.name ?? id);
  const grounded = data.conditions.flying === "suspended";
  const chips = [];
  if (grounded) chips.push(`<span class="cond bad">Flying suspended</span>`);
  if (cut.length) chips.push(`<span class="cond bad">Road cut: ${cut.map(esc).join(", ")}</span>`);
  const message = data.banner ? `<span class="excon-msg"><b>EXCON</b>${esc(data.banner.text)}</span>` : "";
  $("#banner").innerHTML = message || chips.length ? `<div class="banner">${message}${chips.join("")}</div>` : "";
}

function renderPartner(partner) {
  $("#partner").innerHTML = partner
    ? `<div class="partner-set">
         <span class="linked">Linked</span>
         <span class="callsign">${esc(partner.callsign)}</span>
         <span class="role" data-role="${partner.role}">${partner.role === "air" ? "Air cell" : "Land cell"}</span>
         <code class="muted">${esc(partner.url)}</code>
         <button class="btn ghost small" id="partner-clear">Unlink</button>
       </div>`
    : `<form class="partner-form" id="partner-form">
         <input type="url" id="partner-url" placeholder="https://ops-room.their-subdomain.workers.dev" autocomplete="off" spellcheck="false" />
         <button class="btn small" type="submit">Link</button>
       </form>`;
}

function renderHeld(held) {
  $("#held").innerHTML = held
    .map(
      (r) => `
      <div class="approval">
        <div>
          <div class="who">Held for the Duty Officer · raised by <span class="badge src-${r.source}">${label(r.source, r.from)}</span></div>
          <div class="what">#${r.id} ${esc(r.siteName)}: ${r.items.map((l) => `${l.qty}× ${esc(l.name.toLowerCase())}`).join(", ")}</div>
          <div class="why">${esc(r.heldReason ?? "")}. Your call, not the watchkeeper's.</div>
        </div>
        <div class="actions">
          <button class="btn approve" data-decide="${r.id}" data-decision="approved">Release</button>
          <button class="btn reject" data-decide="${r.id}" data-decision="rejected">Reject</button>
        </div>
      </div>`
    )
    .join("");
}

function renderSites(sites) {
  const land = state.data.cell.role === "land";
  $("#sites").innerHTML = sites
    .map((s) => {
      const cut = s.road === "cut";
      return `
        <div class="site ${cut ? "cut" : ""} ${cut && land ? "blocked" : ""}" title="${esc(s.place)} · site id ${esc(s.id)}">
          <span class="site-name">${esc(s.name.replace("DP ", ""))}</span>
          <span class="site-place">${esc(s.place)}</span>
          <span class="site-road">${cut ? "Road cut" : "Road open"}</span>
          <span class="site-counts"><b>${s.openRequests}</b> open · <b>${s.delivered}</b> done</span>
        </div>`;
    })
    .join("");
}

function lanes() {
  const air = state.data.cell.role === "air";
  return [
    { status: "requested", label: "Requested", next: "tasked", action: "Task" },
    { status: "tasked", label: "Tasked", next: "en_route", action: air ? "Launch" : "Roll" },
    { status: "en_route", label: state.data.cell.enRouteLabel, next: "delivered", action: "Delivered" },
    { status: "delivered", label: "Done" }
  ];
}

function renderBoard(requests) {
  const open = requests.filter((r) => r.status !== "delivered" && r.status !== "cancelled").length;
  $("#requests-meta").textContent = `${open} open · up to ${state.data.cell.maxPalletsPerRequest} pallets a ${state.data.cell.lift}`;
  const inLane = (r, status) => {
    if (status === "requested") return r.status === "requested" || r.status === "held";
    if (status === "delivered") return r.status === "delivered" || r.status === "cancelled";
    return r.status === status;
  };
  $("#board").innerHTML = lanes()
    .map((lane) => {
      const list = requests
        .filter((r) => inLane(r, lane.status))
        .sort((a, b) =>
          lane.status === "delivered" ? b.updatedAt.localeCompare(a.updatedAt) : rank(b.precedence) - rank(a.precedence) || a.id - b.id
        );
      return `
        <div class="lane" data-status="${lane.status}">
          <div class="lane-head"><span>${lane.label}</span><span class="count">${list.length}</span></div>
          ${list.length ? list.map((r) => ticket(r, lane)).join("") : `<div class="empty">${emptyLane(lane.status)}</div>`}
        </div>`;
    })
    .join("");
  for (const r of requests) state.seenRequests.add(r.id);
}

function ticket(r, lane) {
  const isNew = !state.firstLoad && !state.seenRequests.has(r.id);
  const stamp =
    r.status === "cancelled"
      ? `<span class="stamp">Cancelled</span>`
      : r.status === "held"
        ? `<span class="stamp held">Held</span>`
        : r.heldReason
          ? `<span class="stamp released">Released</span>`
          : "";
  const actions =
    lane.next && r.status === lane.status
      ? `<div class="ticket-actions">
           <button class="btn small" data-request="${r.id}" data-status="${lane.next}">${lane.action}</button>
           <button class="btn ghost small cancel" data-request="${r.id}" data-status="cancelled" title="Cancel request">✕</button>
         </div>`
      : r.status === "held"
        ? `<div class="ticket-actions"><span class="muted small">Waiting for the Duty Officer</span></div>`
        : "";
  return `
    <article class="ticket ${isNew ? "pop" : ""}" data-status="${r.status}" data-precedence="${r.precedence}">
      ${stamp}
      <div class="ticket-top">
        <span class="ticket-id">#${r.id}</span>
        <span class="ticket-site">${esc(r.siteName)}</span>
      </div>
      ${r.precedence !== "routine" ? `<div class="precedence" data-precedence="${r.precedence}">${r.precedence}</div>` : ""}
      <ul>${r.items.map((l) => `<li><span class="qty">${l.qty}×</span><span>${esc(l.name)}</span></li>`).join("")}</ul>
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
      <div class="ticket-foot">
        <span class="badge src-${r.source}">${label(r.source, r.from)}</span>
        <span class="total">${r.pallets} plt</span>
      </div>
      <div class="ticket-foot"><span class="age" data-age="${r.createdAt}">${ago(r.createdAt)}</span>${
        r.updatedBy !== r.source && r.status !== "requested" && r.status !== "held"
          ? `<span class="age">${r.status.replace("_", " ")} by ${label(r.updatedBy)}</span>`
          : ""
      }</div>
      ${actions}
    </article>`;
}

function emptyLane(status) {
  return {
    requested: "No requests. Raise one over MCP, or run a surge.",
    tasked: "Nothing tasked",
    en_route: "Nothing on the move",
    delivered: "Nothing delivered yet"
  }[status];
}

function renderMissions(missions) {
  const core = missions.filter((m) => !m.bonus);
  const bonus = missions.filter((m) => m.bonus);
  const coreDone = core.filter((m) => m.done).length;
  const bonusDone = bonus.filter((m) => m.done).length;
  const pct = Math.round((coreDone / core.length) * 100);
  $("#missions-meta").textContent = `${coreDone + bonusDone}/${missions.length}`;
  $("#progress").innerHTML = `
    <div class="ring" style="--p:${pct}" data-label="${coreDone}/${core.length}"></div>
    <div class="progress-text">
      <strong>${progressLine(core)}</strong>
      <span>Bonus missions: ${bonusDone}/${bonus.length}</span>
    </div>`;

  const justDone = [];
  for (const m of missions) {
    if (m.done && !state.doneMissions.has(m.id)) {
      if (!state.firstLoad) justDone.push(m);
      state.doneMissions.add(m.id);
    }
  }
  const item = (m) => `
    <li class="mission ${m.done ? "done" : ""} ${justDone.includes(m) ? "just-done" : ""}">
      <span class="check"></span>
      <div>
        <div class="mission-title">${esc(m.title)}</div>
        <div class="mission-hint">${esc(m.hint)}</div>
      </div>
      ${m.bonus ? "" : `<span class="cp" title="Phase ${m.phase}">P${m.phase}</span>`}
    </li>`;
  $("#missions").innerHTML = core.map(item).join("") + `<li class="mission-divider">Bonus</li>` + bonus.map(item).join("");
  justDone.forEach((m, i) => setTimeout(() => toast(`Mission complete: ${m.title}`, m.hint), i * 700));
}

function progressLine(core) {
  const next = core.find((m) => !m.done);
  if (!next) return "Every core mission done. Outstanding.";
  return {
    1: "Phase 1: stand up the ops room",
    2: "Phase 2: build the tasking tools",
    3: "Phase 3: put the watchkeeper on shift",
    4: "Phase 4: joint tasking"
  }[next.phase];
}

function renderStores(stores) {
  const low = stores.filter((s) => s.stock > 0 && s.stock <= s.reserve).length;
  const out = stores.filter((s) => s.stock === 0).length;
  $("#stores-meta").textContent = out ? `${out} out, ${low} at reserve` : low ? `${low} at or below reserve` : "Pallets on hand";
  $("#stores").innerHTML = stores
    .map((s) => {
      state.maxStock[s.id] = Math.max(state.maxStock[s.id] ?? 0, s.stock, s.reserve * 2, 8);
      const max = state.maxStock[s.id];
      const pct = Math.round((s.stock / max) * 100);
      const reservePct = Math.round((s.reserve / max) * 100);
      const cls = s.stock === 0 ? "out" : s.stock <= s.reserve ? "low" : "";
      return `
        <div class="item ${cls}" title="${esc(s.description)}">
          <div class="item-top">
            <span class="item-name">${esc(s.name)}</span>
            <span class="item-stock">${s.stock}</span>
          </div>
          <div class="bar"><span style="width:${pct}%"></span><i style="left:${reservePct}%" title="Reserve: ${s.reserve}"></i></div>
          <div class="item-foot">
            <span><code>${esc(s.id)}</code> · reserve ${s.reserve}</span>
            <button class="btn ghost small" data-resupply="${esc(s.id)}" title="Add 10 pallets">+10</button>
          </div>
        </div>`;
    })
    .join("");
}

function renderFeed(events) {
  $("#feed").innerHTML = events.length
    ? events
        .map((e) => {
          const fresh = !state.firstLoad && !state.seenEvents.has(e.id);
          const isMission = e.type === "mission.complete";
          return `
            <li class="${fresh ? "fresh" : ""} ${isMission ? "mission-event" : ""} ${e.type.startsWith("excon.") ? "excon-event" : ""}">
              <time>${zulu(e.at)}</time>
              <div class="msg">${isMission ? "" : `<span class="badge src-${e.source}">${label(e.source)}</span>`}${esc(e.message)}</div>
            </li>`;
        })
        .join("")
    : `<li><div></div><div class="muted">Nothing yet. Things you do show up here.</div></li>`;
  for (const e of events) state.seenEvents.add(e.id);
}

function renderStats(stats, excon) {
  const sources = Object.entries(stats.bySource)
    .map(([s, n]) => `<span class="badge src-${s}">${label(s)} ${n}</span>`)
    .join(" ");
  const net = excon.url
    ? `<span class="${excon.joined ? "" : "muted"}" title="${esc(excon.url)}">${excon.joined ? "Reporting to EXCON" : "EXCON not reached yet"}</span>`
    : `<span class="muted">Running without EXCON</span>`;
  $("#stats").innerHTML = `
    <span>Raised <strong>${stats.raised}</strong></span>
    <span>Delivered <strong>${stats.delivered}</strong></span>
    <span>Pallets delivered <strong>${stats.palletsDelivered}</strong></span>
    <span>${sources || '<span class="muted">No requests yet</span>'}</span>
    ${net}`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  try {
    if (el.dataset.request) {
      el.disabled = true;
      await api(`/api/requests/${el.dataset.request}`, { method: "PATCH", body: JSON.stringify({ status: el.dataset.status }) });
    } else if (el.dataset.resupply) {
      el.disabled = true;
      await api(`/api/stores/${encodeURIComponent(el.dataset.resupply)}/resupply`, { method: "POST", body: JSON.stringify({ quantity: 10 }) });
    } else if (el.dataset.decide) {
      el.disabled = true;
      await api(`/api/requests/${el.dataset.decide}/decision`, { method: "POST", body: JSON.stringify({ decision: el.dataset.decision }) });
    } else if (el.dataset.inject) {
      el.disabled = true;
      const type = el.dataset.inject;
      const body = type === "weather" ? { type, flying: "suspended" } : type === "surge" ? { type, count: 3 } : { type };
      const result = await api("/api/inject", { method: "POST", headers: { "x-cell-client": "excon" }, body: JSON.stringify(body) });
      toast("Inject", result.summary);
      setTimeout(() => (el.disabled = false), 1200);
    } else if (el.id === "partner-clear") {
      await api("/api/partner", { method: "DELETE" });
    } else if (el.id === "change-setup") {
      state.editingSetup = true;
      $("#setup").hidden = false;
      $("#setup-cancel").hidden = false;
      $("#setup-warning").hidden = false;
      $("#setup-callsign").value = state.data.cell.callsign;
      document.querySelector(`input[name="role"][value="${state.data.cell.role}"]`).checked = true;
      $("#setup-callsign").focus();
      return;
    } else if (el.id === "setup-cancel") {
      state.editingSetup = false;
      $("#setup").hidden = true;
      return;
    } else if (el.id === "reset") {
      if (!confirm("Reset the ops room? Requests and the log are cleared and stores are refilled. Your mission board, callsign and partner are kept.")) return;
      await api("/api/reset", { method: "POST", body: "{}" });
      state.seenRequests.clear();
    } else if (el.dataset.copy || el.dataset.copyText) {
      const text = el.dataset.copyText ?? $(el.dataset.copy).textContent;
      await navigator.clipboard.writeText(text);
      const old = el.textContent;
      el.textContent = "Copied";
      setTimeout(() => (el.textContent = old), 1200);
      return;
    } else return;
    await load();
  } catch (e) {
    toast("That didn't work", e.message);
    el.disabled = false;
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    if (form.id === "setup-form") {
      const role = new FormData(form).get("role");
      const callsign = $("#setup-callsign").value;
      const changingRole = state.data?.cell.setUp && role !== state.data.cell.role;
      if (changingRole && !confirm("Change role? Your stores are swapped and your requests are cleared.")) return;
      await api("/api/setup", { method: "POST", body: JSON.stringify({ role, callsign }) });
      state.editingSetup = false;
      $("#setup").hidden = true;
      state.maxStock = {};
    } else if (form.id === "partner-form") {
      const partner = await api("/api/partner", { method: "POST", body: JSON.stringify({ url: $("#partner-url").value }) });
      toast(`Linked to ${partner.callsign}`, "Now finish TODO 3 in src/agent.ts and deploy");
    } else return;
    await load();
  } catch (e) {
    toast("That didn't work", e.message);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setOnline(online, why) {
  $("#status .dot").classList.toggle("off", !online);
  $("#status-text").textContent = online ? "On the net" : "Can't reach the ops room";
  $("#status").title = why ?? "";
}

function toast(title, detail) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="star">★</span><div>${esc(title)}${detail ? `<small>${esc(detail)}</small>` : ""}</div>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 350);
  }, 4200);
}

const LABELS = { mcp: "MCP", agent: "Agent", visitor: "Joint", board: "Board", excon: "EXCON", api: "API", smoke: "Smoke" };
const label = (source, from) => (source === "visitor" && from ? `Joint · ${esc(from)}` : (LABELS[source] ?? esc(source)));
const rank = (precedence) => ["routine", "priority", "immediate", "flash"].indexOf(precedence);
const pad = (n) => String(n).padStart(2, "0");

/** Zulu time of day, e.g. 14:32:07Z */
function zulu(iso) {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** A date-time group, e.g. 181432Z NOV 26 */
function dtg(d = new Date()) {
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()];
  return `${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z ${month} ${String(d.getUTCFullYear()).slice(2)}`;
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$("#mcp-url").textContent = `${location.origin}/mcp`;
$("#clock").textContent = dtg();
setInterval(() => ($("#clock").textContent = dtg()), 1000);
load().then(schedule);
