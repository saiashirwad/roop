import type { ESTree } from "@oxlint/plugins"

const BUILT_INS = new Set([
  "Record",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "PropertyKey",
  "NonNullable",
])
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"])

type TypeAliasEnvironment = ReadonlyMap<string, ESTree.TSType>

type ResolvedType = {
  readonly type: ESTree.TSType
  readonly substitutions: TypeAliasEnvironment
}

export type UnsafeDictionary = {
  readonly kind: "unsafe-dictionary"
  readonly unsafeValue: "any" | "empty-object" | "object" | "union" | "unknown"
}

export type WideningTargetKind =
  | "anonymous object"
  | "any"
  | "empty object"
  | "generic container"
  | "object"
  | "open dictionary"
  | "unknown"

export type WideningTarget = {
  readonly kind: WideningTargetKind
}

export type TypeEnvironment = {
  readonly aliases: ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>
  readonly aliasDeclarations: readonly ESTree.TSTypeAliasDeclaration[]
  readonly interfaces: ReadonlyMap<string, readonly ESTree.TSInterfaceDeclaration[]>
  readonly shadowedBuiltIns: ReadonlySet<string>
}

function declaredStatement(statement: ESTree.Statement): ESTree.Node | null {
  return statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
    ? (statement.declaration ?? null)
    : statement
}

export function createTypeEnvironment(program: ESTree.Program): TypeEnvironment {
  const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>()
  const aliasDeclarations: ESTree.TSTypeAliasDeclaration[] = []
  const interfaces = new Map<string, ESTree.TSInterfaceDeclaration[]>()
  const shadowedBuiltIns = new Set<string>()

  for (const statement of program.body) {
    const declaration = declaredStatement(statement)
    if (declaration?.type === "ImportDeclaration") {
      for (const specifier of declaration.specifiers) {
        if (BUILT_INS.has(specifier.local.name)) shadowedBuiltIns.add(specifier.local.name)
      }
      continue
    }

    if (declaration?.type === "TSTypeAliasDeclaration") {
      aliasDeclarations.push(declaration)
      const existing = aliases.get(declaration.id.name)
      if (existing === undefined) aliases.set(declaration.id.name, declaration)
      else shadowedBuiltIns.add(declaration.id.name)
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name)
      continue
    }

    if (declaration?.type === "TSInterfaceDeclaration") {
      const declarations = interfaces.get(declaration.id.name) ?? []
      declarations.push(declaration)
      interfaces.set(declaration.id.name, declarations)
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name)
      continue
    }

    if (declaration?.type === "TSEnumDeclaration") {
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name)
      continue
    }

    if (
      (declaration?.type === "ClassDeclaration" || declaration?.type === "FunctionDeclaration") &&
      declaration.id !== null
    ) {
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name)
    }
  }

  const nestedAliases: ESTree.TSTypeAliasDeclaration[] = []
  const nestedInterfaces: ESTree.TSInterfaceDeclaration[] = []
  collectNestedTypeDeclarations(program, nestedAliases, nestedInterfaces)
  for (const alias of nestedAliases) {
    if (!aliasDeclarations.includes(alias)) aliasDeclarations.push(alias)
  }
  for (const declaration of nestedInterfaces) {
    const declarations = interfaces.get(declaration.id.name) ?? []
    if (!declarations.includes(declaration)) declarations.push(declaration)
    interfaces.set(declaration.id.name, declarations)
  }

  return { aliases, aliasDeclarations, interfaces, shadowedBuiltIns }
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null
}

