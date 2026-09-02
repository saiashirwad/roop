# @roop/agent-rpc

The `@roop/agent` kernel served over Effect RPC (`effect/unstable/rpc`).

- `AgentRpc.ts`: the `RpcGroup` contract shared by servers and clients.
- `AgentRpcServer.ts`: handlers for the group, backed by a `RunSupervisor`.
- `AgentRpcHttp.ts`: HTTP/NDJSON server and client layers.
- `RunSupervisor.ts`: host-side lifecycle state (one active run per session, subscribers, messages
  to a running run, interrupts).

## RPC methods

| Method          | Payload                                 | Result                                                | Errors                                    |
| --------------- | --------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `StartRun`      | `{ sessionId, prompt, policy?, meta? }` | stream of `RunEvent`                                  | `SessionBusy`, runtime and journal errors |
| `SubscribeRun`  | `{ sessionId }`                         | stream of `RunEvent` (replay, then live)              | `RunNotFound`, runtime and journal errors |
| `SendMessage`   | `{ sessionId, content }`                | `{ runId, started }`                                  | `SessionBusy`, journal errors             |
| `InterruptRun`  | `{ sessionId }`                         | `void`                                                | `RunNotFound`                             |
| `GetHistory`    | `{ sessionId }`                         | `JournalSnapshot` (`sessionId`, `revision`, `events`) | `JournalError`, `JournalFutureVersion`    |
| `ListSessions`  | none                                    | `Array<SessionSummary>`                               | `JournalError`                            |
| `DeleteSession` | `{ sessionId }`                         | `void`                                                | `SessionBusy`, `JournalError`             |

## Lifecycle

A session has at most one active run. `StartRun` starts one and returns its stream; that stream is
the run's lifetime, so a client that drops it interrupts the run. `SubscribeRun` attaches another
reader to the active run: it replays every event published so far and continues live, with no gap
between the two. `SendMessage` delivers a user message to the active run: the kernel commits it as a
`user/message` at the next step boundary (after the tool results of the step in progress, or right
after a final answer, which then makes the run take another step instead of ending), and the model
sees it in its next request. The reply is `{ runId, started: false }`. When no run is active,
`SendMessage` starts one with the message as its prompt and replies `{ runId, started: true }`; the
caller then `SubscribeRun`s. A run started this way belongs to the supervisor, not to any stream: it
keeps going without subscribers until it ends or is interrupted. A run that has ended counts as
inactive, so a message sent after the end starts a fresh run rather than failing. `InterruptRun`
stops the active run and returns once its terminal `run` event is committed and the session is free;
`GetHistory` then shows the whole run, steering messages included.

## Events

`RunEvent` (from `@roop/agent`) is one algebra for the live stream and for history: a `StartRun` or
`SubscribeRun` stream carries the run's journal events (`run`, `turn`, `step`, `model/attempt`,
`model/request`, `session/meta`, `user/message`, `assistant/message`, `tool`, `tool/call`,
`tool/result`) in commit order, interleaved with the live-only members `text/delta`,
`reasoning/delta`, `tool/output` (preliminary tool results), and `subagent` (a child run's event,
tagged with the tool call that runs the child). Every event carries `version` and `at` (epoch
milliseconds). Filtering a live stream with `RunEvent.isLive` yields exactly the events `GetHistory`
returns for the run, so one renderer serves both.

A run ends with a top-level `run` event in state `completed` or `aborted` (`reason` is `completed`,
`failed`, `interrupted`, or `stopped`; `usage` totals the run's tokens); `RunEvent.isTerminal`
recognizes it. The kernel commits that event before the run's handle settles, whatever ended the
run, so every subscriber sees it. A failed run also fails the stream with the typed error.

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
