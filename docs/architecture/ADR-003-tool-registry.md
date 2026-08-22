# ADR-003: Collected and validated tool registry

- Status: Accepted
- Date: 2026-08-22
- Decision: KTD3

## Context

Repeated toolkit merging can hide duplicate names and can make results depend on grouping.

## Decision

Collect typed tool contributions first. Validate all names and conflicts once at plan finalization.
Compile a valid registry to Effect AI at one internal adapter boundary.

## Consequences

Duplicate names fail before a model call and identify every contributor in stable order. Tool
requirements and failures remain in Effect channels until an application provides them.
