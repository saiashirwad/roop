# ADR-010: Consolidated interpreter

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD10

## Context

The previous loop and step split was already consolidated. A new file split would add names without
adding independent contracts.

## Decision

Keep the consolidated interpreter as `internal/run.ts`. Split a helper only when it has an
independent contract and tests.

## Consequences

The refactor keeps a small internal change surface. Public boundaries are tested without restoring
the removed `agentLoop.ts` and `runStep.ts` seam.
