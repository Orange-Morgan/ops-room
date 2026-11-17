import { DurableObject } from "cloudflare:workers";
import { EXERCISE, SITES } from "../../src/ops/scenario";
import type { Conditions, Inject, Role, Snapshot } from "../../src/ops/types";

/**
 * Exercise control (EXCON) for Exercise ORANGE CLOUD.
 *
 *   /                 the EXCON console (static files in ./public, PIN needed to act)
 *   POST /api/join    { url }  an ops room introduces itself (ops rooms do this on their own)
 *   GET  /api/cop     the common operating picture: every ops room, every site, one feed
 *   POST /api/inject  { inject, target }  send an inject to all cells, one role or one cell (PIN)
 *   POST /api/remove  { url }  forget one ops room (PIN)
 *   POST /api/reset   forget everything (PIN)
 *
 * EXCON holds no copy of the ops rooms' data. It reads each one's public
 * /api/state when someone is looking, and posts injects to /api/inject.
 */

interface HubEnv {
  EXERCISE: DurableObjectNamespace<Exercise>;
  ASSETS: Fetcher;
  /** Set with: npx wrangler secret put EXCON_PIN -c excon/wrangler.jsonc */
  EXCON_PIN?: string;
}

export interface CellSummary {
  url: string;
  callsign: string;
  role: Role;
  /** False when EXCON hasn't heard from the ops room for a while. */
  online: boolean;
  lastSeen: string | null;
  /** Phases 1 to 4: true once every core mission in the phase is done. */
  phases: boolean[];
  missionsDone: number;
  missionsTotal: number;
  bonusDone: number;
  /** Titles of the bonus missions done so far. */
  bonus: string[];
  counts: { open: number; held: number; enRoute: number; delivered: number; pallets: number };
  /** The partner cell's callsign and URL, once linked. */
  partner: { callsign: string; url: string } | null;
}

export interface Cop {
  exercise: { name: string; island: string; now: string };
  conditions: Conditions;
  banner: { text: string; at: string } | null;
  cells: CellSummary[];
  sites: { id: string; name: string; place: string; road: "open" | "cut"; open: number; delivered: number }[];
  totals: { cells: number; online: number; open: number; delivered: number; pallets: number; missions: number };
  feed: { at: string; kind: "excon" | "mission" | "delivered" | "joint" | "sunray"; who: string; text: string }[];
}

type Target = "all" | "air" | "land" | string;

