import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import * as stylex from "@stylexjs/stylex"
import { Clock, Effect } from "effect"
import { useEffect, useRef, useState } from "react"

import { Composer, type Command } from "./Composer.tsx"
import { Markdown } from "./Markdown.tsx"
import { Palette, type PaletteAction } from "./Palette.tsx"
import { Reasoning } from "./Reasoning.tsx"
import {
  capsAtom,
  forkSessionAtom,
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
  app: { display: "grid", gridTemplateColumns: "248px 1fr", height: "100vh" },
  sidebar: {
    backgroundColor: "var(--sidebar)",
    borderRightColor: "var(--border)",
    borderRightStyle: "solid",
    borderRightWidth: 1,
    display: "flex",
    flexDirection: "column",
    fontSize: 14,
    overflowY: "auto",
    paddingBlock: 8,
    paddingInline: 8,
  },
  workspace: {
    alignItems: "center",
    borderRadius: 6,
    display: "flex",
    gap: 8,
    marginBottom: 4,
    paddingBlock: 6,
    paddingInline: 8,
  },
  logo: {
    alignItems: "center",
    backgroundColor: "var(--text)",
    borderRadius: 4,
    color: "#fff",
    display: "flex",
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  workspaceName: { fontWeight: 600 },
  workspaceModel: {
    color: "var(--faint)",
    fontSize: 12,
    marginLeft: "auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  row: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": "var(--hover)" },
    borderRadius: 6,
    borderWidth: 0,
    color: "var(--muted)",
    cursor: "pointer",
    display: "flex",
    fontFamily: "inherit",
    fontSize: 14,
    gap: 8,
    minHeight: 28,
    paddingBlock: 2,
    paddingInline: 8,
    textAlign: "left",
    width: "100%",
  },
  rowActive: { backgroundColor: "var(--active)", color: "var(--text)", fontWeight: 500 },
  rowIcon: { flexShrink: 0, fontSize: 14, opacity: 0.7, width: 18 },
  rowText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowTime: { color: "var(--faint)", flexShrink: 0, fontSize: 12, marginLeft: "auto" },
  sectionTitle: {
    color: "var(--faint)",
    fontSize: 12,
    fontWeight: 500,
    marginTop: 16,
    paddingBlock: 4,
    paddingInline: 8,
  },
  hint: {
    color: "var(--faint)",
    fontSize: 12,
    marginTop: "auto",
    paddingBlock: 8,
    paddingInline: 8,
  },
  key: {
    backgroundColor: "var(--hover)",
    borderRadius: 3,
    fontFamily: "var(--mono)",
    fontSize: 11,
    paddingBlock: 1,
    paddingInline: 4,
  },
  main: { display: "flex", flexDirection: "column", overflow: "hidden" },
  chat: { flexGrow: 1, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    marginInline: "auto",
    maxWidth: 708,
    paddingBlock: 48,
    paddingInline: 24,
    width: "100%",
  },
  pageTitle: {
    fontSize: 32,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    lineHeight: 1.2,
    marginBottom: 12,
  },
  user: {
    alignSelf: "flex-end",
    backgroundColor: "var(--callout)",
    borderRadius: 12,
    maxWidth: "85%",
    paddingBlock: 8,
    paddingInline: 14,
    whiteSpace: "pre-wrap",
  },
  notice: { color: "var(--red)", fontFamily: "var(--mono)", fontSize: 13 },
  empty: {
    color: "var(--faint)",
    fontSize: 22,
    fontWeight: 600,
    marginTop: "26vh",
    textAlign: "center",
  },
  emptySub: { color: "var(--faint)", fontSize: 14, fontWeight: 400, marginTop: 6 },
  composer: {
    marginInline: "auto",
    maxWidth: 708,
    paddingBlock: 20,
    paddingInline: 24,
    width: "100%",
  },
})

const ago = (timestamp: number) => {
  const minutes = Math.round((Effect.runSync(Clock.currentTimeMillis) - timestamp) / 60_000)
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
      <div {...stylex.props(styles.workspace)}>
        <span {...stylex.props(styles.logo)}>r</span>
        <span {...stylex.props(styles.workspaceName)}>roop{busy ? " ·" : ""}</span>
        <span {...stylex.props(styles.workspaceModel)}>
          {modelId ?? (caps._tag === "Success" ? caps.value.defaultModelId : "")}
        </span>
      </div>
      <button {...stylex.props(styles.row)} disabled={busy} onClick={onNew}>
        <span {...stylex.props(styles.rowIcon)}>✚</span>
        <span {...stylex.props(styles.rowText)}>New session</span>
      </button>
      <div {...stylex.props(styles.sectionTitle)}>Sessions</div>
      {sessions._tag === "Success" &&
        sessions.value.map((session) => (
          <button
            key={session.id}
            {...stylex.props(styles.row, session.id === active && styles.rowActive)}
            disabled={busy}
            onClick={() => select(session.id)}
          >
            <span {...stylex.props(styles.rowIcon)}>💬</span>
            <span {...stylex.props(styles.rowText)}>
              {session.title === "" ? "Untitled" : session.title}
            </span>
            <span {...stylex.props(styles.rowTime)}>{ago(session.updatedAt)}</span>
          </button>
        ))}
      <div {...stylex.props(styles.hint)}>
        <span {...stylex.props(styles.key)}>/</span> or{" "}
        <span {...stylex.props(styles.key)}>⌘K</span> for commands
      </div>
    </aside>
  )
}

