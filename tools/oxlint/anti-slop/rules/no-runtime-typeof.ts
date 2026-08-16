import { defineRule } from "@oxlint/plugins"
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins"

import {
  createTypeEnvironment,
  resolveTypeAliasAt,
  type TypeEnvironment,
} from "../shared/dictionary-types.ts"

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier)
  while (scope !== null) {
    const variable = scope.set.get(identifier.name)
    if (variable !== undefined) return variable
    scope = scope.upper
  }
  return null
}

function isUnknownOrAny(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  visited = new Set<ESTree.TSTypeAliasDeclaration>(),
): boolean {
  if (type.type === "TSParenthesizedType")
    return isUnknownOrAny(type.typeAnnotation, environment, visited)
  if (type.type === "TSUnknownKeyword" || type.type === "TSAnyKeyword") return true
  if (type.type === "TSUnionType")
    return type.types.some((member) => isUnknownOrAny(member, environment, visited))
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return false
  const alias = resolveTypeAliasAt(type.typeName.name, type, environment)
  if (alias === undefined || visited.has(alias)) return false
  const next = new Set(visited)
  next.add(alias)
  return isUnknownOrAny(alias.typeAnnotation, environment, next)
}

/** Disallow runtime typeof checks that narrow explicitly unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow typeof checks on unknown or any values; external values must be decoded into meaningful types at their I/O boundary.",
    },
    messages: {
      runtimeTypeof:
        "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
    },
  },
  createOnce(context) {
    let environment: TypeEnvironment | null = null
    return {
      Program(node: ESTree.Program) {
        environment = createTypeEnvironment(node)
      },
      UnaryExpression(node) {
        if (environment === null) return
        const operand = node.argument
        const variable =
          operand.type === "Identifier" ? resolveVariable(context.sourceCode, operand) : null
        const identifier = variable?.identifiers.find(
          (candidate) =>
            candidate.typeAnnotation !== null && candidate.typeAnnotation !== undefined,
        )
        if (
          node.operator === "typeof" &&
          identifier?.typeAnnotation !== null &&
          identifier?.typeAnnotation !== undefined &&
          isUnknownOrAny(identifier.typeAnnotation.typeAnnotation, environment)
        ) {
          context.report({ node, messageId: "runtimeTypeof" })
        }
      },
    }
  },
})
