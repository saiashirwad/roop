import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

const FORBIDDEN_SYMBOL_NAME = "shape"

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME)
}

function isPropertyName(node: ESTree.Node & { name: string }): boolean {
  const parent = node.parent as unknown as {
    type: string
    property?: unknown
    key?: unknown
    computed?: boolean
    shorthand?: boolean
  }
  return (
    (parent.type === "MemberExpression" && parent.property === node && !parent.computed) ||
    (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) ||
    (parent.type === "TSPropertySignature" && parent.key === node && !parent.computed) ||
    (parent.type === "TSMethodSignature" && parent.key === node && !parent.computed)
  )
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (node.type === "Identifier" && isPropertyName(node)) return
      if (!containsForbiddenSymbolName(node.name)) return
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      })
    }

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    }
  },
})
