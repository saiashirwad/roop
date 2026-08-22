To answer any Effect-related questions refer to ./.repos/effect/ (gitignored; `pnpm install` fetches
it via `scripts/prepare-effect.sh`)

Use `gpt-5.6-luna` for every subagent. Do not use `gpt-5.6-sol` for a subagent. If Luna is not
available, do not start the subagent. Continue in the primary agent or report the limit. Use terra
if required

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

# Effect usage

- Prefer an existing Effect primitive to an agent-specific invention. Fibers for cancellation, Layer
  for wiring, Schedule for retries, Stream/PubSub for events. Interruption is structured
  concurrency. There is no cancellation token.
- Anything that must survive a caller being interrupted belongs in Effect.ensuring — a lost race or
  a timeout is ordinary usage, not an edge case. State transitions that guard an invariant must be
  atomic. SubscriptionRef. modify, not read-then-write: correctness must not depend on where the
  runtime happens to yield.
- The model arrives through the environment. An Agent never names a provider.
- Use Effect.fn("Module.operation") as the function definition, taking the operation's real
  parameters — not as a wrapper around a zero-argument generator that is then invoked. Both trace;
  only the first carries argument capture and stack-trace information, and the language service
  flags the second. Never annotate the generator's return type to steer inference: it collapses the
  error and requirement channels to unknown. Annotate spans with Effect.annotateCurrentSpan inside
  the function.
- Errors are Schema.TaggedError. Define message as a getter, never a schema field: the error still
  reads well in logs and stack traces, but the string is derived, so it cannot drift from the fields
  it describes and never enters the encoded form. Decoding reconstructs the class, so the getter
  works on the far side of a boundary too.
- Entity ids are Schema.branded and namespaced (@effect-harness/RunId), so they carry a validator
  and a codec rather than a compile-time tag.
- Domain types express absence with Option, never null or undefined. Options records — the argument
  object describing what a caller may omit — keep optional properties, because that is how Effect's
  own APIs express arguments. A serialization boundary may project Option to null; that is the wire
  format's business, not the domain's.
- Tracing export is application wiring, never a harness dependency. v4 ships an OTLP exporter at
  effect/unstable/observability; @effect/opentelemetry is only for interop with an existing OTel
  SDK. See examples/tracing.ts.
