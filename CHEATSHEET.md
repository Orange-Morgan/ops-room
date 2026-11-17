# Exercise ORANGE CLOUD: cheat sheet

Cloudflare London · Wednesday 18 November 2026 · 14:30 to 16:30 · ENDEX at 16:20, then the debrief and prizes

Printable version: [docs/cheatsheet.pdf](docs/cheatsheet.pdf)

## Links

| | |
|---|---|
| Starter repo | https://github.com/GoncaloLeitao/exercise-orange-cloud |
| Your ops room | `https://ops-room.<your-subdomain>.workers.dev` (Wrangler prints it) |
| Ops board / chat / MCP / API | `/` · `/chat` · `/mcp` · `/api/state` |
| Cloudflare OS | https://cfos.cfevents.dev, sign in with your work email and a one-time code |
| AI Playground (backup) | https://playground.ai.cloudflare.com/models |
| Step-by-step guide | [docs/guide.md](docs/guide.md) |

## Get going

```sh
git clone https://github.com/GoncaloLeitao/exercise-orange-cloud.git
cd exercise-orange-cloud
npm install
npx wrangler login
npm run deploy
```

No Node 22 or no npm? Use the **Deploy to Cloudflare** button in the README, then edit in GitHub's web editor (press `.` on your repo). Every commit redeploys.

| Your cell | Moves by | One request carries | Reaches | Stops when |
|---|---|---|---|---|
| Air cell | sortie | up to 6 pallets | any distribution point | flying is suspended |
| Land cell | convoy | up to 24 pallets | points with an open road | that point's road is cut |

## The phases

**1. Stand up the ops room** (aim for 14:50). Deploy and open your ops board. Pick Air or Land and a callsign. In Cloudflare OS, open **Gatekeepers → MCP Server**, paste your `/mcp` URL, select **Continue** and ask for a SITREP. Backup: AI Playground, **Custom MCP → Add server** (10 messages per chat).

**2. Build the tasking tools** (aim for 15:15). In `src/mcp.ts`, finish TODO 1 to 4: `raise_request`, `list_requests`, `update_request_status`, `resupply_store`. After each deploy, Cloudflare OS sees new tools within 5 minutes. Approve anything that changes your ops room. Then ask for every generator you have, and release the held request on your board.

**3. Watchkeeper on shift** (aim for 15:30). In `src/agent.ts`, uncomment TODO 1, `this.addMcpServer(...)`, and TODO 2, `tools: this.mcp.getAITools()`. Deploy, open `/chat` and have the watchkeeper raise a request, move it and deliver it.

**4. Joint tasking** (aim for 15:45). Swap URLs with your partner cell and paste theirs into **Partner cell** on your board. Do TODO 3 in `src/agent.ts`, deploy and start a new conversation. Ask for a delivery your cell can't make: a cut road, suspended flying, too big a load.

**Then your own mission**, until ENDEX at 16:20. Build your idea in Cloudflare OS, or go for the bonus missions. See [docs/ideas.md](docs/ideas.md).

## The code you'll write

```ts
// src/mcp.ts: every tool has the same shape. get_sitrep is done for you: copy its pattern.
server.registerTool(
  "get_sitrep",                                            // the name the model calls
  {
    description: `${cell.label}: the current picture. ...`,  // how the model decides when to use it
    inputSchema: z.object({}),                             // a zod schema: what the model must send
    annotations: { readOnlyHint: true }                    // a hint that it changes nothing
  },
  async () => asText(await cell.getSitrep())               // do the work, send back JSON text
);

// src/agent.ts, TODO 1: connect the watchkeeper to your MCP server
await this.addMcpServer("cell", `${origin}/mcp`, {
  id: "cell",
  transport: { type: "streamable-http", headers: { "x-cell-client": "agent", "x-cell-origin": origin } }
});

// TODO 2, inside generateText({ ... }): give the model every tool from every connected MCP server
tools: this.mcp.getAITools(),

// TODO 3 (Phase 4): a second MCP server, your partner cell's. Its tools show up as tool_partner_...
const partner = await partnerCell(this, origin);
if (partner) {
  await this.addMcpServer("partner", partner.mcpUrl, {
    id: "partner",
    transport: { type: "streamable-http", headers: partner.headers }
  });
}
```

`cell` throws readable errors (not enough stock, road cut, load too big) and the MCP SDK passes them to the model, so skip the `try`/`catch`. A request that dips into a reserve comes back `held`: only a human can release it, on the board.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local ops room at http://localhost:8787 (use MCP Inspector: Cloudflare OS and AI Playground can't reach localhost) |
| `npm run deploy` | Put it live |
| `npm run smoke -- <url> --write --agent` | Check the API, your MCP tools and the watchkeeper |
| `npx wrangler tail` | Live logs from your Worker |
| `npx @modelcontextprotocol/inspector` | MCP Inspector, for poking at `/mcp` |
| `npm run skip:mcp` / `skip:agent` / `skip:joint` / `skip:all` / `skip:stretch` | Drop in a finished version (yours is saved as `src/*.ts.bak`) |

## If it breaks

| What you see | Fix |
|---|---|
| The watchkeeper says it isn't on the net | Finish TODO 1 and TODO 2 in `src/agent.ts` and deploy again |
| A request is stuck | Held: release it at the top of your board. Road cut or no flying: hand it to your partner |
| Still one MCP server after Phase 4 | Link your partner on the board, deploy TODO 3, start a new conversation |
| New tools missing in Cloudflare OS | Wait 5 minutes, then start a new chat |
| New tools missing in AI Playground | **Custom MCP → Tools → Refresh** |
| "Couldn't use an MCP server" | `npm run smoke -- <url>` shows the error |
| Error 1042 | Keep `global_fetch_strictly_public` in `wrangler.jsonc` |
| Replies are slow | The watchkeeper switches to its fallback model by itself after one slow call |
| Free Workers AI allowance used up | Deploy from your teammate's account. It resets at midnight UTC |
| Anything else | No duff: wave at exercise control |

## Missions

**Phase 1:** Ops room open · Comms check · First SITREP
**Phase 2:** Request raised · On the move · Resupply
**Phase 3:** Watchkeeper on shift · The watchkeeper raises a request · Delivered · Sunray's say-so
**Phase 4:** Link established · Joint tasking
**Bonus:** Flash traffic · Standing orders · Field modification
