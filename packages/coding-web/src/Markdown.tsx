import { marked } from "marked"

marked.use({ renderer: { html: () => "" } })

export const Markdown = ({ text }: { readonly text: string }) => (
  <div
    className="markdown"
    dangerouslySetInnerHTML={{
      /* SAFETY: The renderer is configured synchronously, so marked returns HTML text here. */
      __html: marked.parse(text) as string,
    }}
  />
)