function lexicalScopeOwner(node: ESTree.Node): ESTree.Node {
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

function lexicalScopeOwners(node: ESTree.Node): readonly ESTree.Node[] {
  const owners: ESTree.Node[] = []
  let current: ESTree.Node | null = node
  while (current !== null) {
    const owner = lexicalScopeOwner(current)
    if (!owners.includes(owner)) owners.push(owner)
    if (owner.type === "Program") break
    current = owner.parent
  }
  return owners
}

function collectNestedTypeDeclarations(
  node: ESTree.Node,
  aliases: ESTree.TSTypeAliasDeclaration[],
  interfaces: ESTree.TSInterfaceDeclaration[],
  seen = new Set<ESTree.Node>(),
): void {
  if (seen.has(node)) return
  seen.add(node)
  if (node.type === "TSTypeAliasDeclaration") aliases.push(node)
  if (node.type === "TSInterfaceDeclaration") interfaces.push(node)
  const record = node as unknown as Readonly<Record<string, unknown>>
  for (const [key, value] of Object.entries(record)) {
    if (key === "parent" || key === "type") continue
    if (typeof value === "object" && value !== null && "type" in value) {
      collectNestedTypeDeclarations(value as ESTree.Node, aliases, interfaces, seen)
    } else if (Array.isArray(value)) {
      for (const child of value) {
        if (typeof child === "object" && child !== null && "type" in child) {
          collectNestedTypeDeclarations(child as ESTree.Node, aliases, interfaces, seen)
        }
      }
    }
  }
}

function resolveAlias(
  name: string,
  reference: ESTree.Node,
  environment: TypeEnvironment,
): ESTree.TSTypeAliasDeclaration | undefined {
  for (const owner of lexicalScopeOwners(reference)) {
    const declaration = environment.aliasDeclarations.find(
      (candidate) => candidate.id.name === name && lexicalScopeOwner(candidate) === owner,
    )
    if (declaration !== undefined) return declaration
  }
  return environment.aliases.get(name)
}

export function resolveTypeAliasAt(
  name: string,
  reference: ESTree.Node,
  environment: TypeEnvironment,
): ESTree.TSTypeAliasDeclaration | undefined {
  return resolveAlias(name, reference, environment)
}

function resolveInterfaces(
  name: string,
  reference: ESTree.Node,
  environment: TypeEnvironment,
): readonly ESTree.TSInterfaceDeclaration[] {
  for (const owner of lexicalScopeOwners(reference)) {
    const scoped = [...environment.interfaces.values()]
      .flatMap((items) => items)
      .filter((candidate) => candidate.id.name === name && lexicalScopeOwner(candidate) === owner)
    if (scoped.length > 0) return scoped
  }
  return (environment.interfaces.get(name) ?? []).filter(
    (candidate) => lexicalScopeOwner(candidate).type === "Program",
  )
}

export function hasTypeAliasAt(
  type: ESTree.TSTypeReference,
  environment: TypeEnvironment,
): boolean {
  return (
    type.typeName.type === "Identifier" &&
    resolveAlias(type.typeName.name, type, environment) !== undefined
  )
}

function isBuiltIn(name: string, environment: TypeEnvironment): boolean {
  return BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name)
}

function isBuiltInAt(name: string, reference: ESTree.Node, environment: TypeEnvironment): boolean {
  return (
    isBuiltIn(name, environment) &&
    resolveAlias(name, reference, environment) === undefined &&
    resolveInterfaces(name, reference, environment).length === 0
  )
}

function isUnappliedReferenceTo(type: ESTree.TSType, name: string): boolean {
  const unwrapped = unwrapTransparentType(type)
  return (
    unwrapped.type === "TSTypeReference" &&
    typeReferenceName(unwrapped) === name &&
    (unwrapped.typeArguments === null ||
      unwrapped.typeArguments === undefined ||
      unwrapped.typeArguments.params.length === 0)
  )
}

function unwrapTransparentType(type: ESTree.TSType): ESTree.TSType {
  let current = type
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation
  }
  return current
}

function isNeverType(type: ESTree.TSType): boolean {
  return unwrapTransparentType(type).type === "TSNeverKeyword"
}

function isEffectivelyEmptyMember(member: ESTree.TSSignature): boolean {
  return (
    member.type === "TSPropertySignature" &&
    member.optional === true &&
    member.typeAnnotation !== null &&
    member.typeAnnotation !== undefined &&
    isNeverType(member.typeAnnotation.typeAnnotation)
  )
}

