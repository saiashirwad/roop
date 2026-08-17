import * as stylex from "@stylexjs/stylex"
import { useState } from "react"

import { Markdown } from "./Markdown.tsx"

const styles = stylex.create({
  reasoning: {
    borderColor: "var(--border)",
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    color: "var(--faint)",
    fontSize: 13,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": "var(--hover)" },
    borderWidth: 0,
    color: "inherit",
    cursor: "pointer",
    display: "flex",
    fontFamily: "inherit",
    fontSize: "inherit",
    gap: 8,
    paddingBlock: 6,
    paddingInline: 12,
    textAlign: "left",
    width: "100%",
  },
  chevron: {
    display: "inline-block",
    flexShrink: 0,
    fontSize: 10,
    transitionDuration: "150ms",
    transitionProperty: "transform",
    width: 12,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  body: {
    borderTopColor: "var(--border)",
    borderTopStyle: "solid",
    borderTopWidth: 1,
    paddingBlock: 12,
    paddingInline: 16,
  },
})

/** A reasoning-model's thinking, collapsed by default to keep answers prominent. */
export const Reasoning = ({ text }: { readonly text: string }) => {
  const [open, setOpen] = useState(false)
  return (
    <div {...stylex.props(styles.reasoning)}>
      <button {...stylex.props(styles.header)} onClick={() => setOpen(!open)}>
        <span {...stylex.props(styles.chevron, open && styles.chevronOpen)}>▶</span>
        <span>thinking</span>
      </button>
      {open && (
        <div {...stylex.props(styles.body)}>
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}
