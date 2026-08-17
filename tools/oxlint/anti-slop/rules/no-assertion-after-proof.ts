import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion

function assertedIdentifier(node: TypeAssertion): ESTree.IdentifierReference | null {
  return node.expression.type === "Identifier" ? node.expression : null
}

function isSchemaProof(statement: ESTree.Statement, name: string): boolean {
  if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") {
    return false
  }
  const assertion = statement.expression
  if (
    assertion.callee.type !== "MemberExpression" ||
    assertion.callee.object.type !== "Identifier" ||
    assertion.callee.object.name !== "assert" ||
    assertion.callee.property.type !== "Identifier" ||
    assertion.callee.property.name !== "ok"
  ) {
    return false
  }
  const [argument] = assertion.arguments
  if (argument?.type !== "CallExpression" || argument.callee.type !== "CallExpression") return false
  const schemaIs = argument.callee
  if (
    schemaIs.callee.type !== "MemberExpression" ||
    schemaIs.callee.object.type !== "Identifier" ||
    schemaIs.callee.object.name !== "Schema" ||
    schemaIs.callee.property.type !== "Identifier" ||
    schemaIs.callee.property.name !== "is"
  ) {
    return false
  }
  const [proved] = argument.arguments
  return proved?.type === "Identifier" && proved.name === name
}

function previousStatement(node: ESTree.Node): ESTree.Statement | null {
  const declaration = node.parent?.type === "VariableDeclarator" ? node.parent.parent : null
  if (
    declaration?.type !== "VariableDeclaration" ||
    declaration.parent?.type !== "BlockStatement"
  ) {
    return null
  }
  const index = declaration.parent.body.indexOf(declaration)
  return index > 0 ? (declaration.parent.body[index - 1] ?? null) : null
}

/** Reject assertions made redundant by an adjacent Schema.is proof. */
export const noAssertionAfterProofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow assertions immediately following a Schema.is proof of the same value.",
    },
    messages: {
      redundantAssertion:
        "Schema.is already narrows this value. Keep the proven type instead of asserting it again.",
    },
  },
  createOnce(context) {
    const check = (node: TypeAssertion) => {
      const identifier = assertedIdentifier(node)
      if (identifier === null) return
      const previous = previousStatement(node)
      if (previous === null || !isSchemaProof(previous, identifier.name)) return
      context.report({ node, messageId: "redundantAssertion" })
    }

    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
    }
  },
})
