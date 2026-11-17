#!/usr/bin/env node
// Health check for your ops room: API, MCP server and (optionally) the watchkeeper.
//
//   npm run smoke                                   checks http://localhost:8787
//   npm run smoke -- https://ops-room.you.workers.dev
//   npm run smoke -- <url> --write                  also exercises the write tools (requests show as "smoke")
//   npm run smoke -- <url> --agent                  also asks your watchkeeper a question
//   npm run smoke -- <url> --reset                  wipes the ops room AND the mission board first (careful)
//
// The URL can be your Worker or its MCP server URL: a trailing /mcp is ignored.
// Smoke-test traffic is labelled "smoke" and never ticks missions.

const args = process.argv.slice(2);
// Accept the Worker URL or the MCP URL people copy from the ops board.
const base = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:8787").replace(/\/+$/, "").replace(/\/mcp$/, "");
const flags = new Set(args.filter((a) => a.startsWith("--")));

const PHASE_2_TOOLS = ["raise_request", "list_requests", "update_request_status", "resupply_store"];
let failures = 0;

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};
const info = (msg) => console.log(`  \x1b[2m•\x1b[0m ${msg}`);

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });
  const body = await res.json().catch(() => null);
  return { res, body };
}

let rpcId = 0;
async function mcp(method, params = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "x-cell-client": "smoke"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  // Responses come back as plain JSON or as a single server-sent event.
  const payload = text.trim().startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
  return msg.result;
}

function toolJson(result) {
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

console.log(`\nSmoke testing ${base}\n`);

// 1. REST API ---------------------------------------------------------------
console.log("API");
let cell = null;
try {
  if (flags.has("--reset")) {
    await api("/api/reset", { method: "POST", body: JSON.stringify({ everything: true }) });
    info("reset the ops room and the mission board");
  }
  const { res, body } = await api("/api/state");
  if (res.ok && Array.isArray(body?.stores)) {
    cell = body.cell;
    ok(`GET /api/state → ${cell.callsign} (${cell.roleLabel}), ${body.stores.length} stores, ${body.requests.length} requests`);
    const done = body.missions.filter((m) => m.done).length;
    info(`missions complete: ${done}/${body.missions.length}`);
    if (!cell.setUp) info("no role or callsign picked yet: open the ops board to stand the ops room up");
    if (body.partner) info(`partner cell: ${body.partner.callsign} at ${body.partner.url}`);
    if (body.conditions.flying === "suspended") info("flying is suspended");
    if (body.conditions.roadsCut.length) info(`roads cut: ${body.conditions.roadsCut.join(", ")}`);
  } else bad(`GET /api/state → HTTP ${res.status}`);
} catch (e) {
  bad(`couldn't reach ${base}: ${e.message}`);
  console.log(`\nIs it running? Try "npm run dev" first, or pass your Worker URL.\n`);
  process.exit(1);
}

// 2. MCP server ------------------------------------------------------------------
console.log("\nMCP server (/mcp)");
let toolNames = [];
let sitrep = null;
try {
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ops-room-smoke-test", version: "1.0.0" }
  });
  ok(`initialize → ${init.serverInfo?.name} ${init.serverInfo?.version}`);
  const list = await mcp("tools/list");
  toolNames = list.tools.map((t) => t.name);
  ok(`tools/list → ${toolNames.join(", ")}`);
  sitrep = toolJson(await mcp("tools/call", { name: "get_sitrep", arguments: {} }));
  if (Array.isArray(sitrep?.stores) && sitrep.stores.length) ok(`tools/call get_sitrep → ${sitrep.stores.length} stores, ${sitrep.sites.length} sites`);
  else bad("tools/call get_sitrep didn't return the SITREP");
} catch (e) {
  bad(`MCP request failed: ${e.message}`);
}

const built = PHASE_2_TOOLS.filter((t) => toolNames.includes(t));
console.log(`\nPhase 2 progress: ${built.length}/${PHASE_2_TOOLS.length} tools`);
for (const t of PHASE_2_TOOLS) (toolNames.includes(t) ? ok : info)(`${t}${toolNames.includes(t) ? "" : "  (not built yet)"}`);
const extra = toolNames.filter((t) => t !== "get_sitrep" && !PHASE_2_TOOLS.includes(t));
if (extra.length) info(`extra tools: ${extra.join(", ")}`);

