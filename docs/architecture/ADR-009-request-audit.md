# ADR-009: Auditable effective requests

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD9

## Context

Dynamic rendering is useful, but a later reader must know what the model could see.

## Decision

Record a versioned JSON-safe effective request, exposed tool names, and canonical prompt, tool, and
plan fingerprints for each logical request. Do not encode handlers, functions, or live token deltas.

## Consequences

Request behavior can be audited without storing executable values. The journal remains portable.
