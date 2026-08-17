import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion

function unwrap(expression: ESTree.Expression): ESTree.Expression {
  let current = expression
  while (
    current.type === "AwaitExpression" ||
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression"
  ) {
    current = current.argument ?? current.expression
  }
  return current
}

function memberName(member: ESTree.MemberExpression): string | null {
  if (!member.computed && member.property.type === "Identifier") return member.property.name
  return member.computed &&
    member.property.type === "Literal" &&
    typeof member.property.value === "string"
    ? member.property.value
    : null
}

function isDeserializationCall(expression: ESTree.Expression): boolean {
  const unwrapped = unwrap(expression)
  if (unwrapped.type !== "CallExpression" || unwrapped.callee.type !== "MemberExpression")
    return false
  const method = memberName(unwrapped.callee)
  if (method === "json") return true
  return (
    method === "parse" &&
    unwrapped.callee.object.type === "Identifier" &&
    unwrapped.callee.object.name === "JSON"
  )
}

/** Require parsed data to be decoded rather than trusted through a type assertion. */
export const noCastDeserializationRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow type assertions directly on JSON.parse and Response.json results.",
    },
    messages: {
      castDeserialization:
        "Deserialized data is untrusted. Decode it with a schema at this boundary instead of asserting its type.",
    },
  },
  createOnce(context) {
    const check = (node: TypeAssertion) => {
      if (!isDeserializationCall(node.expression)) return
      context.report({ node, messageId: "castDeserialization" })
    }

    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
    }
  },
})
