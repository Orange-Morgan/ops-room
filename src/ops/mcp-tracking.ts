import { cleanCallsign } from "./store";
import type { Caller } from "./types";

/**
 * Work out who is calling /mcp.
 *
 * Your watchkeeper sends `x-cell-client: agent` and `x-cell-origin: <its origin>`
 * (see src/agent.ts). If that origin is not this Worker, it's a partner
 * cell's watchkeeper on your net, and `x-cell-callsign` says which one.
 * Everyone else is a regular MCP client.
 */
export function identifyMcpCaller(request: Request, ownOrigin: string): Caller {
  const client = request.headers.get("x-cell-client");
  const fromOrigin = request.headers.get("x-cell-origin");
  if (client === "smoke") return { source: "smoke" };
  if (client === "agent") {
    if (fromOrigin && safeOrigin(fromOrigin) !== ownOrigin) {
      return { source: "visitor", from: cleanCallsign(request.headers.get("x-cell-callsign")) ?? hostLabel(fromOrigin) };
    }
    return { source: "agent" };
  }
  return { source: "mcp" };
}

/**
 * Peek at the JSON-RPC body of an MCP request and tell the ops room about
 * tools/list and tools/call, so the mission board can tick. Runs in the
 * background (ctx.waitUntil) and never affects the MCP response.
 */
export async function trackMcpRequest(request: Request, env: Env, caller: Caller): Promise<void> {
  if (request.method !== "POST") return;
  try {
    const body = (await request.json()) as unknown;
    const messages = Array.isArray(body) ? body : [body];
    const store = env.OPS.getByName("ops");
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const { method, params } = msg as { method?: unknown; params?: { name?: unknown } };
      if (method !== "tools/list" && method !== "tools/call") continue;
      await store.trackMcp({
        method,
        tool: typeof params?.name === "string" ? params.name : undefined,
        caller
      });
    }
  } catch {
    // Not JSON, or the store is busy. Tracking is best effort.
  }
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.slice(0, 100);
  }
}

/** A readable stand-in when a visitor doesn't say who they are. */
function hostLabel(origin: string): string {
  try {
    return new URL(origin).hostname.split(".").slice(0, 2).join(".").slice(0, 32);
  } catch {
    return "a partner cell";
  }
}
