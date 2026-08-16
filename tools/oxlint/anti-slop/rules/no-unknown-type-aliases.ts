import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

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

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
    },
    messages: {
      unknownAlias:
        "Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
    },
  },
  createOnce(context) {
    const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>()
    let aliasDeclarations: readonly ESTree.TSTypeAliasDeclaration[] = []

    const resolveAlias = (name: string, reference: ESTree.Node) => {
      for (const owner of scopeOwners(reference)) {
        const alias = aliasDeclarations.find(
          (candidate) => candidate.id.name === name && scopeOwner(candidate) === owner,
        )
        if (alias !== undefined) return alias
      }
      return aliases.get(name)
    }

    const resolvesToUnknown = (type: ESTree.TSType, visited = new Set<string>()): boolean => {
      if (type.type === "TSUnknownKeyword") return true
      if (type.type === "TSParenthesizedType")
        return resolvesToUnknown(type.typeAnnotation, visited)
      if (type.type === "TSUnionType") {
        return type.types.some((member) => resolvesToUnknown(member, visited))
      }
      const name = referencedAliasName(type)
      if (name === null || visited.has(name)) return false
      const alias = resolveAlias(name, type)
      if (
        alias === undefined ||
        (alias.typeParameters !== null && alias.typeParameters !== undefined)
      ) {
        return false
      }
      const nextVisited = new Set(visited)
      nextVisited.add(name)
      return resolvesToUnknown(alias.typeAnnotation, nextVisited)
    }

    return {
      Program(node) {
        aliases.clear()
        const collected: ESTree.TSTypeAliasDeclaration[] = []
        collectAliases(node, collected)
        aliasDeclarations = collected
        for (const statement of node.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
          if (declaration?.type === "TSTypeAliasDeclaration") {
            aliases.set(declaration.id.name, declaration)
          }
        }
        for (const alias of aliasDeclarations) {
          if (!resolvesToUnknown(alias.typeAnnotation, new Set([alias.id.name]))) continue
          context.report({
            node: alias.id,
            messageId: "unknownAlias",
            data: { alias: alias.id.name },
          })
        }
      },
    }
  },
})
