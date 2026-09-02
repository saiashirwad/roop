import { Cause, Context, Effect, Exit, Fiber, Ref, Schema, type Scope } from "effect"

export class TaskNotFound extends Schema.TaggedErrorClass<TaskNotFound>()("TaskNotFound", {
  id: Schema.String,
}) {
  override get message(): string {
    return `Task '${this.id}' was not found in this run`
  }
}

export class TaskFailed extends Schema.TaggedErrorClass<TaskFailed>()("TaskFailed", {
  id: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Task '${this.id}' failed: ${this.detail}`
  }
}

export type TaskStatus = "running" | "completed" | "failed"

export interface TaskInfo {
  readonly id: string
  readonly name: string
  readonly status: TaskStatus
}

/**
 * Background work owned by one run. A task is started from a tool call, keeps
 * running after that call returns, and is collected by a later call. Every task
 * lives in the run's scope: when the run ends, unfinished tasks are interrupted.
 */
export interface TasksService {
  /** Start `work` in the background, in the caller's environment, and return its task id. */
  readonly spawn: <R>(
    name: string,
    work: Effect.Effect<string, unknown, R>,
  ) => Effect.Effect<string, never, R>
  /** Wait for one task and return its result. */
  readonly await: (id: string) => Effect.Effect<string, TaskNotFound | TaskFailed>
  /** Every task started in this run, in start order. */
  readonly list: Effect.Effect<ReadonlyArray<TaskInfo>>
}

export class Tasks extends Context.Service<Tasks, TasksService>()("roop/Tasks") {}

interface Entry {
  readonly name: string
  readonly fiber: Fiber.Fiber<string, unknown>
}

/** The runtime provides one of these per run, bound to the run's scope. */
export const make = Effect.fn("Tasks.make")(function* (scope: Scope.Scope) {
  const entries = yield* Ref.make(new Map<string, Entry>())
  const sequence = yield* Ref.make(0)

  const lookup = (id: string) =>
    Ref.get(entries).pipe(
      Effect.flatMap((map) => {
        const entry = map.get(id)
        return entry === undefined ? Effect.fail(new TaskNotFound({ id })) : Effect.succeed(entry)
      }),
    )

  const status = (entry: Entry): TaskStatus => {
    const exit = entry.fiber.pollUnsafe()
    return exit === undefined ? "running" : Exit.isSuccess(exit) ? "completed" : "failed"
  }

  return Tasks.of({
    spawn: (name, work) =>
      Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(sequence, (n) => n + 1)
        const id = `${name}:${n}`
        const fiber = yield* Effect.forkIn(work, scope)
        yield* Ref.update(entries, (map) => new Map(map).set(id, { name, fiber }))
        return id
      }),
    await: (id) =>
      Effect.gen(function* () {
        const entry = yield* lookup(id)
        const exit = yield* Effect.exit(Fiber.join(entry.fiber))
        return yield* Exit.match(exit, {
          onSuccess: (result) => Effect.succeed(result),
          onFailure: (cause) => new TaskFailed({ id, detail: Cause.pretty(cause).trim() }),
        })
      }),
    list: Ref.get(entries).pipe(
      Effect.map((map) =>
        [...map.entries()].map(([id, entry]) => ({ id, name: entry.name, status: status(entry) })),
      ),
    ),
  })
})
