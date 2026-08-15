import { TextNode, type EditorConfig, type SerializedTextNode } from "lexical"

export class TagNode extends TextNode {
  static override getType(): string {
    return "tag"
  }

  static override clone(node: TagNode): TagNode {
    return new TagNode(node.__text, node.__key)
  }

  static override importJSON(json: SerializedTextNode): TagNode {
    return $createTag(json.text)
  }

  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    dom.className = "composer-tag"
    return dom
  }

  override exportJSON(): SerializedTextNode {
    return { ...super.exportJSON(), type: "tag" }
  }
}

export const $createTag = (text: string): TagNode => {
  const node = new TagNode(text)
  node.setMode("token")
  return node
}
