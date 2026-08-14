import type { EditorTheme, MarkdownTheme } from "@mariozechner/pi-tui"

const ansi = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`

export const bold = ansi(1, 22)
export const dim = ansi(2, 22)
export const italic = ansi(3, 23)
export const underline = ansi(4, 24)
export const strikethrough = ansi(9, 29)
export const red = ansi(31, 39)
export const green = ansi(32, 39)
export const yellow = ansi(33, 39)
export const cyan = ansi(36, 39)

export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: yellow,
  codeBlock: (text) => text,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: dim,
  bold,
  italic,
  strikethrough,
  underline,
}

export const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
}
