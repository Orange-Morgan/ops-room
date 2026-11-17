import { Agent, getAgentByName } from "agents";
import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import {
  chatModel,
  handleChatRequest,
  partnerCell,
  rememberTurn,
  reportScheduledTask,
  toModelMessages,
  traceTools,
  type ChatReply,
  type ChatState,
  type PartnerLink
} from "../../src/ops/agent-kit";

const SYSTEM_PROMPT = `You are the duty watchkeeper in a cell's ops room on Exercise ORANGE CLOUD, a joint relief exercise on the island of Halcyon after a storm.
You help the ops team raise requests for support, keep them moving and keep the stores topped up.

Rules:
- Use your tools for anything about stores, sites, conditions or requests. Call get_sitrep first if you don't have a recent one. Never guess stock, site ids or request numbers.
- Sites are distribution points DP ALPHA to DP HOTEL, with ids alpha to hotel. Quantities are pallets.
- Only say something is done after the tool call worked. If a tool returns an error, say what it said and suggest what to do next.
- Raise what you are asked to raise and let the ops room judge it. Never trim or refuse a request yourself because of a reserve: raise it in full, and the tool result says whether it is held.
- A request with status "held" is waiting for the Duty Officer, a human, to approve it on the ops board. You can't approve it yourself. Say so.
- Always give request numbers, like #104.
- For totals and "how are we doing" questions, use ops_summary rather than adding up requests yourself.
- When someone tells you something the next watch should know, call note_for_handover before you reply.
- Be brief and factual, as a good watchkeeper is. Plain text, no emoji, no sign-offs like "let me know if you need anything else".`;

function jointOrders(partner: PartnerLink | null): string {
  if (!partner) return "";
  return `

Joint tasking. Your partner cell is ${partner.callsign}, a ${partner.roleLabel.toLowerCase()}. ${partner.about}
- Tools named tool_partner_... act on ${partner.callsign}'s ops room. Tools named tool_cell_... act on your own. Never mix them up.
- Try your own cell first. When a tool error says your cell can't do it (a road is cut, flying is suspended, the load is too big), hand the request to ${partner.callsign}: read their picture with tool_partner_get_sitrep, then raise it with tool_partner_raise_request. Split the load if it is more than they can carry in one request.
- If the request was already on your own board, cancel your copy once theirs is raised, so the stores aren't committed twice.
- Don't task or move ${partner.callsign}'s requests for them. Say what you handed over, with their request numbers.`;
}

interface StretchState extends ChatState {
  /** Duty instance only: this Worker's origin, saved so standing orders can reach /mcp without a request. */
  origin?: string;
  /** Duty instance only: when someone last chatted, so standing orders can stop themselves. */
  lastChatAt?: number;
  /** Duty instance only: handover notes, shared by every conversation. Agent memory that survives restarts. */
  notes?: string[];
}

/**
 * Every chat session is its own Watchkeeper. Standing orders and the handover notes live on one
 * extra instance with this name, so there is only ever one of each however many conversations are open.
 */
const DUTY = "duty";

/** Standing orders stop themselves once nobody has chatted for this long. */
const IDLE_STOP_MS = 60 * 60 * 1000;

/**
 * Stretch reference. On top of the finished Phase 4 watchkeeper:
 *   - standing orders: a stores check every two minutes that resupplies anything at or below
 *     its reserve, run by one "duty" instance and stopped after an hour without chat
 *   - handover notes: memory shared across conversations, kept on the same duty instance
 *   - local tools: tools that run inside the agent, mixed with MCP tools
 */
export class Watchkeeper extends Agent<Env, StretchState> {
  initialState: StretchState = { messages: [], notes: [] };

  async onRequest(request: Request) {
    return handleChatRequest(this, request);
  }

