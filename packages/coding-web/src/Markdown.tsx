import { marked } from "marked"

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

const decodeNumericEntities = (value: string): string =>
  value.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_match, hex: string, decimal: string) => {
    const code = Number.parseInt(hex ?? decimal, hex === undefined ? 10 : 16)
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : ""
  })

const decodePercentEscapes = (value: string): string => {
  let decoded = value
  // A URL parser may encounter more than one layer of percent escaping. A
  // small fixed bound catches obfuscated schemes without unbounded work.
  for (let pass = 0; pass < 3; pass += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      break
    }
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

/** Keep markdown links useful without allowing them to become script sinks. */
const safeHref = (href: string): string | undefined => {
  const value = href.trim()
  if (value === "") return undefined
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return undefined
  }
  const normalized = decodeNumericEntities(decodePercentEscapes(value))
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index)
    if (code < 32 || code === 127) return undefined
  }
  const normalizedScheme = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase()
  if (
    normalizedScheme === "javascript" ||
    normalizedScheme === "data" ||
    normalizedScheme === "vbscript"
  ) {
    return undefined
  }
  if (value.startsWith("//")) return undefined
  if (
    value.startsWith("#") ||
    (value.startsWith("/") && !value.startsWith("//")) ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    return value
  }
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto"
    ? value
    : undefined
}

marked.use({
  renderer: {
    // Raw HTML is not part of the renderer's supported markdown surface.
    html: () => "",
    link({ href, title, tokens }) {
      const safe = safeHref(href ?? "")
      const text = this.parser.parseInline(tokens)
      if (safe === undefined) return text
      const titleAttribute =
        title === undefined || title === null ? "" : ` title="${escapeAttribute(title)}"`
      return `<a href="${escapeAttribute(safe)}"${titleAttribute}>${text}</a>`
    },
    image({ href, title, text }) {
      const safe = safeHref(href ?? "")
      if (safe === undefined) return escapeAttribute(text)
      const titleAttribute =
        title === undefined || title === null ? "" : ` title="${escapeAttribute(title)}"`
      return `<img src="${escapeAttribute(safe)}" alt="${escapeAttribute(text)}"${titleAttribute}>`
    },
  },
})

export const renderMarkdown = (text: string): string => {
  /* SAFETY: async parsing is never enabled, so marked.parse synchronously returns HTML. */
  return marked.parse(text) as string
}

export const Markdown = ({ text }: { readonly text: string }) => (
  <div
    className="markdown"
    dangerouslySetInnerHTML={{
      /* SAFETY: renderMarkdown removes raw HTML and disallows unsafe URL schemes. */
      __html: renderMarkdown(text),
    }}
  />
)