function isEffectivelyEmptyTypeLiteral(type: ESTree.TSTypeLiteral): boolean {
  return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember)
}

function isEffectivelyEmptyInterface(
  declarations: readonly ESTree.TSInterfaceDeclaration[],
): boolean {
  if (declarations.length !== 1) return false
  const [type] = declarations
  return (
    type !== undefined &&
    type.extends.length === 0 &&
    (type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember))
  )
}

function resolvedSubstitutionArgument(
  type: ESTree.TSType,
  base: TypeAliasEnvironment,
  resolving: ReadonlySet<string> = new Set(),
): ESTree.TSType {
  const unwrapped = unwrapTransparentType(type)
  if (unwrapped.type !== "TSTypeReference") return type
  const name = typeReferenceName(unwrapped)
  if (name === null || resolving.has(name)) return type
  const substitution = base.get(name)
  if (substitution === undefined) return type
  const nextResolving = new Set(resolving)
  nextResolving.add(name)
  return resolvedSubstitutionArgument(substitution, base, nextResolving)
}

function aliasSubstitution(
  alias: ESTree.TSTypeAliasDeclaration,
  type: ESTree.TSTypeReference,
  base: TypeAliasEnvironment,
): TypeAliasEnvironment | null {
  const parameters = alias.typeParameters?.params ?? []
  const arguments_ = type.typeArguments?.params ?? []
  const next = new Map(base)
  for (const [index, parameter] of parameters.entries()) {
    const argument = arguments_[index] ?? parameter.default
    if (argument === null || argument === undefined) return null
    next.set(parameter.name.name, resolvedSubstitutionArgument(argument, next))
  }
  return next
}

function interfaceSubstitution(
  declaration: ESTree.TSInterfaceDeclaration,
  heritage: ESTree.TSInterfaceHeritage,
  base: TypeAliasEnvironment,
): TypeAliasEnvironment | null {
  const parameters = declaration.typeParameters?.params ?? []
  const arguments_ = heritage.typeArguments?.params ?? []
  const next = new Map(base)
  for (const [index, parameter] of parameters.entries()) {
    const argument = arguments_[index] ?? parameter.default
    if (argument === null || argument === undefined) return null
    next.set(parameter.name.name, resolvedSubstitutionArgument(argument, next))
  }
  return next
}

function unsafeDirectValue(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
): UnsafeDictionary["unsafeValue"] | null {
  const unwrapped = unwrapTransparentType(type)
  if (unwrapped.type === "TSUnknownKeyword") return "unknown"
  if (unwrapped.type === "TSAnyKeyword") return "any"
  if (unwrapped.type === "TSObjectKeyword") return "object"
  if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped))
    return "empty-object"
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.some(
      (member) => unsafeDirectValue(member, environment, substitutions, resolvingAliases) !== null,
    )
      ? "union"
      : null
  }
  if (unwrapped.type === "TSIntersectionType") {
    const unsafeMembers = unwrapped.types.map((member) =>
      unsafeDirectValue(member, environment, substitutions, resolvingAliases),
    )
    if (unsafeMembers.includes("any")) return "any"
    return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
      ? unsafeMembers[0]
      : null
  }
  if (unwrapped.type !== "TSTypeReference") return null
  const name = typeReferenceName(unwrapped)
  if (name === null) return null
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInAt(name, unwrapped, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0]
    return wrapped === undefined
      ? null
      : unsafeDirectValue(wrapped, environment, substitutions, resolvingAliases)
  }
  const substitution = substitutions.get(name)
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? null
      : unsafeDirectValue(substitution, environment, substitutions, resolvingAliases)
  }
  const interfaceDeclarations = resolveInterfaces(name, unwrapped, environment)
  if (interfaceDeclarations.length > 0) {
    return isEffectivelyEmptyInterface(interfaceDeclarations) ? "empty-object" : null
  }
  const alias = resolveAlias(name, unwrapped, environment)
  if (alias === undefined || resolvingAliases.has(name)) return null
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions)
  if (nextSubstitutions === null) return null
  const nextResolving = new Set(resolvingAliases)
  nextResolving.add(name)
  return unsafeDirectValue(alias.typeAnnotation, environment, nextSubstitutions, nextResolving)
}

