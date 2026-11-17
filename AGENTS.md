# Notes for AI coding assistants

This repo is a hackathon starter. The people you're working with are here to learn how MCP servers and agents work on Cloudflare by building them, in about two hours, in pairs. Help them build it. Don't build it for them.

## Coach, don't copy

The guided path has TODOs in two files: `src/mcp.ts` (Phase 2) and `src/agent.ts` (Phases 3 and 4). For those:

- Explain the idea first, then point at what they need: the finished `get_sitrep` tool in `src/mcp.ts` is the template, and `src/ops/client.ts` lists every call the ops room supports.
- Give hints and small examples that aren't the answer. Showing how `get_sitrep` returns its result is fine. Writing their `raise_request` handler is not.
- If they're stuck after a couple of hints, show the one line or block they're stuck on, not the whole file.
- Don't copy code from `solutions/` into `src/`, and don't reproduce it from reading it. If someone wants the finished version, tell them about the skip commands instead. That's what they're for, and nobody minds:

  | Command | Drops in |
  |---|---|
  | `npm run skip:mcp` | A finished `src/mcp.ts` (Phase 2) |
  | `npm run skip:agent` | A finished `src/agent.ts` for Phase 3, with the Phase 4 TODO left to do |
  | `npm run skip:joint` | A finished `src/agent.ts` for Phase 4 |
  | `npm run skip:all` | Phases 2 to 4 |
  | `npm run skip:stretch` | All of that, plus the stretch reference |

  Each one backs up the current file first (`src/*.ts.bak`, then `.bak-2`, and so on).
- If they insist you write a TODO for them, you can, but mention the skip command first and keep it to what they asked for.

Stretch goals and their own ideas are different. Help properly there: that's where they'll learn the most and where judges look. Push for something the reference in `solutions/stretch/` doesn't already do, rather than rebuilding it. Ideas are in `docs/ideas.md`.

## How the project fits together

- One Worker, `src/index.ts`: `/` ops board, `/chat` chat UI, `/api/*` REST API, `/mcp` the MCP server, `/agents/*` the agent.
- `src/ops/` is plumbing (store, client, missions, scenario, chat protocol). Read it freely, but don't change it unless they ask.
- The MCP server uses `@modelcontextprotocol/server` and `createMcpHandler` from `agents/mcp/server`. Tools return JSON as text with the `asText()` helper, and errors thrown by the ops room client become tool errors the model can read, so tool handlers don't need `try`/`catch`.
- Every tool description starts with `${cell.label}` (for example "Air cell KESTREL 1"). Keep that on new tools: in Phase 4 one agent holds two cells' tools with the same names.
- The watchkeeper is an Agents SDK `Agent` called `Watchkeeper`, one instance per chat session. It reaches the Worker's own public `/mcp` URL with `addMcpServer`, which is why `global_fetch_strictly_public` must stay in `compatibility_flags`. Without it, the Worker calling its own hostname gets error 1042.
- `addMcpServer` is called with `id: "cell"` for their own server and `id: "partner"` for the partner cell's, so the model sees `tool_cell_<name>` and `tool_partner_<name>`. Keep those ids: the system prompt and the kit rely on them.
- The `x-cell-client`, `x-cell-origin` and `x-cell-callsign` headers tell the ops board who is calling. Keep them on `addMcpServer`.
- A cell is an Air cell or a Land cell, chosen on the ops board, not in config. Air: any site, 6 pallets a request, nothing launches while flying is suspended. Land: 24 pallets a request, can't reach a site whose road is cut.
- Quantities are pallets. Site ids are `alpha` to `hotel`. Store ids come from `get_sitrep`.
- A request that would take a store below its reserve is saved as `held`. Only a human can release it, on the ops board. Don't add an MCP tool or an agent tool that approves held requests: keeping that decision with a person is the point of the exercise. If they ask for one, say why it's missing and let them decide.

## Constraints

- Attendees use their own free Cloudflare accounts. Stay on the free plan: no paid products, and keep `vars.MODEL` on a model the free plan allows (`@cf/openai/gpt-oss-120b` by default, with `@cf/google/gemma-4-26b-a4b-it` as `vars.MODEL_FALLBACK`, which steps in by itself when the first is slow).
- Don't add dependencies for the guided path. Everything it needs is installed.
- Use invented data only. Don't suggest loading anything from a work system.
- `excon/` is the facilitators' Worker. Attendees don't deploy or change it.
- Prefer small, readable changes they can explain at the debrief.

## Checking work

- `npm run check` type-checks. Wrangler doesn't type-check on deploy.
- `npm run smoke -- https://<their-worker>` checks the API and lists their MCP tools. Add `--write` to exercise the write tools and `--agent` to ask the watchkeeper a question and see which MCP servers it holds.
- `npx wrangler tail` streams live logs.
- The mission board on their ops board ticks as things work.

## Docs

- Step by step: `docs/guide.md`
- Agents SDK: https://developers.cloudflare.com/agents/
- MCP on Cloudflare: https://developers.cloudflare.com/agents/model-context-protocol/
- Workers AI models: https://developers.cloudflare.com/workers-ai/models/
