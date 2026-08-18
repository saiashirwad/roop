import { Clock, Context, Effect, Layer, Path, Ref, Schema } from "effect"

import { ExecutionWorld } from "./ExecutionWorld.ts"

/* ========================================================================== *
 * Schemas & Configuration                                                    *
 * ========================================================================== */

export class TruncateError extends Schema.TaggedErrorClass<TruncateError>()("TruncateError", {
  message: Schema.String,
}) {}

/** The model-facing projection of a tool output. */
export class TruncateResult extends Schema.Class<TruncateResult>("TruncateResult")({
  content: Schema.String,
  truncated: Schema.Boolean,
  totalBytes: Schema.Finite,
  totalLines: Schema.Finite,
  spillPath: Schema.optionalKey(Schema.String),
  hint: Schema.optionalKey(Schema.String),
}) {}

export interface TruncateOptions {
  /** A safe, descriptive component of the spill file name. */
  readonly key?: string | undefined
  /** Input/output byte ceiling before spilling (default: 32 KiB). */
  readonly maxBytes?: number | undefined
  /** Input/output line ceiling before spilling (default: 200). */
  readonly maxLines?: number | undefined
  /** Leading lines retained in a spilled-output preview (default: 80). */
  readonly previewHead?: number | undefined
  /** Trailing lines retained in a spilled-output preview (default: 20). */
  readonly previewTail?: number | undefined
  /** @deprecated Use previewHead. */
  readonly previewHeadLines?: number | undefined
  /** @deprecated Use previewTail. */
  readonly previewTailLines?: number | undefined
  /** A short description included in the model-facing recovery hint. */
  readonly hintContext?: string | undefined
}

export interface TruncateConfig {
  readonly maxBytes: number
  readonly maxLines: number
  readonly previewHead: number
  readonly previewTail: number
  readonly spillDir: string
}

export const defaultTruncateConfig: TruncateConfig = {
  maxBytes: 32 * 1024,
  maxLines: 200,
  previewHead: 80,
  previewTail: 20,
  spillDir: ".roop/truncations",
}

/* ========================================================================== *
 * Capability Seam: Truncate                                                  *
 * ========================================================================== */

export interface TruncateService {
  readonly truncate: (
    content: string,
    options?: TruncateOptions,
  ) => Effect.Effect<TruncateResult, TruncateError>
  readonly truncateCommand: (
    command: string,
    stdout: string,
    stderr: string,
    options?: TruncateOptions,
  ) => Effect.Effect<
    {
      readonly stdout: TruncateResult
      readonly stderr: TruncateResult
    },
    TruncateError
  >
}

/* ========================================================================== *
 * Pure Preview Formatting & Slicing                                          *
 * ========================================================================== */

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength
const nonNegativeInteger = (value: number): number => Math.max(0, Math.floor(value))
const sanitizeKey = (key: string): string => key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50)

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/** Crop on Unicode code-point boundaries so a preview is valid UTF-8. */
const takePrefix = (text: string, budget: number): string => {
  let used = 0
  let result = ""
  for (const character of text) {
    const size = byteLength(character)
    if (used + size > budget) break
    result += character
    used += size
  }
  return result
}

const takeSuffix = (text: string, budget: number): string => {
  let used = 0
  const reversed: Array<string> = []
  for (const character of Array.from(text).reverse()) {
    const size = byteLength(character)
    if (used + size > budget) break
    reversed.push(character)
    used += size
  }
  return reversed.reverse().join("")
}

const previewOptions = (config: TruncateConfig, options: TruncateOptions | undefined) => ({
  maxBytes: nonNegativeInteger(options?.maxBytes ?? config.maxBytes),
  maxLines: nonNegativeInteger(options?.maxLines ?? config.maxLines),
  head: nonNegativeInteger(options?.previewHead ?? options?.previewHeadLines ?? config.previewHead),
  tail: nonNegativeInteger(options?.previewTail ?? options?.previewTailLines ?? config.previewTail),
})

const makePreview = (args: {
  readonly lines: ReadonlyArray<string>
  readonly totalBytes: number
  readonly spillPath: string
  readonly hintContext?: string | undefined
  readonly options: ReturnType<typeof previewOptions>
}): Preview => {
  const { lines, totalBytes, spillPath, hintContext, options } = args
  const headLines = lines.slice(0, options.head)
  const tailStart = Math.max(headLines.length, lines.length - options.tail)
  const tailLines = lines.slice(tailStart)
  const omittedLines = Math.max(0, lines.length - headLines.length - tailLines.length)
  const marker =
    omittedLines > 0
      ? `... [${omittedLines} lines omitted; ${formatBytes(totalBytes)} total] ...`
      : `... [output shortened to fit ${formatBytes(options.maxBytes)}; ${formatBytes(totalBytes)} total] ...`
  const hint =
    `Output truncated${hintContext === undefined ? "" : ` for ${hintContext}`}. ` +
    `Full output: ${spillPath}. Use grep or readFile with offset and limit to inspect a small section.`

  // Preview payloads obey the same byte bound as the input threshold. The
  // compact marker and recovery hint are added afterward so even tiny limits
  // still leave the model a usable path to the full output.
  const markerBytes = byteLength(marker)
  const separatorBytes = tailLines.length > 0 ? byteLength("\n\n") : 0
  const available = Math.max(0, options.maxBytes - markerBytes - separatorBytes)
  const headBudget = tailLines.length === 0 ? available : Math.floor(available * 0.8)
  const head = takePrefix(headLines.join("\n"), headBudget)
  const tail = takeSuffix(tailLines.join("\n"), Math.max(0, available - byteLength(head)))
  const parts = [head, marker, tail].filter((part) => part.length > 0)
  return { content: `${parts.join("\n\n")}\n\n${hint}`, hint }
}

