import { DurableObject } from "cloudflare:workers";
import { KNOWN_TOOLS, MISSIONS, type MissionId } from "./missions";
import { EXERCISE, MAX_STOCK, ROLES, SITES, SURGE_NOTES, SURGE_PRECEDENCE, storesFor } from "./scenario";
import {
  OpsError,
  pallets,
  PRECEDENCES,
  REQUEST_STATUSES,
  type Caller,
  type Conditions,
  type Identity,
  type Inject,
  type ListRequestsFilter,
  type Mission,
  type OpsEvent,
  type Partner,
  type Precedence,
  type RaiseRequestInput,
  type RequestLine,
  type RequestStatus,
  type Role,
  type Site,
  type Sitrep,
  type Snapshot,
  type Source,
  type StoreItem,
  type SupportRequest
} from "./types";

type Row = Record<string, SqlStorageValue>;

const STATUS_RANK: Record<RequestStatus, number> = { held: 0, requested: 1, tasked: 2, en_route: 3, delivered: 4, cancelled: 4 };
const MAX_EVENTS = 300;
const MAX_LINE_QTY = 24;

/**
 * Your ops room's backend: one Durable Object with its own SQLite database.
 *
 * Everything else talks to it over RPC: the REST API, your MCP tools (via
 * src/ops/client.ts) and the ops board. There is one instance per
 * deployment, named "ops".
 */
