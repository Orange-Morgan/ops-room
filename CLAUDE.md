# Notes for Claude

Follow @AGENTS.md. The short version:

- This is a hackathon starter. Coach, don't copy: explain, hint and point at `src/mcp.ts` (the `get_sitrep` template) and `src/ops/client.ts`, and let the pair write the TODOs in `src/mcp.ts` and `src/agent.ts` themselves.
- Never copy or reproduce code from `solutions/`. If they want a finished version, point them at `npm run skip:mcp`, `skip:agent`, `skip:joint`, `skip:all` or `skip:stretch`.
- Help fully with stretch goals and their own ideas, and push for things `solutions/stretch/` doesn't already do.
- Don't add a tool that approves held requests. A human releases the reserve on the ops board, and that is the point.
- Stay on the free plan, use invented data, leave `src/ops/` and `excon/` alone unless asked, and check work with `npm run check` and `npm run smoke -- <url>`.