function interfaceDictionaryValueTypes(
  declarations: readonly ESTree.TSInterfaceDeclaration[],
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
  resolvingInterfaces: ReadonlySet<ESTree.TSInterfaceDeclaration> = new Set(),
): readonly ResolvedType[] {
  const values: ResolvedType[] = []
  for (const declaration of declarations) {
    if (resolvingInterfaces.has(declaration)) continue
    const nextResolvingInterfaces = new Set(resolvingInterfaces)
    nextResolvingInterfaces.add(declaration)
    for (const member of declaration.body.body) {
      if (member.type === "TSIndexSignature") {
        values.push({ type: member.typeAnnotation.typeAnnotation, substitutions })
      }
    }
    for (const heritage of declaration.extends) {
      if (heritage.expression.type !== "Identifier") continue
      const base = resolveInterfaces(heritage.expression.name, heritage, environment)
      for (const baseDeclaration of base) {
        const baseSubstitutions = interfaceSubstitution(baseDeclaration, heritage, substitutions)
        if (baseSubstitutions === null) continue
        values.push(
          ...interfaceDictionaryValueTypes(
            [baseDeclaration],
            environment,
            baseSubstitutions,
            resolvingAliases,
            nextResolvingInterfaces,
          ),
        )
      }
    }
  }
  return values
}

function dictionaryValueTypes(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
): readonly ResolvedType[] {
  const unwrapped = unwrapTransparentType(type)

  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member): readonly ResolvedType[] =>
      member.type === "TSIndexSignature" && member.typeAnnotation !== null
        ? [{ type: member.typeAnnotation.typeAnnotation, substitutions }]
        : [],
    )
  }

  if (unwrapped.type === "TSMappedType") {
    return unwrapped.typeAnnotation === null
      ? []
      : [{ type: unwrapped.typeAnnotation, substitutions }]
  }

  if (unwrapped.type !== "TSTypeReference") return []
  const name = typeReferenceName(unwrapped)
  if (name === null) return []

  const substitution = substitutions.get(name)
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? []
      : dictionaryValueTypes(substitution, environment, substitutions, resolvingAliases)
  }

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInAt(name, unwrapped, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0]
    return wrapped === undefined
      ? []
      : dictionaryValueTypes(wrapped, environment, substitutions, resolvingAliases)
  }

  if (name === "Record" && isBuiltInAt(name, unwrapped, environment)) {
    const value = unwrapped.typeArguments?.params[1] ?? null
    return value === null ? [] : [{ type: value, substitutions }]
  }

  if ((name === "Pick" || name === "Omit") && isBuiltInAt(name, unwrapped, environment)) {
    const source = unwrapped.typeArguments?.params[0]
    return source === undefined
      ? []
      : dictionaryValueTypes(source, environment, substitutions, resolvingAliases)
  }

  const interfaceDeclarations = resolveInterfaces(name, unwrapped, environment)
  if (interfaceDeclarations.length > 0) {
    return interfaceDictionaryValueTypes(
      interfaceDeclarations,
      environment,
      substitutions,
      resolvingAliases,
    )
  }

  const alias = resolveAlias(name, unwrapped, environment)
  if (alias === undefined || resolvingAliases.has(name)) return []
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions)
  if (nextSubstitutions === null) return []
  const nextResolving = new Set(resolvingAliases)
  nextResolving.add(name)
  return dictionaryValueTypes(alias.typeAnnotation, environment, nextSubstitutions, nextResolving)
}

