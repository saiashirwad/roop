import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { connectRoom, type ChatMessage, type Member, type RoomConnection } from "./connection.ts"
import { formatRecord, isTextDelta } from "./renderRecord.ts"

export type AppProps = {
  readonly url: string
  readonly name: string
}

type Line = { readonly id: string; readonly text: string }
type Focus = "agent" | "chat"

/** Coalesce TextDelta UI writes so OpenTUI is not re-laid-out on every token. */
const makeDeltaCoalescer = (append: (chunk: string) => void) => {
  let pending = ""
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    if (pending.length === 0) return
    const chunk = pending
    pending = ""
    append(chunk)
  }

  return {
    push(delta: string) {
      pending += delta
      if (timer === undefined) {
        timer = setTimeout(flush, 32)
      }
    },
    drain() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      flush()
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      pending = ""
    },
  }
}

const timeHHMM = (at: number): string => {
  const d = new Date(at)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  return `${h}:${m}`
}

export const App = (props: AppProps) => {
  const dims = useTerminalDimensions()
  const [status, setStatus] = createSignal("connecting…")
  const [selfName, setSelfName] = createSignal(props.name)
  const [members, setMembers] = createSignal<ReadonlyArray<Member>>([])
  const [agentLines, setAgentLines] = createSignal<Array<Line>>([])
  const [chatLines, setChatLines] = createSignal<Array<Line>>([])
  const [draft, setDraft] = createSignal("")
  const [agentBuf, setAgentBuf] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [focus, setFocus] = createSignal<Focus>("agent")

  let conn: RoomConnection | undefined
  let agentId = 0
  let chatId = 0
  /** Dedup hydrate + live Chat deliveries. */
  const seenChat = new Set<string>()

  const pushAgent = (text: string) => {
    agentId += 1
    setAgentLines((prev) => [...prev.slice(-400), { id: `a${agentId}`, text }])
  }

  const pushChat = (text: string, id?: string) => {
    chatId += 1
    setChatLines((prev) => [...prev.slice(-300), { id: id ?? `c${chatId}`, text }])
  }

  const flushAgent = () => {
    const buf = agentBuf()
    if (buf.length === 0) return
    pushAgent(`agent: ${buf}`)
    setAgentBuf("")
  }

  const coalescer = makeDeltaCoalescer((chunk) => {
    setAgentBuf((b) => b + chunk)
  })

  onMount(() => {
    conn = connectRoom(props.url, props.name, {
      onJoin: (info) => {
        setSelfName(info.self.name)
        setMembers(info.members)
        setStatus(info.running ? "connected (run active)" : "connected")
      },
      onPresence: (next) => {
        const prev = members()
        setMembers(next)
        // Join/leave noise stays in the human column only.
        if (prev.length === 0) return
        const prevIds = new Set(prev.map((m) => m.id))
        const nextIds = new Set(next.map((m) => m.id))
        for (const m of next) {
          if (!prevIds.has(m.id)) pushChat(`· ${m.name} joined`)
        }
        for (const m of prev) {
          if (!nextIds.has(m.id)) pushChat(`· ${m.name} left`)
        }
      },
      onRecord: (_seq, record) => {
        if (isTextDelta(record)) {
          coalescer.push(record.entry.event.delta)
          return
        }
        coalescer.drain()
        flushAgent()
        const line = formatRecord(record)
        if (line !== undefined) pushAgent(line)
        if (record.entry._tag === "Agent") {
          const tag = record.entry.event._tag
          if (tag === "RunCompleted" || tag === "RunFailed" || tag === "RunInterrupted") {
            setStatus("connected")
          } else if (tag === "RunStarted") {
            setStatus("connected (run active)")
          }
        }
      },
      onChat: (msg: ChatMessage) => {
        if (seenChat.has(msg.id)) return
        seenChat.add(msg.id)
        pushChat(`${timeHHMM(msg.at)} ${msg.from.name}: ${msg.text}`, msg.id)
      },
      onError: (message) => {
        const short = message.split(/\r?\n/).find((l) => l.trim().length > 0) ?? message
        const trimmed = short.length > 160 ? `${short.slice(0, 160)}…` : short
        setError(trimmed)
        pushAgent(`! ${trimmed}`)
      },
      onStatus: setStatus,
    })
  })

  onCleanup(() => {
    coalescer.dispose()
    void conn?.dispose()
  })

  const submit = () => {
    const text = draft().trim()
    if (text.length === 0 || conn === undefined) return
    setDraft("")
    setError(undefined)

    if (text === "/quit" || text === "/exit") {
      void conn.dispose().then(() => process.exit(0))
      return
    }
    if (text === "/interrupt") {
      void conn.interrupt()
      return
    }
    if (text === "/users") {
      pushChat(`· online: ${members().map((m) => m.name).join(", ") || "(none)"}`)
      return
    }
    if (text === "/agent" || text === "/a") {
      setFocus("agent")
      return
    }
    if (text === "/chat" || text === "/c") {
      setFocus("chat")
      return
    }

    if (focus() === "chat") {
      void conn.say(text)
    } else {
      void conn.prompt(text)
    }
  }

  useKeyboard((key) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      void conn?.dispose().then(() => process.exit(0))
      return
    }
    if (key.ctrl && key.name === "d") {
      void conn?.interrupt()
      return
    }
    // Tab toggles agent ↔ human chat (bash.tv-style dual focus).
    if (key.name === "tab") {
      setFocus((f) => (f === "agent" ? "chat" : "agent"))
      return
    }
    if (key.name === "return" || key.name === "enter") {
      submit()
      return
    }
    if (key.name === "backspace") {
      setDraft((d) => d.slice(0, -1))
      return
    }
    if (key.sequence !== undefined && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      setDraft((d) => d + key.sequence)
    }
  })

  const height = () => dims().height
  const width = () => dims().width
  const memberNames = () => members().map((m) => m.name).join(", ") || "—"

  // Right chat column ~ min(36, 35% width); left takes the rest.
  const chatCol = () => Math.max(24, Math.min(40, Math.floor(width() * 0.34)))
  const agentCol = () => Math.max(20, width() - chatCol())

  const focusLabel = () => (focus() === "agent" ? "agent" : "chat")
  const promptFg = () => (focus() === "agent" ? "#a0ffa0" : "#ffd580")
  const promptPrefix = () => (focus() === "agent" ? "agent ›" : "chat  ›")

  return (
    <box flexDirection="column" width={width()} height={height()}>
      <box height={1} flexShrink={0} backgroundColor="#1a1a2e" paddingLeft={1}>
        <text fg="#e0e0ff" wrapMode="none">
          {`roop · ${selfName()} · ${status()} · online ${memberNames()}`}
        </text>
      </box>

      <box flexDirection="row" flexGrow={1}>
        {/* ── Left: agent / shared workspace transcript ── */}
        <box flexDirection="column" width={agentCol()} flexGrow={1} border={["right"]} borderColor="#333355">
          <box height={1} flexShrink={0} backgroundColor={focus() === "agent" ? "#1e3a2f" : "#12121a"} paddingLeft={1}>
            <text fg={focus() === "agent" ? "#a0ffa0" : "#666688"} wrapMode="none">
              {focus() === "agent" ? "▸ agent" : "  agent"}
            </text>
          </box>
          <scrollbox stickyScroll={true} stickyStart="bottom" flexGrow={1} paddingLeft={1} paddingRight={1}>
            <For each={agentLines()}>
              {(line) => (
                <text wrapMode="word" width="100%">
                  {line.text}
                </text>
              )}
            </For>
            <Show when={agentBuf().length > 0}>
              <text wrapMode="word" width="100%" fg="#c8e6c9">
                {`agent: ${agentBuf()}`}
              </text>
            </Show>
          </scrollbox>
        </box>

        {/* ── Right: human-to-human chat ── */}
        <box flexDirection="column" width={chatCol()} flexShrink={0}>
          <box height={1} flexShrink={0} backgroundColor={focus() === "chat" ? "#3a2e1e" : "#12121a"} paddingLeft={1}>
            <text fg={focus() === "chat" ? "#ffd580" : "#666688"} wrapMode="none">
              {focus() === "chat" ? "▸ chat" : "  chat"}
            </text>
          </box>
          <box height={1} flexShrink={0} paddingLeft={1}>
            <text fg="#555577" wrapMode="none">
              {members()
                .map((m) => m.name)
                .join(" · ") || "—"}
            </text>
          </box>
          <scrollbox stickyScroll={true} stickyStart="bottom" flexGrow={1} paddingLeft={1} paddingRight={1}>
            <For each={chatLines()}>
              {(line) => (
                <text wrapMode="word" width="100%" fg="#d0d0e8">
                  {line.text}
                </text>
              )}
            </For>
          </scrollbox>
        </box>
      </box>

      <Show when={error()}>
        <box height={1} flexShrink={0} paddingLeft={1}>
          <text fg="#ff6b6b" wrapMode="none">
            {`! ${error()}`}
          </text>
        </box>
      </Show>

      <box height={1} flexShrink={0} backgroundColor="#16213e" paddingLeft={1}>
        <text fg={promptFg()} wrapMode="none">
          {`${promptPrefix()} ${draft()}`}
        </text>
      </box>

      <box height={1} flexShrink={0} paddingLeft={1}>
        <text fg="#555555" wrapMode="none">
          {`tab ${focusLabel()} · enter send · ctrl+d interrupt · esc quit · /a /c /users`}
        </text>
      </box>
    </box>
  )
}
