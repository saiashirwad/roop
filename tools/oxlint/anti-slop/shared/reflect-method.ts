import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins"

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

function isGlobalReflect(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  if (expression.type !== "Identifier" || expression.name !== "Reflect") return false
  if (sourceCode.isGlobalReference(expression)) return true
  const variable = resolveVariable(sourceCode, expression)
  return variable === null || variable.defs.length === 0
}

function unwrapChainExpression(expression: ESTree.Expression): ESTree.Expression {
  return expression.type === "ChainExpression" ? expression.expression : expression
}

/** Reports whether a call target names one method on the global Reflect object. */
export function isGlobalReflectMethodCall(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  methodName: string,
): boolean {
  const unwrapped = unwrapChainExpression(callee)
  if (!("property" in unwrapped) || !("object" in unwrapped) || !("computed" in unwrapped))
    return false
  if (!isGlobalReflect(sourceCode, unwrapped.object)) return false
  const property = unwrapped.property
  return unwrapped.computed
    ? property.type === "Literal" && property.value === methodName
    : property.type === "Identifier" && property.name === methodName
}
