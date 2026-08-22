# ADR-011: Two-package workspace

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD11

## Context

The kernel needs a host example that proves service and transport replacement. The RPC package is
already the current consumer.

## Decision

Keep the two-package workspace and the existing Effect bootstrap, Turbo, workspace, and portable
crypto files. Publish only the kernel in the experimental release.

## Consequences

`packages/agent` remains portable and publishable. `packages/agent-rpc` remains a consumer and host
proof, not a kernel dependency.
