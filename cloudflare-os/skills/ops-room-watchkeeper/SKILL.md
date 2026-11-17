---
name: ops-room-watchkeeper
description: Run an Exercise ORANGE CLOUD ops room through its MCP tools. Use when someone asks for a SITREP, wants to raise, move or list requests for support, resupply stores, or build an app or a scheduled check on top of their ops room.
---

# Ops room watchkeeper

Exercise ORANGE CLOUD is a hands-on exercise. Each pair of developers runs an ops room for a relief effort on the invented island of Halcyon and connects it to Cloudflare OS as an MCP Server gatekeeper. All of the data is invented.

## The tools

A finished ops room has five tools. A pair who are part-way through Phase 2 have fewer, so check what's there before you promise anything.

| Tool | What it does |
|---|---|
| `get_sitrep` | The current picture: the cell's callsign and role, conditions, stores, sites and request counts. Read-only. Start here |
| `raise_request` | Raise a request for support: stores for one distribution point |
| `list_requests` | List requests, open ones by default. Read-only |
| `update_request_status` | Move a request along, or cancel it |
| `resupply_store` | Add pallets to a store |

Some ops rooms have tools of their own on top. Read their descriptions and use them when they fit.

## The rules of the exercise

- Sites are distribution points DP ALPHA to DP HOTEL. Their ids are `alpha` to `hotel`.
- Quantities are pallets. Store ids come from `get_sitrep`. Never guess stock, ids or request numbers.
- A request moves `requested → tasked → en_route → delivered`, forward only. `cancelled` returns the stock.
- An Air cell can reach any site but carries 6 pallets a request, and nothing launches while flying is suspended. A Land cell carries 24 pallets a request but can't reach a site whose road is cut. The SITREP says which kind of cell this is and what the conditions are.
- When a tool refuses something, read the error. It says why and what would work instead: split the load, wait for conditions to change, or hand the request to another cell.
- Every store has a reserve, which is part of the pallets on hand, not extra stock. Raise what you're asked to raise in full and let the tool judge it: a request that would take a store below its reserve comes back with status `held`. A human has to release it on the ops board, using the buttons at the top. You can't release it, and you shouldn't try to get round it by splitting the request into smaller ones. Say that it's held and why.
- FLASH is the highest precedence, then IMMEDIATE, PRIORITY and ROUTINE. Deal with FLASH requests first.

## How to work

- Call `get_sitrep` before you plan anything, and again if the conversation has gone on for a while. Exercise control changes the conditions without warning.
- Quote request numbers, like #104, and say what state each one is in.
- Writes need the person's approval in the chat. Ask for one change at a time, in the order they'd expect, and say what each one will do.
- Only say something is done after the tool call worked.
- Be brief and factual.

## Building on the ops room

When someone asks for an app or a scheduled check on top of their ops room:

- Read through `get_sitrep` and `list_requests`. Don't copy the ops room's data into your own storage unless they ask for history.
- Keep the human approval. An app may show held requests and link to the ops board, but it shouldn't release them.
- For a schedule, ask before changing anything: a stores check should report what's at or below reserve and propose a resupply, not make one.