// 3. Write tools (optional) ------------------------------------------------------
if (flags.has("--write") && built.includes("raise_request")) {
  console.log("\nWrite tools (requests are labelled smoke)");
  // Pick a site this cell can reach right now, and its best-stocked store, so the test request isn't refused or held.
  const cut = new Set(sitrep?.conditions?.roadsCut ?? []);
  const site = (sitrep?.sites ?? []).find((s) => !cut.has(s.id))?.id ?? "alpha";
  const store = [...(sitrep?.stores ?? [])].sort((a, b) => b.onHand - b.reserve - (a.onHand - a.reserve))[0]?.id ?? "water";
  const grounded = sitrep?.cell?.role === "air" && sitrep?.conditions?.flying === "suspended";
  try {
    if (grounded) info("flying is suspended, so this Air cell refuses new requests: skipping the write tools");
    else {
      const request = toolJson(await mcp("tools/call", { name: "raise_request", arguments: { site, items: [{ storeId: store, qty: 1 }] } }));
      if (request?.id) ok(`raise_request → #${request.id} for ${request.siteName}, status ${request.status}`);
      else bad(`raise_request returned ${JSON.stringify(request).slice(0, 160)}`);
      if (request?.id && built.includes("update_request_status")) {
        const status = request.status === "held" ? "cancelled" : "delivered";
        const moved = toolJson(await mcp("tools/call", { name: "update_request_status", arguments: { requestId: request.id, status } }));
        moved?.status === status ? ok(`update_request_status → #${moved.id} ${status}`) : bad(`update_request_status didn't mark the request ${status}`);
      }
      if (built.includes("list_requests")) {
        const requests = toolJson(await mcp("tools/call", { name: "list_requests", arguments: { status: "all" } }));
        Array.isArray(requests) ? ok(`list_requests → ${requests.length} requests`) : bad("list_requests didn't return a list");
      }
      if (built.includes("resupply_store")) {
        const item = toolJson(await mcp("tools/call", { name: "resupply_store", arguments: { storeId: store, quantity: 1 } }));
        item?.id ? ok(`resupply_store → ${item.name} now ${item.stock}`) : bad("resupply_store didn't return the store");
      }
      const refused = await mcp("tools/call", { name: "raise_request", arguments: { site, items: [{ storeId: "champagne", qty: 1 }] } });
      refused?.isError ? ok(`bad input comes back as a tool error: "${refused.content?.[0]?.text?.slice(0, 70)}…"`) : bad("asking for champagne should fail");
    }
  } catch (e) {
    bad(`write tools failed: ${e.message}`);
  }
}

// 4. Watchkeeper (optional) -------------------------------------------------------
if (flags.has("--agent")) {
  console.log("\nWatchkeeper (/agents/watchkeeper)");
  const session = `smoke-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { res, body } = await api(`/agents/watchkeeper/${session}`, {
      method: "POST",
      headers: { "x-cell-client": "smoke" },
      body: JSON.stringify({ message: "How many pallets of bottled water do we have on hand? One short sentence." })
    });
    if (res.ok && body?.reply) {
      ok(`reply in ${body.ms} ms using ${body.model}: "${body.reply.replace(/\s+/g, " ").slice(0, 120)}"`);
      info(`MCP tools the watchkeeper can see: ${body.mcp?.toolCount ?? 0}; tools it used: ${body.tools.map((t) => t.name).join(", ") || "none"}`);
      for (const s of body.mcp?.servers ?? []) info(`MCP server "${s.name}": ${s.state}, ${s.tools.length} tools, ${s.url}`);
      if (!body.mcp?.toolCount) info("the watchkeeper isn't on the net yet (Phase 3)");
      if (/say again/i.test(body.reply)) info("the model sometimes garbles a reply and the watchkeeper covers for it: run this again before you start debugging");
    } else bad(`watchkeeper error: ${body?.error ?? `HTTP ${res.status}`}`);
    await api(`/agents/watchkeeper/${session}`, { method: "DELETE" });
  } catch (e) {
    bad(`watchkeeper request failed: ${e.message}`);
  }
}

console.log(failures ? `\n\x1b[31m${failures} problem(s) found.\x1b[0m\n` : "\n\x1b[32mAll good.\x1b[0m\n");
process.exit(failures ? 1 : 0);
