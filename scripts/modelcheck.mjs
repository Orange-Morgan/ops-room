#!/usr/bin/env node
// Model check for exercise control: is the watchkeeper's model quick and getting things right today?
//
//   npm run modelcheck -- <air-ops-room-url> <land-ops-room-url> [--runs 2]
//
// Point it at two reference ops rooms that run a finished Phase 4 watchkeeper
// (npm run skip:all or skip:stretch). It runs five jobs with whatever model they
// are deployed with, and checks what landed on the boards, not what the model said.
//
// CAREFUL: it wipes both ops rooms before every job and leaves them as KESTREL 1 (Air)
// and BADGER 2 (Land), linked as partners. Never point it at a team's ops room.

const args = process.argv.slice(2);
const urls = args.filter((a) => /^https?:\/\//.test(a)).map((u) => u.replace(/\/+$/, "").replace(/\/mcp$/, ""));
const runsAt = args.indexOf("--runs");
const RUNS = runsAt >= 0 ? Number(args[runsAt + 1]) || 1 : 1;
if (urls.length !== 2) {
  console.error("Usage: npm run modelcheck -- <air-ops-room-url> <land-ops-room-url> [--runs 2]");
  process.exit(1);
}
const [AIR, LAND] = urls;
const TURN_TIMEOUT = 150_000;
const J = { "content-type": "application/json" };

async function api(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...J, ...(init.headers ?? {}) } });
  return res.json().catch(() => null);
}

