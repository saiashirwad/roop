/**
 * roop room client — join a multiplayer coding room from your terminal.
 *
 *   pnpm --filter=@roop/edge client <url> <name>
 *   e.g. pnpm client http://localhost:8787/room/demo/ws alice
 *
 * Commands: /interrupt stops the active run, /users lists the room, /quit exits.
 */
import * as readline from "node:readline/promises"

import type { ServerMessage } from "./protocol.ts"

const [urlArg, name] = process.argv.slice(2)
if (urlArg === undefined || name === undefined) {
  console.error("usage: client <url> <name>   e.g. client http://localhost:8787/room/demo/ws alice")
  process.exit(1)
}

const wsUrl = urlArg.replace(/^http/, "ws")

let lastSeq = 0
let inAgentText = false
let intentionalClose = false

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
      // ReasoningDelta, ToolProgress, subagent events: too noisy for the CLI.
      break
    }
  }
}

const handle = (message: ServerMessage) => {
  switch (message.type) {
    case "welcome": {
      console.log(
        `joined as ${message.self.name} — online: ${message.members.map((m) => m.name).join(", ")}` +
          (message.running ? " (a run is active)" : ""),
      )
      break
    }
    case "presence": {
      endAgentText()
      console.log(`~ online: ${message.members.map((m) => m.name).join(", ")}`)
      break
    }
    case "record": {
      if (message.seq > lastSeq) lastSeq = message.seq
      renderRecord(message.record)
      break
    }
    case "error": {
      endAgentText()
      console.log(`! ${message.message}`)
      break
    }
  }
}

let socket: WebSocket | undefined

const connect = (): void => {
  const url = `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}&after=${lastSeq}`
  const ws = new WebSocket(url)
  socket = ws

  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return
    try {
      handle(JSON.parse(event.data) as ServerMessage)
    } catch {
      // Ignore malformed frames.
    }
  })

  ws.addEventListener("close", () => {
    if (intentionalClose) return
    endAgentText()
    console.log("~ disconnected; reconnecting…")
    setTimeout(connect, 1000)
  })

  ws.addEventListener("error", () => {
    // The close handler performs the reconnect.
  })
}

const main = async () => {
  connect()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.on("SIGINT", () => {
    intentionalClose = true
    socket?.close()
    process.exit(0)
  })

  console.log("type a message and hit enter; /interrupt, /users, /quit")
  for await (const line of rl) {
    const text = line.trim()
    if (text.length === 0) continue

    if (text === "/quit" || text === "/exit") {
      intentionalClose = true
      socket?.close()
      process.exit(0)
    }

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      console.log("! not connected yet")
      continue
    }

    if (text === "/interrupt") {
      socket.send(JSON.stringify({ type: "interrupt" }))
      continue
    }
    if (text === "/users") {
      console.log("~ (see the last presence line; a fresh one prints on join/leave)")
      continue
    }

    socket.send(JSON.stringify({ type: "prompt", text }))
  }
}

await main()
