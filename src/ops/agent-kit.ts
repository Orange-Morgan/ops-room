import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "cloudflare:workers";
import type { Agent } from "agents";
import { wrapLanguageModel, type ModelMessage, type StepResult, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { ROLES } from "./scenario";
import type { Role } from "./types";

/**
 * Plumbing for src/agent.ts: the HTTP chat protocol used by /chat, model
 * setup, conversation history, the partner link and ops board reporting.
 * You can read it, but you don't need to change it for the guided path.
 */

export interface ToolTrace {
  /** The MCP tool name, e.g. "raise_request" */
  name: string;
  /** Which MCP server it came from (the name you gave addMcpServer) */
  server: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
  tools?: ToolTrace[];
}

export interface ChatState {
  messages: ChatMessage[];
}

export interface ChatReply {
  reply: string;
  tools: ToolTrace[];
}

/** What the kit needs from your agent class. */
export type ChatAgent = Agent<Env, ChatState> & {
  chat(message: string, origin: string): Promise<ChatReply>;
};

/** Your partner cell, ready to hand to addMcpServer. */
export interface PartnerLink {
  /** What the partner answers to, e.g. "BADGER 2" */
  callsign: string;
  role: Role;
  /** "Air cell" or "Land cell" */
  roleLabel: string;
  /** One line on what that kind of cell can and can't do */
  about: string;
  /** The partner's MCP server */
  mcpUrl: string;
  /** Headers that tell the partner's ops board which cell is calling */
  headers: Record<string, string>;
}

/** The id src/agent.ts gives the partner's MCP server, so its tools show up as tool_partner_<name>. */
const PARTNER_ID = "partner";

const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";
/** Takes over when the first model is slow or failing. It is slower on a good day, but it passes the same tests. */
const DEFAULT_FALLBACK = "@cf/google/gemma-4-26b-a4b-it";
/** A model call that takes longer than this is abandoned, and the fallback answers instead. */
const SLOW_MS = 12_000;
/** After that, the slow model is rested for this long before it is tried again. */
const REST_MS = 3 * 60_000;

function modelName(bindings: Env = env): string {
  return (bindings.MODEL as string | undefined) || DEFAULT_MODEL;
}

/** vars.MODEL_FALLBACK in wrangler.jsonc. "none" switches the fallback off. */
function fallbackName(bindings: Env = env): string | null {
  const name = String((bindings.MODEL_FALLBACK as string | undefined) ?? DEFAULT_FALLBACK).trim();
  return !name || name === "none" || name === modelName(bindings) ? null : name;
}
const HISTORY_FOR_MODEL = 12;
const HISTORY_TO_KEEP = 40;

// -----------------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------------

const NO_TOOLS_NOTE =
  "Right now you have NO tools and cannot call any functions, so you cannot see or change stores, sites or requests. " +
  "Never write out a function or tool call. Do not pretend to have done anything. Reply in plain text: explain that " +
  "you're not on the net yet (your developer needs to connect the MCP server in src/agent.ts), then help with anything else.";

const NOT_CONNECTED_REPLY =
  "I'm not on the net yet, so I can't see stores, sites or requests. " +
  "Connect me to your MCP server in src/agent.ts (Phase 3) and I'll get to work.";

const SAY_AGAIN = "Say again? That one came through garbled.";

/**
 * Some open models occasionally leak their raw tool-call syntax as text
 * (for example gpt-oss's "<|channel|>" tokens), answer with their private
 * reasoning, or get stuck repeating themselves. Tidy that up so the chat
 * stays readable.
 */
export function cleanReply(text: string, hadTools: boolean): string {
  const leaked = /<\|(start|channel|message|call|end|constrain)\|>/.test(text);
  const cleaned = text
    .replace(/<\|start\|>[\s\S]*?(<\|call\|>|<\|end\|>|$)/g, "")
    .replace(/<\|[a-z_]+\|>/g, "")
    .trim();
  if (isGarbled(cleaned)) return SAY_AGAIN;
  if (cleaned) return cleaned;
  if (!hadTools) return NOT_CONNECTED_REPLY;
  return leaked ? SAY_AGAIN : "";
}

/** True when a reply is the model thinking out loud or stuck in a loop, rather than an answer. */
export function isGarbled(text: string): boolean {
  // The reasoning channel came out as the reply.
  if (/^\s*(assistant)?(analysis|commentary)\b\s*(:|\n|$)/i.test(text)) return true;
  // A tool call came out as text instead of being made.
  if (/^\s*(```(json)?\s*)?\{\s*"(name|tool|function)"\s*:\s*"/.test(text) || /"name"\s*:\s*"tool_(cell|partner)_/.test(text)) return true;
  // One character, one word or one phrase, over and over.
  if (/([^\s])\1{49,}/.test(text)) return true;
  if (/(\b[\w']+\b)(?:\W+\1\b){14,}/.test(text)) return true;
  if (/(.{16,120}?)\1{4,}/s.test(text)) return true;
  return false;
}

/**
 * Request numbers quoted in a reply that no tool returned and nobody mentioned.
 * Now and then a model reports "#112 raised" without calling the tool. The
 * ops room is the record, so a number it never issued is treated as a slip.
 */
export function inventedRequests(reply: string, known: string): string[] {
  const quoted = new Set([...reply.matchAll(/#(\d{3,})\b/g)].map((m) => m[1]));
  return [...quoted].filter((id) => !new RegExp(`\\b${id}\\b`).test(known));
}

/** Token usage for the current chat turn, so the chat UI can show what each reply cost. */
interface TurnUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** The model behind each call, in order. Usually one name, two when the fallback stepped in. */
  models: string[];
}
const turnUsage = new AsyncLocalStorage<TurnUsage>();

/** Models that were slow or failing a moment ago, and when each may be tried again. */
const resting = new Map<string, number>();

class SlowModel extends Error {}

/**
 * The Workers AI model named in wrangler.jsonc (vars.MODEL), tuned for snappy tool calling.
 *
 * Model speed on a shared service varies through the day. If a call to the
 * first model takes more than a few seconds or fails, the fallback model
 * (vars.MODEL_FALLBACK) answers instead, and keeps answering for a few
 * minutes before the first model gets another go.
 */
export function chatModel(bindings: Env = env) {
  const workersai = createWorkersAI({ binding: bindings.AI });
  const build = (name: string) => {
    // Reasoning models think before they answer. A watchkeeper should be quick,
    // so keep the thinking short.
    const settings: Record<string, unknown> = {};
    if (name.includes("gpt-oss") || name.includes("glm")) settings.reasoning_effort = "low";
    return workersai(name as Parameters<typeof workersai>[0], settings as Parameters<typeof workersai>[1]);
  };
  const first = modelName(bindings);
  const fallback = fallbackName(bindings);
  return wrapLanguageModel({
    model: build(first),
    middleware: {
      transformParams: async ({ params }) => {
        // Before Phase 3 the agent has no tools. Tell the model, so it
        // doesn't pretend to raise requests (or try to call tools it hasn't got).
        const prompt = params.tools?.length
          ? params.prompt
          : [{ role: "system" as const, content: NO_TOOLS_NOTE }, ...params.prompt];
        // Some models default to very short replies (256 tokens). Give them room,
        // but not so much that a model stuck in a loop keeps everyone waiting.
        return { ...params, prompt, maxOutputTokens: params.maxOutputTokens ?? 1200 };
      },
      wrapGenerate: async ({ params, model }) => {
        // Run one model call and add it to this turn's tally.
        const answer = async <T extends { usage?: { inputTokens?: unknown; outputTokens?: unknown } }>(
          name: string,
          run: () => PromiseLike<T>
        ): Promise<T> => {
          const result = await run();
          const tally = turnUsage.getStore();
          if (tally) {
            tally.modelCalls += 1;
            tally.inputTokens += tokenCount(result.usage?.inputTokens);
            tally.outputTokens += tokenCount(result.usage?.outputTokens);
            tally.models.push(name);
          }
          return result;
        };

        if (!fallback) return answer(first, () => model.doGenerate(params));
        if ((resting.get(first) ?? 0) > Date.now()) return answer(fallback, () => build(fallback).doGenerate(params));

        // Give the first model a fair chance, then hand over.
        const giveUp = new AbortController();
        const signals = params.abortSignal ? [giveUp.signal, params.abortSignal] : [giveUp.signal];
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tooSlow = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SlowModel()), SLOW_MS);
        });
        const attempt = Promise.resolve(model.doGenerate({ ...params, abortSignal: AbortSignal.any(signals) }));
        attempt.catch(() => {}); // it may fail after we've stopped listening
        try {
          return await answer(first, () => Promise.race([attempt, tooSlow]));
        } catch (e) {
          const slow = e instanceof SlowModel;
          if (!slow && !worthAnotherModel(e, params.abortSignal)) throw e;
          giveUp.abort();
          resting.set(first, Date.now() + REST_MS);
          await noteFallback(first, fallback, slow ? "slow" : "failing");
          return answer(fallback, () => build(fallback).doGenerate(params));
        } finally {
          clearTimeout(timer);
        }
      }
    }
  });
}

/** Errors another model would hit too (the free allowance, a paid-only model, the caller giving up) are passed on. */
function worthAnotherModel(e: unknown, callerSignal?: AbortSignal): boolean {
  if (callerSignal?.aborted) return false;
  const text = e instanceof Error ? e.message : String(e);
  return !/4006|daily free allocation|neurons|5035|requires a Workers Paid plan/i.test(text);
}

/** Say on the ops board that the fallback has stepped in, so nobody wonders why replies changed. */
async function noteFallback(first: string, fallback: string, why: "slow" | "failing") {
  try {
    await env.OPS.getByName("ops").noteModelFallback({ first, fallback, why, minutes: REST_MS / 60_000 });
  } catch {
    // The board is a nice-to-have here.
  }
}

function tokenCount(value: unknown): number {
  if (typeof value === "number") return value;
  const total = (value as { total?: unknown } | undefined)?.total;
  return typeof total === "number" ? total : 0;
}

// -----------------------------------------------------------------------------
// Conversation history
// -----------------------------------------------------------------------------

/** The recent conversation plus the new message, in the shape the AI SDK expects. */
export function toModelMessages(history: ChatMessage[], newMessage: string): ModelMessage[] {
  const recent = history.slice(-HISTORY_FOR_MODEL).map((m) => ({ role: m.role, content: m.content }) as ModelMessage);
  return [...recent, { role: "user", content: newMessage }];
}

/** A new state with this turn appended (and old turns trimmed). */
export function rememberTurn<S extends ChatState>(state: S, userMessage: string, reply: string, tools: ToolTrace[]): S {
  const now = new Date().toISOString();
  const messages: ChatMessage[] = [
    ...(state?.messages ?? []),
    { role: "user", content: userMessage, at: now },
    { role: "assistant", content: reply || "(no reply)", at: now, tools }
  ];
  return { ...state, messages: messages.slice(-HISTORY_TO_KEEP) };
}

// -----------------------------------------------------------------------------
// Partner cell (Phase 4)
// -----------------------------------------------------------------------------

/**
 * The partner cell set on your ops board, or null if there isn't one yet.
 *
 * It also drops a saved link to a previous partner, so changing partner on
 * the board takes effect on the next message.
 */
export async function partnerCell(agent: ChatAgent, origin: string): Promise<PartnerLink | null> {
  const store = env.OPS.getByName("ops");
  const [partner, who] = await Promise.all([store.getPartner(), store.identity()]);
  const mcpUrl = partner ? new URL("/mcp", partner.url).href : null;
  const saved = savedServers(agent)[PARTNER_ID];
  if (saved && (!mcpUrl || new URL(saved.server_url).href !== mcpUrl)) {
    await agent.removeMcpServer(PARTNER_ID);
  }
  if (!partner || !mcpUrl) return null;
  return {
    callsign: partner.callsign,
    role: partner.role,
    roleLabel: ROLES[partner.role].label,
    about: ROLES[partner.role].blurb,
    mcpUrl,
    headers: { "x-cell-client": "agent", "x-cell-origin": origin, "x-cell-callsign": who.callsign }
  };
}

function savedServers(agent: ChatAgent) {
  try {
    return agent.getMcpServers().servers;
  } catch {
    return {};
  }
}

// -----------------------------------------------------------------------------
// Tool call traces (shown as chips in the chat UI)
// -----------------------------------------------------------------------------

/** Turn the AI SDK's steps into a simple list of the MCP tools the model called. */
export function traceTools(agent: ChatAgent, steps: StepResult<ToolSet>[]): ToolTrace[] {
  const names = toolNameLookup(agent);
  const traces = new Map<string, ToolTrace>();
  for (const step of steps) {
    for (const part of step.content) {
      if (part.type === "tool-call") {
        const known = names.get(part.toolName);
        traces.set(part.toolCallId, {
          name: known?.name ?? part.toolName,
          server: known?.server ?? "local",
          input: part.input
        });
      } else if (part.type === "tool-result") {
        const trace = traces.get(part.toolCallId);
        if (trace) trace.output = simplifyOutput(part.output);
      } else if (part.type === "tool-error") {
        const trace = traces.get(part.toolCallId);
        if (trace) trace.error = part.error instanceof Error ? part.error.message : String(part.error);
      }
    }
  }
  return [...traces.values()];
}

/** Map AI SDK tool keys (tool_<serverId>_<name>) back to MCP tool and server names. */
function toolNameLookup(agent: ChatAgent) {
  const lookup = new Map<string, { name: string; server: string }>();
  try {
    const state = agent.getMcpServers();
    for (const tool of agent.mcp.listTools()) {
      const key = `tool_${tool.serverId.replace(/-/g, "")}_${tool.name}`;
      lookup.set(key, { name: tool.name, server: state.servers[tool.serverId]?.name ?? tool.serverId });
    }
  } catch {
    // No MCP servers yet.
  }
  return lookup;
}

/** MCP results are { content: [{ type: "text", text }] }. Show the JSON inside instead. */
function simplifyOutput(output: unknown): unknown {
  const content = (output as { content?: { type: string; text?: string }[] })?.content;
  if (!Array.isArray(content)) return output;
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  }
}

// -----------------------------------------------------------------------------
// HTTP chat protocol for /chat
//
//   GET    /agents/watchkeeper/<session>   { messages, model, mcp }
//   POST   /agents/watchkeeper/<session>   { message } -> { reply, tools, ms, model, mcp }
//   DELETE /agents/watchkeeper/<session>   start a fresh conversation
// -----------------------------------------------------------------------------

const reportedLinks = new Set<string>();

export async function handleChatRequest(agent: ChatAgent, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const model = modelName();

  if (request.method === "GET") {
    await agent.mcp.waitForConnections({ timeout: 3_000 });
    return json({ messages: agent.state?.messages ?? [], model, mcp: mcpStatus(agent) });
  }
  if (request.method === "DELETE") {
    agent.setState({ ...agent.state, messages: [] });
    return json({ ok: true });
  }
  if (request.method !== "POST") return json({ error: "Use GET, POST or DELETE" }, 405);

  let message = "";
  try {
    const body = (await request.json()) as { message?: unknown };
    message = String(body?.message ?? "").trim().slice(0, 2000);
  } catch {
    // fall through
  }
  if (!message) return json({ error: 'Send JSON like { "message": "Give me a SITREP" }' }, 400);

  const started = Date.now();
  const usage: TurnUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, models: [] };
  try {
    // After a restart, saved MCP connections reconnect in the background.
    await agent.mcp.waitForConnections({ timeout: 5_000 });
    const before = agent.state?.messages ?? [];
    // Everything the model could legitimately quote: the conversation so far and this message.
    const said = JSON.stringify(before) + message;
    const slipped = (t: ChatReply) => isGarbled(t.reply) || inventedRequests(t.reply, said + JSON.stringify(t.tools)).length > 0;
    let turn = await turnUsage.run(usage, () => agent.chat(message, url.origin));
    if (slipped(turn) && turn.tools.every((t) => isReadOnly(agent, t))) {
      // The model lost the thread and nothing was changed. Forget that attempt and ask once more.
      agent.setState({ ...agent.state, messages: before });
      turn = await turnUsage.run(usage, () => agent.chat(message, url.origin));
    }
    const { reply: text, tools } = turn;
    const invented = inventedRequests(text, said + JSON.stringify(tools));
    const changedSomething = !tools.every((t) => isReadOnly(agent, t));
    let reply =
      cleanReply(text, mcpStatus(agent).toolCount > 0) ||
      (tools.length
        ? `(The watchkeeper made ${tools.length} tool call${tools.length === 1 ? "" : "s"} but ran out of steps before replying. The chips below show what it did.)`
        : "(Nothing heard. The model returned no text, so try asking again.)");
    if (invented.length && !changedSomething) reply = SAY_AGAIN;
    else if (invented.length) {
      reply += `\n\n(Check the board: ${invented.map((id) => `#${id}`).join(", ")} isn't in anything the ops room returned.)`;
    }
    // Keep the saved conversation in step with what the user actually saw.
    const saved = agent.state?.messages ?? [];
    const last = saved[saved.length - 1];
    if (last?.role === "assistant" && last.content !== reply) {
      agent.setState({ ...agent.state, messages: [...saved.slice(0, -1), { ...last, content: reply }] });
    }
    if (request.headers.get("x-cell-client") !== "smoke") await reportTurn(agent, tools);
    // Report the model that actually answered: the fallback, if it stepped in.
    return json({ reply, tools, usage, ms: Date.now() - started, model: usage.models.at(-1) ?? model, mcp: mcpStatus(agent) });
  } catch (e) {
    console.error("chat failed", e);
    return json({ error: friendlyError(e, url.origin), ms: Date.now() - started, model, mcp: mcpStatus(agent) }, 500);
  }
}

/** True when the MCP server marked the tool read-only, so calling it again changes nothing. */
function isReadOnly(agent: ChatAgent, trace: ToolTrace): boolean {
  try {
    const servers = agent.getMcpServers().servers;
    return agent.mcp
      .listTools()
      .some((t) => t.name === trace.name && servers[t.serverId]?.name === trace.server && t.annotations?.readOnlyHint === true);
  } catch {
    return false;
  }
}

/** Tell the ops board what happened, for the mission board and activity log. */
async function reportTurn(agent: ChatAgent, tools: ToolTrace[]) {
  try {
    const store = env.OPS.getByName("ops");
    const status = mcpStatus(agent);
    const link = status.servers.find((s) => s.id === PARTNER_ID && s.state === "ready");
    const partner = link ? ((await store.getPartner())?.callsign ?? "your partner cell") : null;
    await store.noteAgentReply({
      toolCount: status.toolCount,
      toolsUsed: tools.map((t) => (link && t.server === link.name ? `${partner}'s ${t.name}` : t.name))
    });
    if (!link || !partner) return;
    if (!reportedLinks.has(link.url)) {
      reportedLinks.add(link.url);
      await store.noteLink(partner);
    }
    if (tools.some((t) => t.server === link.name && t.name === "raise_request" && !t.error)) {
      await store.noteJointTasking(partner);
    }
  } catch (e) {
    console.warn("could not report to the ops board", e);
  }
}

export function mcpStatus(agent: ChatAgent) {
  try {
    const state = agent.getMcpServers();
    const servers = Object.entries(state.servers).map(([id, s]) => ({
      id,
      name: s.name,
      url: s.server_url,
      state: s.state,
      error: s.error,
      tools: state.tools.filter((t) => t.serverId === id).map((t) => t.name)
    }));
    return { servers, toolCount: state.tools.length };
  } catch {
    return { servers: [], toolCount: 0 };
  }
}

function friendlyError(e: unknown, origin: string): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/4006|daily free allocation|neurons/i.test(text)) {
    return 'You\'ve used today\'s free Workers AI allowance (10,000 Neurons). It resets at midnight UTC. Deploy from a teammate\'s account, or upgrade to Workers Paid. To make it last longer, set vars.MODEL in wrangler.jsonc to "@cf/google/gemma-4-26b-a4b-it", which costs about 40% as much.';
  }
  if (/5035|requires a Workers Paid plan/i.test(text)) {
    return 'That model needs the Workers Paid plan. Set vars.MODEL in wrangler.jsonc back to "@cf/openai/gpt-oss-120b".';
  }
  if (/3040|capacity|429/i.test(text)) {
    return "Workers AI is busy right now. Give it a few seconds and try again.";
  }
  if (/mcp|connect|fetch failed|discover|initialize/i.test(text)) {
    return `Couldn't use an MCP server: ${text}. Check yours with "npm run smoke -- ${origin}" or MCP Inspector. If it's your partner's, check their URL on your ops board.`;
  }
  return `Something went wrong: ${text}`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

// -----------------------------------------------------------------------------
// Stretch goal helpers
// -----------------------------------------------------------------------------

/** Tell the mission board a scheduled task ran ("Standing orders"). */
export async function reportScheduledTask(description: string) {
  await env.OPS.getByName("ops").noteScheduledTask(description);
}
