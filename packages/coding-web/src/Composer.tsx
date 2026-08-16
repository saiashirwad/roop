import { LexicalComposer } from "@lexical/react/LexicalComposer"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary"
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin"
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin"
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin"
import * as stylex from "@stylexjs/stylex"
import {
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
} from "lexical"
import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"

import { $createTag, TagNode } from "./TagNode.ts"

const styles = stylex.create({
  card: {
    backgroundColor: "var(--surface)",
    borderColor: "var(--border)",
    borderRadius: 12,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: "0 4px 18px rgba(55, 53, 47, 0.07)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
  },
  input: {
    color: "var(--text)",
    fontSize: 15,
    lineHeight: 1.5,
    minHeight: 44,
    outline: "none",
    position: "relative",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  placeholder: {
    color: "var(--faint)",
    fontSize: 15,
    left: 0,
    pointerEvents: "none",
    position: "absolute",
    top: 0,
  },
  shell: { position: "relative" },
  chips: { alignItems: "center", display: "flex", gap: 6 },
  chip: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": "var(--hover)" },
    borderColor: "var(--border)",
    borderRadius: 14,
    borderStyle: "solid",
    borderWidth: 1,
    color: "var(--muted)",
    cursor: "pointer",
    display: "flex",
    fontFamily: "inherit",
    fontSize: 12,
    gap: 5,
    paddingBlock: 3,
    paddingInline: 10,
  },
  chipDot: { backgroundColor: "var(--green)", borderRadius: "50%", height: 6, width: 6 },
  send: {
    alignItems: "center",
    backgroundColor: "var(--blue)",
    borderRadius: "50%",
    borderWidth: 0,
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    fontSize: 15,
    height: 28,
    justifyContent: "center",
    marginLeft: "auto",
    opacity: { default: 1, ":disabled": 0.35 },
    width: 28,
  },
  stop: { backgroundColor: "var(--red)" },
  menu: {
    backgroundColor: "var(--surface)",
    borderRadius: 10,
    bottom: "calc(100% + 8px)",
    boxShadow:
      "rgba(15, 15, 15, 0.05) 0px 0px 0px 1px, rgba(15, 15, 15, 0.1) 0px 5px 10px, rgba(15, 15, 15, 0.2) 0px 15px 40px",
    left: 0,
    maxHeight: 280,
    overflowY: "auto",
    padding: 6,
    position: "absolute",
    width: 340,
    zIndex: 20,
  },
  search: {
    alignItems: "center",
    borderBottomColor: "var(--border)",
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    display: "flex",
    gap: 8,
    marginBottom: 4,
    paddingBlock: 8,
    paddingInline: 10,
  },
  searchIcon: { color: "var(--faint)", flexShrink: 0, fontSize: 13 },
  searchInput: {
    backgroundColor: "transparent",
    borderWidth: 0,
    color: "var(--text)",
    fontFamily: "inherit",
    fontSize: 14,
    outline: "none",
    width: "100%",
  },
  menuHeading: {
    color: "var(--faint)",
    fontSize: 12,
    fontWeight: 500,
    paddingBlock: 4,
    paddingInline: 8,
  },
  menuItem: {
    alignItems: "center",
    borderRadius: 6,
    cursor: "pointer",
    display: "flex",
    fontSize: 14,
    gap: 8,
    paddingBlock: 5,
    paddingInline: 8,
  },
  menuItemActive: { backgroundColor: "var(--hover)" },
  menuIcon: { flexShrink: 0, width: 18 },
  menuLabel: { flexShrink: 0 },
  menuDescription: {
    color: "var(--faint)",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
})

export type Command = {
  readonly group: string
  readonly icon: string
  readonly label: string
  readonly description?: string | undefined
  readonly action: { readonly kind: "tag" } | { readonly kind: "run"; readonly run: () => void }
}

class Option extends MenuOption {
  readonly command: Command
  constructor(command: Command) {
    super(`${command.group}:${command.label}`)
    this.command = command
  }
}

const InlineMenu = ({
  commands,
  trigger,
}: {
  readonly commands: ReadonlyArray<Command>
  readonly trigger: "@" | "/"
}) => {
  const [editor] = useLexicalComposerContext()
  const [query, setQuery] = useState("")
  const [typed, setTyped] = useState<string | undefined>(undefined)
  const triggerFn = useBasicTypeaheadTriggerMatch(trigger, { minLength: 0 })
  const options = useMemo(() => {
    const match = (typed ?? query).toLowerCase()
    return commands
      .filter((command) => command.label.toLowerCase().includes(match))
      .slice(0, 24)
      .map((command) => new Option(command))
  }, [commands, query, typed])

  return (
    <LexicalTypeaheadMenuPlugin<Option>
      commandPriority={COMMAND_PRIORITY_HIGH}
      options={options}
      triggerFn={triggerFn}
      onQueryChange={(matching) => {
        setQuery(matching ?? "")
        setTyped(undefined)
      }}
      onClose={() => setTyped(undefined)}
      onSelectOption={(option, nodeToReplace, closeMenu) => {
        editor.update(() => {
          const command = option.command
          if (command.action.kind === "tag") {
            const tag = $createTag(command.label)
            if (nodeToReplace !== null) {
              nodeToReplace.replace(tag)
            } else {
              $getRoot().selectEnd()
              tag.select()
            }
            const space = $createTextNode(" ")
            tag.insertAfter(space)
            space.select()
          } else {
            nodeToReplace?.remove()
            command.action.run()
          }
          closeMenu()
        })
      }}
      menuRenderFn={(anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorRef.current === null || options.length === 0
          ? null
          : createPortal(
              <div {...stylex.props(styles.menu)}>
                <div {...stylex.props(styles.search)}>
                  <span {...stylex.props(styles.searchIcon)}>⌕</span>
                  <input
                    {...stylex.props(styles.searchInput)}
                    placeholder={trigger === "@" ? "Mention a skill or tool…" : "Search commands…"}
                    value={typed ?? query}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault()
                        const delta = event.key === "ArrowDown" ? 1 : -1
                        const next =
                          ((selectedIndex ?? 0) + delta + options.length) % options.length
                        setHighlightedIndex(next)
                        return
                      }
                      if (event.key === "Enter") {
                        event.preventDefault()
                        const option = options[selectedIndex ?? 0]
                        if (option !== undefined) selectOptionAndCleanUp(option)
                        return
                      }
                      if (event.key === "Escape") {
                        event.preventDefault()
                        editor.dispatchCommand(KEY_ESCAPE_COMMAND, event.nativeEvent)
                        editor.getRootElement()?.focus()
                      }
                    }}
                  />
                </div>
                {options.map((option, index) => {
                  const heading =
                    index === 0 || options[index - 1]!.command.group !== option.command.group
                  return (
                    <div key={option.key}>
                      {heading && (
                        <div {...stylex.props(styles.menuHeading)}>{option.command.group}</div>
                      )}
                      <div
                        {...stylex.props(
                          styles.menuItem,
                          index === selectedIndex && styles.menuItemActive,
                        )}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          selectOptionAndCleanUp(option)
                        }}
                        onMouseEnter={() => setHighlightedIndex(index)}
                      >
                        <span {...stylex.props(styles.menuIcon)}>{option.command.icon}</span>
                        <span {...stylex.props(styles.menuLabel)}>{option.command.label}</span>
                        {option.command.description !== undefined && (
                          <span {...stylex.props(styles.menuDescription)}>
                            {option.command.description}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>,
              anchorRef.current,
            )
      }
    />
  )
}

const SubmitPlugin = ({
  busy,
  onSubmit,
}: {
  readonly busy: boolean
  readonly onSubmit: (prompt: string) => void
}) => {
  const [editor] = useLexicalComposerContext()
  useEffect(
    () =>
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event?.shiftKey === true) return false
          event?.preventDefault()
          const text = editor
            .getEditorState()
            .read(() => $getRoot().getTextContent())
            .trim()
          if (text.length === 0 || busy) return true
          editor.update(() => $getRoot().clear())
          onSubmit(text)
          return true
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, busy, onSubmit],
  )
  return null
}

const SendButton = ({
  busy,
  empty,
  onInterrupt,
  onSubmit,
}: {
  readonly busy: boolean
  readonly empty: boolean
  readonly onInterrupt: () => void
  readonly onSubmit: (prompt: string) => void
}) => {
  const [editor] = useLexicalComposerContext()
  if (busy) {
    return (
      <button {...stylex.props(styles.send, styles.stop)} onClick={onInterrupt}>
        ◼
      </button>
    )
  }
  return (
    <button
      {...stylex.props(styles.send)}
      disabled={empty}
      onClick={() => {
        const text = editor
          .getEditorState()
          .read(() => $getRoot().getTextContent())
          .trim()
        if (text.length === 0) return
        editor.update(() => $getRoot().clear())
        onSubmit(text)
      }}
    >
      ↑
    </button>
  )
}

export const Composer = ({
  busy,
  commands,
  mentions,
  model,
  onInterrupt,
  onModelClick,
  onSubmit,
}: {
  readonly busy: boolean
  readonly commands: ReadonlyArray<Command>
  readonly mentions: ReadonlyArray<Command>
  readonly model: string
  readonly onInterrupt: () => void
  readonly onModelClick: () => void
  readonly onSubmit: (prompt: string) => void
}) => {
  const [empty, setEmpty] = useState(true)
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "composer",
        nodes: [TagNode],
        onError: (error) => {
          throw error
        },
      }}
    >
      <div {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.shell)}>
          <PlainTextPlugin
            contentEditable={<ContentEditable {...stylex.props(styles.input)} id="composer" />}
            placeholder={
              <div {...stylex.props(styles.placeholder)}>
                Ask, build, or run anything — @ to mention, / for commands…
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <div {...stylex.props(styles.chips)}>
          <button {...stylex.props(styles.chip)} onClick={onModelClick}>
            <span {...stylex.props(styles.chipDot)} />
            {model}
          </button>
          <SendButton busy={busy} empty={empty} onInterrupt={onInterrupt} onSubmit={onSubmit} />
        </div>
      </div>
      <InlineMenu commands={commands} trigger="/" />
      <InlineMenu commands={mentions} trigger="@" />
      <SubmitPlugin busy={busy} onSubmit={onSubmit} />
      <OnChangePlugin
        onChange={(state) => setEmpty(state.read(() => $getRoot().getTextContent().trim() === ""))}
      />
    </LexicalComposer>
  )
}
