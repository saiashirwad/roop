import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import * as stylex from "@stylexjs/stylex"
import { useEffect, useRef, useState } from "react"

import { Markdown } from "./Markdown.tsx"
import {
  capsAtom,
  interruptAtom,
  modelAtom,
  promptAtom,
  sessionAtom,
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
    gap: 24,
    overflowY: "auto",
    paddingBlock: 20,
    paddingInline: 16,
  },
  wordmark: { fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" },
  section: { display: "flex", flexDirection: "column", gap: 6 },
  sectionTitle: {
    color: "var(--faint)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  model: {
    backgroundColor: { default: "transparent", ":hover": "var(--accent-soft)" },
    borderRadius: 8,
    borderWidth: 0,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    fontSize: 13,
    paddingBlock: 6,
    paddingInline: 8,
    textAlign: "left",
  },
  modelActive: { backgroundColor: "var(--accent-soft)", color: "var(--accent)" },
  entryName: { fontWeight: 600 },
  entryDescription: {
    color: "var(--muted)",
    display: "-webkit-box",
    fontSize: 12,
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
  },
  entry: { fontSize: 13, paddingBlock: 2, paddingInline: 8 },
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

const Sidebar = ({ busy }: { readonly busy: boolean }) => {
  const caps = useAtomValue(capsAtom)
  const [modelId, setModelId] = useAtom(modelAtom)
  const setSession = useAtomSet(sessionAtom)
  const setTranscript = useAtomSet(transcriptAtom)
  if (caps._tag !== "Success") return <aside {...stylex.props(styles.sidebar)} />
  const { models, defaultModelId, skills, tools } = caps.value
  const active = modelId ?? defaultModelId
  return (
    <aside {...stylex.props(styles.sidebar)}>
      <span {...stylex.props(styles.wordmark)}>roop{busy ? " ·" : ""}</span>
      <button
        {...stylex.props(styles.newSession)}
        onClick={() => {
          setSession(crypto.randomUUID())
          setTranscript([])
        }}
      >
        New session
      </button>
      <div {...stylex.props(styles.section)}>
        <span {...stylex.props(styles.sectionTitle)}>Models</span>
        {models.map((model) => (
          <button
            key={model.id}
            {...stylex.props(styles.model, model.id === active && styles.modelActive)}
            onClick={() => setModelId(model.id)}
          >
            <span {...stylex.props(styles.entryName)}>{model.id}</span>
            {model.description !== undefined && (
              <span {...stylex.props(styles.entryDescription)}>{model.description}</span>
            )}
          </button>
        ))}
      </div>
      {skills.length > 0 && (
        <div {...stylex.props(styles.section)}>
          <span {...stylex.props(styles.sectionTitle)}>Skills</span>
          {skills.map((skill) => (
            <div key={skill.id} {...stylex.props(styles.entry)}>
              <span {...stylex.props(styles.entryName)}>{skill.id}</span>
              <div {...stylex.props(styles.entryDescription)}>{skill.description}</div>
            </div>
          ))}
        </div>
      )}
      <div {...stylex.props(styles.section)}>
        <span {...stylex.props(styles.sectionTitle)}>Tools</span>
        {tools.map((tool) => (
          <div key={tool.name} {...stylex.props(styles.entry)} title={tool.description}>
            <span {...stylex.props(styles.entryName)}>{tool.name}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}

const Composer = ({ busy }: { readonly busy: boolean }) => {
  const [text, setText] = useState("")
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
          placeholder="Message the agent…"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
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
  const prompt = useAtomValue(promptAtom)
  const busy = prompt.waiting
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [transcript])
  return (
    <div {...stylex.props(styles.app)}>
      <Sidebar busy={busy} />
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
        <Composer busy={busy} />
      </main>
    </div>
  )
}
