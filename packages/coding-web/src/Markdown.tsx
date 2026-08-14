import { marked } from "marked"

marked.use({ renderer: { html: () => "" } })

export const Markdown = ({ text }: { readonly text: string }) => (
  <div className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(text) as string }} />
)
