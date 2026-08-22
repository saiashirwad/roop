# Roop

Roop is an Effect-native agent runtime. It provides a portable agent loop, typed failures, scoped
resources, and replaceable services through Effect Layers.

Roop is the framework only. It does not provide a model provider, database, UI, sandbox, coding
tool, deployment system, or channel integration.

## Workspace

The repository keeps two packages:

- [`@roop/agent`](./packages/agent) is the portable kernel.
- [`@roop/agent-rpc`](./packages/agent-rpc) is a host example that serves the kernel over Effect
  RPC.

The kernel source may import only `effect`, `effect/unstable/ai`, and local modules. The portability
and workerd tests enforce this rule.

## Current refactor boundary

The current branch is the behavior baseline for the Effect-native kernel refactor. It keeps the
existing interpreter while its dependency boundaries are changed in small units.

The target public model is:

- an explicit `Agent` value;
- effectful modules that contribute ordered instructions and typed tools;
- models, journals, and domain services supplied through Effect Layers;
- typed around middleware at model, tool, step, and turn boundaries; and
- a scoped run `Stream` whose interruption owns run cleanup.

The current behavior contract is tested without API keys or a local model command. It covers text
and reasoning streaming, model-tool-model loops, concurrent tools, provider and live correlation
IDs, timeouts, interruption, policy limits, prompt rewriting, tool rejection, provider-executed
tools, and durable message derivation.

## Architecture records

The accepted decisions and baseline commits are in
[`docs/architecture/README.md`](./docs/architecture/README.md). The baseline commits are:

- `83e4cc7` — runtime correctness fixes;
- `3b3dcdf` — consolidated loop and step execution;
- `7fec88b` — product package cut;
- `ae58ea1` — dead identifier and export cleanup.

## Development

Requirements:

- Node.js 24 (`24.15.0`)
- pnpm 11
- Git

```bash
corepack enable
pnpm install
pnpm check
```

Other useful commands:

```bash
pnpm test
pnpm lint
pnpm format:check
```

The Effect source used for local API questions is checked out at `./.repos/effect` by the install
script.

## License

MIT
