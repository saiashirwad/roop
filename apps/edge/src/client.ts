/**
 * roop room client — join a multiplayer coding room from your terminal.
 *
 * Speaks the liminal Schema protocol (not the old ad-hoc JSON types).
 *
 *   pnpm --filter=@roop/edge client <url> <name>
 *   e.g. pnpm client http://localhost:8787/room/demo/ws alice
 *
 * Commands: /say <msg> human chat, /interrupt, /users, /quit.
 * Plain lines go to the agent (Prompt).
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as readline from "node:readline/promises"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as Client from "liminal/Client"

import { RoomClient } from "./RoomClient.ts"
import * as reducers from "./reducers.ts"

const [urlArg, name] = process.argv.slice(2)
if (urlArg === undefined || name === undefined) {
  console.error("usage: client <url> <name>   e.g. client http://localhost:8787/room/demo/ws alice")
  process.exit(1)
}

const baseUrl = urlArg.replace(/^http/, "ws")
const withName = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}`

let lastSeq = 0
let inAgentText = false
let members: ReadonlyArray<{ id: string; name: string }> = []

const endAgentText = () => {
  if (inAgentText) {
    process.stdout.write("\n")
    inAgentText = false
  }
}

const summarize = (value: unknown, max = 100): string => {
  let text: string
  try {
    text = JSON.stringify(value) ?? ""
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const renderRecord = (record: {
  entry:
    | { _tag: "UserPrompt"; prompt: string; actor?: { id: string; name: string } }
    | { _tag: "Agent"; event: { _tag: string; [key: string]: unknown } }
}) => {
  if (record.entry._tag === "UserPrompt") {
    endAgentText()
    const who = record.entry.actor?.name ?? "someone"
    console.log(`\n${who}> ${record.entry.prompt}`)
    return
  }

  const event = record.entry.event
  switch (event._tag) {
    case "RunStarted": {
      endAgentText()
      console.log("· run started")
      break
    }
    case "TextDelta": {
      if (!inAgentText) {
        process.stdout.write("agent: ")
        inAgentText = true
      }
      process.stdout.write(String(event.delta))
      break
    }
    case "ToolCall": {
      endAgentText()
      console.log(`  [tool] ${String(event.name)} ${summarize(event.params)}`)
      break
    }
    case "ToolResult": {
      const tag = event.isFailure === true ? "fail" : "ok"
      console.log(`  [${tag}] ${summarize(event.result)}`)
      break
    }
    case "RunCompleted": {
      endAgentText()
      console.log("· done")
      break
    }
    case "RunFailed": {
      endAgentText()
      console.log(`· failed: ${String(event.message)}`)
      break
    }
    case "RunInterrupted": {
      endAgentText()
      console.log("· interrupted")
      break
    }
    default: {
      break
    }
  }
}

const clientLayer = (url: string) =>
  Client.layerSocket({
    client: RoomClient,
    url,
    replay: { mode: "startup" },
    reducers,
    onConnect: (state) =>
      Effect.sync(() => {
        lastSeq = state.cursor
        members = state.members
        console.log(
          `joined as ${state.self.name} — online: ${state.members.map((m) => m.name).join(", ")}` +
            (state.running ? " (a run is active)" : ""),
        )
      }),
  }).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor))

const listenEvents = RoomClient.events.pipe(
  Stream.runForEach((event) =>
    Effect.sync(() => {
      if (event._tag === "Presence") {
        endAgentText()
        members = event.members
        console.log(`~ online: ${event.members.map((m) => m.name).join(", ")}`)
        return
      }
      if (event._tag === "Chat") {
        endAgentText()
        console.log(`[chat] ${event.from.name}: ${event.text}`)
        return
      }
      if (event._tag === "Record") {
        if (event.seq > lastSeq) lastSeq = event.seq
        renderRecord(event.record)
      }
    }),
  ),
)

/**
 * Read one line. Returns null on stdin EOF so piped smoke tests can exit cleanly
 * (Node readline's question() hangs after the pipe closes).
 */
const readLine = (rl: readline.Interface) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string | null>((resolve) => {
        if (process.stdin.readableEnded) {
          resolve(null)
          return
        }
        let settled = false
        const finish = (value: string | null) => {
          if (settled) return
          settled = true
          rl.off("close", onClose)
          process.stdin.off("end", onEnd)
          resolve(value)
        }
        const onClose = () => finish(null)
        const onEnd = () => finish(null)
        rl.once("close", onClose)
        process.stdin.once("end", onEnd)
        void rl.question("").then(
          (line) => finish(line),
          () => finish(null),
        )
      }),
    catch: () => null as null,
  })

const readInput = Effect.gen(function* () {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log("type a message and hit enter; /say <msg>, /interrupt, /users, /quit")

  try {
    while (true) {
      const line = yield* readLine(rl)
      if (line === null) break
      const text = line.trim()
      if (text.length === 0) continue

      if (text === "/quit" || text === "/exit") break

      if (text === "/interrupt") {
        yield* RoomClient.fn("Interrupt")({}).pipe(Effect.ignore)
        continue
      }
      if (text === "/users") {
        console.log(`~ online: ${members.map((m) => m.name).join(", ") || "(none)"}`)
        continue
      }
      if (text.startsWith("/say ") || text === "/say") {
        const msg = text.slice(5).trim()
        if (msg.length === 0) {
          console.log("usage: /say <message>")
          continue
        }
        yield* RoomClient.fn("Say")({ text: msg }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              endAgentText()
              console.log(`! ${Cause.pretty(cause)}`)
            }),
          ),
        )
        continue
      }

      yield* RoomClient.fn("Prompt")({ text }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            endAgentText()
            console.log(`! ${Cause.pretty(cause)}`)
          }),
        ),
      )
    }
  } finally {
    rl.close()
  }
})

const program = Effect.gen(function* () {
  while (true) {
    const url = `${withName}&after=${lastSeq}`
    const session = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(listenEvents)
      yield* readInput
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
    }).pipe(Effect.provide(clientLayer(url)), Effect.scoped)

    const exit = yield* session.pipe(Effect.exit)
    if (Exit.isSuccess(exit)) break

    endAgentText()
    console.log("~ disconnected; reconnecting…")
    console.error(Cause.pretty(exit.cause).split("\n")[0] ?? "")
    yield* Effect.sleep("1 second")
  }
})

await Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exit(1)
})
