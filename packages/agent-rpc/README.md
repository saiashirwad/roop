# @roop/agent-rpc

The `@roop/agent` kernel served over Effect RPC (`effect/unstable/rpc`).

- `AgentRpc.ts`: the `RpcGroup` contract shared by servers and clients.
- `AgentRpcServer.ts`: handlers for the group, backed by a `RunSupervisor`.
- `AgentRpcHttp.ts`: HTTP/NDJSON server and client layers.
- `RunSupervisor.ts`: host-side lifecycle state (one active run per session, subscribers,
  interrupts).

## RPC methods

| Method          | Payload                                 | Result                                                | Errors                                    |
| --------------- | --------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `StartRun`      | `{ sessionId, prompt, policy?, meta? }` | stream of `AgentEvent`                                | `SessionBusy`, runtime and journal errors |
| `SubscribeRun`  | `{ sessionId }`                         | stream of `AgentEvent` (replay, then live)            | `RunNotFound`, runtime and journal errors |
| `InterruptRun`  | `{ sessionId }`                         | `void`                                                | `RunNotFound`                             |
| `GetHistory`    | `{ sessionId }`                         | `JournalSnapshot` (`sessionId`, `revision`, `events`) | `JournalError`, `JournalFutureVersion`    |
| `ListSessions`  | none                                    | `Array<SessionSummary>`                               | `JournalError`                            |
| `DeleteSession` | `{ sessionId }`                         | `void`                                                | `SessionBusy`, `JournalError`             |

`meta` is `{ title?, cwd? }`. When present it is committed as a `session/meta` journal event before
the run's `user/message`; `ListSessions` reports the latest value of each field along with
`revision`, `createdAt`, and `updatedAt` (epoch milliseconds). `DeleteSession` refuses while a run
is active on the session and is otherwise a no-op for unknown sessions.

## Hosting

```ts
import { AgentRpcServerHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { RunSupervisorLive } from "@roop/agent-rpc/RunSupervisor.ts"
import { Runtime } from "@roop/agent"
import { JournalFs } from "@roop/journal-fs"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Layer } from "effect"

const journal = JournalFs.layer({ directory: "./.roop/sessions" }).pipe(
  Layer.provide([NodeFileSystem.layer, NodePath.layer]),
)
const host = RunSupervisorLive(agent).pipe(
  Layer.provide(Layer.mergeAll(Runtime.AgentRuntimeLive, journal, model)),
)
const server = AgentRpcServerHttp("/rpc").pipe(Layer.provide(host))
```

Swap `journal` for `JournalMemory.JournalMemory` to keep sessions in memory.
