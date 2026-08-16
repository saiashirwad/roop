import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts"

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature

function referencedAliasName(type: ESTree.TSType): string | null {
  if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation)
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null
}

function scopeOwner(node: ESTree.Node): ESTree.Node {
  let current: ESTree.Node = node
  while (current.parent !== null) {
    if (
      current.type === "BlockStatement" ||
      current.type === "TSModuleBlock" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    )
      return current
    current = current.parent
  }
  return current
}

function scopeOwners(node: ESTree.Node): readonly ESTree.Node[] {
  const owners: ESTree.Node[] = []
  let current: ESTree.Node | null = node
  while (current !== null) {
    const owner = scopeOwner(current)
    if (!owners.includes(owner)) owners.push(owner)
    if (owner.type === "Program") break
    current = owner.parent
  }
  return owners
}

function collectAliases(
  node: ESTree.Node,
  aliases: ESTree.TSTypeAliasDeclaration[],
  seen = new Set<ESTree.Node>(),
): void {
  if (seen.has(node)) return
  seen.add(node)
  if (node.type === "TSTypeAliasDeclaration") aliases.push(node)
  const record = node as unknown as Readonly<Record<string, unknown>>
  for (const [key, value] of Object.entries(record)) {
    if (key === "parent" || key === "type") continue
    if (typeof value === "object" && value !== null && "type" in value) {
      collectAliases(value as ESTree.Node, aliases, seen)
    } else if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === "object" && child !== null && "type" in child) {
          collectAliases(child as ESTree.Node, aliases, seen)
        }
      }
    }
  }
}

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>()
    let aliasDeclarations: readonly ESTree.TSTypeAliasDeclaration[] = []
    const shadowedBuiltins = new Set<string>()

    const resolveAlias = (name: string, reference: ESTree.Node) => {
      for (const owner of scopeOwners(reference)) {
        const alias = aliasDeclarations.find(
          (candidate) => candidate.id.name === name && scopeOwner(candidate) === owner,
        )
        if (alias !== undefined) return alias
      }
      return aliases.get(name)
    }

    const resolvesToUnknown = (
      type: ESTree.TSType,
      shadowedAliases: ReadonlySet<string>,
      visited = new Set<string>(),
    ): boolean => {
      if (type.type === "TSUnknownKeyword") return true
      if (type.type === "TSParenthesizedType") {
        return resolvesToUnknown(type.typeAnnotation, shadowedAliases, visited)
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) => resolvesToUnknown(member, shadowedAliases, visited))
      }
      if (
        type.type === "TSTypeReference" &&
        type.typeName.type === "Identifier" &&
        (type.typeName.name === "Promise" || type.typeName.name === "PromiseLike")
      ) {
        if (shadowedAliases.has(type.typeName.name)) return false
        if (shadowedBuiltins.has(type.typeName.name)) return false
        const shadowingAlias = resolveAlias(type.typeName.name, type)
        if (shadowingAlias !== undefined) {
          if (shadowingAlias.typeParameters !== null && shadowingAlias.typeParameters !== undefined)
            return false
          if (visited.has(type.typeName.name)) return false
          const nextVisited = new Set(visited)
          nextVisited.add(type.typeName.name)
          return resolvesToUnknown(shadowingAlias.typeAnnotation, shadowedAliases, nextVisited)
        }
        const value = type.typeArguments?.params[0]
        return value !== undefined && resolvesToUnknown(value, shadowedAliases, visited)
      }
      const name = referencedAliasName(type)
      if (name === null || visited.has(name) || shadowedAliases.has(name)) return false
      const alias = resolveAlias(name, type)
      if (
        alias === undefined ||
        (alias.typeParameters !== null && alias.typeParameters !== undefined)
      ) {
        return false
      }
      const nextVisited = new Set(visited)
      nextVisited.add(name)
      return resolvesToUnknown(alias.typeAnnotation, shadowedAliases, nextVisited)
    }

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType
      if (annotation === null || annotation === undefined) return
      if (
        !resolvesToUnknown(
          annotation.typeAnnotation,
          lexicalTypeParameterNames(node, context.sourceCode.visitorKeys),
        )
      ) {
        return
      }
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" })
    }

    return {
      Program(node) {
        aliases.clear()
        shadowedBuiltins.clear()
        const collected: ESTree.TSTypeAliasDeclaration[] = []
        collectAliases(node, collected)
        aliasDeclarations = collected
        for (const statement of node.body) {
          if (statement.type === "ImportDeclaration") {
            for (const specifier of statement.specifiers) {
              if (specifier.local.name === "Promise" || specifier.local.name === "PromiseLike") {
                shadowedBuiltins.add(specifier.local.name)
              }
            }
          }
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
          if (declaration?.type === "TSTypeAliasDeclaration") {
            aliases.set(declaration.id.name, declaration)
          }
        }
      },
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    }
  },
})
