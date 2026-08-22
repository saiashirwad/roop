# ADR-001: Explicit Agent and runtime capability

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD1

## Context

An agent definition must be visible in application code. Runtime services must remain replaceable
through Effect Layers.

## Decision

Define `Agent` as a named value. Define `AgentRuntime` as the Effect capability that interprets the
value. A delegation tool declares `AgentRuntime` in its requirements.

## Consequences

The definition is explicit and testable. The runtime can use different models, journals, and host
services. No ambient agent service or module-global registry is required.