export function classifyUnsafeDictionaryValue(
  valueType: ESTree.TSType,
  environment: TypeEnvironment,
): UnsafeDictionary | null {
  const unsafeValue = unsafeDirectValue(valueType, environment, new Map(), new Set())
  return unsafeValue === null ? null : { kind: "unsafe-dictionary", unsafeValue }
}

export function classifyUnsafeDictionary(
  type: ESTree.TSType,
  environment: TypeEnvironment,
): UnsafeDictionary | null {
  for (const valueType of dictionaryValueTypes(type, environment, new Map(), new Set())) {
    const unsafeValue = unsafeDirectValue(
      valueType.type,
      environment,
      valueType.substitutions,
      new Set(),
    )
    if (unsafeValue !== null) return { kind: "unsafe-dictionary", unsafeValue }
  }
  return null
}

function resolvesToDictionary(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
): boolean {
  return dictionaryValueTypes(type, environment, substitutions, resolvingAliases).length > 0
}

export function classifyWideningTarget(
  type: ESTree.TSType,
  environment: TypeEnvironment,
): WideningTarget | null {
  const unwrapped = unwrapTransparentType(type)
  if (unwrapped.type === "TSAnyKeyword") return { kind: "any" }
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" }
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" }
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type === "TSIndexSignature")
      ? { kind: "open dictionary" }
      : unwrapped.members.length > 0
        ? { kind: "anonymous object" }
        : { kind: "empty object" }
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadDictionaryKeyType(unwrapped.constraint, environment, new Map())
      ? { kind: "open dictionary" }
      : null
  }
  if (unwrapped.type !== "TSTypeReference") return null
  const name = typeReferenceName(unwrapped)
  if (name === null) return null
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInAt(name, unwrapped, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0]
    return wrapped === undefined ? null : classifyWideningTarget(wrapped, environment)
  }
  if (name === "Record" && isBuiltInAt(name, unwrapped, environment)) {
    const key = unwrapped.typeArguments?.params[0]
    return key !== undefined && isBroadDictionaryKeyType(key, environment, new Map())
      ? { kind: "open dictionary" }
      : null
  }
  if (name === "Pick" || name === "Omit") {
    return classifyUtilityTarget(name, unwrapped, environment, new Map(), new Set())
  }
  if (
    resolveInterfaces(name, unwrapped, environment).length > 0 &&
    dictionaryValueTypes(unwrapped, environment, new Map(), new Set()).length > 0
  ) {
    return { kind: "open dictionary" }
  }
  const alias = resolveAlias(name, unwrapped, environment)
  if (alias === undefined) return null
  if ((alias.typeParameters?.params.length ?? 0) > 0) {
    const substitutions = aliasSubstitution(alias, unwrapped, new Map())
    return substitutions !== null &&
      resolvesToDictionary(alias.typeAnnotation, environment, substitutions, new Set([name]))
      ? { kind: "generic container" }
      : null
  }
  const substitutions = aliasSubstitution(alias, unwrapped, new Map())
  if (substitutions === null) return null
  const resolved = classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    substitutions,
    new Set([name]),
  )
  return resolved
}

export function isBroadDictionaryKeyType(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string> = new Set(),
): boolean {
  const unwrapped = unwrapTransparentType(type)
  if (
    unwrapped.type === "TSStringKeyword" ||
    unwrapped.type === "TSNumberKeyword" ||
    unwrapped.type === "TSSymbolKeyword"
  ) {
    return true
  }
  if (unwrapped.type === "TSTypeOperator" && unwrapped.operator === "keyof") {
    return unwrapped.typeAnnotation.type === "TSAnyKeyword"
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.some((member) =>
      isBroadDictionaryKeyType(member, environment, substitutions, resolvingAliases),
    )
  }
  if (unwrapped.type !== "TSTypeReference") return false
  const name = typeReferenceName(unwrapped)
  if (name === null) return false
  const substitution = substitutions.get(name)
  if (substitution !== undefined && !isUnappliedReferenceTo(substitution, name)) {
    return isBroadDictionaryKeyType(substitution, environment, substitutions, resolvingAliases)
  }
  if (name === "PropertyKey" && isBuiltInAt(name, unwrapped, environment)) return true
  const alias = resolveAlias(name, unwrapped, environment)
  if (alias === undefined || resolvingAliases.has(name)) return false
  const nextResolving = new Set(resolvingAliases)
  nextResolving.add(name)
  return isBroadDictionaryKeyType(alias.typeAnnotation, environment, substitutions, nextResolving)
}

