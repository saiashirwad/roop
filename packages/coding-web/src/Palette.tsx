import * as stylex from "@stylexjs/stylex"
import { Command } from "cmdk"

const styles = stylex.create({
  overlay: {
    alignItems: "flex-start",
    backgroundColor: "rgba(15, 15, 15, 0.2)",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    paddingTop: "18vh",
    position: "fixed",
    zIndex: 10,
  },
  card: {
    backgroundColor: "var(--surface)",
    borderRadius: 10,
    boxShadow:
      "rgba(15, 15, 15, 0.05) 0px 0px 0px 1px, rgba(15, 15, 15, 0.1) 0px 5px 10px, rgba(15, 15, 15, 0.2) 0px 15px 40px",
    overflow: "hidden",
    width: 540,
  },
})

export type Model = { readonly id: string; readonly description?: string | undefined }

export type PaletteAction =
  | { readonly kind: "new" }
  | { readonly kind: "resume"; readonly id: string }
  | { readonly kind: "fork" }
  | { readonly kind: "model"; readonly id: string }

export const Palette = ({
  activeModel,
  models,
  sessions = [],
  onAction,
  onClose,
}: {
  readonly activeModel: string
  readonly models: ReadonlyArray<Model>
  readonly sessions?: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly onAction: (action: PaletteAction) => void
  readonly onClose: () => void
}) => (
  <div {...stylex.props(styles.overlay)} onMouseDown={onClose}>
    <div {...stylex.props(styles.card)} onMouseDown={(event) => event.stopPropagation()}>
      <Command label="Commands">
        <Command.Input
          autoFocus
          placeholder="Search commands, models, skills, tools…"
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose()
          }}
        />
        <Command.List>
          <Command.Empty>No results</Command.Empty>
          <Command.Group heading="Session">
            <Command.Item onSelect={() => onAction({ kind: "new" })}>New session</Command.Item>
            <Command.Item onSelect={() => onAction({ kind: "fork" })}>Fork current session</Command.Item>
            {sessions.map((session) => (
              <Command.Item
                key={session.id}
                value={`resume ${session.id} ${session.title}`}
                onSelect={() => onAction({ kind: "resume", id: session.id })}
              >
                Resume: {session.title === "" ? "Untitled" : session.title}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Models">
            {models.map((model) => (
              <Command.Item
                key={model.id}
                value={`model ${model.id}`}
                onSelect={() => onAction({ kind: "model", id: model.id })}
              >
                <span>
                  {model.id}
                  {model.id === activeModel ? " ·" : ""}
                </span>
                {model.description !== undefined && <small>{model.description}</small>}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  </div>
)
