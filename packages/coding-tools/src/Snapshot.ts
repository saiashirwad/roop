import { type AgentHooks, layerHook } from "@roop/agent/AgentHooks.ts"
import { Clock, Context, Effect, Exit, Layer, Path, Ref, Schema, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

import { ExecutionWorld } from "./ExecutionWorld.ts"

/* ========================================================================== *
 * Schemas & Models                                                           *
 * ========================================================================== */

export class SnapshotError extends Schema.TaggedErrorClass<SnapshotError>()("SnapshotError", {
  message: Schema.String,
  exitCode: Schema.optionalKey(Schema.Finite),
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export const TreeHash = Schema.String.pipe(Schema.brand("TreeHash"))
export type TreeHash = typeof TreeHash.Type

export class SnapshotEntry extends Schema.Class<SnapshotEntry>("SnapshotEntry")({
  treeHash: TreeHash,
  label: Schema.String,
  timestamp: Schema.Finite,
  turn: Schema.optional(Schema.Finite),
  step: Schema.optional(Schema.Finite),
  toolCallName: Schema.optional(Schema.String),
}) {}

export class RevertReport extends Schema.Class<RevertReport>("RevertReport")({
  revertedTo: TreeHash,
  previousTreeHash: TreeHash,
  diffSummary: Schema.String,
  message: Schema.String,
}) {}

export interface SnapshotTrackOptions {
  readonly label?: string | undefined
  readonly turn?: number | undefined
  readonly step?: number | undefined
  readonly toolCallName?: string | undefined
}

/* ========================================================================== *
 * Capability Seam: Snapshot                                                  *
 * ========================================================================== */

export interface SnapshotService {
  /** Record the current workspace as a tree in Git's object database. */
  readonly track: (options?: SnapshotTrackOptions) => Effect.Effect<TreeHash, SnapshotError>
  /** Restore all non-ignored files captured by a snapshot without changing the user's Git index. */
  readonly restore: (treeHash: TreeHash | string) => Effect.Effect<void, SnapshotError>
  /** Restore a snapshot and report the changes made from the current shadow tree. */
  readonly revert: (treeHash: TreeHash | string) => Effect.Effect<RevertReport, SnapshotError>
  /** Produce a unified diff between two shadow trees. */
  readonly diff: (
    fromTreeHash: TreeHash | string,
    toTreeHash: TreeHash | string,
  ) => Effect.Effect<string, SnapshotError>
  readonly history: Effect.Effect<ReadonlyArray<SnapshotEntry>>
}

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the typed boundary that normalizes platform and subprocess failures into SnapshotError. */
const toSnapshotError = (error: unknown): SnapshotError =>
  Schema.is(SnapshotError)(error)
    ? error
    : new SnapshotError({ message: `Snapshot operation failed: ${String(error)}`, cause: error })

export class Snapshot extends Context.Service<Snapshot, SnapshotService>()("roop/Snapshot") {
  /**
   * Git-backed provider. It owns a separate `GIT_INDEX_FILE`; the normal
   * branch, staging area, and commits remain untouched. `.roop` is explicitly
   * excluded so the shadow index never snapshots itself.
   */
  static readonly layer: (options?: {
    readonly shadowIndexName?: string
  }) => Layer.Layer<Snapshot, never, ExecutionWorld | Path.Path> = (options) =>
    Layer.effect(
      Snapshot,
      Effect.gen(function* () {
        const world = yield* ExecutionWorld
        const path = yield* Path.Path
        const history = yield* Ref.make<Array<SnapshotEntry>>([])
        const lock = yield* Semaphore.make(1)
        const shadowIndexPath = path.join(
          world.root,
          ".roop",
          options?.shadowIndexName ?? "shadow.index",
        )

        const runGit = (args: ReadonlyArray<string>): Effect.Effect<string, SnapshotError> =>
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* world.spawner.spawn(
                ChildProcess.make("git", args, {
                  cwd: world.root,
                  env: { ...world.env, GIT_INDEX_FILE: shadowIndexPath },
                }),
              )
              const [stdout, stderr, exitCode] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              )
              const code = Number(exitCode)
              if (code !== 0) {
                return yield* new SnapshotError({
                  message: `git ${args.join(" ")} failed: ${stderr.trim()}`,
                  exitCode: code,
                })
              }
              return stdout
            }),
          ).pipe(Effect.mapError(toSnapshotError))

        const captureTree = (): Effect.Effect<TreeHash, SnapshotError> =>
          Effect.gen(function* () {
            yield* world.filesystem.makeDirectory(path.dirname(shadowIndexPath), {
              recursive: true,
            })
            yield* runGit(["add", "-A", "--", ".", ":(exclude).roop"])
            const output = yield* runGit(["write-tree"])
            return TreeHash.make(output.trim())
          }).pipe(Effect.mapError(toSnapshotError))

        const treeFiles = (
          treeHash: TreeHash | string,
        ): Effect.Effect<ReadonlyArray<string>, SnapshotError> =>
          runGit(["ls-tree", "-r", "--name-only", "-z", String(treeHash)]).pipe(
            Effect.map((output) => output.split("\0").filter((file) => file.length > 0)),
          )

        const restoreTree = (
          targetTree: TreeHash | string,
          currentTree: TreeHash,
        ): Effect.Effect<void, SnapshotError> =>
          Effect.gen(function* () {
            const [currentFiles, targetFiles] = yield* Effect.all([
              treeFiles(currentTree),
              treeFiles(targetTree),
            ])
            const targetSet = new Set(targetFiles)
            // Remove only files tracked by the current shadow tree. Ignored
            // local files remain untouched, while newly-created agent files
            // absent from the target are removed before checkout.
            for (const file of [...currentFiles]
              .filter((file) => !targetSet.has(file))
              .sort()
              .reverse()) {
              const absolutePath = yield* world.resolvePath(file)
              yield* world.filesystem.remove(absolutePath, { force: true })
            }
            yield* runGit(["read-tree", String(targetTree)])
            yield* runGit(["checkout-index", "-a", "-f"])
          }).pipe(Effect.mapError(toSnapshotError))

        const record = (treeHash: TreeHash, options: SnapshotTrackOptions | undefined) =>
          Effect.gen(function* () {
            const timestamp = yield* Clock.currentTimeMillis
            yield* Ref.update(history, (entries) => [
              ...entries,
              new SnapshotEntry({
                treeHash,
                label: options?.label ?? `snapshot-${timestamp}`,
                timestamp,
                turn: options?.turn,
                step: options?.step,
                toolCallName: options?.toolCallName,
              }),
            ])
          })

        const trackUnlocked = (options: SnapshotTrackOptions | undefined) =>
          Effect.gen(function* () {
            const treeHash = yield* captureTree()
            yield* record(treeHash, options)
            return treeHash
          })
        const withLock = <A>(effect: Effect.Effect<A, SnapshotError>) => lock.withPermits(1)(effect)

        return Snapshot.of({
          track: (options) => withLock(trackUnlocked(options)),
          restore: (targetTree) =>
            withLock(
              Effect.gen(function* () {
                const currentTree = yield* captureTree()
                yield* restoreTree(targetTree, currentTree)
              }),
            ),
          revert: (targetTree) =>
            withLock(
              Effect.gen(function* () {
                const currentTree = yield* trackUnlocked({ label: "pre-revert" })
                const diffSummary = yield* runGit([
                  "diff",
                  "--no-ext-diff",
                  String(currentTree),
                  String(targetTree),
                  "--",
                ])
                yield* restoreTree(targetTree, currentTree)
                return new RevertReport({
                  revertedTo: TreeHash.make(String(targetTree)),
                  previousTreeHash: currentTree,
                  diffSummary,
                  message: `Restored workspace state to tree ${targetTree}`,
                })
              }),
            ),
          diff: (fromTree, toTree) =>
            withLock(runGit(["diff", "--no-ext-diff", String(fromTree), String(toTree), "--"])),
          history: Ref.get(history),
        })
      }),
    )

  /** In-memory provider for fast tests and filesystem-free execution worlds. */
  static readonly memory: () => Layer.Layer<Snapshot, never, ExecutionWorld> = () =>
    Layer.effect(
      Snapshot,
      Effect.gen(function* () {
        const world = yield* ExecutionWorld
        const snapshots = new Map<string, Map<string, string>>()
        const history = yield* Ref.make<Array<SnapshotEntry>>([])
        const sequence = yield* Ref.make(0)

        const capture = (): Effect.Effect<TreeHash, SnapshotError> =>
          Effect.gen(function* () {
            const files = yield* world.filesystem.readDirectory(world.root, { recursive: true })
            const snapshot = new Map<string, string>()
            for (const file of files) {
              const absolutePath = yield* world.resolvePath(file)
              const content = yield* world.filesystem.readFileString(absolutePath)
              snapshot.set(file, content)
            }
            const number = yield* Ref.modify(
              sequence,
              (current) => [current + 1, current + 1] as const,
            )
            const hash = TreeHash.make(`tree_mem_${number}`)
            snapshots.set(hash, snapshot)
            return hash
          }).pipe(Effect.mapError(toSnapshotError))

        const record = (treeHash: TreeHash, options: SnapshotTrackOptions | undefined) =>
          Effect.gen(function* () {
            const timestamp = yield* Clock.currentTimeMillis
            yield* Ref.update(history, (entries) => [
              ...entries,
              new SnapshotEntry({
                treeHash,
                label: options?.label ?? "memory-snapshot",
                timestamp,
                turn: options?.turn,
                step: options?.step,
                toolCallName: options?.toolCallName,
              }),
            ])
          })

        const track = (options?: SnapshotTrackOptions) =>
          Effect.gen(function* () {
            const hash = yield* capture()
            yield* record(hash, options)
            return hash
          })
        const restore = (treeHash: TreeHash | string): Effect.Effect<void, SnapshotError> =>
          Effect.gen(function* () {
            const target = snapshots.get(String(treeHash))
            if (target === undefined) {
              return yield* new SnapshotError({ message: `Snapshot not found: ${treeHash}` })
            }
            const current = yield* world.filesystem.readDirectory(world.root, { recursive: true })
            for (const file of current) {
              const absolutePath = yield* world.resolvePath(file)
              yield* world.filesystem.remove(absolutePath, { force: true })
            }
            for (const [file, content] of target) {
              const absolutePath = yield* world.resolvePath(file)
              yield* world.filesystem.writeFileString(absolutePath, content)
            }
          }).pipe(Effect.mapError(toSnapshotError))
        const diff = (fromTree: TreeHash | string, toTree: TreeHash | string) =>
          Effect.gen(function* () {
            const from = snapshots.get(String(fromTree))
            const to = snapshots.get(String(toTree))
            if (from === undefined || to === undefined) {
              return yield* new SnapshotError({ message: "Snapshot not found" })
            }
            const files = new Set([...from.keys(), ...to.keys()])
            return [...files]
              .filter((file) => from.get(file) !== to.get(file))
              .sort()
              .map((file) => `diff --snapshot a/${file} b/${file}`)
              .join("\n")
          }).pipe(Effect.mapError(toSnapshotError))

        return Snapshot.of({
          track,
          restore,
          revert: (targetTree) =>
            Effect.gen(function* () {
              const currentTree = yield* track({ label: "pre-revert" })
              const diffSummary = yield* diff(currentTree, targetTree)
              yield* restore(targetTree)
              return new RevertReport({
                revertedTo: TreeHash.make(String(targetTree)),
                previousTreeHash: currentTree,
                diffSummary,
                message: `Restored workspace state to tree ${targetTree}`,
              })
            }),
          diff,
          history: Ref.get(history),
        })
      }),
    )
}

