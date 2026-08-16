import { Context, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export class ExecutionWorld extends Context.Service<
  ExecutionWorld,
  {
    readonly filesystem: FileSystem.FileSystem
    readonly spawner: ChildProcessSpawner["Service"]
  }
>()("roop/ExecutionWorld") {
  /**
   * Layer providing ExecutionWorld from ambient FileSystem and ChildProcessSpawner services.
   */
  static readonly layer: Layer.Layer<
    ExecutionWorld,
    never,
    FileSystem.FileSystem | ChildProcessSpawner
  > = Layer.effect(
    ExecutionWorld,
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner
      return ExecutionWorld.of({ filesystem, spawner })
    }),
  )
}
