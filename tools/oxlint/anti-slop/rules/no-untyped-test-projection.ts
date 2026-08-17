import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

function isTestFile(filename: string): boolean {
  return (
    filename.includes("/test/") || filename.endsWith(".test.ts") || filename.endsWith(".test.tsx")
  )
}

function isAnyAnnotation(annotation: ESTree.TSTypeAnnotation | null | undefined): boolean {
  return annotation?.typeAnnotation.type === "TSAnyKeyword"
}

function isProjectionCall(node: ESTree.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.property.type === "Identifier" &&
    (node.callee.property.name === "find" || node.callee.property.name === "filter")
  )
}

/** Require test projections to narrow with a type predicate instead of any. */
export const noUntypedTestProjectionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow any-typed callbacks passed to find and filter in test files.",
    },
    messages: {
      untypedProjection:
        "This test projection erases its element type. Use a typed predicate or a reusable assertion helper that narrows the event union.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!isTestFile(context.filename)) return
        if (!isProjectionCall(node)) return
        const [predicate] = node.arguments
        if (
          predicate === undefined ||
          (predicate.type !== "ArrowFunctionExpression" && predicate.type !== "FunctionExpression")
        ) {
          return
        }
        const [parameter] = predicate.params
        if (parameter?.type !== "Identifier" || !isAnyAnnotation(parameter.typeAnnotation)) return
        context.report({ node: parameter, messageId: "untypedProjection" })
      },
    }
  },
})
