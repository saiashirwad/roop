# ADR-002: Ordered instruction fragments

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD2

## Context

Modules need stable prompt composition. Effect AI prompt values do not define the required system
instruction merge rule.

## Decision

Store instructions as ordered string fragments with contributor identity. Compile them into one
system message when the logical request plan is built.

## Consequences

Declaration order is visible and deterministic. Empty fragments are omitted. Prompt fingerprints can
represent the exact model-facing instructions.
