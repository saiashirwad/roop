To answer any Effect-related questions refer to ./.repos/effect/ (gitignored; `pnpm install` fetches
it via `scripts/prepare-effect.sh`)

Module naming: PascalCase for modules exporting an Effect service/tag or schema namespace
(SessionJournal.ts, Agent.ts); camelCase for leaf pure-function helpers (run.ts, toolScheduler.ts).

This repo is the agent framework only — no product packages. packages/agent is the portable kernel;
it may import only `effect` and `effect/unstable/ai` (enforced by test/portability.test.ts; proven
by the workerd suite in test-workerd/). Models, tools, and clients live in consuming projects.

Capability seams follow a strict three-role discipline:

1. Definition: Context.Service tag/shape (e.g. `SessionJournal`, `ModelCatalog`).
2. Consumer: Tools and handlers declare the service in `dependencies` and yield it at runtime (e.g.
   the `Subagent` delegation tool depends on `Agent` to run a child run per task).
3. Provider: Composition layers provide the capability (e.g. `SessionJournalFs` for durable
   journals, `SessionJournalMemory` for tests, `cryptoWeb` for portable ids, any
   `effect/unstable/ai` LanguageModel layer for models). This guarantees that swapping storage or
   model providers is an atomic 1-line layer swap. packages/agent-rpc is the example consumer: the
   same kernel served over Effect RPC (server + client modes).
