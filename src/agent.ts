import { Agent } from "agents";
import { generateText, isStepCount } from "ai";
import {
  chatModel,
  handleChatRequest,
  partnerCell,
  rememberTurn,
  toModelMessages,
  traceTools,
  type ChatReply,
  type ChatState,
  type PartnerLink
} from "./ops/agent-kit";

/** Who your agent is and how it should behave. Make it your own. */
const SYSTEM_PROMPT = `You are the duty watchkeeper in a cell's ops room on Exercise ORANGE CLOUD, a joint relief exercise on the island of Halcyon after a storm.
You help the ops team raise requests for support, keep them moving and keep the stores topped up.

Rules:
- Use your tools for anything about stores, sites, conditions or requests. Call get_sitrep first if you don't have a recent one. Never guess stock, site ids or request numbers.
- Sites are distribution points DP ALPHA to DP HOTEL, with ids alpha to hotel. Quantities are pallets.
- Only say something is done after the tool call worked. If a tool returns an error, say what it said and suggest what to do next.
- Raise what you are asked to raise and let the ops room judge it. Never trim or refuse a request yourself because of a reserve: raise it in full, and the tool result says whether it is held.
- A request with status "held" is waiting for the Duty Officer, a human, to approve it on the ops board. You can't approve it yourself. Say so.
- Always give request numbers, like #104.
- If you have no tools available, say you are not on the net yet.
- Be brief and factual, as a good watchkeeper is. Plain text, no emoji, no sign-offs like "let me know if you need anything else".`;

/** Phase 4: extra orders once a partner cell is linked (TODO 3). Sharpen them. */
function jointOrders(partner: PartnerLink | null): string {
  if (!partner) return "";
  return `

Joint tasking. Your partner cell is ${partner.callsign}, a ${partner.roleLabel.toLowerCase()}. ${partner.about}
- Tools named tool_partner_... act on ${partner.callsign}'s ops room. Tools named tool_cell_... act on your own. Never mix them up.
- Try your own cell first. When a tool error says your cell can't do it (a road is cut, flying is suspended, the load is too big), hand the request to ${partner.callsign}: read their picture with tool_partner_get_sitrep, then raise it with tool_partner_raise_request. Split the load if it is more than they can carry in one request.
- If the request was already on your own board, cancel your copy once theirs is raised, so the stores aren't committed twice.
- Don't task or move ${partner.callsign}'s requests for them. Say what you handed over, with their request numbers.`;
}

/**
 * PHASES 3 AND 4: your watchkeeper
 * ================================
 *
 * Open /chat on your Worker and say hello. The watchkeeper can talk, but
 * can't do anything yet: it isn't on the net. Two changes fix that (Phase 3):
 *
 *   TODO 1  connect to your MCP server with this.addMcpServer(...)
 *   TODO 2  hand the model your MCP tools with this.mcp.getAITools()
 *
 * Then ask it to raise a request and watch your ops board.
 *
 * Phase 4 adds a second MCP server, your partner cell's:
 *
 *   TODO 3  link to your partner with partnerCell(...) and this.addMcpServer(...)
 *
 * Stuck? `npm run skip:agent` finishes Phase 3 and `npm run skip:joint`
 * finishes Phase 4 (your file is backed up to src/agent.ts.bak first).
 *
 * Each chat session gets its own Watchkeeper instance. It's a Durable Object,
 * so it keeps its state (the conversation) between messages.
 */
export class Watchkeeper extends Agent<Env, ChatState> {
  initialState: ChatState = { messages: [] };

  // The chat UI at /chat talks to this agent over HTTP.
  async onRequest(request: Request) {
    return handleChatRequest(this, request);
  }

  async chat(message: string, origin: string): Promise<ChatReply> {
    // TODO 1 (Phase 3): connect to your own MCP server, the same way Cloudflare OS did.
    // Uncomment this. The id makes your tools show up as tool_cell_<name>, and
    // the headers tell the ops board the calls come from your watchkeeper.
    //
    // await this.addMcpServer("cell", `${origin}/mcp`, {
    //   id: "cell",
    //   transport: {
    //     type: "streamable-http",
    //     headers: { "x-cell-client": "agent", "x-cell-origin": origin }
    //   }
    // });

    // TODO 3 (Phase 4): link to your partner cell, the one set on your ops board.
    // Delete the next line and uncomment the block under it. Your watchkeeper
    // then holds two MCP servers at once: yours and theirs.
    const partner: PartnerLink | null = null;
    //
    // const partner = await partnerCell(this, origin);
    // if (partner) {
    //   await this.addMcpServer("partner", partner.mcpUrl, {
    //     id: "partner",
    //     transport: { type: "streamable-http", headers: partner.headers }
    //   });
    // }

    // Ask the model. It sees the conversation so far and, once you've done
    // TODO 2, every tool from every MCP server you've connected. The SDK runs
    // the tools the model picks and feeds the results back until it has an answer.
    const result = await generateText({
      model: chatModel(this.env),
      system: SYSTEM_PROMPT + jointOrders(partner),
      messages: toModelMessages(this.state.messages, message),
      // TODO 2 (Phase 3): give the model your MCP tools. Uncomment the next line.
      // tools: this.mcp.getAITools(),
      stopWhen: isStepCount(10)
    });

    // Remember the conversation. setState saves it in this agent's storage.
    const tools = traceTools(this, result.steps);
    this.setState(rememberTurn(this.state, message, result.text, tools));

    return { reply: result.text, tools };
  }
}
