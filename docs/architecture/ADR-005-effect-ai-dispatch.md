# ADR-005: Effect AI tool dispatch

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD5

## Context

Effect AI already parses tool calls and provides a toolkit dispatch seam. Roop must still own its
policy and scheduling behavior.

## Decision

Let Effect AI parse and dispatch with `concurrency: "unbounded"`. Wrap the installed handler so Roop
is the only owner of approval, scheduling, correlation, timeouts, output limits, middleware, and
live events.

## Consequences

There is one tool dispatch owner and one concurrency gate. Provider-executed and local calls share
one correlation and journal contract.
