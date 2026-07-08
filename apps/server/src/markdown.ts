/**
 * Line-buffered ANSI markdown for streamed REPL output.
 * Styles complete lines only; oversized partials stream raw (no cursor rewrites).
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
}

export const styleInline = (text: string): string =>
  text
    .replace(/`([^`\n]+)`/g, `${ANSI.cyan}$1${ANSI.reset}`)
    .replace(/\*\*([^*\n]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`)

export type MarkdownLineState = {
  readonly inCodeFence: boolean
}

export const initialMarkdownLineState: MarkdownLineState = { inCodeFence: false }

export const styleMarkdownLine = (
  line: string,
  state: MarkdownLineState,
): { readonly text: string; readonly state: MarkdownLineState } => {
  if (/^\s*(```|~~~)/.test(line)) {
    return {
      text: `${ANSI.gray}${line}${ANSI.reset}`,
      state: { inCodeFence: !state.inCodeFence },
    }
  }
  if (state.inCodeFence) {
    return { text: line, state }
  }
  if (/^#{1,6}\s/.test(line)) {
    return { text: `${ANSI.bold}${line}${ANSI.reset}`, state }
  }
  if (/^>\s?/.test(line)) {
    return { text: `${ANSI.gray}${line}${ANSI.reset}`, state }
  }
  const bullet = line.match(/^(\s*)[-*]\s(.*)$/)
  if (bullet !== null) {
    return { text: `${bullet[1]}• ${styleInline(bullet[2] ?? "")}`, state }
  }
  return { text: styleInline(line), state }
}

/** Past this many buffered chars a partial line streams through raw. */
const flushCap = 200

/** Stateful per-run writer; flush drains any trailing partial line. */
export const makeMarkdownWriter = () => {
  let buffer = ""
  let state = initialMarkdownLineState
  let partial = false

  const write = (delta: string): string => {
    buffer += delta
    let out = ""
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (partial) {
        out += `${line}\n`
        partial = false
      } else {
        const styled = styleMarkdownLine(line, state)
        state = styled.state
        out += `${styled.text}\n`
      }
      newline = buffer.indexOf("\n")
    }
    if (buffer.length > flushCap) {
      out += buffer
      buffer = ""
      partial = true
    }
    return out
  }

  const flush = (): string => {
    if (buffer.length === 0) {
      return ""
    }
    const text = partial || state.inCodeFence ? buffer : styleInline(buffer)
    buffer = ""
    partial = false
    return text
  }

  return { write, flush }
}

export type MarkdownWriter = ReturnType<typeof makeMarkdownWriter>
