import { routeAgentRequest } from "agents";
import { createMcpHandler } from "agents/mcp/server";
import { handleApi } from "./ops/api";
import { cellFor } from "./ops/client";
import { identifyMcpCaller, trackMcpRequest } from "./ops/mcp-tracking";
import { createOpsMcpServer } from "./mcp";

// Durable Object classes must be exported from the Worker's entry point.
export { OpsRoom } from "./ops/store";
export { Watchkeeper } from "./agent";

/**
 * Exercise ORANGE CLOUD: one Worker, four jobs.
 *
 *   /             the live ops board (static files in ./public)
 *   /chat         a chat UI for your watchkeeper (./public/chat.html)
 *   /api/*        your ops room's REST API     -> src/ops/api.ts
 *   /mcp          your MCP server              -> src/mcp.ts    (Phase 2)
 *   /agents/*     your watchkeeper             -> src/agent.ts  (Phases 3 and 4)
 *
 * You don't need to edit this file for the guided path.
 */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      const caller = identifyMcpCaller(request, url.origin);
      ctx.waitUntil(trackMcpRequest(request.clone(), env, caller));
      // A fresh MCP server per request, wired to your ops room and labelled with who is calling.
      const who = await env.OPS.getByName("ops").identity();
      const handler = createMcpHandler(() => createOpsMcpServer(cellFor(env, caller, who)));
      return handler(request, env, ctx);
    }

    // Routes /agents/watchkeeper/<session> to a Watchkeeper instance.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