function classifyUtilityTarget(
  name: string,
  type: ESTree.TSTypeReference,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
): WideningTarget | null {
  if ((name !== "Pick" && name !== "Omit") || !isBuiltInAt(name, type, environment)) return null
  const source = type.typeArguments?.params[0]
  const keys = type.typeArguments?.params[1]
  if (source === undefined || keys === undefined) return null
  const sourceTarget = classifyAliasBroadTarget(
    source,
    environment,
    substitutions,
    resolvingAliases,
  )
  if (sourceTarget?.kind !== "open dictionary") return null
  if (name === "Pick" && !isBroadDictionaryKeyType(keys, environment, substitutions)) return null
  return { kind: "open dictionary" }
}

function classifyAliasBroadTarget(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  substitutions: TypeAliasEnvironment,
  resolvingAliases: ReadonlySet<string>,
): WideningTarget | null {
  const unwrapped = unwrapTransparentType(type)
  if (unwrapped.type === "TSAnyKeyword") return { kind: "any" }
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" }
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" }
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type === "TSIndexSignature")
      ? { kind: "open dictionary" }
      : unwrapped.members.length === 0
        ? { kind: "empty object" }
        : null
  }
  if (unwrapped.type === "TSMappedType") {
    return isBroadDictionaryKeyType(unwrapped.constraint, environment, substitutions)
      ? { kind: "open dictionary" }
      : null
  }
  if (unwrapped.type !== "TSTypeReference") return null
  const name = typeReferenceName(unwrapped)
  if (name === null) return null
  const substitution = substitutions.get(name)
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? null
      : classifyAliasBroadTarget(substitution, environment, substitutions, resolvingAliases)
  }
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltInAt(name, unwrapped, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0]
    return wrapped === undefined
      ? null
      : classifyAliasBroadTarget(wrapped, environment, substitutions, resolvingAliases)
  }
  if (name === "Record" && isBuiltInAt(name, unwrapped, environment)) {
    const key = unwrapped.typeArguments?.params[0]
    return key !== undefined && isBroadDictionaryKeyType(key, environment, substitutions)
      ? { kind: "open dictionary" }
      : null
  }
  if (name === "Pick" || name === "Omit") {
    return classifyUtilityTarget(name, unwrapped, environment, substitutions, resolvingAliases)
  }
  if (
    resolveInterfaces(name, unwrapped, environment).length > 0 &&
    dictionaryValueTypes(unwrapped, environment, substitutions, resolvingAliases).length > 0
  ) {
    return { kind: "open dictionary" }
  }
  const alias = resolveAlias(name, unwrapped, environment)
  if (alias === undefined || resolvingAliases.has(name)) return null
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions)
  if (nextSubstitutions === null) return null
  const nextResolving = new Set(resolvingAliases)
  nextResolving.add(name)
  return classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving,
  )
}

export function isKnownEvidenceExpression(expression: ESTree.Expression): boolean {
  let current = expression
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression
  }
  if (current.type === "ObjectExpression") return true
  return (
    current.type === "ArrayExpression" ||
    current.type === "ArrowFunctionExpression" ||
    current.type === "ClassExpression" ||
    current.type === "FunctionExpression" ||
    current.type === "NewExpression" ||
    current.type === "Literal" ||
    current.type === "TemplateLiteral" ||
    current.type === "UnaryExpression"
  )
}
