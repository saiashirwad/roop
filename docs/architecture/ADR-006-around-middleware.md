# ADR-006: Typed around middleware

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD6

## Context

Policies need to observe and change full operation lifetimes, including failure, interruption, and
resource cleanup.

## Decision

Represent middleware as explicit typed values with Layer-backed constructors. Compose with a right
fold so the leftmost declared value is outermost.

## Consequences

Middleware can preserve distinct service requirements, typed failures, scope, and finalizers. It
does not need a global hook service.
