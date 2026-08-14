To answer any Effect-related questions refer to ./.repos/effect/ (gitignored; `pnpm install` fetches
it via `scripts/prepare-effect.sh`)

Module naming: PascalCase for modules exporting an Effect service/tag or schema namespace
(SessionStore.ts, Agent.ts); camelCase for leaf pure-function helpers (agentLoop.ts, agentTool.ts).

packages/agent is the portable kernel — it may import only `effect` and `effect/unstable/ai`
(enforced by test/portability.test.ts; proven by the workerd suite in test-workerd/). Provider and
platform wiring lives in packages/agent-node; a Cloudflare/Workers adapter would be a sibling
package with the same shape.

patches/@effect__ai-openai-compat@4.0.0-beta.97.patch is load-bearing: DeepSeek's chat-completions
API rejects consecutive tool calls unless they are coalesced into one assistant message and
content-less assistant messages are dropped. Do not remove the patchedDependencies wiring in
pnpm-workspace.yaml.
