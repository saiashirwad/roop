# ADR-004: One plan per logical request

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD4

## Context

Retries and fallback are physical attempts. They must not change the tools or instructions that the
agent exposed for the request.

## Decision

Render the agent once for each logical model request. Create one immutable plan and fingerprint.
Permit a retry or fallback only before the first model part is emitted or tool dispatch starts.

## Consequences

The renderer is deterministic for a request. Attempts can be audited and cannot silently expose a
different plan.
