// The EXCON console. Plain JavaScript, no build step.
// It polls GET /api/cop every few seconds. Anything that changes the exercise needs the PIN.

const POLL_MS = 3000;
const $ = (sel) => document.querySelector(sel);

let pin = sessionStorage.getItem("excon-pin") ?? "";
let unlocked = false;
let cop = null;
let cellOptions = "";

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", "x-excon-pin": pin, ...(init.headers ?? {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function load() {
  try {
    cop = await api("/api/cop");
    render(cop);
  } catch (e) {
    $("#summary").textContent = `Can't read the picture: ${e.message}`;
  }
}

async function unlock(quiet = false) {
  if (!pin) return setLocked(true);
  try {
    await api("/api/auth");
    setLocked(false);
  } catch (e) {
    setLocked(true);
    if (!quiet) toast("Still locked", e.message);
  }
}

function setLocked(locked) {
  unlocked = !locked;
  document.body.classList.toggle("locked", locked);
  $("#pin-state").textContent = locked ? "Locked" : "Unlocked";
  $("#pin-state").classList.toggle("ok", !locked);
  if (!locked) sessionStorage.setItem("excon-pin", pin);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(data) {
  const t = data.totals;
  $("#summary").textContent = `${t.online} of ${t.cells} ops rooms on the net · ${t.delivered} delivered · ${t.open} open · ${t.missions} missions done`;
  $("#cells-meta").textContent = `${t.cells} joined`;

  const chips = [];
  if (data.banner) chips.push(`<span class="excon-msg"><b>Message</b>${esc(data.banner.text)}</span>`);
  if (data.conditions.flying === "suspended") chips.push(`<span class="cond bad">Flying suspended</span>`);
  const cut = data.sites.filter((s) => s.road === "cut");
  if (cut.length) chips.push(`<span class="cond bad">Road cut: ${cut.map((s) => esc(s.name)).join(", ")}</span>`);
  $("#conditions").innerHTML = chips.length ? `<div class="banner">${chips.join("")}</div>` : "";

  // Site pickers: fill once, then leave the selection alone.
  if (!$("#flash-site").dataset.filled) {
    const options = data.sites.map((s) => `<option value="${s.id}">${esc(s.name)} · ${esc(s.place)}</option>`).join("");
    $("#flash-site").insertAdjacentHTML("beforeend", options);
    $("#bridge-site").insertAdjacentHTML("beforeend", options);
    $("#flash-site").dataset.filled = "1";
  }

  // Target picker: all, a role, or one cell.
  const options = data.cells.map((c) => `<option value="${esc(c.url)}">${esc(c.callsign)} only</option>`).join("");
  if (options !== cellOptions) {
    cellOptions = options;
    const target = $("#target");
    const chosen = target.value;
    target.querySelectorAll("option[data-cell]").forEach((o) => o.remove());
    target.insertAdjacentHTML("beforeend", options.replaceAll("<option ", "<option data-cell "));
    if ([...target.options].some((o) => o.value === chosen)) target.value = chosen;
  }

  $("#cells").innerHTML = data.cells.length
    ? data.cells
        .map(
          (c) => `
        <tr class="${c.online ? "" : "offline"}">
          <td>
            <span class="callsign">${esc(c.callsign)}</span>
            <span class="role" data-role="${c.role}">${c.role}</span>
            ${c.online ? "" : `<span class="cond bad">off the net</span>`}
            <div class="url">${esc(c.url)}</div>
          </td>
          <td><span class="pips">${c.phases.map((done, i) => `<i class="${done ? "done" : ""}" title="Phase ${i + 1}">${i + 1}</i>`).join("")}</span></td>
          <td class="num">${c.missionsDone}/${c.missionsTotal}${c.bonusDone ? ` <span class="bonus" title="${esc(c.bonus.join(", "))}">+${c.bonusDone}</span>` : ""}</td>
          <td class="num">${c.counts.open}</td>
          <td class="num ${c.counts.held ? "warn" : ""}">${c.counts.held}</td>
          <td class="num">${c.counts.delivered}</td>
          <td>${c.partner ? `<span class="callsign">${esc(c.partner.callsign)}</span>` : `<span class="muted">none</span>`}</td>
          <td class="links">
            <a href="${esc(c.url)}/" target="_blank" rel="noopener">Board ↗</a>
            <a href="${esc(c.url)}/chat" target="_blank" rel="noopener">Chat ↗</a>
            <button class="btn ghost small" data-remove="${esc(c.url)}" title="Forget this ops room">✕</button>
          </td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="8" class="muted">No ops rooms have joined yet. They join on their own once a team opens its ops board.</td></tr>`;

  $("#feed").innerHTML = data.feed.length
    ? data.feed
        .map(
          (f) => `
        <li class="kind-${f.kind}">
          <time>${zulu(f.at)}</time>
          <div><span class="who">${esc(f.who)}</span>${esc(f.text)}</div>
        </li>`
        )
        .join("")
    : `<li><time></time><div class="muted">Nothing yet.</div></li>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function buildInject(el) {
  const type = el.dataset.inject;
  if (type === "surge") return { type, count: Number($("#surge-count").value) };
  if (type === "flash") return { type, site: $("#flash-site").value || undefined };
  if (type === "bridge_out") return { type, site: $("#bridge-site").value || undefined };
  if (type === "bridge_open") {
    const site = $("#bridge-site").value;
    if (!site) throw new Error("Pick the site whose road should reopen.");
    return { type, site };
  }
  if (type === "weather") return { type, flying: el.dataset.flying };
  if (type === "message") return { type, text: el.dataset.clear ? "" : $("#message").value };
  return { type };
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el || el.type === "submit") return;
  try {
    if (el.dataset.inject) {
      if (!unlocked) throw new Error("Enter the PIN first.");
      el.disabled = true;
      const inject = buildInject(el);
      const result = await api("/api/inject", { method: "POST", body: JSON.stringify({ inject, target: $("#target").value }) });
      const failed = result.failed.length ? `${result.failed.length} failed: ${result.failed.map((f) => f.callsign).join(", ")}` : "";
      toast(`Sent to ${result.sent} ops room${result.sent === 1 ? "" : "s"}`, failed);
      if (inject.type === "message" && !el.dataset.clear) $("#message").value = "";
      setTimeout(() => (el.disabled = false), 800);
    } else if (el.dataset.remove) {
      if (!unlocked) throw new Error("Enter the PIN first.");
      if (!confirm("Forget this ops room? It rejoins by itself the next time its board is open.")) return;
      await api("/api/remove", { method: "POST", body: JSON.stringify({ url: el.dataset.remove }) });
    } else if (el.id === "reset") {
      if (!unlocked) throw new Error("Enter the PIN first.");
      if (!confirm("Forget every ops room, the inject log and the current conditions? Ops rooms keep their own data and rejoin when their boards are open.")) return;
      await api("/api/reset", { method: "POST", body: "{}" });
    } else return;
    await load();
  } catch (e) {
    toast("That didn't work", e.message);
    el.disabled = false;
  }
});

$("#pin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  pin = $("#pin").value.trim();
  unlock();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast(title, detail) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div>${esc(title)}${detail ? `<small>${esc(detail)}</small>` : ""}</div>`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

const pad = (n) => String(n).padStart(2, "0");

function zulu(iso) {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

function dtg(d = new Date()) {
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()];
  return `${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z ${month} ${String(d.getUTCFullYear()).slice(2)}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$("#cop-url").textContent = `${location.origin}/api/cop`;
$("#clock").textContent = dtg();
setInterval(() => ($("#clock").textContent = dtg()), 1000);
unlock(true);
load();
setInterval(() => {
  if (!document.hidden) load();
}, POLL_MS);
