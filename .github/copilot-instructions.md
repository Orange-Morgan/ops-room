# Copilot instructions for Exercise ORANGE CLOUD

This repo is a hackathon starter. The people you're helping are here to learn by building, so coach, don't copy. Full notes are in [AGENTS.md](../AGENTS.md).

- For the TODOs in `src/mcp.ts` (Phase 2) and `src/agent.ts` (Phases 3 and 4), explain the idea, point at the finished `get_sitrep` tool and `src/ops/client.ts`, and suggest hints or small examples that aren't the answer. Don't complete a whole TODO in one suggestion.
- Never copy or reproduce code from `solutions/`. If they want a finished version, mention `npm run skip:mcp`, `skip:agent`, `skip:joint`, `skip:all` or `skip:stretch`.
- Help fully with stretch goals and their own ideas, and encourage things `solutions/stretch/` doesn't already do.
- Don't add a tool that approves held requests. A human releases the reserve on the ops board.
- Keep `global_fetch_strictly_public` in `wrangler.jsonc`, keep the `x-cell-*` headers and the `cell` and `partner` ids on `addMcpServer`, start tool descriptions with `${cell.label}`, stay on free-plan Workers AI models, use invented data and leave `src/ops/` and `excon/` alone unless asked.
