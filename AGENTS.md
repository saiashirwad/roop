To answer any Effect-related questions refer to ./.repos/effect/ (gitignored, but it's there)

Module naming: PascalCase for modules exporting an Effect service/tag or schema namespace
(SessionStore.ts, AgentRunner.ts); camelCase for leaf pure-function helpers (sessionTurns.ts,
capabilityQueries.ts).

## apps/edge — multiplayer rooms on Cloudflare

Worker + per-room Durable Object as a **liminal `ActorRuntime`** (hibernatable WebSockets, DO
sqlite for the session log, prompt queue, and shared virtual filesystem). True multiplayer: any
member can prompt (runs serialize through the durable queue) or interrupt. The Effect agent
runtime (core AgentRunner, fake-fs toolkit, model from worker secrets) lives inside the DO.

Protocol is liminal Schema (`RoomClient` / `RoomActor`), not ad-hoc JSON.

- Local: `pnpm --filter=@roop/edge dev` (wrangler dev; symlink `apps/edge/.env` to the root
  `.env` for model keys — it is gitignored)
- CLI client (liminal): `pnpm --filter=@roop/edge client <url> <name>` e.g.
  `pnpm client http://localhost:8787/room/demo/ws alice`
  (`/say <msg>` for human chat; plain lines prompt the agent)
- OpenTUI client: `pnpm --filter=@roop/edge-tui start <url> <name>`
  (two columns: agent left, human chat right; `tab` switches focus)
- Deploy: `cd apps/edge && npx wrangler deploy`; model keys as secrets
  (`npx wrangler secret put KIMI_API_KEY`)
- Note: the Kimi coding-plan key works from a local machine but is 403-rejected from
  Cloudflare egress IPs; use Z.AI/DeepSeek keys for the deployed worker.

### Layout

```
apps/edge/src/
  main.ts              # Worker.make + export Room (RoomRuntime)
  RoomRuntime.ts       # ActorRuntime.make
  RoomActor / Client / Namespace
  hydrate, external handlers, services/PromptQueue + RoomLayers
  client.ts            # liminal readline client (smoke / scripts)
apps/edge-tui/         # OpenTUI Solid terminal UI (not bundled into the worker)
```

Liminal / effect-workerd are consumed via `file:../../../liminal/...` (same Effect beta as
the monorepo). Worker entry: `src/main.ts`; DO class export name remains `Room`.
