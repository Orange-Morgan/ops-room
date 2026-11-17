/**
 * The mission board. Missions tick themselves off when the ops room sees the
 * matching activity, so exercise control can see your progress at a glance.
 */

export interface MissionDef {
  id: MissionId;
  title: string;
  hint: string;
  phase: number;
  bonus?: boolean;
}

export type MissionId =
  | "ops_room_open"
  | "comms_check"
  | "first_sitrep"
  | "request_raised"
  | "on_the_move"
  | "resupplied"
  | "watch_on"
  | "watch_raises"
  | "watch_delivers"
  | "sunray"
  | "link"
  | "joint"
  | "flash"
  | "standing_orders"
  | "field_mod";

export const MISSIONS: MissionDef[] = [
  {
    id: "ops_room_open",
    title: "Ops room open",
    hint: "Deploy your cell, open this board and pick a role and callsign",
    phase: 1
  },
  {
    id: "comms_check",
    title: "Comms check",
    hint: "Connect Cloudflare OS, AI Playground or MCP Inspector to your /mcp endpoint",
    phase: 1
  },
  {
    id: "first_sitrep",
    title: "First SITREP",
    hint: "Ask the MCP client for a SITREP so it calls get_sitrep",
    phase: 1
  },
  {
    id: "request_raised",
    title: "Request raised",
    hint: "Build raise_request and raise a request over MCP",
    phase: 2
  },
  {
    id: "on_the_move",
    title: "On the move",
    hint: "Build update_request_status and move a request along over MCP",
    phase: 2
  },
  {
    id: "resupplied",
    title: "Resupply",
    hint: "Build resupply_store and top up a store over MCP",
    phase: 2
  },
  {
    id: "watch_on",
    title: "Watchkeeper on shift",
    hint: "Connect your agent to your MCP server and brief it",
    phase: 3
  },
  {
    id: "watch_raises",
    title: "The watchkeeper raises a request",
    hint: "Ask your watchkeeper to raise a request",
    phase: 3
  },
  {
    id: "watch_delivers",
    title: "Delivered",
    hint: "Your watchkeeper raises a request and later reports it delivered",
    phase: 3
  },
  {
    id: "sunray",
    title: "Sunray's say-so",
    hint: "A request that dips into the reserve is held until a human approves or rejects it on this board",
    phase: 3
  },
  {
    id: "link",
    title: "Link established",
    hint: "Your watchkeeper connects to your partner cell's MCP server, or theirs connects to yours",
    phase: 4
  },
  {
    id: "joint",
    title: "Joint tasking",
    hint: "A request crosses cells: your watchkeeper raises one with your partner, or theirs raises one here",
    phase: 4
  },
  {
    id: "flash",
    title: "Flash traffic",
    hint: "Deliver a FLASH request",
    phase: 5,
    bonus: true
  },
  {
    id: "standing_orders",
    title: "Standing orders",
    hint: "Your watchkeeper runs a scheduled task (for example, a stores check every few minutes)",
    phase: 5,
    bonus: true
  },
  {
    id: "field_mod",
    title: "Field modification",
    hint: "Invent a new MCP tool and get a client to call it",
    phase: 5,
    bonus: true
  }
];

/** Tools from the guided path and the stretch reference. Anything else counts as a "Field modification". */
export const KNOWN_TOOLS = new Set([
  "get_sitrep",
  "raise_request",
  "list_requests",
  "update_request_status",
  "resupply_store",
  "ops_summary"
]);
