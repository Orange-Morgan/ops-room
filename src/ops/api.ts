import { cleanCallsign } from "./store";
import { REQUEST_STATUSES, type Caller, type Inject, type RequestStatus, type Role, type Source } from "./types";

/**
 * Your ops room's REST API. The ops board uses it, and so can you (curl,
 * scripts, your own frontend).
 *
 *   GET    /api/state                     everything the ops board needs in one call
 *   GET    /api/sitrep                    the short picture (what get_sitrep returns)
 *   POST   /api/setup                     { role: "air" | "land", callsign }
 *   GET    /api/stores                    stores with pallets on hand and reserve
 *   POST   /api/stores/:storeId/resupply  { quantity }
 *   GET    /api/requests?status=open      requests (open | held | requested | tasked | en_route | delivered | cancelled | all)
 *   POST   /api/requests                  { site, items: [{ storeId, qty }], precedence?, note? }
 *   GET    /api/requests/:id
 *   PATCH  /api/requests/:id              { status }
 *   POST   /api/requests/:id/decision     { decision: "approved" | "rejected" } for a held request
 *   POST   /api/partner                   { url } link a partner cell
 *   DELETE /api/partner
 *   POST   /api/inject                    { type, ... } an inject from exercise control
 *   POST   /api/reset                     fresh stores, no requests (missions are kept)
 */
export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method.toUpperCase();
  const store = env.OPS.getByName("ops");
  // The board and exercise control label their own requests, so the badges on the board are right.
  const client = request.headers.get("x-cell-client");
  const source: Source = client === "board" || client === "excon" || client === "smoke" ? client : "api";
  const caller: Caller = { source };

  try {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    if (path === "/api/state" && method === "GET") {
      const excon = exconUrl(env);
      if (source === "board") ctx.waitUntil(reportToExcon(env, url.origin));
      return json(await store.snapshot(excon));
    }

    if (path === "/api/sitrep" && method === "GET") return json(await store.sitrep());

    if (path === "/api/setup" && method === "POST") {
      const body = await readJson(request);
      const who = await store.setUp({ role: String(body.role ?? ""), callsign: String(body.callsign ?? "") }, caller);
      return json(who);
    }

    if (path === "/api/stores" && method === "GET") return json(await store.getStores());

    let m = path.match(/^\/api\/stores\/([^/]+)\/resupply$/);
    if (m && method === "POST") {
      const body = await readJson(request);
      return json(await store.resupply(decodeURIComponent(m[1]), Number(body.quantity ?? 10), caller));
    }

    if (path === "/api/requests" && method === "GET") {
      const status = (url.searchParams.get("status") ?? "open") as RequestStatus | "open" | "all";
      return json(await store.listRequests({ status, site: url.searchParams.get("site") ?? undefined }));
    }

    if (path === "/api/requests" && method === "POST") {
      const body = await readJson(request);
      return json(await store.raiseRequest(body as never, caller), 201);
    }

    m = path.match(/^\/api\/requests\/(\d+)$/);
    if (m && method === "GET") return json(await store.getRequest(Number(m[1])));
    if (m && method === "PATCH") {
      const body = await readJson(request);
      const status = String(body.status ?? "") as RequestStatus;
      if (!REQUEST_STATUSES.includes(status)) return error(`status must be one of ${REQUEST_STATUSES.join(", ")}`, 400);
      return json(await store.updateRequestStatus(Number(m[1]), status, caller));
    }

    m = path.match(/^\/api\/requests\/(\d+)\/decision$/);
    if (m && method === "POST") {
      const body = await readJson(request);
      return json(await store.decideHeld(Number(m[1]), body.decision as "approved" | "rejected", caller));
    }

    if (path === "/api/partner" && method === "POST") {
      const body = await readJson(request);
      return json(await store.setPartner(await lookUpPartner(String(body.url ?? ""), url.origin), caller));
    }
    if (path === "/api/partner" && method === "DELETE") {
      await store.clearPartner(caller);
      return json({ ok: true });
    }

    if (path === "/api/inject" && method === "POST") {
      const body = await readJson(request);
      return json(await store.inject(body as Inject));
    }

    if (path === "/api/reset" && method === "POST") {
      const body = await readJson(request);
      if (body.everything === true) await store.resetEverything();
      else await store.reset();
      return json({ ok: true });
    }

    return error(`No API route for ${method} ${path}`, 404);
  } catch (e) {
    // Errors from the store carry friendly messages (not enough stock, road cut...).
    return error(e instanceof Error ? e.message : String(e), 400);
  }
}

// -----------------------------------------------------------------------------
// Partner cell
// -----------------------------------------------------------------------------

/** Ask the other ops room who it is, so the board (and your watchkeeper) can name it. */
async function lookUpPartner(input: string, ownOrigin: string): Promise<{ url: string; callsign: string; role: Role }> {
  let origin: string;
  try {
    origin = new URL(input.trim()).origin;
  } catch {
    throw new Error("Paste your partner's Worker URL, like https://ops-room.someone.workers.dev");
  }
  if (origin === ownOrigin) throw new Error("That's your own ops room. Paste your partner cell's URL instead.");
  let cell: { callsign?: unknown; role?: unknown } | undefined;
  try {
    const res = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) cell = ((await res.json()) as { cell?: { callsign?: unknown; role?: unknown } }).cell;
  } catch {
    // handled below
  }
  const callsign = cleanCallsign(cell?.callsign);
  if (!callsign || (cell?.role !== "air" && cell?.role !== "land")) {
    throw new Error(`Couldn't find an ops room at ${origin}. Check the URL and that your partner has deployed.`);
  }
  return { url: origin, callsign, role: cell.role };
}

// -----------------------------------------------------------------------------
// Exercise control
// -----------------------------------------------------------------------------

/** Where exercise control lives (vars.EXCON_URL in wrangler.jsonc), or null to run on your own. */
export function exconUrl(env: Env): string | null {
  const raw = String(env.EXCON_URL ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Introduce this ops room to exercise control, at most once a minute. EXCON
 * then reads /api/state to draw the big screen and posts injects to /api/inject.
 * Best effort: with no EXCON, or one that's unreachable, the ops room carries on alone.
 */
async function reportToExcon(env: Env, origin: string): Promise<void> {
  const excon = exconUrl(env);
  if (!excon) return;
  // Exercise control on the internet can't call back to a laptop.
  if (isLocal(origin) && !isLocal(excon)) return;
  const store = env.OPS.getByName("ops");
  try {
    if (!(await store.exconDue())) return;
    const res = await fetch(`${excon}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: origin }),
      signal: AbortSignal.timeout(5000)
    });
    await store.noteExcon(res.ok);
  } catch {
    await store.noteExcon(false).catch(() => {});
  }
}

function isLocal(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

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

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-cell-client"
  };
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { ...corsHeaders(), "cache-control": "no-store" } });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}
