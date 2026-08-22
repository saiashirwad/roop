# ADR-007: Scoped stream and RPC supervision

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD7

## Context

The kernel must be embeddable. Named run admission, subscribers, replay handoff, and external
interruption are host concerns.

## Decision

Use direct scoped stream execution as the kernel API. Move named supervision, active subscribers,
external interruption, and replay handoff to an RPC-owned `RunSupervisor`.

## Consequences

Consuming a stream starts the run. Interrupting the stream interrupts run-owned work. The RPC
example can add host lifecycle behavior without making it a kernel dependency.