  async chat(message: string, origin: string): Promise<ChatReply> {
    await this.connectToCell(origin);
    const partner = await partnerCell(this, origin);
    if (partner) {
      await this.addMcpServer("partner", partner.mcpUrl, {
        id: "partner",
        transport: { type: "streamable-http", headers: partner.headers }
      });
    }

    // One named instance runs standing orders and keeps the handover notes. Safe to call every
    // turn: scheduleEvery is idempotent, and getAgentByName always lands on the same instance.
    const duty = (await getAgentByName(this.env.Watchkeeper, DUTY)) as unknown as DurableObjectStub<Watchkeeper>;
    const notes = await duty.startStandingOrders(origin);

    const result = await generateText({
      model: chatModel(this.env),
      system: SYSTEM_PROMPT + jointOrders(partner) + handoverNotes(notes),
      messages: toModelMessages(this.state.messages, message),
      tools: { ...this.mcp.getAITools(), ...this.localTools(duty) },
      stopWhen: isStepCount(12)
    });

    const tools = traceTools(this, result.steps);
    this.setState(rememberTurn(this.state, message, result.text, tools));
    return { reply: result.text, tools };
  }

  private connectToCell(origin: string) {
    return this.addMcpServer("cell", `${origin}/mcp`, {
      id: "cell",
      transport: { type: "streamable-http", headers: { "x-cell-client": "agent", "x-cell-origin": origin } }
    });
  }

  /** Tools that run inside the agent rather than over MCP. */
  private localTools(duty: DurableObjectStub<Watchkeeper>) {
    return {
      note_for_handover: tool({
        description:
          "Write a note in the handover log for the next watch, for example a site contact or a standing instruction. Every conversation with this ops room's watchkeeper can read the log.",
        inputSchema: z.object({ note: z.string().min(3).max(200).describe("The note, in one sentence") }),
        execute: async ({ note }) => {
          const count = await duty.addHandoverNote(note);
          return `Logged. The handover log has ${count} note${count === 1 ? "" : "s"}.`;
        }
      })
    };
  }

  // ---------------------------------------------------------------------------
  // The duty instance: standing orders and shared memory
  // ---------------------------------------------------------------------------

  /** Runs on the duty instance. Starts the two-minute stores check (once) and returns the handover notes. */
  async startStandingOrders(origin: string): Promise<string[]> {
    this.setState({ ...this.state, origin, lastChatAt: Date.now() });
    await this.scheduleEvery(120, "storesCheck");
    return this.state.notes ?? [];
  }

  /** Runs on the duty instance. */
  async addHandoverNote(note: string): Promise<number> {
    const notes = [...(this.state.notes ?? []), note.slice(0, 200)].slice(-20);
    this.setState({ ...this.state, notes });
    return notes.length;
  }

  /** Runs every two minutes once scheduled. Resupplies any store at or below its reserve. */
  async storesCheck() {
    // Nobody has chatted for an hour: stop, so the check doesn't run forever after the event.
    if (Date.now() - (this.state.lastChatAt ?? 0) > IDLE_STOP_MS) {
      for (const schedule of await this.listSchedules()) {
        if (schedule.callback === "storesCheck") await this.cancelSchedule(schedule.id);
      }
      return;
    }
    const origin = this.state.origin;
    if (!origin) return;
    // Scheduled runs have no request, so reconnect from the saved origin and call tools directly.
    await this.connectToCell(origin);
    const sitrepResult = await this.mcp.callTool({ serverId: "cell", name: "get_sitrep", arguments: {} });
    const text = (sitrepResult.content as { type: string; text?: string }[])?.find((c) => c.type === "text")?.text ?? "{}";
    const sitrep = JSON.parse(text) as { stores?: { id: string; name: string; onHand: number; reserve: number }[] };
    const low = (sitrep.stores ?? []).filter((s) => s.onHand <= s.reserve);
    for (const store of low) {
      await this.mcp.callTool({ serverId: "cell", name: "resupply_store", arguments: { storeId: store.id, quantity: 10 } });
    }
    await reportScheduledTask(
      low.length ? `stores check resupplied ${low.map((s) => s.name.toLowerCase()).join(", ")}` : "stores check, nothing at reserve"
    );
  }
}

function handoverNotes(notes: string[]): string {
  if (!notes.length) return "";
  return `\n\nHandover log from earlier watches:\n${notes.map((n) => `- ${n}`).join("\n")}`;
}
