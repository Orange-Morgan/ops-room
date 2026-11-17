# The guided path

By the end of this you'll have an MCP server that runs a relief ops room, an AI watchkeeper that uses it, and a link to another cell so your two agents can hand work to each other. Everything runs on one Cloudflare Worker in your own account.

There are four phases. Rough timings for the session, 14:30 to 16:30:

| Phase | You'll have | Aim to finish by |
|---|---|---|
| [1. Stand up the ops room](#phase-1-stand-up-the-ops-room) | A deployed ops room with a role and callsign, and an MCP client calling your first tool | 14:50 |
| [2. Build the tasking tools](#phase-2-build-the-tasking-tools) | Four new tools that raise requests, move them along and resupply | 15:15 |
| [3. Put the watchkeeper on shift](#phase-3-put-the-watchkeeper-on-shift) | An agent that runs the ops room through your MCP server | 15:30 |
| [4. Joint tasking](#phase-4-joint-tasking) | Your agent working across two MCP servers: yours and your partner cell's | 15:45 |
| [Your own mission](#your-own-mission) | Whatever you choose to build | ENDEX at 16:20 |

Behind schedule? Every phase has a skip command that drops in a finished version. Skipping is allowed and nobody minds.

## Before you start

- A free Cloudflare account. [Sign up](https://dash.cloudflare.com/sign-up) if you haven't got one.
- For working locally: Node.js 22 or later, Git and an editor. Check with `node --version`.
- No local setup? Use the Deploy button in the README and edit in the browser. On your new GitHub repo, press `.` to open the web editor. Each commit to `main` redeploys.
- Use invented data all afternoon. Don't paste anything from a work system into a model or a free account.

## The exercise in one minute

A storm has hit the island of Halcyon. Eight distribution points, DP ALPHA to DP HOTEL, need stores: water, rations, medical supplies, shelter kits and more. Stores are counted in pallets.

A request for support is a load of stores for one distribution point. It moves `requested → tasked → en_route → delivered`.

You work in pairs, and each pair runs one cell. Exercise control (EXCON) tells you which kind:

| | Air cell | Land cell |
|---|---|---|
| Moves stores by | sortie | convoy |
| One request carries | up to 6 pallets | up to 24 pallets |
| Can reach | any distribution point | points whose road is open |
| Stops when | flying is suspended | never, but a cut road blocks that point |

Neither kind can do everything, which is what Phase 4 is for.

Two more rules. Every store has a reserve, and a request that would take a store below it is held until a human releases it on the ops board. And EXCON sends injects during the afternoon: a surge of new requests, a bridge out, bad weather, a FLASH request. They arrive on your board whether you're ready or not.

---

## Phase 1: stand up the ops room

Goal: deploy your ops room, give it a role and callsign, and get an MCP client to call a tool.

### 1. Deploy

From a terminal:

```sh
git clone https://github.com/GoncaloLeitao/exercise-orange-cloud.git
cd exercise-orange-cloud
npm install
npx wrangler login
npm run deploy
```

Or use the Deploy button in the [README](../README.md#option-b-the-deploy-button).

Wrangler prints your Worker's URL. It looks like `https://ops-room.<your-subdomain>.workers.dev`. The rest of this guide calls it `<your-worker>`.

### 2. Open the ops board

Go to `https://<your-worker>/`. The board asks you to stand up your ops room: choose **Air cell** or **Land cell**, as EXCON told you, and pick a callsign. KESTREL 1, BADGER 2, anything short. **Ops room open** ticks on the mission board.

Have a look round. The lanes are empty, the stores are full and all eight roads are open. Open **Run your own injects** at the bottom and select **Surge** to see a few requests arrive, then move one along with the buttons on its ticket. That's the REST API at work: the board is plain HTML calling `/api/*`.

A few seconds after you open the board, your ops room also reports to EXCON and appears on the big screen.

### 3. Connect an MCP client

MCP (Model Context Protocol) is how AI apps find and use tools. A client connects to a server, asks which tools it has, and lets a model call them. Your ops room already runs an MCP server at `https://<your-worker>/mcp` with one tool, `get_sitrep`.

Copy the URL from the **Your MCP server** box on the board, then connect a client. Use the event's Cloudflare OS for the rest of the afternoon. AI Playground is the backup.

**Cloudflare OS** (use this one)

The event has its own [Cloudflare OS](https://github.com/cloudflare/cloudflare-os) at [cfos.cfevents.dev](https://cfos.cfevents.dev).

1. Open [cfos.cfevents.dev](https://cfos.cfevents.dev) and sign in with your work email and a one-time code.
2. Open **Gatekeepers** from the sidebar (you may also be offered it the first time you sign in) and choose **MCP Server**.
3. Paste your MCP server URL and select **Continue**.
4. Start a chat and ask: *Give me a SITREP from my ops room.*

Tools marked read-only, like `get_sitrep`, run straight away. Anything that changes your ops room waits for you to approve it in the chat, so from Phase 2 on, expect to press **Approve** for each request, status change and resupply.

**AI Playground** (backup: no sign-in, but chats stop after 10 messages)

1. Open [playground.ai.cloudflare.com/models](https://playground.ai.cloudflare.com/models).
2. In the panel on the right, open **Custom MCP** and select **Add server**.
3. Paste your MCP server URL and select **Add server**. After a few seconds it says **Ready**, and the **Tools** tab lists `get_sitrep`.
4. Ask it: *Give me a SITREP from my ops room.* When it says the demo is limited to 10 messages, start a new chat.

Either way, the model calls `get_sitrep` and the board ticks **Comms check** and **First SITREP**.

**MCP Inspector** (a developer tool that shows the raw protocol)

```sh
npx @modelcontextprotocol/inspector
```

It opens in your browser. Choose the Streamable HTTP transport, paste your URL, connect, list the tools and run `get_sitrep`. If you'd rather stay in the terminal:

```sh
npx @modelcontextprotocol/inspector --cli https://<your-worker>/mcp --transport http --method tools/call --tool-name get_sitrep
```

### What just happened

The client sent `tools/list` to your Worker and got back a name, a description and an input schema for each tool. The model read those, decided `get_sitrep` would answer your question, and the client sent `tools/call`. Your Worker ran the tool and sent back the picture as JSON.

`src/index.ts` sends every `/mcp` request to `createMcpHandler` from the Agents SDK, which builds a fresh server from `src/mcp.ts` for each request. That file is where you're going next.

---

## Phase 2: build the tasking tools

Goal: add four tools to `src/mcp.ts` so an MCP client can run your ops room.

### How a tool is built

Open `src/mcp.ts`. The finished `get_sitrep` tool is your template:

```ts
server.registerTool(
  "get_sitrep",                                   // the name the model calls
  {
    title: "Get the SITREP",
    description: `${cell.label}: the current picture. ...`, // how the model decides when to use it
    inputSchema: z.object({}),                    // a zod schema; the SDK validates input for you
    annotations: { readOnlyHint: true }           // a hint that it doesn't change anything
  },
  async () => {
    const sitrep = await cell.getSitrep();         // talk to your ops room
    return asText(sitrep);                         // send the result back as JSON text
  }
);
```

`cell` is a small client for your ops room's backend, a Durable Object with a SQLite database. `src/ops/client.ts` lists what it can do. When something's wrong, like an unknown store, a load too big for one sortie or a road that's cut, it throws an error with a readable message. The MCP SDK turns that into a tool error the model can read and explain, so you don't need `try`/`catch`.

Every description starts with `${cell.label}`, which reads like "Air cell KESTREL 1". It looks fussy now. In Phase 4 one agent holds your tools and your partner's, with the same names, and the description is how the model tells whose is whose.

### Your loop for each tool

1. Uncomment the block and write the handler.
2. Deploy with `npm run deploy` (or commit and push if you used the Deploy button).
3. Cloudflare OS picks up new tools within about 5 minutes. If one still isn't there, start a new chat. In AI Playground, open **Custom MCP → Tools** and select **Refresh**.
4. Ask for something that needs the tool and watch your board.

Working locally? `npm run dev` serves everything at http://localhost:8787. Cloudflare OS and AI Playground can't reach your laptop, so connect MCP Inspector to `http://localhost:8787/mcp` instead.

### TODO 1: `raise_request`

The schema is written for you. Fill in the handler so it calls `cell.raiseRequest` and returns the result.

Then ask: *DP CHARLIE needs 2 pallets of water and 1 of medical supplies.* A new ticket appears on the board, labelled **MCP**, and **Request raised** ticks.

Now try one your ops room can't take: *DP CHARLIE needs 3 pallets of champagne.* The error comes back as a tool result and the model explains it.

<details>
<summary>Show the answer</summary>

```ts
async ({ site, items, precedence, note }) => {
  const request = await cell.raiseRequest({ site, items, precedence, note });
  return asText(request);
}
```

</details>

### TODO 2: `list_requests`

Read-only, like `get_sitrep`. Both inputs are optional, and `status` defaults to `"open"` (anything not delivered or cancelled).

Ask: *What's still open?*

<details>
<summary>Show the answer</summary>

```ts
async ({ status, site }) => asText(await cell.listRequests({ status, site }))
```

</details>

### TODO 3: `update_request_status`

Requests move forward only: `requested → tasked → en_route → delivered`. Cancelling returns the stock.

Ask: *Task request 101 and get it moving.* Then: *It's arrived, mark it delivered.* **On the move** ticks.

<details>
<summary>Show the answer</summary>

```ts
async ({ requestId, status }) => asText(await cell.updateRequestStatus(requestId, status))
```

</details>

### TODO 4: `resupply_store`

This one's all yours, including the description and the schema. It takes a `storeId` (a string) and a `quantity` (a whole number of pallets from 1 to 50), and calls `cell.resupplyStore(storeId, quantity)`.

Write the description for a model, not a person: say what the tool does, when to use it and where the ids come from. Start it with `${cell.label}:` like the others.

Ask: *A resupply flight has landed. Add ten pallets of medical supplies.* **Resupply** ticks.

<details>
<summary>Show the answer</summary>

```ts
server.registerTool(
  "resupply_store",
  {
    title: "Resupply a store",
    description: `${cell.label}: add pallets to a store, for example after a resupply run. Use store ids from get_sitrep.`,
    inputSchema: z.object({
      storeId: z.string().describe("Store id from get_sitrep"),
      quantity: z.number().int().min(1).max(50).describe("How many pallets to add")
    })
  },
  async ({ storeId, quantity }) => asText(await cell.resupplyStore(storeId, quantity))
);
```

</details>

### Meet the Duty Officer

Ask for more than the reserve allows: *DP DELTA needs every generator we have.*

The request is raised, but it comes back `held`, and an orange bar appears at the top of your board: **Held for the Duty Officer**. Nothing has left the stores yet. Select **Release** or **Reject**. You are the Duty Officer, and **Sunray's say-so** ticks when you decide. (Sunray is the commander's appointment title on a radio net.)

There is no MCP tool for that decision, and that's deliberate. The model can recommend releasing a reserve. Only a human can do it. Cloudflare OS adds a second check of its own by asking you to approve every write.

### Check your work

```sh
npm run smoke -- https://<your-worker> --write
```

You want `Phase 2 progress: 4/4 tools`. Smoke-test requests are labelled **smoke** and don't count towards missions.

Stuck or short on time? `npm run skip:mcp` copies in a finished `src/mcp.ts` and keeps yours as `src/mcp.ts.bak`. Deploy afterwards.

---

## Phase 3: put the watchkeeper on shift

Goal: connect your agent to your MCP server so it can run the ops room from a chat.

### Meet the watchkeeper

Open `https://<your-worker>/chat` and say hello. The watchkeeper will talk, but it will tell you it isn't on the net yet. It has no tools.

It lives in `src/agent.ts`. It's an [Agents SDK](https://developers.cloudflare.com/agents/) `Agent`, and every chat session gets its own instance. Each instance is a Durable Object with its own storage, which is how it remembers the conversation between messages.

When you send a message, `chat()` asks the model for a reply with `generateText` from the AI SDK. Once the model has tools, the SDK runs a loop: the model asks for a tool, the SDK calls it, the result goes back to the model, and so on until it has an answer (up to 10 steps).

### TODO 1: connect to your MCP server

In `chat()`, uncomment the `addMcpServer` call:

```ts
await this.addMcpServer("cell", `${origin}/mcp`, {
  id: "cell",
  transport: {
    type: "streamable-http",
    headers: { "x-cell-client": "agent", "x-cell-origin": origin }
  }
});
```

The watchkeeper connects to your `/mcp` over its public URL, the same way Cloudflare OS did. The connection is saved in its storage, so calling this on every message is fine. The `id` gives the server a stable name, so the model sees your tools as `tool_cell_get_sitrep` and so on. The headers tell the board that the calls come from your agent.

### TODO 2: hand the model your tools

Uncomment one line in the `generateText` call:

```ts
tools: this.mcp.getAITools(),
```

`getAITools()` turns every tool from every connected MCP server into the format the AI SDK expects.

Leave TODO 3 alone for now. It belongs to Phase 4.

### Try it

Deploy, then reload `/chat`. The pill at the top should say **On the net: 1 MCP server · 5 tools**. Try the suggestions under the chat, or:

- *Give me a SITREP.*
- *DP HOTEL needs 2 pallets of blankets and 1 of rations.*
- *Task the request you just raised and get it moving.*
- *It's arrived. Mark it delivered.*
- *What's closest to its reserve? Resupply it with 10 pallets.*

Under each reply you'll see the tools the watchkeeper called. Select one to see its input and output. On the board its requests are labelled **AGENT**, and **Watchkeeper on shift**, **The watchkeeper raises a request** and **Delivered** tick as it works.

Then ask it for something that dips into a reserve and watch what it says. It should tell you the request is held and that it can't release it. If you haven't ticked **Sunray's say-so** yet, release it on the board now.

### Make it your own

The `SYSTEM_PROMPT` at the top of `src/agent.ts` is the watchkeeper's character and rules. Change it: give it a callsign of its own, have it report in SITREP format, or make it refuse to task anything routine while a FLASH request is open. The rules about using tools and quoting request numbers keep it honest, so change those carefully.

Stuck? `npm run skip:agent` copies in a finished `src/agent.ts` (yours goes to `src/agent.ts.bak`). You need a working MCP server as well, so run `npm run skip:mcp` first if Phase 2 isn't done.

---

## Phase 4: joint tasking

Goal: link your watchkeeper to your partner cell's MCP server, and hand over a request your own cell can't deliver.

EXCON pairs each Air cell with a Land cell. An Air cell can reach anywhere but lifts little. A Land cell lifts a lot but needs a road. Between you, most things are possible.

### 1. Link your partner on the board

Swap Worker URLs with your partner cell. On your ops board, paste theirs into **Partner cell** and select **Link**. The board looks them up and shows their callsign and role. They do the same with yours.

### 2. TODO 3: connect to your partner's MCP server

In `chat()` in `src/agent.ts`, delete the line `const partner: PartnerLink | null = null;` and uncomment the block under it:

```ts
const partner = await partnerCell(this, origin);
if (partner) {
  await this.addMcpServer("partner", partner.mcpUrl, {
    id: "partner",
    transport: { type: "streamable-http", headers: partner.headers }
  });
}
```

`partnerCell()` reads the partner you set on the board. The rest is the same call you made in Phase 3, pointed at somebody else's Worker. Your watchkeeper now holds two MCP servers. The model sees your tools as `tool_cell_...` and theirs as `tool_partner_...`.

The `jointOrders()` function near the top of the file adds a few lines to the system prompt once a partner is linked: try your own cell first, read the partner's SITREP before handing over, split a load that's too big for them. Read them. You'll want to sharpen them.

### 3. Try it

Deploy, then select **New conversation** on `/chat`. The pill should say **On the net: 2 MCP servers**.

You need a request your cell can't deliver. EXCON will send injects for this. To make your own, open **Run your own injects** on your board:

- **Land cell:** select **Bridge out**, note which road it cut, then ask the watchkeeper: *DP ECHO needs 8 pallets of water and 2 of medical supplies* (use the site that was cut).
- **Air cell:** select **Weather** to suspend flying, then ask: *DP BRAVO needs 4 pallets of sandbags.* Or ask for a load too big for a sortie: *DP BRAVO needs 12 pallets of sandbags.*

Watch the tool chips. The purple ones are calls to your partner's MCP server. A good watchkeeper reads your SITREP, sees the problem, reads your partner's SITREP, and raises the request there, split into loads your partner can carry. Their board shows the new tickets labelled **JOINT** with your callsign. **Link established** and **Joint tasking** tick on both boards.

When you're done, select **All clear** to reopen the roads and resume flying.

### What just happened

Your agent used tools from two organisations' systems in one conversation, and neither system knows about the other. Each MCP server describes its own tools. The agent read both descriptions and worked out what to send where.

Look at it from your partner's side too. A stranger's agent has just written to their ops room. The `x-cell-callsign` header says who it was, but nothing checks it, and nothing limits what a visiting agent can do. Which of your tools would you let a partner call? What would you want to see in the log? [Lock the net](ideas.md#lock-the-net) in the ideas page picks this up.

Stuck? `npm run skip:joint` copies in a finished `src/agent.ts`, and `npm run skip:all` does Phases 2 to 4 in one go. You still need to link your partner on the board.

---

## Your own mission

From about 15:45 until ENDEX at 16:20 the time is yours. Three ways to spend it:

1. **Build your own idea in Cloudflare OS.** You brought some. Your ops room is already connected as a Gatekeeper, so Cloudflare OS can build apps on top of it, write code against its tools and run things on a schedule. Or start something unrelated. [ideas.md](ideas.md) has prompts to get you going.
2. **Go for the bonus missions.** There are three on your board: deliver a FLASH request (**Flash traffic**), give the watchkeeper a scheduled task (**Standing orders**), and invent an MCP tool of your own (**Field modification**). [ideas.md](ideas.md#stretch-goals-on-the-ops-room) explains each. `npm run skip:stretch` drops in a reference for the first two, and reading `solutions/stretch/` is a good way to see how they work.
3. **Make your watchkeeper better at joint tasking.** EXCON keeps sending injects. An agent that copes with a bridge out and bad weather in the same five minutes is a good thing to show at the debrief.

At ENDEX, tools down. Each pair gets a minute at the hot debrief to show what they built.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| The board keeps asking you to stand up the ops room | Pick a role, type a callsign of 2 to 16 letters or numbers, and select **Stand up**. |
| The watchkeeper says it isn't on the net | Finish TODO 1 and TODO 2 in `src/agent.ts` and deploy again. |
| "Couldn't use an MCP server" | Your MCP server fails to start, often because of a duplicate tool name or an error at the top level of `src/mcp.ts`. Run `npm run smoke -- <your-worker>` and `npx wrangler tail`. If it's your partner's server, check their URL on your board. |
| Error 1042 | `global_fetch_strictly_public` is missing from `compatibility_flags` in `wrangler.jsonc`. Put it back and deploy. |
| A request won't move and says it is held | It dips into a reserve. Release or reject it at the top of your board. |
| "The road to DP … is cut" or "Flying is suspended" | That's an inject, not a bug. Hand the request to your partner cell, or wait for EXCON to clear it. |
| The chat says 1 MCP server after Phase 4 | Check your partner is linked on your board, that you deployed after TODO 3, and start a new conversation. |
| "Say again? That one came through garbled." | The model lost the thread. Ask again. |
| New tools don't show in Cloudflare OS | It checks for new tools every 5 minutes. Wait, then start a new chat. |
| New tools don't show in AI Playground | **Custom MCP → Tools → Refresh**. |
| Can't sign in to Cloudflare OS | Use your work email. If the code never arrives, tell exercise control and use AI Playground meanwhile. |
| AI Playground says the demo is limited to 10 messages | Start a new chat, or switch to Cloudflare OS, which has no such limit. |
| Cloudflare OS or AI Playground can't connect to localhost | They run on the internet. Deploy, or use MCP Inspector for local testing. |
| Replies take a long time | Model speed varies through the day. After one slow call the watchkeeper switches to its fallback model for three minutes by itself, and your board's log says so. Nothing to do. |
| "You've used today's free Workers AI allowance" | The allowance is per account and resets at midnight UTC. Deploy from your teammate's account. To make it last, set `vars.MODEL` to `"@cf/google/gemma-4-26b-a4b-it"` before it runs out: it costs about 40% as much. |
| "That model needs the Workers Paid plan" | Set `vars.MODEL` back to `"@cf/openai/gpt-oss-120b"`. |
| Wrangler asks for a workers.dev subdomain | New accounts need one. Pick any name. |
| `npm install` complains about the Node version | You need Node.js 22 or later. |
| TypeScript errors | `npm run check` lists them. Wrangler doesn't type-check when it deploys, so a type error can hide a bug. |
| Your ops room isn't on the big screen | Open your ops board and leave it open for a minute. If the footer says "EXCON not reached yet", tell exercise control. |
| The ops room is a mess | **Reset ops room** on the board gives you fresh stores and no requests. To wipe the mission board too: `curl -X POST https://<your-worker>/api/reset -H 'content-type: application/json' -d '{"everything":true}'` |

## REST API reference

Useful for scripts and your own frontends. Everything returns JSON, quantities are pallets and site ids are `alpha` to `hotel`.

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/state` | | Everything the ops board shows, in one call |
| `GET /api/sitrep` | | The short picture, as `get_sitrep` returns it |
| `POST /api/setup` | `{ "role": "air", "callsign": "KESTREL 1" }` | Your cell's identity. Changing role swaps the stores and clears requests |
| `GET /api/stores` | | Stores with pallets on hand and reserve |
| `POST /api/stores/:storeId/resupply` | `{ "quantity": 10 }` | The updated store |
| `GET /api/requests?status=open&site=echo` | | Requests, newest first. Status can be `open`, `held`, `requested`, `tasked`, `en_route`, `delivered`, `cancelled` or `all` |
| `POST /api/requests` | `{ "site": "echo", "items": [{ "storeId": "water", "qty": 2 }], "precedence": "priority", "note": "school hall" }` | The new request |
| `GET /api/requests/:id` | | One request |
| `PATCH /api/requests/:id` | `{ "status": "tasked" }` | The updated request |
| `POST /api/requests/:id/decision` | `{ "decision": "approved" }` | The Duty Officer's decision on a held request |
| `POST /api/partner` | `{ "url": "https://ops-room.someone.workers.dev" }` | Your partner cell, looked up from their Worker |
| `DELETE /api/partner` | | `{ "ok": true }` |
| `POST /api/inject` | `{ "type": "surge", "count": 3 }` | What the inject did. Types: `surge`, `flash`, `bridge_out`, `bridge_open`, `weather`, `all_clear`, `message` |
| `POST /api/reset` | `{ "everything": true }` (optional) | `{ "ok": true }` |

The API is open, like the MCP server: anyone who knows your URL can use it. That keeps the afternoon simple, and [Lock the net](ideas.md#lock-the-net) is there if it bothers you.
