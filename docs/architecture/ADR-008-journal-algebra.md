# ADR-008: Versioned journal algebra

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD8

## Context

Durable history must be portable and safe for concurrent writers. Storage must not own prompt
projection.

## Decision

Use a versioned append-only event algebra with atomic expected-revision batches. A missing session
is revision zero. Recover open spans before the next turn. Do not persist token deltas.

## Consequences

Journal implementations can be swapped. Revision conflicts write nothing. Recovery does not
automatically re-execute an uncertain tool side effect.