/* ========================================================================== *
 * AgentHooks Integration: SnapshotHooks                                      *
 * ========================================================================== */

export interface SnapshotHookOptions {
  /** Mutating tool names that trigger a pre-execution snapshot. */
  readonly mutatingTools?: ReadonlyArray<string>
  /** Revert the matching snapshot when a tool fails. Requires serialized mutating tools for safety. */
  readonly autoRevertOnFailure?: boolean | undefined
  /** Record a shadow snapshot before each mutating tool even when auto-revert is off. */
  readonly trackMutations?: boolean | undefined
}

const defaultMutatingTools = ["writeFile", "edit", "applyPatch", "bash"]

/** Optional hook policy; the core loop never requires snapshots. */
export const SnapshotHooks = (
  options?: SnapshotHookOptions,
): Layer.Layer<AgentHooks, never, AgentHooks | Snapshot> => {
  const mutatingTools = new Set(options?.mutatingTools ?? defaultMutatingTools)

  return layerHook("snapshot", (downstream) =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot
      const pending = yield* Ref.make<Map<string, ReadonlyArray<TreeHash>>>(new Map())
      const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>())
      const keyFor = (
        context: { readonly sessionId: string; readonly turn: number; readonly step: number },
        name: string,
      ) => `${context.sessionId}:${context.turn}:${context.step}:${name}`
      const lockFor = (sessionId: string) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(locks)).get(sessionId)
          if (existing !== undefined) return existing
          const created = yield* Semaphore.make(1)
          return yield* Ref.modify(locks, (map) => {
            const raced = map.get(sessionId)
            if (raced !== undefined) return [raced, map] as const
            const next = new Map(map)
            next.set(sessionId, created)
            return [created, next] as const
          })
        })

      return {
        ...downstream,
        beforeToolExecute: (context, call) =>
          Effect.gen(function* () {
            if (options?.autoRevertOnFailure === true || options?.trackMutations !== true) {
              return yield* downstream.beforeToolExecute(context, call)
            }
            if (!mutatingTools.has(call.name))
              return yield* downstream.beforeToolExecute(context, call)
            const treeHash = yield* snapshot
              .track({
                label: `before-${call.name}-t${context.turn}-s${context.step}`,
                turn: context.turn,
                step: context.step,
                toolCallName: call.name,
              })
              .pipe(Effect.orElseSucceed(() => undefined))
            if (treeHash !== undefined) {
              const key = keyFor(context, call.name)
              yield* Ref.update(pending, (entries) => {
                const next = new Map(entries)
                next.set(key, [...(next.get(key) ?? []), treeHash])
                return next
              })
            }
            return yield* downstream.beforeToolExecute(context, call)
          }),
        withToolExecution: (context, call, execute) =>
          Effect.gen(function* () {
            if (options?.autoRevertOnFailure !== true || !mutatingTools.has(call.name)) {
              return yield* execute
            }

            // The scheduler has already admitted this effect. Hold the
            // per-session snapshot lock for the complete tool stream, so a
            // failure can only revert its own immediately preceding state.
            const lock = yield* lockFor(context.sessionId)
            const released = yield* Ref.make(false)
            const releaseOnce = Ref.modify(released, (done) => [done, true] as const).pipe(
              Effect.flatMap((done) => (done ? Effect.void : lock.release(1))),
            )

            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* lock.take(1)
                return yield* restore(
                  Effect.gen(function* () {
                    const treeHash = yield* snapshot
                      .track({
                        label: `before-${call.name}-t${context.turn}-s${context.step}`,
                        turn: context.turn,
                        step: context.step,
                        toolCallName: call.name,
                      })
                      .pipe(Effect.orElseSucceed(() => undefined))

                    if (treeHash === undefined) {
                      return (yield* execute).pipe(Stream.ensuring(releaseOnce))
                    }

                    const key = keyFor(context, call.name)
                    yield* Ref.update(pending, (entries) => {
                      const next = new Map(entries)
                      next.set(key, [...(next.get(key) ?? []), treeHash])
                      return next
                    })

                    return (yield* execute).pipe(
                      Stream.onExit((exit) =>
                        Exit.isFailure(exit)
                          ? snapshot.revert(treeHash).pipe(Effect.ignore)
                          : Effect.void,
                      ),
                      Stream.ensuring(releaseOnce),
                    )
                  }).pipe(
                    Effect.onExit((exit) => (Exit.isFailure(exit) ? releaseOnce : Effect.void)),
                  ),
                )
              }),
            )
          }),
        afterToolExecute: (context, call, isFailure) =>
          Effect.gen(function* () {
            const key = keyFor(context, call.name)
            const treeHash = yield* Ref.modify(pending, (entries) => {
              const snapshots = entries.get(key) ?? []
              const next = new Map(entries)
              if (snapshots.length <= 1) next.delete(key)
              else next.set(key, snapshots.slice(1))
              return [snapshots[0], next] as const
            })
            if (isFailure && treeHash !== undefined && options?.autoRevertOnFailure === true) {
              yield* snapshot.revert(treeHash).pipe(Effect.ignore)
            }
            return yield* downstream.afterToolExecute(context, call, isFailure)
          }),
      }
    }),
  )
}

export const layerSnapshotHooks = SnapshotHooks
