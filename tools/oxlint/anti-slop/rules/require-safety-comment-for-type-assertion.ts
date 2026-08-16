import { defineRule } from "@oxlint/plugins"
import type { ESTree, SourceCode } from "@oxlint/plugins"

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "SwitchCase",
  "TryStatement",
  "CatchClause",
  "FunctionDeclaration",
  "FunctionExpression",
])

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  )
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let statement: ESTree.Node | null = node.parent
  while (statement !== null) {
    if (
      statement.type === "ArrowFunctionExpression" &&
      sourceCode.getCommentsBefore(statement).some((comment) => /\bSAFETY\s*:/u.test(comment.value))
    ) {
      return true
    }
    if (commentOwnerKinds.has(statement.type)) break
    if (statement.parent === null) break
    statement = statement.parent
  }
  if (statement === null) return false
  return (
    sourceCode.getCommentsBefore(node).some((comment) => /\bSAFETY\s*:/u.test(comment.value)) ||
    sourceCode.getCommentsBefore(statement).some((comment) => /\bSAFETY\s*:/u.test(comment.value))
  )
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node)) return
      context.report({ node, messageId: "missingSafetyComment" })
    }

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    }
  },
})
