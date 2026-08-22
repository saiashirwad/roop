# Roop architecture decisions

These records define the boundary for the Effect-native kernel refactor. They are accepted for the
experimental release. The implementation may change names, but it must preserve these decisions and
their tests.

## Baseline

U1 records the current behavior before the public API changes. The relevant history is:

- `83e4cc7` — `fix: clean up runtime correctness (#29)`.
- `3b3dcdf` — `refactor: fold agentLoop/runStep into run`.
- `7fec88b` — `refactor: cut repo down to the agent framework kernel`.
- `ae58ea1` — `refactor: prune dead ids and unused kernel exports`.

The two-package workspace is part of the baseline. `packages/agent` is the portable kernel and
`packages/agent-rpc` is the host example.

## Decision index

1. [Explicit Agent and runtime capability](./ADR-001-agent-and-runtime.md)
2. [Ordered instruction fragments](./ADR-002-instruction-fragments.md)
3. [Collected and validated tool registry](./ADR-003-tool-registry.md)
4. [One plan per logical request](./ADR-004-logical-request.md)
5. [Effect AI tool dispatch](./ADR-005-effect-ai-dispatch.md)
6. [Typed around middleware](./ADR-006-around-middleware.md)
7. [Scoped stream and RPC supervision](./ADR-007-scoped-stream.md)
8. [Versioned journal algebra](./ADR-008-journal-algebra.md)
9. [Auditable effective requests](./ADR-009-request-audit.md)
10. [Consolidated interpreter](./ADR-010-consolidated-interpreter.md)
11. [Two-package workspace](./ADR-011-two-package-workspace.md)
12. [Extension proof before legacy deletion](./ADR-012-extension-proof.md)

## Characterization contract

The current tests are the behavior contract for later units. They cover text and reasoning
streaming, model-tool-model loops, concurrent tools, provider and live correlation IDs, model and
tool timeouts, interruption and finalizer cleanup, policy limits, prompt rewriting, tool rejection,
provider-executed tools, and durable message derivation. The U1 tests use scripted models and local
Effect services. They do not require API keys or a local model command.
