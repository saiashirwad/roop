import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion

function isEscapeHatch(type: ESTree.TSType): boolean {
  return type.type === "TSAnyKeyword" || type.type === "TSUnknownKeyword"
}

function isEffectTypeBoundary(node: TypeAssertion): boolean {
  if (node.parent?.type !== "CallExpression") return false
  const callee = node.parent.callee
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return false
  return (
    (callee.object.type === "Identifier" &&
      callee.object.name === "Context" &&
      callee.property.name === "omit") ||
    (callee.object.type === "Identifier" &&
      callee.object.name === "toolkit" &&
      callee.property.name === "toLayer")
  )
}

/** Ban assertions that discard all type evidence instead of documenting a concrete invariant. */
export const noEscapeHatchAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow assertions to any, never, and unknown.",
    },
    messages: {
      escapeHatch:
        "This assertion erases type evidence. Narrow with a predicate or schema, or assert the concrete type justified by the local invariant.",
    },
  },
  createOnce(context) {
    const check = (node: TypeAssertion) => {
      if (
        context.filename.includes("/test/") ||
        context.filename.endsWith(".test.ts") ||
        context.filename.endsWith(".test.tsx")
      ) {
        return
      }
      if (isEffectTypeBoundary(node)) return
      if (!isEscapeHatch(node.typeAnnotation)) return
      context.report({ node, messageId: "escapeHatch" })
    }

    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
    }
  },
})
