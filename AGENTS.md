To answer any Effect-related questions refer to ./.repos/effect/ (gitignored, but it's there)

Module naming: PascalCase for modules exporting an Effect service/tag or schema namespace
(SessionStore.ts, AgentRunner.ts); camelCase for leaf pure-function helpers (sessionTurns.ts,
capabilityQueries.ts).

## apps/edge — multiplayer rooms on Cloudflare

Worker + per-room Durable Object (hibernatable WebSockets, DO sqlite for the session log,
prompt queue, and shared virtual filesystem). True multiplayer: any member can prompt (runs
serialize through the durable queue) or interrupt. The Effect agent runtime (core AgentRunner,
fake-fs toolkit, model from worker secrets) lives inside the DO.

- Local: `pnpm --filter=@roop/edge dev` (wrangler dev; symlink `apps/edge/.env` to the root
  `.env` for model keys — it is gitignored)
- Client: `pnpm --filter=@roop/edge client <url> <name>` e.g.
  `pnpm client http://localhost:8787/room/demo/ws alice`
- Deploy: `cd apps/edge && npx wrangler deploy`; model keys as secrets
  (`npx wrangler secret put KIMI_API_KEY`)
- Note: the Kimi coding-plan key works from a local machine but is 403-rejected from
  Cloudflare egress IPs; use Z.AI/DeepSeek keys for the deployed worker.
