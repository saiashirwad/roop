import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Random,
  Schema,
  Sink,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class PathEscapesError extends Schema.TaggedErrorClass<PathEscapesError>()(
  "PathEscapesError",
  {
    path: Schema.String,
    root: Schema.String,
    message: Schema.String,
  },
) {}

export class WorktreeError extends Schema.TaggedErrorClass<WorktreeError>()("WorktreeError", {
  message: Schema.String,
  exitCode: Schema.Finite,
}) {}

export interface ExecutionWorldService {
  /** The canonical absolute root directory of this execution workspace. */
  readonly root: string
  /** Optional derived/isolated environment variables for subprocesses. */
  readonly env?: Record<string, string | undefined> | undefined
  /** The workspace-scoped filesystem. */
  readonly filesystem: FileSystem.FileSystem
  /** The workspace-scoped process spawner. */
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  /**
   * Safely resolve a path relative to the workspace root.
   * Fails with PathEscapesError if the resolved path escapes the workspace root.
   */
  readonly resolvePath: (
    raw: string,
  ) => Effect.Effect<string, PathEscapesError | PlatformError.PlatformError>
}

export const makePathResolver = (
  root: string,
  path: Path.Path,
  filesystem?: FileSystem.FileSystem,
): ((raw: string) => Effect.Effect<string, PathEscapesError | PlatformError.PlatformError>) => {
  const workspace = path.resolve(root)
  const isNotFound = (error: PlatformError.PlatformError): boolean =>
    error.reason._tag === "NotFound"

  const canonicalAncestor = (filesystem: FileSystem.FileSystem, target: string) =>
    Effect.gen(function* () {
      let candidate = target
      while (true) {
        const resolved = yield* filesystem.realPath(candidate).pipe(
          Effect.map((real) => ({ candidate, real })),
          Effect.catchTag("PlatformError", (error) =>
            isNotFound(error) ? Effect.void : Effect.fail(error),
          ),
        )
        if (resolved !== undefined) return resolved
        const parent = path.dirname(candidate)
        if (parent === candidate) return undefined
        candidate = parent
      }
    })

  return (raw: string) =>
    Effect.gen(function* () {
      const target = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw)
      const rel = path.relative(workspace, target)
      const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
      if (escapes) {
        return yield* new PathEscapesError({
          path: raw,
          root: workspace,
          message: `path escapes the workspace root (${workspace}): ${raw}`,
        })
      }

      // Keep the pure resolver usable for lightweight callers that do not
      // provide a filesystem capability; the ExecutionWorld layers always do.
      if (filesystem === undefined) return target

      // Resolve the existing target, or the nearest existing ancestor for a
      // new file, so symlinks cannot redirect operations outside the workspace.
      // Filesystems without realPath support (for example the in-memory test
      // world) report NotFound for every path and retain lexical semantics.
      const fs = filesystem
      const rootReal = yield* fs
        .realPath(workspace)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            isNotFound(error) ? Effect.succeed(workspace) : Effect.fail(error),
          ),
        )
      const ancestor = yield* canonicalAncestor(fs, target)
      if (ancestor !== undefined) {
        const realTarget = path.join(ancestor.real, path.relative(ancestor.candidate, target))
        const realRel = path.relative(rootReal, realTarget)
        if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
          return yield* new PathEscapesError({
            path: raw,
            root: workspace,
            message: `path escapes the workspace root (${workspace}): ${raw}`,
          })
        }
      }
      return target
    })
}

