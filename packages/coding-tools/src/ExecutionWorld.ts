import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Random,
  Schema,
  Scope,
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

export class HomesteadError extends Schema.TaggedErrorClass<HomesteadError>()("HomesteadError", {
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
  readonly resolvePath: (raw: string) => Effect.Effect<string, PathEscapesError>
}

export const makePathResolver = (
  root: string,
  path: Path.Path,
): ((raw: string) => Effect.Effect<string, PathEscapesError>) => {
  const workspace = path.resolve(root)
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
          resolvePath: makePathResolver(resolvedRoot, path),
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
          readFileString: (target: string) =>
            Effect.sync(() => {
              const content = files.get(target)
              if (content === undefined) {
                throw new Error(`file not found: ${target}`)
              }
              return content
            }),
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
          resolvePath: makePathResolver(root, path),
        })
      }),
    )

  /**
   * Homestead Git worktree isolated ExecutionWorld.
   * Acquires a detached or branched git worktree on scope entry and cleans it up on scope exit.
   */
  static readonly homestead = (options: {
    readonly baseRepo: string
    readonly branch?: string
    readonly env?: Record<string, string | undefined>
    readonly worktreeDir?: string
  }): Layer.Layer<
    ExecutionWorld,
    HomesteadError,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Path.Path
  > =>
    Layer.effect(
      ExecutionWorld,
      Effect.gen(function* () {
        const filesystem = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const path = yield* Path.Path
        const scope = yield* Scope.Scope

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
          const exitCode = yield* handle.exitCode
          if (Number(exitCode) !== 0) {
            const stderr = yield* Stream.mkString(Stream.decodeText(handle.stderr))
            return yield* new HomesteadError({
              exitCode: Number(exitCode),
              message: `Failed to create git worktree at ${worktreePath}: ${stderr}`,
            })
          }
        }).pipe(
          Effect.mapError((error) =>
            Schema.is(HomesteadError)(error)
              ? error
              : new HomesteadError({
                  exitCode: -1,
                  message: `Failed to create git worktree at ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
                }),
          ),
        )

        yield* createWorktree

        yield* Scope.addFinalizer(
          scope,
          Effect.scoped(
            Effect.gen(function* () {
              const cleanupHandle = yield* spawner.spawn(
                ChildProcess.make("git", ["worktree", "remove", "--force", worktreePath], {
                  cwd: baseRepo,
                }),
              )
              yield* cleanupHandle.exitCode
              yield* filesystem.remove(worktreePath, { recursive: true }).pipe(Effect.ignore)
            }),
          ).pipe(Effect.ignore),
        )

        return ExecutionWorld.of({
          root: worktreePath,
          env: options.env,
          filesystem,
          spawner,
          resolvePath: makePathResolver(worktreePath, path),
        })
      }),
    )
}
