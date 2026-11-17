import { ROLES } from "./scenario";
import type { Caller, Identity, ListRequestsFilter, RaiseRequestInput, RequestStatus } from "./types";

/**
 * A small typed client for your ops room's backend (the OpsRoom Durable Object).
 *
 * Your MCP tools get one of these, already labelled with who is calling
 * (an MCP client, your watchkeeper or a partner cell's watchkeeper), so the
 * ops board can show where each request came from.
 *
 * Every method returns plain JSON-friendly data. When something is wrong
 * (not enough stock, unknown site, a road that's cut) it throws an Error with
 * a message that is safe to show to people and models.
 */
export function cellFor(env: Env, caller: Caller, who: Identity) {
  const store = () => env.OPS.getByName("ops");
  const cfg = ROLES[who.role];
  return {
    /** What this cell answers to, e.g. "KESTREL 1". */
    callsign: who.callsign,
    /** "air" or "land". */
    role: who.role,
    /** The cell in full, e.g. "Air cell KESTREL 1". Put it in tool descriptions so a model knows whose tools these are. */
    label: `${cfg.label} ${who.callsign}`,
    /** One line on what this kind of cell can and can't do. */
    about: cfg.blurb,

    /** The current picture: callsign, conditions, stores, sites and request counts. */
    getSitrep: () => store().sitrep(),

    /** Requests, newest first. Defaults to open requests (not delivered or cancelled). */
    listRequests: (filter: ListRequestsFilter = {}) => store().listRequests(filter),

    /** One request by its number, e.g. 101. */
    getRequest: (requestId: number) => store().getRequest(requestId),

    /**
     * Raise a request for support. Store ids and site ids come from getSitrep().
     * Stock is committed straight away. If the request would take a store below
     * its reserve it comes back with status "held" and waits for a human.
     */
    raiseRequest: (input: RaiseRequestInput) => store().raiseRequest(input, caller),

    /** Move a request along: "tasked" → "en_route" → "delivered", or "cancelled". */
    updateRequestStatus: (requestId: number, status: RequestStatus) => store().updateRequestStatus(requestId, status, caller),

    /** Add pallets to a store after a resupply run. */
    resupplyStore: (storeId: string, quantity: number) => store().resupply(storeId, quantity, caller)
  };
}

export type Cell = ReturnType<typeof cellFor>;
