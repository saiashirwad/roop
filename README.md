# roop

Compose a coding agent from Effect layers.

The kernel streams a model, runs tools, journals a session, and interrupts.
Models, tools, filesystems, and clients plug in. The loop does not care which.

Unstable. Private packages. APIs will move.

## Run

Node 24, pnpm 11, a [DeepSeek](https://platform.deepseek.com) key.

```bash
git clone https://github.com/saiashirwad/roop.git
cd roop
corepack enable && pnpm install

export DEEPSEEK_API_KEY=...
pnpm --filter @roop/coding-harness serve
```

Then a client:

```bash
pnpm --filter @roop/coding-tui start
pnpm --filter @roop/coding-web dev
```

RPC is `http://localhost:8787/rpc`. Sessions land in `.roop/sessions`.
Claude and Codex work if their CLIs are logged in.

## Compose

```ts
const coding = CodingTools()
const claude = Claude()

export const agent = AgentPlugins([
  coding,
  Todos(),
  claude,
  subagent({
    name: "delegate",
    description: "Hand off an isolated coding task.",
    plugins: [coding, claude],
    layer: ExecutionWorld.worktreeFromParent(),
  }),
]).pipe(
  Layer.provide(SessionStoreFs(".roop/sessions")),
  Layer.provide(ExecutionWorld.local(process.cwd())),
)
```

Swap the world, keep the tools:

```ts
ExecutionWorld.local("/repo")
ExecutionWorld.worktree({ baseRepo: "/repo" })
ExecutionWorld.memory({ files: { "src/index.ts": "export const n = 1" } })
```

`local` is not a sandbox. `bash` runs as you.

`@roop/agent` imports `effect` and nothing else. The tests run it in workerd.

## Packages

- [`agent`](./packages/agent) — portable kernel
- [`agent-rpc`](./packages/agent-rpc) — HTTP + NDJSON
- [`coding-tools`](./packages/coding-tools) — read, write, bash
- [`coding-harness`](./packages/coding-harness) — reference server
- [`coding-tui`](./packages/coding-tui) — terminal
- [`coding-web`](./packages/coding-web) — browser

Plugins: [claude](./packages/plugin-claude), [codex](./packages/plugin-codex), [openai](./packages/plugin-openai), [skills](./packages/plugin-skills), [todo](./packages/plugin-todo), [web](./packages/plugin-web).

## Check

```bash
pnpm check
```

## License

MIT
