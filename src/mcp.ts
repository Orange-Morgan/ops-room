import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Cell } from "./ops/client";

/**
 * PHASE 2: your MCP server
 * ========================
 *
 * MCP (Model Context Protocol) is how AI apps find and call tools. Anything
 * that speaks MCP (Cloudflare OS, AI Playground, MCP Inspector, Claude, Cursor,
 * your own agent) can connect to https://<your-worker>/mcp, ask "what tools do
 * you have?" and call them.
 *
 * Each tool has:
 *   a name         what the model calls
 *   a description  how the model decides when to use it (write it for a model)
 *   an inputSchema a zod schema; the SDK validates input for you
 *   a handler      does the work and returns content
 *
 * `cell` talks to your ops room's backend. src/ops/client.ts lists everything it can do.
 *
 * Every description starts with `${cell.label}`, for example "Air cell KESTREL 1".
 * In Phase 4 one agent holds your tools and your partner cell's, and they have
 * the same names. The description is how the model tells whose is whose.
 *
 * YOUR JOBS (uncomment each block, then fill in the handler):
 *   TODO 1  raise_request          ->  cell.raiseRequest({ site, items, precedence, note })
 *   TODO 2  list_requests          ->  cell.listRequests({ status, site })
 *   TODO 3  update_request_status  ->  cell.updateRequestStatus(requestId, status)
 *   TODO 4  resupply_store         ->  cell.resupplyStore(storeId, quantity)
 *
 * After each one: save, test it in Cloudflare OS, AI Playground or MCP Inspector, and watch
 * your ops board. Stuck? Run `npm run skip:mcp` to drop in a finished version
 * (your file is backed up to src/mcp.ts.bak first).
 */
export function createOpsMcpServer(cell: Cell) {
  const server = new McpServer(
    { name: "ops-room", version: "1.0.0" },
    {
      instructions: `Tools for the ops room of ${cell.label} on Exercise ORANGE CLOUD, a relief exercise. ${cell.about} Quantities are in pallets. Sites are distribution points with ids alpha to hotel.`
    }
  );

  // DONE FOR YOU: a read-only tool with no inputs. Use it as your template.
  server.registerTool(
    "get_sitrep",
    {
      title: "Get the SITREP",
      description: `${cell.label}: the current picture. Conditions (flying, roads cut), stores with pallets on hand and the reserve level (the reserve is part of the pallets on hand, not extra), sites, and how many requests are at each stage. Start here.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    },
    async () => {
      const sitrep = await cell.getSitrep();
      return asText(sitrep);
    }
  );

  // TODO 1: raise_request
  // The schema is written for you. Fill in the handler: call cell.raiseRequest
  // and return the request it gives back, wrapped in asText(...).
  //
  // server.registerTool(
  //   "raise_request",
  //   {
  //     title: "Raise a request for support",
  //     description: `${cell.label}: raise a request for support, a load of stores for one distribution point. Use site and store ids from get_sitrep. Stock is committed straight away. A request that takes a store below its reserve comes back with status "held" and waits for a human to approve it on the ops board. Returns the request number.`,
  //     inputSchema: z.object({
  //       site: z.string().describe("Site id: alpha, bravo, charlie, delta, echo, foxtrot, golf or hotel"),
  //       items: z
  //         .array(
  //           z.object({
  //             storeId: z.string().describe("Store id from get_sitrep, e.g. water"),
  //             qty: z.number().int().min(1).max(24).default(1).describe("How many pallets")
  //           })
  //         )
  //         .min(1)
  //         .describe("What the site needs"),
  //       precedence: z
  //         .enum(["routine", "priority", "immediate", "flash"])
  //         .default("routine")
  //         .describe("How urgent it is. FLASH is life or death"),
  //       note: z.string().max(140).optional().describe("Anything the crew should know, e.g. deliver to the school hall")
  //     })
  //   },
  //   async ({ site, items, precedence, note }) => {
  //     // your code here
  //   }
  // );

  // TODO 2: list_requests
  // Read-only, like get_sitrep. Both inputs are optional.
  //
  // server.registerTool(
  //   "list_requests",
  //   {
  //     title: "List requests",
  //     description: `${cell.label}: list requests for support, newest first. "open" (the default) means anything not yet delivered or cancelled. Optionally filter by site.`,
  //     inputSchema: z.object({
  //       status: z
  //         .enum(["open", "held", "requested", "tasked", "en_route", "delivered", "cancelled", "all"])
  //         .default("open")
  //         .describe("Which requests to show"),
  //       site: z.string().optional().describe("Only this site id, e.g. echo")
  //     }),
  //     annotations: { readOnlyHint: true }
  //   },
  //   async ({ status, site }) => {
  //     // your code here
  //   }
  // );

  // TODO 3: update_request_status
  // Requests move requested → tasked → en_route → delivered (or cancelled).
  //
  // server.registerTool(
  //   "update_request_status",
  //   {
  //     title: "Update a request's status",
  //     description: `${cell.label}: move a request along: requested → tasked → en_route → delivered. Requests only move forward. "cancelled" cancels it and returns the stock. A held request can't move until a human approves it on the ops board.`,
  //     inputSchema: z.object({
  //       requestId: z.number().int().describe("The request number, e.g. 101"),
  //       status: z.enum(["tasked", "en_route", "delivered", "cancelled"]).describe("The new status")
  //     })
  //   },
  //   async ({ requestId, status }) => {
  //     // your code here
  //   }
  // );

  // TODO 4: resupply_store
  // This one's all yours: write the description and the inputSchema too.
  // Inputs: storeId (a string) and quantity (a whole number of pallets, 1 to 50).
  // Then call cell.resupplyStore(storeId, quantity).
  // Start the description with `${cell.label}:` like the others.

  return server;
}

/** MCP tools return content blocks. JSON as text is the simplest thing that works well with models. */
function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