const STALE_MS = 2500;
const OFFLINE_MS = 25_000;
const FETCH_TIMEOUT_MS = 4500;
const CORE_PHASES = [1, 2, 3, 4];

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const exercise = env.EXERCISE.getByName("exercise");
    try {
      if (url.pathname === "/api/cop" && request.method === "GET") return json(await exercise.cop());

      if (url.pathname === "/api/join" && request.method === "POST") {
        const body = await readJson(request);
        return json(await exercise.join(String(body.url ?? "")));
      }

      // Everything below changes the exercise, so it needs the PIN.
      const denied = checkPin(request, env);
      if (denied) return denied;

      if (url.pathname === "/api/auth" && request.method === "GET") return json({ ok: true });

      if (url.pathname === "/api/inject" && request.method === "POST") {
        const body = await readJson(request);
        return json(await exercise.inject(body.inject as Inject, String(body.target ?? "all")));
      }
      if (url.pathname === "/api/remove" && request.method === "POST") {
        const body = await readJson(request);
        return json(await exercise.remove(String(body.url ?? "")));
      }
      if (url.pathname === "/api/reset" && request.method === "POST") return json(await exercise.reset());

      return json({ error: `No API route for ${request.method} ${url.pathname}` }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
} satisfies ExportedHandler<HubEnv>;

function checkPin(request: Request, env: HubEnv): Response | null {
  const pin = String(env.EXCON_PIN ?? "").trim();
  if (!pin) {
    return json(
      { error: "EXCON_PIN isn't set. Run: npx wrangler secret put EXCON_PIN -c excon/wrangler.jsonc (or add it to excon/.dev.vars for local dev)." },
      503
    );
  }
  if (request.headers.get("x-excon-pin") !== pin) return json({ error: "Wrong PIN." }, 401);
  return null;
}

export class Exercise extends DurableObject<HubEnv> {
  private sql: SqlStorage;
  private refreshing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: HubEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS cells (
        url TEXT PRIMARY KEY, joined_at TEXT NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0,
        ok_at INTEGER NOT NULL DEFAULT 0, snapshot TEXT
      );
      CREATE TABLE IF NOT EXISTS injects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, text TEXT NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------------------
  // Ops rooms joining
  // ---------------------------------------------------------------------------

  /** An ops room introduces itself. EXCON checks it really is one before listing it. */
  async join(input: string): Promise<{ ok: true; callsign: string }> {
    let origin: string;
    try {
      const parsed = new URL(input.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
      origin = parsed.origin;
    } catch {
      throw new Error("Send the ops room's URL, like { \"url\": \"https://ops-room.someone.workers.dev\" }.");
    }
    const snapshot = await fetchSnapshot(origin);
    if (!snapshot) throw new Error(`Couldn't find an ops room at ${origin}.`);
    const isNew = this.sql.exec("SELECT 1 FROM cells WHERE url = ?", origin).toArray().length === 0;
    this.sql.exec(
      `INSERT INTO cells (url, joined_at, checked_at, ok_at, snapshot) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET checked_at = excluded.checked_at, ok_at = excluded.ok_at, snapshot = excluded.snapshot`,
      origin,
      new Date().toISOString(),
      Date.now(),
      Date.now(),
      JSON.stringify(snapshot)
    );
    // A cell that joins late (or was reset) gets the conditions everyone else already has.
    if (isNew) await this.syncConditions(origin, snapshot);
    return { ok: true, callsign: snapshot.cell.callsign };
  }

  private async syncConditions(url: string, snapshot: Snapshot) {
    const want = this.conditions();
    const injects: Inject[] = [];
    for (const site of want.roadsCut) {
      if (!snapshot.conditions.roadsCut.includes(site)) injects.push({ type: "bridge_out", site });
    }
    if (want.flying !== snapshot.conditions.flying) injects.push({ type: "weather", flying: want.flying });
    const banner = this.banner();
    if (banner && snapshot.banner?.text !== banner.text) injects.push({ type: "message", text: banner.text });
    for (const inject of injects) await sendInject(url, inject);
  }

  remove(url: string) {
    this.sql.exec("DELETE FROM cells WHERE url = ?", url);
    return { ok: true };
  }

  reset() {
    this.sql.exec("DELETE FROM cells");
    this.sql.exec("DELETE FROM injects");
    this.sql.exec("DELETE FROM meta");
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // The common operating picture
  // ---------------------------------------------------------------------------

  async cop(): Promise<Cop> {
    await this.refresh();
    const now = Date.now();
    const rows = this.sql.exec("SELECT * FROM cells ORDER BY joined_at").toArray();
    const cells: CellSummary[] = [];
    const feed: Cop["feed"] = [];
    const perSite = new Map<string, { open: number; delivered: number }>(SITES.map((s) => [s.id, { open: 0, delivered: 0 }]));

    for (const row of rows) {
      const snapshot = parse<Snapshot | null>(row.snapshot === null ? null : String(row.snapshot), null);
      if (!snapshot) continue;
      const okAt = Number(row.ok_at);
      const core = snapshot.missions.filter((m) => !m.bonus);
      const bonus = snapshot.missions.filter((m) => m.bonus && m.done);
      const open = snapshot.requests.filter((r) => r.status !== "delivered" && r.status !== "cancelled");
      cells.push({
        url: String(row.url),
        callsign: snapshot.cell.callsign,
        role: snapshot.cell.role,
        online: now - okAt < OFFLINE_MS,
        lastSeen: okAt ? new Date(okAt).toISOString() : null,
        phases: CORE_PHASES.map((phase) => core.filter((m) => m.phase === phase).every((m) => m.done)),
        missionsDone: core.filter((m) => m.done).length,
        missionsTotal: core.length,
        bonusDone: bonus.length,
        bonus: bonus.map((m) => m.title),
        counts: {
          open: open.length,
          held: open.filter((r) => r.status === "held").length,
          enRoute: open.filter((r) => r.status === "en_route").length,
          delivered: snapshot.stats.delivered,
          pallets: snapshot.stats.palletsDelivered
        },
        partner: snapshot.partner ? { callsign: snapshot.partner.callsign, url: snapshot.partner.url } : null
      });
      for (const site of snapshot.sites) {
        const total = perSite.get(site.id);
        if (!total) continue;
        total.open += site.openRequests;
        total.delivered += site.delivered;
      }
      for (const event of snapshot.events) {
        const kind = FEED_KINDS[event.type];
        if (!kind) continue;
        feed.push({ at: event.at, kind, who: snapshot.cell.callsign, text: event.message.replace(/^Mission complete: /, "") });
      }
    }
    for (const row of this.sql.exec("SELECT at, text FROM injects ORDER BY id DESC LIMIT 20").toArray()) {
      feed.push({ at: String(row.at), kind: "excon", who: "EXCON", text: String(row.text) });
    }
    feed.sort((a, b) => b.at.localeCompare(a.at));

    const conditions = this.conditions();
    const cut = new Set(conditions.roadsCut);
    return {
      exercise: { name: EXERCISE.name, island: EXERCISE.island, now: new Date(now).toISOString() },
      conditions,
      banner: this.banner(),
      cells,
      sites: SITES.map((s) => ({ id: s.id, name: s.name, place: s.place, road: cut.has(s.id) ? "cut" : "open", ...perSite.get(s.id)! })),
      totals: {
        cells: cells.length,
        online: cells.filter((c) => c.online).length,
        open: cells.reduce((n, c) => n + c.counts.open, 0),
        delivered: cells.reduce((n, c) => n + c.counts.delivered, 0),
        pallets: cells.reduce((n, c) => n + c.counts.pallets, 0),
        missions: cells.reduce((n, c) => n + c.missionsDone + c.bonusDone, 0)
      },
      feed: feed.slice(0, 40)
    };
  }

  /** Re-read any ops room whose picture is more than a couple of seconds old. One refresh at a time. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.refreshStale().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refreshStale() {
    const now = Date.now();
    const stale = this.sql
      .exec("SELECT url FROM cells WHERE checked_at < ?", now - STALE_MS)
      .toArray()
      .map((r) => String(r.url));
    await Promise.all(
      stale.map(async (url) => {
        const snapshot = await fetchSnapshot(url);
        if (snapshot) {
          this.sql.exec("UPDATE cells SET checked_at = ?, ok_at = ?, snapshot = ? WHERE url = ?", Date.now(), Date.now(), JSON.stringify(snapshot), url);
        } else {
          this.sql.exec("UPDATE cells SET checked_at = ? WHERE url = ?", Date.now(), url);
        }
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Injects
  // ---------------------------------------------------------------------------

  /** Send an inject to every cell, one role or one cell, and keep EXCON's own picture in step. */
  async inject(inject: Inject, target: Target) {
    if (!inject || typeof inject !== "object" || typeof inject.type !== "string") throw new Error("Send { inject: { type, ... }, target }.");
    // Pick the site here, so every ops room gets the same one.
    if ((inject.type === "bridge_out" || inject.type === "flash") && !inject.site) {
      const cut = new Set(this.conditions().roadsCut);
      const choices = inject.type === "bridge_out" ? SITES.filter((s) => !cut.has(s.id)) : SITES;
      inject.site = (choices.length ? choices : SITES)[Math.floor(Math.random() * (choices.length || SITES.length))].id;
    }
    const everyone = target === "all";
    const cells = this.cellList().filter((c) => everyone || c.role === target || c.url === target);
    if (!cells.length) throw new Error("No ops rooms match that target yet.");

    const results = await Promise.all(
      cells.map(async (cell) => ({ callsign: cell.callsign, ...(await sendInject(cell.url, inject)) }))
    );

    // Conditions and messages only become EXCON's picture when they went to everyone.
    if (everyone) this.applyToPicture(inject);
    const to = everyone ? "all cells" : target === "air" || target === "land" ? `${target} cells` : (cells[0]?.callsign ?? target);
    this.sql.exec("INSERT INTO injects (at, text) VALUES (?, ?)", new Date().toISOString(), `${describe(inject)} → ${to}`);
    // Make the next picture show the effect straight away.
    this.sql.exec("UPDATE cells SET checked_at = 0");
    return { ok: true, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results };
  }

  private applyToPicture(inject: Inject) {
    const conditions = this.conditions();
    const cut = new Set(conditions.roadsCut);
    if (inject.type === "bridge_out" && inject.site) cut.add(inject.site);
    if (inject.type === "bridge_open" && inject.site) cut.delete(inject.site);
    if (inject.type === "weather") conditions.flying = inject.flying === "suspended" ? "suspended" : "open";
    if (inject.type === "all_clear") {
      cut.clear();
      conditions.flying = "open";
    }
    if (inject.type === "message") {
      const text = String(inject.text ?? "").trim().slice(0, 160);
      this.setMeta("banner", text ? JSON.stringify({ text, at: new Date().toISOString() }) : "");
    }
    this.setMeta("roads_cut", JSON.stringify([...cut]));
    this.setMeta("flying", conditions.flying);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private cellList(): { url: string; callsign: string; role: Role }[] {
    return this.sql
      .exec("SELECT url, snapshot FROM cells")
      .toArray()
      .map((row) => {
        const snapshot = parse<Snapshot | null>(row.snapshot === null ? null : String(row.snapshot), null);
        return { url: String(row.url), callsign: snapshot?.cell.callsign ?? String(row.url), role: snapshot?.cell.role ?? "air" };
      });
  }

  private conditions(): Conditions {
    return {
      flying: this.meta("flying") === "suspended" ? "suspended" : "open",
      roadsCut: parse<string[]>(this.meta("roads_cut"), [])
    };
  }

  private banner(): { text: string; at: string } | null {
    return parse<{ text: string; at: string } | null>(this.meta("banner"), null);
  }

  private meta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row && row.value !== null && row.value !== "" ? String(row.value) : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
}

/** Which ops room events make the big-screen feed. Injects come from EXCON's own log instead. */
const FEED_KINDS: Record<string, Cop["feed"][number]["kind"]> = {
  "mission.complete": "mission",
  "request.delivered": "delivered",
  "request.joint": "joint",
  "approval.decided": "sunray"
};

function describe(inject: Inject): string {
  const site = (id?: string) => SITES.find((s) => s.id === id)?.name ?? id ?? "a site";
  switch (inject.type) {
    case "surge":
      return `Surge: ${inject.count ?? 3} new requests each`;
    case "flash":
      return `FLASH: casualties at ${site(inject.site)}`;
    case "bridge_out":
      return `Bridge out: road to ${site(inject.site)} cut`;
    case "bridge_open":
      return `Road to ${site(inject.site)} reopened`;
    case "weather":
      return inject.flying === "suspended" ? "Weather: flying suspended" : "Weather cleared: flying resumed";
    case "all_clear":
      return "All clear: roads open, flying resumed";
    case "message":
      return inject.text ? `Message: ${String(inject.text).slice(0, 160)}` : "Message cleared";
    default:
      return "Inject";
  }
}

async function fetchSnapshot(url: string): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${url}/api/state`, {
      headers: { "x-cell-client": "excon" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const snapshot = (await res.json()) as Snapshot;
    // Enough of a check that this is an ops room and not some other JSON.
    if (typeof snapshot?.cell?.callsign !== "string" || !Array.isArray(snapshot.missions) || !Array.isArray(snapshot.requests)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

async function sendInject(url: string, inject: Inject): Promise<{ ok: boolean; summary?: string; error?: string }> {
  try {
    const res = await fetch(`${url}/api/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cell-client": "excon" },
      body: JSON.stringify(inject),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const body = (await res.json().catch(() => ({}))) as { summary?: string; error?: string };
    return res.ok ? { ok: true, summary: body.summary } : { ok: false, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new Error("Request body must be JSON.");
  }
}

function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const CORS: HeadersInit = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-excon-pin"
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { ...CORS, "cache-control": "no-store" } });
}
