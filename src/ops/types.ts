/**
 * Shared types for Exercise ORANGE CLOUD.
 * You shouldn't need to edit this file for the guided path.
 */

/** Which kind of cell this ops room is. Set on the ops board. */
export type Role = "air" | "land";

/** Who did something. Shown as a badge on the ops board. */
export type Source =
  | "board" // someone clicked a button on the ops board
  | "api" // a direct REST API call (curl, scripts)
  | "mcp" // an MCP client such as Cloudflare OS, AI Playground or MCP Inspector
  | "agent" // your watchkeeper, calling your MCP server
  | "visitor" // a partner cell's watchkeeper, calling your MCP server
  | "excon" // exercise control: injects from the facilitators (or the Surge button)
  | "smoke"; // the smoke test script

/** Who is behind a call, as far as the ops room can tell. */
export interface Caller {
  source: Source;
  /** For visiting watchkeepers: the callsign of the cell they came from. */
  from?: string | null;
}

export type RequestStatus = "held" | "requested" | "tasked" | "en_route" | "delivered" | "cancelled";

export const REQUEST_STATUSES: readonly RequestStatus[] = ["held", "requested", "tasked", "en_route", "delivered", "cancelled"];

/** Message precedence, lowest to highest. FLASH is life-or-death. */
export type Precedence = "routine" | "priority" | "immediate" | "flash";

export const PRECEDENCES: readonly Precedence[] = ["routine", "priority", "immediate", "flash"];

export interface Identity {
  /** What this cell answers to, e.g. "KESTREL 1" */
  callsign: string;
  role: Role;
  /** False until someone has picked a role and callsign on the ops board. */
  setUp: boolean;
}

export interface StoreItem {
  id: string;
  name: string;
  /** Pallets on hand. 0 means none left. */
  stock: number;
  /** The floor. A request that would take stock below this is held for a human to approve. */
  reserve: number;
  description: string;
}

export interface Site {
  /** "alpha" to "hotel" */
  id: string;
  /** "DP ALPHA" */
  name: string;
  /** The village the distribution point serves. */
  place: string;
  /** Convoys can only reach a site while its road is open. */
  road: "open" | "cut";
}

export interface RequestLine {
  storeId: string;
  name: string;
  /** Pallets */
  qty: number;
}

/** A request for support: pallets of stores for one site. */
export interface SupportRequest {
  id: number;
  site: string;
  siteName: string;
  items: RequestLine[];
  /** Total pallets across all lines */
  pallets: number;
  precedence: Precedence;
  status: RequestStatus;
  source: Source;
  /** The callsign of the cell that raised it, when a partner's watchkeeper did. */
  from: string | null;
  note: string | null;
  /** Why it is waiting for the Duty Officer, when status is "held". */
  heldReason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Who moved the request to its current status */
  updatedBy: Source;
}

export interface RaiseRequestInput {
  site: string;
  items: { storeId: string; qty?: number }[];
  precedence?: Precedence;
  note?: string | null;
}

export interface ListRequestsFilter {
  /** "open" = anything not delivered or cancelled. Defaults to "open". */
  status?: RequestStatus | "open" | "all";
  site?: string;
  limit?: number;
}

export interface Conditions {
  /** Sorties can only launch while flying is open. */
  flying: "open" | "suspended";
  /** Site ids whose road is cut. */
  roadsCut: string[];
}

export interface Partner {
  /** The partner Worker's origin, e.g. https://ops-room.someone.workers.dev */
  url: string;
  callsign: string;
  role: Role;
}

/** The short picture a watchkeeper works from. This is what get_sitrep returns. */
export interface Sitrep {
  cell: { callsign: string; role: Role; lift: string; maxPalletsPerRequest: number };
  conditions: Conditions;
  stores: { id: string; name: string; onHand: number; reserve: number }[];
  sites: { id: string; name: string; place: string; road: "open" | "cut"; openRequests: number }[];
  requests: { held: number; requested: number; tasked: number; enRoute: number; delivered: number };
  partner: { callsign: string; role: Role } | null;
}

export interface OpsEvent {
  id: number;
  at: string;
  type: string;
  source: Source;
  message: string;
}

export interface Mission {
  id: string;
  title: string;
  hint: string;
  phase: number;
  bonus: boolean;
  done: boolean;
  doneAt: string | null;
}

/** An inject from exercise control. */
export type Inject =
  | { type: "surge"; count?: number }
  | { type: "flash"; site?: string }
  | { type: "bridge_out"; site: string }
  | { type: "bridge_open"; site: string }
  | { type: "weather"; flying: "open" | "suspended" }
  | { type: "all_clear" }
  | { type: "message"; text: string };

/** Everything the ops board (and exercise control) needs, in one object. */
export interface Snapshot {
  exercise: { name: string; island: string };
  cell: {
    callsign: string;
    role: Role;
    roleLabel: string;
    setUp: boolean;
    lift: string;
    enRouteLabel: string;
    maxPalletsPerRequest: number;
    openedAt: string;
    now: string;
  };
  conditions: Conditions;
  /** A message from exercise control, shown across the top of the board. */
  banner: { text: string; at: string } | null;
  partner: Partner | null;
  excon: { url: string | null; joined: boolean };
  stores: StoreItem[];
  sites: (Site & { openRequests: number; delivered: number })[];
  requests: SupportRequest[];
  missions: Mission[];
  events: OpsEvent[];
  stats: {
    raised: number;
    delivered: number;
    palletsDelivered: number;
    bySource: Partial<Record<Source, number>>;
    belowReserve: string[];
  };
}

/** Thrown for anything the caller did wrong. The message is safe to show to users and models. */
export class OpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsError";
  }
}

export function pallets(n: number): string {
  return `${n} pallet${n === 1 ? "" : "s"}`;
}