export class OpsRoom extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  // ---------------------------------------------------------------------------
  // Who this cell is
  // ---------------------------------------------------------------------------

  identity(): Identity {
    const role: Role = this.meta("role") === "land" ? "land" : "air";
    return { callsign: this.meta("callsign") ?? ROLES[role].callsign, role, setUp: this.meta("set_up") === "1" };
  }

  /** Pick a role and callsign. Changing role swaps the stores and clears the requests. */
  setUp(input: { role?: string; callsign?: string }, caller: Caller): Identity {
    const role = input.role === "air" || input.role === "land" ? input.role : null;
    if (!role) throw new OpsError('Role must be "air" or "land".');
    const callsign = cleanCallsign(input.callsign);
    if (!callsign) throw new OpsError("A callsign needs 2 to 16 letters, numbers or spaces, like KESTREL 1.");
    const before = this.identity();
    this.setMeta("callsign", callsign);
    this.setMeta("set_up", "1");
    if (role !== before.role) {
      this.setMeta("role", role);
      this.sql.exec("DELETE FROM requests");
      this.seedStores();
    }
    this.log("cell.setup", caller.source, `This ops room is ${callsign}, ${ROLES[role].label.toLowerCase()}`);
    if (caller.source !== "smoke") this.complete("ops_room_open");
    return this.identity();
  }

  // ---------------------------------------------------------------------------
  // The picture: stores, sites and conditions
  // ---------------------------------------------------------------------------

  getStores(): StoreItem[] {
    return this.sql
      .exec("SELECT * FROM stores ORDER BY position")
      .toArray()
      .map(rowToStore);
  }

  getSites(): Site[] {
    const cut = new Set(this.conditions().roadsCut);
    return SITES.map((s) => ({ id: s.id, name: s.name, place: s.place, road: cut.has(s.id) ? "cut" : "open" }));
  }

  conditions(): Conditions {
    return {
      flying: this.meta("flying") === "suspended" ? "suspended" : "open",
      roadsCut: parseJson<string[]>(this.meta("roads_cut"), [])
    };
  }

  /** The short picture a watchkeeper works from. */
  sitrep(): Sitrep {
    const who = this.identity();
    const cfg = ROLES[who.role];
    const open = new Map(
      this.sql
        .exec("SELECT site, COUNT(*) AS n FROM requests WHERE status NOT IN ('delivered', 'cancelled') GROUP BY site")
        .toArray()
        .map((r) => [String(r.site), Number(r.n)])
    );
    const byStatus = new Map(
      this.sql
        .exec("SELECT status, COUNT(*) AS n FROM requests GROUP BY status")
        .toArray()
        .map((r) => [String(r.status), Number(r.n)])
    );
    const partner = this.getPartner();
    return {
      cell: { callsign: who.callsign, role: who.role, lift: cfg.lift, maxPalletsPerRequest: cfg.maxPallets },
      conditions: this.conditions(),
      stores: this.getStores().map((s) => ({ id: s.id, name: s.name, onHand: s.stock, reserve: s.reserve })),
      sites: this.getSites().map((s) => ({ ...s, openRequests: open.get(s.id) ?? 0 })),
      requests: {
        held: byStatus.get("held") ?? 0,
        requested: byStatus.get("requested") ?? 0,
        tasked: byStatus.get("tasked") ?? 0,
        enRoute: byStatus.get("en_route") ?? 0,
        delivered: byStatus.get("delivered") ?? 0
      },
      partner: partner ? { callsign: partner.callsign, role: partner.role } : null
    };
  }

  resupply(storeRef: string, quantity: number, caller: Caller): StoreItem {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw new OpsError("Resupply quantity must be a whole number of pallets between 1 and 50.");
    }
    const store = this.findStore(storeRef);
    const stock = Math.min(MAX_STOCK, store.stock + quantity);
    this.sql.exec("UPDATE stores SET stock = ? WHERE id = ?", stock, store.id);
    this.log("stores.resupplied", caller.source, `Resupplied ${store.name}: ${store.stock} → ${stock} pallets`);
    if (caller.source === "mcp" || caller.source === "agent") this.complete("resupplied");
    return { ...store, stock };
  }

  // ---------------------------------------------------------------------------
  // Requests for support
  // ---------------------------------------------------------------------------

  listRequests(filter: ListRequestsFilter = {}): SupportRequest[] {
    const status = filter.status ?? "open";
    const clauses: string[] = [];
    const params: SqlStorageValue[] = [];
    if (status === "open") clauses.push("status NOT IN ('delivered', 'cancelled')");
    else if (status !== "all") {
      if (!REQUEST_STATUSES.includes(status)) throw new OpsError(`Unknown status "${status}".`);
      clauses.push("status = ?");
      params.push(status);
    }
    if (filter.site !== undefined && filter.site !== null && filter.site !== "") {
      clauses.push("site = ?");
      params.push(this.findSite(String(filter.site)).id);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    return this.sql
      .exec(`SELECT * FROM requests ${where} ORDER BY id DESC LIMIT ${limit}`, ...params)
      .toArray()
      .map(rowToRequest);
  }

  getRequest(id: number): SupportRequest {
    const row = this.sql.exec("SELECT * FROM requests WHERE id = ?", id).toArray()[0];
    if (!row) throw new OpsError(`There is no request #${id}. Use list_requests to see current requests.`);
    return rowToRequest(row);
  }

  /** Raise a request for support. Stock is committed straight away, unless the request is held. */
  raiseRequest(input: RaiseRequestInput, caller: Caller): SupportRequest {
    return this.createRequest(input, caller, false);
  }

  private createRequest(input: RaiseRequestInput, caller: Caller, fromExcon: boolean): SupportRequest {
    const who = this.identity();
    const cfg = ROLES[who.role];
    const site = this.findSite(String(input?.site ?? ""));
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new OpsError("A request needs at least one line of stores.");
    }
    const precedence: Precedence = input.precedence ?? "routine";
    if (!PRECEDENCES.includes(precedence)) {
      throw new OpsError(`Precedence must be one of ${PRECEDENCES.join(", ")}.`);
    }

    // Merge duplicate lines and check everything before touching stock.
    const wanted = new Map<string, { store: StoreItem; qty: number }>();
    for (const line of input.items) {
      const qty = line.qty ?? 1;
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
        throw new OpsError(`Each quantity must be a whole number of pallets between 1 and ${MAX_LINE_QTY}.`);
      }
      const store = this.findStore(String(line.storeId ?? ""));
      wanted.set(store.id, { store, qty: (wanted.get(store.id)?.qty ?? 0) + qty });
    }
    const total = [...wanted.values()].reduce((sum, w) => sum + w.qty, 0);
    if (total > cfg.maxPallets) {
      const handOver = who.role === "air" ? ", or hand it to a Land cell: a convoy carries 24" : "";
      throw new OpsError(
        `A ${cfg.lift} carries at most ${pallets(cfg.maxPallets)} and this asks for ${total}. Split it into smaller requests${handOver}.`
      );
    }
    // Requests from exercise control arrive whatever the conditions. That's the point of them.
    if (!fromExcon) this.assertCanMove(site, who.role);
    for (const { store, qty } of wanted.values()) {
      if (store.stock < qty) {
        throw new OpsError(
          store.stock === 0
            ? `There is no ${store.name} left. Resupply it first or send something else.`
            : `Only ${pallets(store.stock)} of ${store.name} on hand, but the request asks for ${qty}. Resupply first or send less.`
        );
      }
    }

    // A request that would take a store below its reserve is held for a human to decide.
    const dips = [...wanted.values()].filter(({ store, qty }) => store.stock - qty < store.reserve);
    const held = !fromExcon && dips.length > 0;
    const heldReason = held ? `Takes ${dips.map((d) => d.store.name.toLowerCase()).join(" and ")} below reserve` : null;

    const lines: RequestLine[] = [...wanted.values()].map(({ store, qty }) => ({ storeId: store.id, name: store.name, qty }));
    if (!held) {
      for (const line of lines) this.sql.exec("UPDATE stores SET stock = stock - ? WHERE id = ?", line.qty, line.storeId);
    }
    const note = input.note ? String(input.note).slice(0, 140) : null;
    const now = new Date().toISOString();
    const id = Number(this.sql.exec("SELECT COALESCE(MAX(id), 100) + 1 AS id FROM requests").one().id);
    this.sql.exec(
      `INSERT INTO requests (id, site, items, pallets, precedence, status, source, from_cell, note, held_reason, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      site.id,
      JSON.stringify(lines),
      total,
      precedence,
      held ? "held" : "requested",
      caller.source,
      caller.source === "visitor" ? (caller.from ?? "A partner cell") : null,
      note,
      heldReason,
      now,
      now,
      caller.source
    );

    const summary = lines.map((l) => `${l.qty}× ${l.name.toLowerCase()}`).join(", ");
    const urgency = precedence === "routine" ? "" : ` (${precedence.toUpperCase()})`;
    const raisedBy = caller.source === "visitor" ? `, raised by ${caller.from ?? "a partner cell"}` : "";
    this.log(
      caller.source === "visitor" ? "request.joint" : held ? "request.held" : "request.raised",
      caller.source,
      `#${id}: ${site.name} needs ${summary}${urgency}${raisedBy}${held ? `. Held for the Duty Officer: ${heldReason!.toLowerCase()}` : ""}`
    );
    if (caller.source === "mcp" || caller.source === "agent") this.complete("request_raised");
    if (caller.source === "agent") this.complete("watch_raises");
    if (caller.source === "visitor") {
      this.complete("link");
      this.complete("joint");
    }
    return this.getRequest(id);
  }

  updateRequestStatus(id: number, status: RequestStatus, caller: Caller): SupportRequest {
    if (!REQUEST_STATUSES.includes(status) || status === "held" || status === "requested") {
      throw new OpsError('Status must be one of "tasked", "en_route", "delivered" or "cancelled".');
    }
    const request = this.getRequest(id);
    if (request.status === status) return request;
    if (request.status === "delivered" || request.status === "cancelled") {
      throw new OpsError(`#${id} is already ${request.status}, so it can't change any more.`);
    }
    if (request.status === "held" && status !== "cancelled") {
      throw new OpsError(
        `#${id} is held for the Duty Officer. A human has to approve it on the ops board before it can move. It can be cancelled instead.`
      );
    }
    if (status !== "cancelled" && STATUS_RANK[status] < STATUS_RANK[request.status]) {
      throw new OpsError(`#${id} is already ${request.status}. Requests only move forward: requested → tasked → en_route → delivered.`);
    }
    const who = this.identity();
    const site = this.findSite(request.site);
    const setsOff = (status === "en_route" || status === "delivered") && STATUS_RANK[request.status] < STATUS_RANK.en_route;
    if (setsOff) this.assertCanMove(site, who.role);
    if (status === "cancelled" && request.status !== "held") {
      for (const line of request.items) {
        this.sql.exec("UPDATE stores SET stock = MIN(?, stock + ?) WHERE id = ?", MAX_STOCK, line.qty, line.storeId);
      }
    }
    this.sql.exec(
      "UPDATE requests SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      status,
      new Date().toISOString(),
      caller.source,
      id
    );

    const verb = {
      tasked: `was tasked to a ${ROLES[who.role].lift}`,
      en_route: who.role === "air" ? `is airborne for ${site.name}` : `is on the road to ${site.name}`,
      delivered: `was delivered to ${site.name}`,
      cancelled: "was cancelled"
    }[status as "tasked" | "en_route" | "delivered" | "cancelled"];
    this.log(status === "delivered" ? "request.delivered" : "request.status", caller.source, `#${id} ${verb}`);
    if (caller.source === "mcp" || caller.source === "agent") this.complete("on_the_move");
    if (status === "delivered") {
      if (request.precedence === "flash" && caller.source !== "smoke") this.complete("flash");
      if (caller.source === "agent" && request.source === "agent") this.complete("watch_delivers");
    }
    return this.getRequest(id);
  }

  /**
   * The Duty Officer's decision on a held request. Only the ops board and the
   * REST API can reach this. There is no MCP tool for it, on purpose: the
   * watchkeeper recommends, a human decides.
   */
  decideHeld(id: number, decision: "approved" | "rejected", caller: Caller): SupportRequest {
    if (decision !== "approved" && decision !== "rejected") {
      throw new OpsError('Decision must be "approved" or "rejected".');
    }
    const request = this.getRequest(id);
    if (request.status !== "held") throw new OpsError(`#${id} isn't held, so there is nothing to decide.`);
    if (decision === "approved") {
      const stores = new Map(this.getStores().map((s) => [s.id, s]));
      for (const line of request.items) {
        const onHand = stores.get(line.storeId)?.stock ?? 0;
        if (onHand < line.qty) {
          throw new OpsError(`Can't release #${id}: only ${pallets(onHand)} of ${line.name} on hand now. Resupply first, or reject it.`);
        }
      }
      for (const line of request.items) this.sql.exec("UPDATE stores SET stock = stock - ? WHERE id = ?", line.qty, line.storeId);
    }
    this.sql.exec(
      "UPDATE requests SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      decision === "approved" ? "requested" : "cancelled",
      new Date().toISOString(),
      caller.source,
      id
    );
    this.log(
      "approval.decided",
      caller.source,
      decision === "approved" ? `The Duty Officer released the reserve for #${id}` : `The Duty Officer rejected #${id}`
    );
    if (caller.source !== "smoke") this.complete("sunray");
    return this.getRequest(id);
  }

  // ---------------------------------------------------------------------------
  // Exercise control: injects
  // ---------------------------------------------------------------------------

  /** Apply an inject from exercise control (or the Surge button on the board). */
  inject(inject: Inject): { ok: true; summary: string } {
    switch (inject?.type) {
      case "surge": {
        const raised = this.surge(inject.count ?? 3);
        return { ok: true, summary: `${raised.length} new request${raised.length === 1 ? "" : "s"}` };
      }
      case "flash": {
        const request = this.flash(inject.site);
        return { ok: true, summary: `FLASH request #${request.id} for ${request.siteName}` };
      }
      case "bridge_out": {
        // No site given: pick one whose road is still open.
        const stillOpen = this.getSites().filter((s) => s.road === "open");
        const site = inject.site ?? (stillOpen.length ? pick(stillOpen).id : SITES[0].id);
        return { ok: true, summary: this.setRoad(site, "cut") };
      }
      case "bridge_open":
        return { ok: true, summary: this.setRoad(inject.site, "open") };
      case "weather":
        return { ok: true, summary: this.setFlying(inject.flying === "suspended" ? "suspended" : "open") };
      case "all_clear":
        this.setMeta("roads_cut", "[]");
        this.setMeta("flying", "open");
        this.log("excon.all_clear", "excon", "All clear: every road is open and flying has resumed");
        return { ok: true, summary: "All clear" };
      case "message": {
        const text = String(inject.text ?? "").trim().slice(0, 160);
        this.setMeta("banner", text ? JSON.stringify({ text, at: new Date().toISOString() }) : "");
        if (text) this.log("excon.message", "excon", `EXCON: ${text}`);
        return { ok: true, summary: text ? "Message shown" : "Message cleared" };
      }
      default:
        throw new OpsError("Unknown inject. Types: surge, flash, bridge_out, bridge_open, weather, all_clear, message.");
    }
  }

  /** A batch of new requests from the distribution points. */
  private surge(count: number): SupportRequest[] {
    const n = Math.min(Math.max(Math.floor(count) || 1, 1), 6);
    const who = this.identity();
    const maxQty = who.role === "air" ? 2 : 5;
    const raised: SupportRequest[] = [];
    for (let i = 0; i < n; i++) {
      const lines = new Map<string, number>();
      const lineCount = 1 + Math.floor(Math.random() * 2);
      for (let j = 0; j < lineCount; j++) {
        // Surge requests leave the reserve alone, so they never need the Duty Officer.
        const spare = this.getStores().filter((s) => s.stock - s.reserve - (lines.get(s.id) ?? 0) > 0);
        if (!spare.length) break;
        const store = pick(spare);
        const room = store.stock - store.reserve - (lines.get(store.id) ?? 0);
        const qty = Math.min(room, 1 + Math.floor(Math.random() * maxQty));
        lines.set(store.id, (lines.get(store.id) ?? 0) + qty);
      }
      if (!lines.size) continue;
      try {
        raised.push(
          this.createRequest(
            {
              site: pick(SITES).id,
              items: [...lines].map(([storeId, qty]) => ({ storeId, qty })),
              precedence: pick(SURGE_PRECEDENCE),
              note: pick(SURGE_NOTES)
            },
            { source: "excon" },
            true
          )
        );
      } catch {
        // Ran out of something, or the load was too big for one lift. Fine.
      }
    }
    return raised;
  }

  /** One FLASH request for medical supplies. Exercise control makes sure there is enough to send. */
  private flash(siteRef?: string): SupportRequest {
    const site = siteRef ? this.findSite(siteRef) : pick(this.getSites());
    const qty = 2;
    const medical = this.findStore("medical");
    if (medical.stock < qty) {
      this.sql.exec("UPDATE stores SET stock = stock + ? WHERE id = ?", qty, medical.id);
      this.log("stores.resupplied", "excon", `Exercise control pre-positioned ${pallets(qty)} of ${medical.name.toLowerCase()}`);
    }
    return this.createRequest(
      { site: site.id, items: [{ storeId: medical.id, qty }], precedence: "flash", note: "Casualties at the clinic" },
      { source: "excon" },
      true
    );
  }

  private setRoad(siteRef: string, road: "open" | "cut"): string {
    const site = this.findSite(String(siteRef ?? ""));
    const cut = new Set(this.conditions().roadsCut);
    if (road === "cut") cut.add(site.id);
    else cut.delete(site.id);
    this.setMeta("roads_cut", JSON.stringify([...cut]));
    const summary =
      road === "cut"
        ? `Bridge out: the road to ${site.name} (${site.place}) is cut`
        : `The road to ${site.name} (${site.place}) has reopened`;
    this.log(road === "cut" ? "excon.bridge_out" : "excon.bridge_open", "excon", summary);
    return summary;
  }

  private setFlying(flying: "open" | "suspended"): string {
    this.setMeta("flying", flying);
    const summary = flying === "suspended" ? "Weather: flying is suspended" : "Weather has cleared: flying has resumed";
    this.log("excon.weather", "excon", summary);
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Partner cell and exercise control
  // ---------------------------------------------------------------------------

  getPartner(): Partner | null {
    return parseJson<Partner | null>(this.meta("partner"), null);
  }

  setPartner(partner: Partner, caller: Caller): Partner {
    this.setMeta("partner", JSON.stringify(partner));
    this.log("partner.set", caller.source, `Partner cell set: ${partner.callsign}, ${ROLES[partner.role].label.toLowerCase()}`);
    return partner;
  }

  clearPartner(caller: Caller) {
    if (!this.getPartner()) return;
    this.setMeta("partner", "");
    this.log("partner.cleared", caller.source, "Partner cell removed");
  }

  /** True when it is time to (re)introduce this cell to exercise control. */
  exconDue(): boolean {
    const last = Number(this.meta("excon_tried_at") ?? 0);
    if (Date.now() - last < 60_000) return false;
    this.setMeta("excon_tried_at", String(Date.now()));
    return true;
  }

  noteExcon(joined: boolean) {
    this.setMeta("excon_joined", joined ? "1" : "");
  }

  // ---------------------------------------------------------------------------
  // Activity tracking (feeds the mission board)
  // ---------------------------------------------------------------------------

  /** Called by the Worker for every MCP request so the mission board can react. */
  trackMcp(input: { method: string; tool?: string; caller: Caller }) {
    const { method, tool, caller } = input;
    const source = caller.source;
    if (source === "smoke") return;
    const who =
      source === "visitor"
        ? `${caller.from ?? "A partner cell"}'s watchkeeper`
        : ({ mcp: "An MCP client", agent: "Your watchkeeper" } as Record<string, string>)[source] ?? source;
    if (method === "tools/list") {
      this.log("mcp.tools_list", source, `${who} listed your MCP tools`);
      if (source === "mcp") this.complete("comms_check");
    } else if (method === "tools/call") {
      this.log("mcp.tool_call", source, `${who} called ${tool ?? "a tool"}`);
      if (source === "mcp") {
        this.complete("comms_check");
        this.complete("first_sitrep");
      }
      if (tool && !KNOWN_TOOLS.has(tool)) this.complete("field_mod");
    }
    if (source === "visitor") this.complete("link");
  }

  /** Called by your watchkeeper after each reply (see src/ops/agent-kit.ts). */
  noteAgentReply(input: { toolCount: number; toolsUsed: string[] }) {
    const used = input.toolsUsed.length ? ` using ${input.toolsUsed.join(", ")}` : "";
    this.log("agent.reply", "agent", `Your watchkeeper replied${used}`);
    if (input.toolCount > 0) this.complete("watch_on");
  }

  noteModelFallback(input: { first: string; fallback: string; why: "slow" | "failing"; minutes: number }) {
    const short = (name: string) => name.split("/").pop() ?? name;
    this.log(
      "agent.model",
      "agent",
      `The watchkeeper's model (${short(input.first)}) is ${input.why}. Using ${short(input.fallback)} for the next ${input.minutes} minutes`
    );
  }

  noteScheduledTask(description: string) {
    this.log("agent.scheduled", "agent", `Standing orders ran: ${description.slice(0, 120)}`);
    this.complete("standing_orders");
  }

  noteLink(partner: string) {
    this.log("partner.link", "agent", `Your watchkeeper is on ${partner}'s net`);
    this.complete("link");
  }

  noteJointTasking(partner: string) {
    this.log("request.handed_over", "agent", `Your watchkeeper raised a request with ${partner}`);
    this.complete("joint");
  }

  // ---------------------------------------------------------------------------
  // Board helpers
  // ---------------------------------------------------------------------------

  snapshot(exconUrl: string | null = null): Snapshot {
    const who = this.identity();
    const cfg = ROLES[who.role];
    const stores = this.getStores();
    const open = this.listRequests({ status: "open", limit: 100 });
    const done = this.sql
      .exec("SELECT * FROM requests WHERE status IN ('delivered', 'cancelled') ORDER BY updated_at DESC LIMIT 12")
      .toArray()
      .map(rowToRequest);
    const events = this.sql
      .exec("SELECT * FROM events ORDER BY id DESC LIMIT 40")
      .toArray()
      .map(rowToEvent);
    const doneMissions = new Map(
      this.sql.exec("SELECT id, done_at FROM missions").toArray().map((r) => [String(r.id), String(r.done_at)])
    );
    const missions: Mission[] = MISSIONS.map((m) => ({
      id: m.id,
      title: m.title,
      hint: m.hint,
      phase: m.phase,
      bonus: Boolean(m.bonus),
      done: doneMissions.has(m.id),
      doneAt: doneMissions.get(m.id) ?? null
    }));

    const perSite = new Map<string, { open: number; delivered: number }>();
    for (const r of this.sql
      .exec(
        `SELECT site,
                SUM(CASE WHEN status NOT IN ('delivered', 'cancelled') THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered
         FROM requests GROUP BY site`
      )
      .toArray()) {
      perSite.set(String(r.site), { open: Number(r.open), delivered: Number(r.delivered) });
    }
    const totals = this.sql
      .exec(
        `SELECT SUM(CASE WHEN status != 'cancelled' THEN 1 ELSE 0 END) AS raised,
                SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN status = 'delivered' THEN pallets ELSE 0 END) AS pallets
         FROM requests`
      )
      .one();
    const bySource: Partial<Record<Source, number>> = {};
    for (const r of this.sql.exec("SELECT source, COUNT(*) AS n FROM requests GROUP BY source").toArray()) {
      bySource[String(r.source) as Source] = Number(r.n);
    }

    return {
      exercise: { name: EXERCISE.name, island: EXERCISE.island },
      cell: {
        callsign: who.callsign,
        role: who.role,
        roleLabel: cfg.label,
        setUp: who.setUp,
        lift: cfg.lift,
        enRouteLabel: cfg.enRouteLabel,
        maxPalletsPerRequest: cfg.maxPallets,
        openedAt: this.meta("opened_at") ?? new Date().toISOString(),
        now: new Date().toISOString()
      },
      conditions: this.conditions(),
      banner: parseJson<{ text: string; at: string } | null>(this.meta("banner"), null),
      partner: this.getPartner(),
      excon: { url: exconUrl, joined: this.meta("excon_joined") === "1" },
      stores,
      sites: this.getSites().map((s) => ({
        ...s,
        openRequests: perSite.get(s.id)?.open ?? 0,
        delivered: perSite.get(s.id)?.delivered ?? 0
      })),
      requests: [...open, ...done],
      missions,
      events,
      stats: {
        raised: Number(totals.raised ?? 0),
        delivered: Number(totals.delivered ?? 0),
        palletsDelivered: Number(totals.pallets ?? 0),
        bySource,
        belowReserve: stores.filter((s) => s.stock <= s.reserve).map((s) => s.name)
      }
    };
  }

  /** Fresh stores and no requests. The mission board, role, callsign and partner are kept. */
  reset() {
    this.sql.exec("DELETE FROM requests");
    this.sql.exec("DELETE FROM events");
    this.seedStores();
    this.log("cell.reset", "board", "The ops room was reset: fresh stores, no requests");
  }

  /** Also wipes the mission board, the partner and any injects. Used by the smoke test's --reset flag. */
  resetEverything() {
    this.reset();
    this.sql.exec("DELETE FROM missions");
    for (const key of ["partner", "banner", "set_up"]) this.setMeta(key, "");
    this.setMeta("roads_cut", "[]");
    this.setMeta("flying", "open");
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** A cell won't take on a move it can't make right now. The error says who can. */
  private assertCanMove(site: Site, role: Role) {
    if (role === "land" && site.road === "cut") {
      throw new OpsError(
        `The road to ${site.name} is cut, so a convoy can't get there. An Air cell can fly it in: hand the request to one.`
      );
    }
    if (role === "air" && this.conditions().flying === "suspended") {
      throw new OpsError(
        "Flying is suspended, so nothing can launch until exercise control clears it. A Land cell can still move by road: hand the request to one."
      );
    }
  }

  /** Find a store by id or by (part of) its name, so models can be a bit sloppy. */
  private findStore(ref: string): StoreItem {
    const stores = this.getStores();
    const key = norm(ref);
    if (!key) throw new OpsError("Missing store id. Use get_sitrep to see store ids.");
    const exact = stores.find((s) => norm(s.id) === key || norm(s.name) === key);
    if (exact) return exact;
    const partial = stores.filter((s) => norm(s.id).includes(key) || norm(s.name).includes(key));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      throw new OpsError(`"${ref}" could mean ${partial.map((s) => s.id).join(" or ")}. Use an exact store id.`);
    }
    throw new OpsError(`"${ref}" isn't a store this cell holds. Valid store ids: ${stores.map((s) => s.id).join(", ")}.`);
  }

  /** Find a site by id ("echo"), name ("DP ECHO") or place ("Highfold"). */
  private findSite(ref: string): Site {
    const sites = this.getSites();
    const key = norm(ref).replace(/^dp/, "");
    const site = key ? sites.find((s) => s.id === key || norm(s.place) === key) : undefined;
    if (!site) {
      throw new OpsError(`"${ref}" isn't a distribution point. Valid site ids: ${sites.map((s) => s.id).join(", ")}.`);
    }
    return site;
  }

  private complete(id: MissionId) {
    const exists = this.sql.exec("SELECT 1 FROM missions WHERE id = ?", id).toArray().length > 0;
    if (exists) return;
    this.sql.exec("INSERT INTO missions (id, done_at) VALUES (?, ?)", id, new Date().toISOString());
    const def = MISSIONS.find((m) => m.id === id);
    this.log("mission.complete", "board", `Mission complete: ${def?.title ?? id}`);
  }

  private log(type: string, source: Source, message: string) {
    this.sql.exec(
      "INSERT INTO events (at, type, source, message) VALUES (?, ?, ?, ?)",
      new Date().toISOString(),
      type,
      source,
      message
    );
    this.sql.exec("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?", MAX_EVENTS);
  }

  private meta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row && row.value !== null && row.value !== "" ? String(row.value) : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS stores (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, stock INTEGER NOT NULL, reserve INTEGER NOT NULL,
        description TEXT NOT NULL, position INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY, site TEXT NOT NULL, items TEXT NOT NULL, pallets INTEGER NOT NULL,
        precedence TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, from_cell TEXT, note TEXT,
        held_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL,
        source TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, done_at TEXT NOT NULL);
    `);
    if (!this.meta("opened_at")) {
      this.setMeta("opened_at", new Date().toISOString());
      // A starting callsign nobody else is likely to have, until the team picks their own.
      this.setMeta("role", "air");
      this.setMeta("callsign", `${ROLES.air.callsign} ${10 + Math.floor(Math.random() * 90)}`);
    }
    if (Number(this.sql.exec("SELECT COUNT(*) AS n FROM stores").one().n) === 0) {
      this.seedStores();
    }
  }

  private seedStores() {
    this.sql.exec("DELETE FROM stores");
    storesFor(this.identity().role).forEach((s, position) => {
      this.sql.exec(
        "INSERT INTO stores (id, name, stock, reserve, description, position) VALUES (?, ?, ?, ?, ?, ?)",
        s.id,
        s.name,
        s.stock,
        s.reserve,
        s.description,
        position
      );
    });
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Callsigns are short and shouty: letters, numbers, spaces and hyphens. */
export function cleanCallsign(value: unknown): string | null {
  const callsign = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16)
    .trim();
  return callsign.length >= 2 ? callsign : null;
}

function rowToStore(r: Row): StoreItem {
  return {
    id: String(r.id),
    name: String(r.name),
    stock: Number(r.stock),
    reserve: Number(r.reserve),
    description: String(r.description)
  };
}

function rowToRequest(r: Row): SupportRequest {
  const siteId = String(r.site);
  return {
    id: Number(r.id),
    site: siteId,
    siteName: SITES.find((s) => s.id === siteId)?.name ?? siteId,
    items: JSON.parse(String(r.items)) as RequestLine[],
    pallets: Number(r.pallets),
    precedence: String(r.precedence) as Precedence,
    status: String(r.status) as RequestStatus,
    source: String(r.source) as Source,
    from: r.from_cell === null ? null : String(r.from_cell),
    note: r.note === null ? null : String(r.note),
    heldReason: r.held_reason === null ? null : String(r.held_reason),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    updatedBy: String(r.updated_by) as Source
  };
}

function rowToEvent(r: Row): OpsEvent {
  return {
    id: Number(r.id),
    at: String(r.at),
    type: String(r.type),
    source: String(r.source) as Source,
    message: String(r.message)
  };
}
