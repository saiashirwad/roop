# ADR-012: Extension proof before legacy deletion

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD12

## Context

Deleting the old composition system before proving public extension seams could hide missing APIs.

## Decision

Gate legacy deletion on public approval and subagent proofs. Keep the `Module` to `Plugin` bridge
internal and temporary.

## Consequences

Extensions must compile without internal imports before the compatibility path is removed. The old
implementation remains only long enough to compare behavior and find missing seams.
