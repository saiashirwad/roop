To answer any Effect-related questions refer to ./.repos/effect/ (gitignored, but it's there)

Module naming: PascalCase for modules exporting an Effect service/tag or schema namespace
(SessionStore.ts, Agent.ts); camelCase for leaf pure-function helpers (agentLoop.ts, agentTool.ts).

packages/agent is the portable kernel — it may import only `effect` and `effect/unstable/ai`
(enforced by test/portability.test.ts). Provider and platform wiring lives in packages/agent-node; a
Cloudflare/Workers adapter would be a sibling package with the same shape.
