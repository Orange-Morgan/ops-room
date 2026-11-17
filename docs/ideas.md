# Your own mission

From about 15:45 until ENDEX at 16:20 you build what you like. This page has starting points for that, the stretch goals on the ops room, and the reference links.

One rule holds all afternoon: use invented data. Don't paste anything from a work system into a model or a free account.

## Build it in Cloudflare OS

The event's Cloudflare OS is at [cfos.cfevents.dev](https://cfos.cfevents.dev). Every person gets an agent and a workspace. The agent does its work by writing small pieces of code and running them, and it can build full-stack apps with a client, a server and durable state. Each link below opens Cloudflare OS with the prompt filled in, ready for you to edit and send.

Your ops room is already connected as a Gatekeeper, so these work on top of it:

- [Use my ops room's tools to give me a SITREP, then list every open request with the most urgent first.](https://cfos.cfevents.dev/?prompt=Use%20my%20ops%20room%27s%20tools%20to%20give%20me%20a%20SITREP%2C%20then%20list%20every%20open%20request%20with%20the%20most%20urgent%20first.)
- [Build me a small app that shows my ops room's open requests by distribution point and refreshes every 30 seconds.](https://cfos.cfevents.dev/?prompt=Build%20me%20a%20small%20app%20that%20shows%20my%20ops%20room%27s%20open%20requests%20by%20distribution%20point%20and%20refreshes%20every%2030%20seconds.)
- [Every 10 minutes, check my ops room's stores and tell me which are at or below reserve. Ask me before you resupply anything.](https://cfos.cfevents.dev/?prompt=Every%2010%20minutes%2C%20check%20my%20ops%20room%27s%20stores%20and%20tell%20me%20which%20are%20at%20or%20below%20reserve.%20Ask%20me%20before%20you%20resupply%20anything.)
- [Write a one-page commander's brief from my ops room: what was delivered where, what is still open, what is held and why.](https://cfos.cfevents.dev/?prompt=Write%20a%20one-page%20commander%27s%20brief%20from%20my%20ops%20room%3A%20what%20was%20delivered%20where%2C%20what%20is%20still%20open%2C%20what%20is%20held%20and%20why.)

Or start from an idea of your own. These three are the kind of small internal app that usually takes a team weeks to get onto a roadmap:

- [Build me an app for booking pool vehicles: a list of vehicles, a calendar, and a request that a transport manager approves. Use made-up data.](https://cfos.cfevents.dev/?prompt=Build%20me%20an%20app%20for%20booking%20pool%20vehicles%3A%20a%20list%20of%20vehicles%2C%20a%20calendar%2C%20and%20a%20request%20that%20a%20transport%20manager%20approves.%20Use%20made-up%20data.)
- [Build me a duty roster app: people, shifts and swaps, with a view of who is on tonight. Use made-up data.](https://cfos.cfevents.dev/?prompt=Build%20me%20a%20duty%20roster%20app%3A%20people%2C%20shifts%20and%20swaps%2C%20with%20a%20view%20of%20who%20is%20on%20tonight.%20Use%20made-up%20data.)
- [Build me a kit serviceability tracker: items, their state, who reported a fault and when it is due back. Use made-up data.](https://cfos.cfevents.dev/?prompt=Build%20me%20a%20kit%20serviceability%20tracker%3A%20items%2C%20their%20state%2C%20who%20reported%20a%20fault%20and%20when%20it%20is%20due%20back.%20Use%20made-up%20data.)

When the first version appears, keep going in the same chat: ask for a field, a filter, a different layout, an approval step. Then ask it how the app is built. Each app runs in its own Dynamic Worker with its own storage, and a Blueprint shares the code without your data.

## Ideas closer to home

You know your own backlog better than we do. If you want a prompt to react against, these are things in-house teams build again and again, and each fits in the time you have:

- A request-and-approve flow for anything that needs a signature: leave, travel, a room, a vehicle. The human approval you met on the ops board is the same pattern.
- A lessons log with search. Put a few invented post-exercise reports in R2, index them with [AI Search](https://developers.cloudflare.com/ai-search/), and ask questions with sources.
- A standing-orders assistant: an agent that answers "what's the procedure for X" from a folder of documents and says which page it came from.
- A status board that pulls from two systems that don't talk to each other. Give each an MCP server and let one agent read both, as you did in Phase 4.
- A form that starts a [Workflow](https://developers.cloudflare.com/workflows/): it waits for a person, chases them after a day, and records who decided what.

## Stretch goals on the ops room

Three of these tick bonus missions on your board. `npm run skip:stretch` drops in one way to do Standing orders and Handover notes, plus an `ops_summary` tool as an example of a tool of your own. It doesn't tick **Field modification**: that one has to be yours.

### Flash traffic

EXCON sends FLASH requests during the afternoon: casualties at a clinic, medical supplies needed now. Deliver one and **Flash traffic** ticks. The better version is a watchkeeper that deals with it unprompted. Add a rule to the system prompt (FLASH first, always), or go further and have a scheduled task look for FLASH requests every minute.

### Standing orders

Agents can wake themselves up. `this.scheduleEvery(120, "storesCheck")` runs an `async storesCheck()` method on the class every two minutes. Scheduled runs have no request, so save the Worker's origin in `this.state` and reconnect to the MCP server from there. Use `this.mcp.callTool({ serverId: "cell", name, arguments })` to call tools directly, and `reportScheduledTask("…")` from `./ops/agent-kit` to tick **Standing orders**. See [scheduling tasks](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/).

One thing to think about: every chat session is its own agent, so scheduling from `chat()` starts a separate check for each conversation. Run it on one named instance instead (`getAgentByName` from `agents` gets you one), and decide when it should stop.

### Field modification

Invent a tool your ops room hasn't got. A few ideas: `eta_for`, `nearest_cell`, `what_can_i_send`, `overdue_requests`, `sitrep_as_text` in the format you'd read out on a net. (`ops_summary` is taken: the stretch reference already has one.) **Field modification** ticks the first time any client calls a tool the starter doesn't know about.

### Handover notes

Give the watchkeeper a tool that runs inside the agent rather than over MCP. Use `tool()` from the `ai` package, mix it in with `tools: { ...this.mcp.getAITools(), note_for_handover }`, and save what it learns with `this.setState(...)`. Add the notes to the system prompt so the next conversation starts with them.

Each chat session is its own agent, so this memory belongs to one conversation. To share it across sessions, keep it in one named agent instance, as the stretch reference does, or add a [D1](https://developers.cloudflare.com/d1/) database or [KV](https://developers.cloudflare.com/kv/) namespace. See [agent state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/).

### Lock the net

Anyone who knows your URL can use your MCP server, and in Phase 4 a partner's agent did. Decide what a visitor may do. Three steps, each harder than the last:

1. Read `x-cell-client` and `x-cell-callsign` in `src/index.ts` and refuse visitors who aren't your linked partner. This stops accidents and nothing else, because anyone can send a header.
2. Add a bearer token check for `/mcp`, store the token with `npx wrangler secret put MCP_TOKEN`, and send it from your watchkeeper in the `addMcpServer` headers. Share a second token with your partner and give it fewer tools. Cloudflare OS only asks for a URL, so test from AI Playground with **Custom headers** once the net is locked.
3. Do it properly with logins and scopes: see [MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/).

### More ideas

- Try [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/): the model writes a little code that calls your tools, instead of calling them one at a time. It helps when a job needs many calls, such as "task everything that's routine".
- Put [AI Gateway](https://developers.cloudflare.com/ai-gateway/) between the watchkeeper and Workers AI for request logs, caching, rate limits and cost tracking. An audit trail of what the model was asked is the first thing a reviewer will want.
- Try other [Workers AI models](https://developers.cloudflare.com/workers-ai/models/) in `vars.MODEL` and compare speed and cost in the chat's **Under the hood** panel. Some models need the Workers Paid plan.
- Build a public status page for the relief effort. The REST API allows cross-origin requests, so it can live anywhere.

## Bigger builds on the platform

**SITREP by voice.** Workers AI has speech-to-text and text-to-speech models. Record a message in the browser, transcribe it, pass it to the watchkeeper and read the reply out loud. Browse the [model catalogue](https://developers.cloudflare.com/workers-ai/models/).

**Requests that look after themselves.** Start a [Workflow](https://developers.cloudflare.com/workflows/) for each request. It can sleep, chase a request that has sat in one lane for too long, and ask the site to confirm delivery an hour later. Workflows survive restarts and retry failed steps for you.

**A brief as a PDF.** Use [Browser Run](https://developers.cloudflare.com/browser-run/) to render an HTML SITREP to a PDF, and store it in [R2](https://developers.cloudflare.com/r2/).

**The watchkeeper in a chat app.** Add a webhook route to the Worker that passes messages to the agent and posts its replies back. Each channel or user can have its own agent instance.

**A third cell.** Nothing says an agent stops at two MCP servers. Link a second partner and write the rules for choosing between them.

## Start your own project

| Starting point | Command |
|---|---|
| Any Workers template | `npm create cloudflare@latest` |
| A chat agent with a React UI | `npm create cloudflare@latest -- --template=cloudflare/agents-starter` |
| A remote MCP server | `npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless` |

There are many more in the [templates repo](https://github.com/cloudflare/templates).

## References

| Area | Where to read |
|---|---|
| Agents and MCP | [Agents SDK](https://developers.cloudflare.com/agents/), [MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/), [MCP client in agents](https://developers.cloudflare.com/agents/tools/mcp/), [MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/) |
| Agents in practice | [Human in the loop](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/), [scheduling](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/), [state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/), [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) |
| AI | [Workers AI](https://developers.cloudflare.com/workers-ai/), [function calling](https://developers.cloudflare.com/workers-ai/features/function-calling/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/), [AI Search](https://developers.cloudflare.com/ai-search/), [Vectorize](https://developers.cloudflare.com/vectorize/) |
| Compute | [Workers](https://developers.cloudflare.com/workers/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Workflows](https://developers.cloudflare.com/workflows/), [Sandbox SDK](https://developers.cloudflare.com/sandbox/), [Browser Run](https://developers.cloudflare.com/browser-run/) |
| Storage | [D1](https://developers.cloudflare.com/d1/) (SQL), [KV](https://developers.cloudflare.com/kv/) (key-value), [R2](https://developers.cloudflare.com/r2/) (objects), [Queues](https://developers.cloudflare.com/queues/) |
| Cloudflare OS | [The source](https://github.com/cloudflare/cloudflare-os), and the event instance at [cfos.cfevents.dev](https://cfos.cfevents.dev) |
| Protocol | [Model Context Protocol](https://modelcontextprotocol.io/), [MCP Inspector](https://github.com/modelcontextprotocol/inspector) |

Most of these have a free allowance, so a free account goes a long way this afternoon. The Sandbox SDK runs on Containers, which need the Workers Paid plan.
