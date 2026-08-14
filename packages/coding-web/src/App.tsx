import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import * as stylex from "@stylexjs/stylex"
import { useEffect, useRef, useState } from "react"

import { Markdown } from "./Markdown.tsx"
import { Palette, type PaletteAction } from "./Palette.tsx"
import {
  capsAtom,
  interruptAtom,
  modelAtom,
  promptAtom,
  selectSessionAtom,
  sessionAtom,
  sessionsAtom,
  transcriptAtom,
} from "./state.ts"
import { ToolCard } from "./toolViews.tsx"

const styles = stylex.create({
  app: { display: "grid", gridTemplateColumns: "260px 1fr", height: "100vh" },
  sidebar: {
    borderRightColor: "var(--border)",
    borderRightStyle: "solid",
    borderRightWidth: 1,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    overflowY: "auto",
    paddingBlock: 20,
    paddingInline: 16,
  },
  wordmark: { fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" },
  modelTag: { color: "var(--muted)", fontSize: 12 },
  sectionTitle: {
    color: "var(--faint)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  sessions: { display: "flex", flexDirection: "column", gap: 2 },
  session: {
    backgroundColor: { default: "transparent", ":hover": "var(--accent-soft)" },
    borderRadius: 8,
    borderWidth: 0,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    fontFamily: "inherit",
    fontSize: 13,
    gap: 1,
    paddingBlock: 6,
    paddingInline: 8,
    textAlign: "left",
  },
  sessionActive: { backgroundColor: "var(--accent-soft)" },
  sessionTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sessionTime: { color: "var(--faint)", fontSize: 11 },
  newSession: {
    backgroundColor: "var(--text)",
    borderRadius: 8,
    borderWidth: 0,
    color: "var(--surface)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    paddingBlock: 8,
  },
  hint: { color: "var(--faint)", fontSize: 12, marginTop: "auto" },
  key: {
    backgroundColor: "var(--accent-soft)",
    borderRadius: 4,
    fontFamily: "var(--mono)",
    paddingBlock: 1,
    paddingInline: 5,
  },
  main: { display: "flex", flexDirection: "column", overflow: "hidden" },
  chat: { flexGrow: 1, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    marginInline: "auto",
    maxWidth: 720,
    paddingBlock: 32,
    paddingInline: 24,
  },
  user: {
    alignSelf: "flex-end",
    backgroundColor: "var(--accent-soft)",
    borderRadius: 14,
    maxWidth: "85%",
    paddingBlock: 8,
    paddingInline: 14,
    whiteSpace: "pre-wrap",
  },
  notice: { color: "var(--red)", fontFamily: "var(--mono)", fontSize: 13 },
  empty: { color: "var(--faint)", marginTop: "30vh", textAlign: "center" },
  composer: {
    marginInline: "auto",
    maxWidth: 720,
    paddingBlock: 16,
    paddingInline: 24,
    width: "100%",
  },
  inputCard: {
    backgroundColor: "var(--surface)",
    borderColor: "var(--border)",
    borderRadius: 14,
    borderStyle: "solid",
    borderWidth: 1,
    display: "flex",
    gap: 8,
    padding: 10,
  },
  input: {
    backgroundColor: "transparent",
    borderWidth: 0,
    color: "var(--text)",
    fontFamily: "inherit",
    fontSize: 15,
    outline: "none",
    resize: "none",
    width: "100%",
  },
  send: {
    alignSelf: "flex-end",
    backgroundColor: "var(--accent)",
    borderRadius: 8,
    borderWidth: 0,
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    opacity: { default: 1, ":disabled": 0.4 },
    paddingBlock: 6,
    paddingInline: 14,
  },
  stop: { backgroundColor: "var(--red)" },
})

const ago = (timestamp: number) => {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1_440)}d`
}

const Sidebar = ({ busy, onNew }: { readonly busy: boolean; readonly onNew: () => void }) => {
  const caps = useAtomValue(capsAtom)
  const sessions = useAtomValue(sessionsAtom)
  const active = useAtomValue(sessionAtom)
  const modelId = useAtomValue(modelAtom)
  const select = useAtomSet(selectSessionAtom)
  return (
    <aside {...stylex.props(styles.sidebar)}>
      <div>
        <div {...stylex.props(styles.wordmark)}>roop{busy ? " ·" : ""}</div>
        <div {...stylex.props(styles.modelTag)}>
          {modelId ?? (caps._tag === "Success" ? caps.value.defaultModelId : "")}
        </div>
      </div>
      <button {...stylex.props(styles.newSession)} onClick={onNew}>
        New session
      </button>
      <span {...stylex.props(styles.sectionTitle)}>Sessions</span>
      <div {...stylex.props(styles.sessions)}>
        {sessions._tag === "Success" &&
          sessions.value.map((session) => (
            <button
              key={session.id}
              {...stylex.props(styles.session, session.id === active && styles.sessionActive)}
              onClick={() => select(session.id)}
            >
              <span {...stylex.props(styles.sessionTitle)}>
                {session.title === "" ? "untitled" : session.title}
              </span>
              <span {...stylex.props(styles.sessionTime)}>{ago(session.updatedAt)}</span>
            </button>
          ))}
      </div>
      <span {...stylex.props(styles.hint)}>
        <span {...stylex.props(styles.key)}>/</span> or{" "}
        <span {...stylex.props(styles.key)}>⌘K</span> for commands
      </span>
    </aside>
  )
}

const Composer = ({
  busy,
  text,
  setText,
  onSlash,
}: {
  readonly busy: boolean
  readonly text: string
  readonly setText: (text: string) => void
  readonly onSlash: () => void
}) => {
  const send = useAtomSet(promptAtom)
  const interrupt = useAtomSet(interruptAtom)
  const submit = () => {
    const prompt = text.trim()
    if (prompt.length === 0 || busy) return
    setText("")
    send(prompt)
  }
  return (
    <div {...stylex.props(styles.composer)}>
      <div {...stylex.props(styles.inputCard)}>
        <textarea
          {...stylex.props(styles.input)}
          autoFocus
          id="composer"
          placeholder="Message the agent, / for commands…"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "/" && text === "") {
              event.preventDefault()
              onSlash()
              return
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        {busy ? (
          <button {...stylex.props(styles.send, styles.stop)} onClick={() => interrupt()}>
            Stop
          </button>
        ) : (
          <button
            {...stylex.props(styles.send)}
            disabled={text.trim().length === 0}
            onClick={submit}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}

export const App = () => {
  const transcript = useAtomValue(transcriptAtom)
  const setTranscript = useAtomSet(transcriptAtom)
  const setSession = useAtomSet(sessionAtom)
  const [modelId, setModelId] = useAtom(modelAtom)
  const caps = useAtomValue(capsAtom)
  const prompt = useAtomValue(promptAtom)
  const busy = prompt.waiting
  const [text, setText] = useState("")
  const [paletteOpen, setPaletteOpen] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [transcript])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const newSession = () => {
    setSession(crypto.randomUUID())
    setTranscript([])
  }
  const close = () => {
    setPaletteOpen(false)
    document.getElementById("composer")?.focus()
  }
  const onAction = (action: PaletteAction) => {
    switch (action.kind) {
      case "new": {
        newSession()
        break
      }
      case "model": {
        setModelId(action.id)
        break
      }
      case "insert": {
        setText(action.text)
        break
      }
    }
    close()
  }
  return (
    <div {...stylex.props(styles.app)}>
      <Sidebar busy={busy} onNew={newSession} />
      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.chat)}>
          <div {...stylex.props(styles.column)}>
            {transcript.length === 0 && (
              <div {...stylex.props(styles.empty)}>Start a conversation</div>
            )}
            {transcript.map((item, index) => {
              switch (item.kind) {
                case "user":
                  return (
                    <div key={index} {...stylex.props(styles.user)}>
                      {item.text}
                    </div>
                  )
                case "assistant":
                  return <Markdown key={index} text={item.text} />
                case "tool":
                  return <ToolCard key={index} tool={item} />
                case "notice":
                  return (
                    <div key={index} {...stylex.props(styles.notice)}>
                      {item.text}
                    </div>
                  )
              }
            })}
            <div ref={bottom} />
          </div>
        </div>
        <Composer busy={busy} text={text} setText={setText} onSlash={() => setPaletteOpen(true)} />
      </main>
      {paletteOpen && caps._tag === "Success" && (
        <Palette
          activeModel={modelId ?? caps.value.defaultModelId}
          models={caps.value.models}
          skills={caps.value.skills}
          tools={caps.value.tools}
          onAction={onAction}
          onClose={close}
        />
      )}
    </div>
  )
}