async function chat(base, session, message) {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/agents/watchkeeper/${session}`, {
      method: "POST",
      headers: { ...J, "x-cell-client": "smoke" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(TURN_TIMEOUT)
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: `HTTP ${res.status}, not JSON: ${text.slice(0, 120)}` };
    }
    if (!body.error && !body.reply) body.error = `HTTP ${res.status}, no reply: ${text.slice(0, 160)}`;
    return {
      ok: res.ok && !body.error,
      model: body.model ?? null,
      models: body.usage?.models ?? [],
      reply: body.reply ?? "",
      error: body.error ?? null,
      tools: body.tools ?? [],
      ms: Date.now() - started,
      calls: body.usage?.modelCalls ?? 0,
      tokIn: body.usage?.inputTokens ?? 0,
      tokOut: body.usage?.outputTokens ?? 0
    };
  } catch (e) {
    return { ok: false, model: null, models: [], reply: "", error: `timeout or network: ${e.message}`, tools: [], ms: Date.now() - started, calls: 0, tokIn: 0, tokOut: 0 };
  }
}

async function freshExercise() {
  for (const base of [AIR, LAND]) await api(base, "/api/reset", { method: "POST", body: JSON.stringify({ everything: true }) });
  await api(AIR, "/api/setup", { method: "POST", headers: { "x-cell-client": "smoke" }, body: JSON.stringify({ role: "air", callsign: "KESTREL 1" }) });
  await api(LAND, "/api/setup", { method: "POST", headers: { "x-cell-client": "smoke" }, body: JSON.stringify({ role: "land", callsign: "BADGER 2" }) });
  await api(AIR, "/api/partner", { method: "POST", body: JSON.stringify({ url: LAND }) });
  await api(LAND, "/api/partner", { method: "POST", body: JSON.stringify({ url: AIR }) });
}

const requests = (base) => api(base, "/api/requests?status=all");
// Garbled: the kit gave up, or tool-call syntax leaked into the reply as text.
const garbled = (t) =>
  /Say again\?|\(The watchkeeper made|\(Nothing heard/.test(t.reply) ||
  /tool_(cell|partner)_|^\s*[\[{]|\[(get_sitrep|raise_request|list_requests|update_request_status|resupply_store)/.test(t.reply);
const lines = (r) => Object.fromEntries(r.items.map((l) => [l.storeId, l.qty]));
const sid = () => `b-${Math.random().toString(36).slice(2, 9)}`;

// Each job returns { pass, note, turns: [...] }.
const JOBS = {
  // A read: does it call the tool and report the number the tool gave?
  async sitrep() {
    const t = await chat(AIR, sid(), "How many pallets of bottled water do we have on hand? One short sentence.");
    const used = t.tools.some((x) => x.name === "get_sitrep" && !x.error);
    return { pass: t.ok && used && /\b12\b/.test(t.reply) && !garbled(t), note: t.error ?? t.reply.slice(0, 90).replace(/\s+/g, " "), turns: [t] };
  },
  // A write with two lines, then three status moves in one go.
  async raise_and_deliver() {
    const s = sid();
    const t1 = await chat(AIR, s, "DP CHARLIE needs 2 pallets of water and 1 of medical supplies");
    let all = await requests(AIR);
    const mine = (all ?? []).filter((r) => r.source === "agent");
    const raised = mine.length === 1 && mine[0].site === "charlie" && lines(mine[0]).water === 2 && lines(mine[0]).medical === 1 && mine[0].pallets === 3;
    const t2 = await chat(AIR, s, "Task it, get it moving, then mark it delivered.");
    all = await requests(AIR);
    const after = (all ?? []).filter((r) => r.source === "agent");
    const delivered = after.length === 1 && after[0].status === "delivered";
    return {
      pass: raised && delivered && !garbled(t1) && !garbled(t2),
      note: `raised ${raised ? "ok" : JSON.stringify(mine.map((r) => [r.site, lines(r)]))}; final status ${after.map((r) => r.status).join(",") || "none"}`,
      turns: [t1, t2]
    };
  },
  // The reserve: the request must come back held, and the model must say so rather than work round it.
  async held() {
    const stock = ((await api(AIR, "/api/stores")) ?? []).find((s) => s.id === "generators")?.stock ?? 4;
    const t = await chat(AIR, sid(), "DP DELTA needs every generator we have");
    const mine = ((await requests(AIR)) ?? []).filter((r) => r.source === "agent" && r.status !== "cancelled");
    const oneHeld = mine.length === 1 && mine[0].status === "held" && lines(mine[0]).generators === stock;
    const saysSo = /held|duty officer|approv|releas/i.test(t.reply);
    return {
      pass: oneHeld && saysSo && !garbled(t),
      note: `${mine.map((r) => `${r.status}:${JSON.stringify(lines(r))}`).join(" ") || "no request"}; says held: ${saysSo}`,
      turns: [t]
    };
  },
  // Bad input: no request should exist afterwards and the reply should explain.
  async unknown_store() {
    const t = await chat(AIR, sid(), "DP CHARLIE needs 3 pallets of champagne");
    // Nothing should have been raised anywhere, on this board or the partner's: no quiet substitutions.
    const mine = [...((await requests(AIR)) ?? []), ...((await requests(LAND)) ?? [])].filter((r) => r.status !== "cancelled");
    const explains = /champagne/i.test(t.reply) && !/not on the net/i.test(t.reply);
    return {
      pass: t.ok && mine.length === 0 && explains && !garbled(t),
      note: mine.length ? `raised ${JSON.stringify(mine.map(lines))} instead` : t.reply.slice(0, 90).replace(/\s+/g, " "),
      turns: [t]
    };
  },
  // Joint tasking: the road is cut, so the Land cell has to hand over to the Air cell, in loads of six or fewer.
  async joint() {
    await api(LAND, "/api/inject", { method: "POST", headers: { "x-cell-client": "excon" }, body: JSON.stringify({ type: "bridge_out", site: "echo" }) });
    const t = await chat(LAND, sid(), "DP ECHO needs 8 pallets of water and 2 of medical supplies");
    const onAir = ((await requests(AIR)) ?? []).filter((r) => r.source === "visitor" && r.status !== "cancelled");
    const onLand = ((await requests(LAND)) ?? []).filter((r) => r.site === "echo" && !["cancelled", "delivered"].includes(r.status));
    const water = onAir.reduce((n, r) => n + (lines(r).water ?? 0), 0);
    const medical = onAir.reduce((n, r) => n + (lines(r).medical ?? 0), 0);
    const other = onAir.reduce((n, r) => n + r.pallets, 0) - water - medical;
    const right = water === 8 && medical === 2 && other === 0 && onAir.every((r) => r.site === "echo" && r.pallets <= 6) && onLand.length === 0;
    return {
      pass: right && !garbled(t),
      note: `air got ${onAir.map((r) => JSON.stringify(lines(r))).join(" + ") || "nothing"}; left on land: ${onLand.length}`,
      turns: [t]
    };
  }
};

console.log(`\nModel check\n  Air cell:  ${AIR}\n  Land cell: ${LAND}\n  Both are wiped before every job.\n`);

let passed = 0;
let total = 0;
const times = [];
const models = new Set();
for (let run = 1; run <= RUNS; run++) {
  for (const [job, fn] of Object.entries(JOBS)) {
    await freshExercise();
    let result;
    try {
      result = await fn();
    } catch (e) {
      result = { pass: false, note: `couldn't run: ${e.message}`, turns: [] };
    }
    total++;
    if (result.pass) passed++;
    for (const t of result.turns) {
      times.push(t.ms);
      for (const m of t.models) models.add(m);
    }
    const secs = result.turns.map((t) => `${(t.ms / 1000).toFixed(1)}s`).join(" + ") || "no reply";
    const mark = result.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const errors = result.turns.map((t) => t.error).filter(Boolean).join(" | ");
    console.log(`  ${mark} ${job.padEnd(18)} ${secs.padEnd(14)} ${errors || result.note}`);
  }
}

await freshExercise();
times.sort((a, b) => a - b);
const median = times.length ? (times[Math.floor(times.length / 2)] / 1000).toFixed(1) : "?";
const slowest = times.length ? (times[times.length - 1] / 1000).toFixed(1) : "?";
console.log(`\n${passed} of ${total} jobs passed. Typical reply ${median}s, slowest ${slowest}s.`);
console.log(`Answered by: ${[...models].join(", ") || "nothing"}`);
if (models.size > 1) console.log("More than one model answered: the first one was slow or failing, and the fallback stepped in.");
if (Number(median) > 10) console.log("Replies are slow today. The fallback will take over by itself, but warn the room that the watchkeeper needs patience.");
console.log("");
process.exit(passed === total ? 0 : 1);