type Spill = (relativePath: string, content: string) => Effect.Effect<void, TruncateError>
type AllocatePath = (key: string | undefined) => Effect.Effect<string>
interface Preview {
  readonly content: string
  readonly hint: string
}

const makeService = (
  config: TruncateConfig,
  allocatePath: AllocatePath,
  spill: Spill,
): TruncateService => {
  const truncate = (
    content: string,
    options?: TruncateOptions,
  ): Effect.Effect<TruncateResult, TruncateError> =>
    Effect.gen(function* () {
      const totalBytes = byteLength(content)
      const lines = content.split(/\r?\n/)
      const totalLines = lines.length
      const limits = previewOptions(config, options)
      if (totalBytes <= limits.maxBytes && totalLines <= limits.maxLines) {
        return new TruncateResult({ content, truncated: false, totalBytes, totalLines })
      }

      const spillPath = yield* allocatePath(options?.key)
      yield* spill(spillPath, content)
      const preview = makePreview({
        lines,
        totalBytes,
        spillPath,
        hintContext: options?.hintContext,
        options: limits,
      })
      return new TruncateResult({
        content: preview.content,
        truncated: true,
        totalBytes,
        totalLines,
        spillPath,
        hint: preview.hint,
      })
    })

  return {
    truncate,
    truncateCommand: (command, stdout, stderr, options) => {
      const commandName = sanitizeKey(command.trim().split(/\s+/)[0] || "command")
      return Effect.all([
        truncate(stdout, {
          ...options,
          key: `${commandName}-stdout`,
          hintContext: `stdout of '${command}'`,
        }),
        truncate(stderr, {
          ...options,
          key: `${commandName}-stderr`,
          hintContext: `stderr of '${command}'`,
        }),
      ]).pipe(Effect.map(([stdout, stderr]) => ({ stdout, stderr })))
    },
  }
}

export class Truncate extends Context.Service<Truncate, TruncateService>()("roop/Truncate") {
  /** Spills complete outputs through the caller's workspace capability. */
  static readonly layer: (
    configOverrides?: Partial<TruncateConfig>,
  ) => Layer.Layer<Truncate, never, ExecutionWorld | Path.Path> = (configOverrides) =>
    Layer.effect(
      Truncate,
      Effect.gen(function* () {
        const world = yield* ExecutionWorld
        const path = yield* Path.Path
        const config: TruncateConfig = { ...defaultTruncateConfig, ...configOverrides }
        const sequence = yield* Ref.make(0)
        const allocatePath: AllocatePath = (key) =>
          Effect.gen(function* () {
            const timestamp = yield* Clock.currentTimeMillis
            return yield* Ref.modify(sequence, (current) => {
              const next = current + 1
              const safeKey = key === undefined ? "" : `${sanitizeKey(key)}_`
              return [path.join(config.spillDir, `tool_${safeKey}${timestamp}_${next}.txt`), next]
            })
          })
        const spill: Spill = (relativePath, content) =>
          Effect.gen(function* () {
            const absolutePath = yield* world.resolvePath(relativePath)
            yield* world.filesystem.makeDirectory(path.dirname(absolutePath), { recursive: true })
            yield* world.filesystem.writeFileString(absolutePath, content)
          }).pipe(Effect.mapError((error) => new TruncateError({ message: error.message })))

        return Truncate.of(makeService(config, allocatePath, spill))
      }),
    )

  /** In-memory provider for hermetic tests and non-filesystem environments. */
  static readonly memory: (options?: {
    readonly config?: Partial<TruncateConfig>
    readonly store?: Map<string, string>
  }) => Layer.Layer<Truncate, never, Path.Path> = (options) =>
    Layer.effect(
      Truncate,
      Effect.gen(function* () {
        const path = yield* Path.Path
        const config: TruncateConfig = { ...defaultTruncateConfig, ...options?.config }
        const store = options?.store ?? new Map<string, string>()
        const sequence = yield* Ref.make(0)
        const allocatePath: AllocatePath = (key) =>
          Ref.modify(sequence, (current) => {
            const next = current + 1
            const safeKey = key === undefined ? "" : `${sanitizeKey(key)}_`
            return [path.join(config.spillDir, `tool_${safeKey}memory_${next}.txt`), next]
          })
        const spill: Spill = (relativePath, content) =>
          Effect.sync(() => {
            store.set(relativePath, content)
          })

        return Truncate.of(makeService(config, allocatePath, spill))
      }),
    )
}