export const App = () => {
  const transcript = useAtomValue(transcriptAtom)
  const sessions = useAtomValue(sessionsAtom)
  const setTranscript = useAtomSet(transcriptAtom)
  const forkSession = useAtomSet(forkSessionAtom)
  const selectSession = useAtomSet(selectSessionAtom)
  const setSession = useAtomSet(sessionAtom)
  const [modelId, setModelId] = useAtom(modelAtom)
  const caps = useAtomValue(capsAtom)
  const prompt = useAtomValue(promptAtom)
  const busy = prompt.waiting
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
    if (busy) return
    setSession(undefined)
    setTranscript([])
  }
  const close = () => {
    setPaletteOpen(false)
    document.getElementById("composer")?.focus()
  }
  const onAction = (action: PaletteAction) => {
    if (busy) {
      close()
      return
    }
    switch (action.kind) {
      case "new": {
        newSession()
        break
      }
      case "resume": {
        selectSession(action.id)
        break
      }
      case "fork": {
        forkSession(undefined)
        break
      }
      case "model": {
        setModelId(action.id)
        break
      }
    }
    close()
  }
  const send = useAtomSet(promptAtom)
  const interrupt = useAtomSet(interruptAtom)
  const model = modelId ?? (caps._tag === "Success" ? caps.value.defaultModelId : "")
  const session = useAtomValue(sessionAtom)
  const title = transcript.find((item) => item.kind === "user")
  const tagCommands: ReadonlyArray<Command> =
    caps._tag === "Success"
      ? [
          ...caps.value.skills.map((skill) => ({
            group: "Skills",
            icon: "◈",
            label: skill.id,
            description: skill.description,
            action: { kind: "tag" as const },
          })),
          ...caps.value.tools.map((tool) => ({
            group: "Tools",
            icon: "⚙",
            label: tool.name,
            description: tool.description,
            action: { kind: "tag" as const },
          })),
        ]
      : []
  const slashCommands: ReadonlyArray<Command> =
    caps._tag === "Success"
      ? [
          {
            group: "Session",
            icon: "✚",
            label: "New session",
            action: { kind: "run" as const, run: newSession },
          },
          ...caps.value.models.map((entry) => ({
            group: "Models",
            icon: entry.id === model ? "●" : "○",
            label: entry.id,
            description: entry.description,
            action: { kind: "run" as const, run: () => setModelId(entry.id) },
          })),
          ...tagCommands,
        ]
      : []
  return (
    <div {...stylex.props(styles.app)}>
      <Sidebar busy={busy} onNew={newSession} />
      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.chat)}>
          <div {...stylex.props(styles.column)}>
            {transcript.length === 0 ? (
              <div {...stylex.props(styles.empty)}>
                Ask, build, or run anything
                <div {...stylex.props(styles.emptySub)}>
                  Your agent has tools, skills, and subagents. Press{" "}
                  <span {...stylex.props(styles.key)}>/</span> for commands.
                </div>
              </div>
            ) : (
              <div {...stylex.props(styles.pageTitle)}>
                {title?.kind === "user"
                  ? title.text.length > 60
                    ? `${title.text.slice(0, 60)}…`
                    : title.text
                  : "Untitled"}
              </div>
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
                case "reasoning":
                  return <Reasoning key={index} text={item.text} />
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
        <div {...stylex.props(styles.composer)}>
          <Composer
            busy={busy}
            commands={slashCommands}
            mentions={tagCommands}
            model={model}
            onInterrupt={() => interrupt()}
            onModelClick={() => setPaletteOpen(true)}
            onSubmit={(prompt) => send(prompt)}
          />
        </div>
      </main>
      {paletteOpen && caps._tag === "Success" && (
        <Palette
          activeModel={model}
          models={caps.value.models}
          sessions={sessions._tag === "Success" ? sessions.value : []}
          busy={busy}
          canFork={session !== undefined}
          onAction={onAction}
          onClose={close}
        />
      )}
    </div>
  )
}