export class ExecutionWorld extends Context.Service<ExecutionWorld, ExecutionWorldService>()(
  "roop/ExecutionWorld",
) {
  /**
   * Layer providing ExecutionWorld for a local directory backed by ambient FileSystem,
   * ChildProcessSpawner, and Path services.
   */
  static readonly local = (
    root?: string,
    options?: {
      readonly env?: Record<string, string | undefined>
    },
  ): Layer.Layer<
    ExecutionWorld,
    never,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path
  > =>
    Layer.effect(
      ExecutionWorld,
      Effect.gen(function* () {
        const filesystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const path = yield* Path.Path
        const resolvedRoot = path.resolve(root ?? ".")
        return ExecutionWorld.of({
          root: resolvedRoot,
          env: options?.env,
          filesystem,
          spawner,
          resolvePath: makePathResolver(resolvedRoot, path, filesystem),
        })
      }),
    )

  /**
   * Default layer providing ExecutionWorld for the current working directory.
   */
  static readonly layer: Layer.Layer<
    ExecutionWorld,
    never,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path
  > = ExecutionWorld.local()

  /**
   * In-memory ExecutionWorld for fast unit testing and sandboxes without host disk access.
   */
  static readonly memory = (options?: {
    readonly root?: string
    readonly files?: Record<string, string>
    readonly env?: Record<string, string | undefined>
    readonly spawner?: (
      command: ChildProcess.Command,
    ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle>
  }): Layer.Layer<ExecutionWorld, never, Path.Path> =>
    Layer.effect(
      ExecutionWorld,
      Effect.gen(function* () {
        const path = yield* Path.Path
        const root = path.resolve(options?.root ?? "/workspace")
        const files = new Map<string, string>()
        if (options?.files) {
          for (const [filePath, content] of Object.entries(options.files)) {
            const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
            files.set(resolved, content)
          }
        }

        const mockFileSystem = FileSystem.makeNoop({
          readFileString: (target: string) => {
            const content = files.get(target)
            if (content === undefined) {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: target,
                  description: `file not found: ${target}`,
                }),
              )
            }
            return Effect.succeed(content)
          },
          writeFileString: (target: string, content: string) =>
            Effect.sync(() => {
              files.set(target, content)
            }),
          readDirectory: (dir: string) =>
            Effect.sync(() => {
              const results: string[] = []
              const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`
              for (const key of files.keys()) {
                if (key === dir || key.startsWith(prefix)) {
                  const rel = path.relative(dir, key)
                  if (rel.length > 0 && !results.includes(rel)) {
                    results.push(rel)
                  }
                }
              }
              return results
            }),
          exists: (target: string) => Effect.sync(() => files.has(target)),
          makeDirectory: () => Effect.void,
          remove: (target: string) =>
            Effect.sync(() => {
              files.delete(target)
            }),
        })

        const mockSpawner = ChildProcessSpawner.make(
          options?.spawner ??
            ((command) => {
              const cmdStr = command._tag === "StandardCommand" ? command.command : "piped-command"
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(12345),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  stdout: Stream.make(new TextEncoder().encode(`output: ${cmdStr}`)),
                  stderr: Stream.empty,
                  all: Stream.make(new TextEncoder().encode(`output: ${cmdStr}`)),
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void),
                }),
              )
            }),
        )

        return ExecutionWorld.of({
          root,
          env: options?.env,
          filesystem: mockFileSystem,
          spawner: mockSpawner,
          resolvePath: makePathResolver(root, path, mockFileSystem),
        })
      }),
    )

  /**
   * Git worktree isolated ExecutionWorld.
   * Acquires a detached or branched git worktree on scope entry and cleans it up on scope exit.
   */
  static readonly worktree = (options: {
    readonly baseRepo: string
    readonly branch?: string | undefined
    readonly env?: Record<string, string | undefined> | undefined
    readonly worktreeDir?: string | undefined
  }): Layer.Layer<
    ExecutionWorld,
    WorktreeError,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path
  > =>
    Layer.effect(
      ExecutionWorld,
      Effect.gen(function* () {
        const filesystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const path = yield* Path.Path

        const baseRepo = path.resolve(options.baseRepo)
        const randId = yield* Random.nextIntBetween(100000, 999999)
        const worktreePath = options.worktreeDir
          ? path.resolve(options.worktreeDir)
          : path.join(baseRepo, ".roop", "worktrees", `wt-${randId}`)

        const createWorktree = Effect.gen(function* () {
          yield* filesystem
            .makeDirectory(path.dirname(worktreePath), { recursive: true })
            .pipe(Effect.ignore)

          const args = options.branch
            ? ["worktree", "add", "-b", options.branch, worktreePath]
            : ["worktree", "add", "--detach", worktreePath, "HEAD"]

          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: baseRepo }))
          const [_stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          if (Number(exitCode) !== 0) {
            return yield* new WorktreeError({
              exitCode: Number(exitCode),
              message: `Failed to create git worktree at ${worktreePath}: ${stderr}`,
            })
          }
          return worktreePath
        }).pipe(
          Effect.mapError((error) =>
            Schema.is(WorktreeError)(error)
              ? error
              : new WorktreeError({
                  exitCode: -1,
                  message: `Failed to create git worktree at ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
                }),
          ),
        )

        const cleanupWorktree = Effect.scoped(
          Effect.gen(function* () {
            const cleanupHandle = yield* spawner.spawn(
              ChildProcess.make("git", ["worktree", "remove", "--force", worktreePath], {
                cwd: baseRepo,
              }),
            )
            const exitCode = yield* Effect.all(
              [
                Stream.runDrain(cleanupHandle.stdout),
                Stream.runDrain(cleanupHandle.stderr),
                cleanupHandle.exitCode,
              ],
              { concurrency: "unbounded" },
            )
            const code = Number(exitCode[2])
            if (code !== 0) {
              return yield* new WorktreeError({
                exitCode: code,
                message: `Failed to remove git worktree at ${worktreePath} (exit code ${code})`,
              })
            }
            // Git owns the worktree metadata. Only remove any empty directory
            // left behind after git confirms that metadata cleanup succeeded.
            yield* filesystem.remove(worktreePath, { recursive: true })
          }),
        ).pipe(Effect.ignore)

        yield* Effect.acquireRelease(createWorktree, () => cleanupWorktree)

        return ExecutionWorld.of({
          root: worktreePath,
          env: options.env,
          filesystem,
          spawner,
          resolvePath: makePathResolver(worktreePath, path, filesystem),
        })
      }),
    )

  /**
   * Scoped layer that derives an isolated Git worktree ExecutionWorld from the ambient parent ExecutionWorld.
   */
  static readonly worktreeFromParent = (options?: {
    readonly branch?: string | undefined
    readonly env?: Record<string, string | undefined> | undefined
    readonly worktreeDir?: string | undefined
  }): Layer.Layer<
    ExecutionWorld,
    WorktreeError,
    ExecutionWorld | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path
  > =>
    Layer.unwrap(
      Effect.gen(function* () {
        const parentWorld = yield* ExecutionWorld
        return ExecutionWorld.worktree({
          baseRepo: parentWorld.root,
          branch: options?.branch,
          env: options?.env ?? parentWorld.env,
          worktreeDir: options?.worktreeDir,
        })
      }),
    )
}

export const normalizeWorkspacePath = (world: ExecutionWorldService, resolved: string): string => {
  const root = world.root.replaceAll("\\", "/").replace(/\/+$/, "")
  const target = resolved.replaceAll("\\", "/")
  if (target === root) return ""
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target
}
