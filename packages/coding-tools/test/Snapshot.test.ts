import { execFileSync } from "node:child_process"

import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentHooks,
  layerNoop,
  type RunContext,
  type ToolCallInfo,
} from "@roop/agent/AgentHooks.ts"
import { Effect, FileSystem, Layer, Stream } from "effect"

import { ExecutionWorld } from "../src/ExecutionWorld.ts"
import { Snapshot, SnapshotHooks } from "../src/Snapshot.ts"

describe("Snapshot", () => {
  it.effect("Snapshot.memory: tracks state, restores, and reverts in-memory files", () =>
    Effect.gen(function* () {
      const world = yield* ExecutionWorld
      const snapshot = yield* Snapshot

      // Step 1: Initial workspace state
      yield* world.filesystem.writeFileString("/workspace/index.ts", "const x = 1")
      yield* world.filesystem.writeFileString("/workspace/config.json", '{"name":"roop"}')
      const snap1 = yield* snapshot.track({ label: "initial" })

      // Step 2: Mutate files (simulating messy model edits)
      yield* world.filesystem.writeFileString(
        "/workspace/index.ts",
        "const x = 999; BAD SYNTAX ERROR",
      )
      yield* world.filesystem.writeFileString("/workspace/new_junk.txt", "garbage")
      const snap2 = yield* snapshot.track({ label: "broken-state" })
      assert.notStrictEqual(snap2, snap1)
      assert.match(yield* snapshot.diff(snap1, snap2), /index\.ts/)

      // Step 3: Revert to snap1
      const report = yield* snapshot.revert(snap1)
      assert.strictEqual(report.revertedTo, snap1)
      assert.ok(report.previousTreeHash !== undefined)

      // Step 4: Verify workspace files are restored
      const restoredIndex = yield* world.filesystem.readFileString("/workspace/index.ts")
      assert.strictEqual(restoredIndex, "const x = 1")

      // Step 5: Verify history
      const history = yield* snapshot.history
      assert.strictEqual(history.length, 3)
    }).pipe(
      Effect.provide(
        Snapshot.memory().pipe(
          Layer.provideMerge(ExecutionWorld.memory({ root: "/workspace" })),
          Layer.provideMerge(NodePath.layer),
        ),
      ),
    ),
  )

  it.effect("SnapshotHooks: takes pre-tool shadow snapshots for mutating tools", () =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot
      const hooks = yield* AgentHooks

      const dummyCtx: RunContext = { sessionId: "s1", turn: 1, step: 1 }
      const readCall: ToolCallInfo = { name: "readFile", params: { path: "a.ts" } }
      const writeCall: ToolCallInfo = {
        name: "writeFile",
        params: { path: "a.ts", content: "data" },
      }

      // Non-mutating tool (readFile) should not trigger a snapshot
      yield* hooks.beforeToolExecute(dummyCtx, readCall)
      let history = yield* snapshot.history
      assert.strictEqual(history.length, 0)

      // Mutating tool (writeFile) should trigger a snapshot
      yield* hooks.beforeToolExecute(dummyCtx, writeCall)
      history = yield* snapshot.history
      assert.strictEqual(history.length, 1)
      assert.strictEqual(history[0]?.toolCallName, "writeFile")
    }).pipe(
      Effect.provide(
        SnapshotHooks().pipe(
          Layer.provideMerge(Snapshot.memory()),
          Layer.provideMerge(ExecutionWorld.memory({ root: "/workspace" })),
          Layer.provideMerge(NodePath.layer),
          Layer.provideMerge(layerNoop),
        ),
      ),
    ),
  )

  it.effect("SnapshotHooks: serializes auto-revert transactions", () =>
    Effect.gen(function* () {
      const world = yield* ExecutionWorld
      const hooks = yield* AgentHooks
      const call: ToolCallInfo = {
        name: "writeFile",
        params: { path: "a.ts", content: "ignored" },
      }

      yield* world.filesystem.writeFileString("/workspace/a.ts", "initial")

      const run = (step: number, content: string, isFailure: boolean) =>
        Effect.gen(function* () {
          const context: RunContext = { sessionId: "s1", turn: 1, step }
          const stream = yield* hooks.withToolExecution(
            context,
            call,
            Effect.succeed(
              Stream.fromEffect(
                world.filesystem
                  .writeFileString("/workspace/a.ts", content)
                  .pipe(Effect.as({ isFailure })),
              ),
            ),
          )
          yield* Stream.runDrain(
            stream.pipe(Stream.tap(() => hooks.afterToolExecute(context, call, isFailure))),
          )
        })

      yield* Effect.all([run(1, "failed", true), run(2, "successful", false)], {
        concurrency: "unbounded",
      })

      assert.strictEqual(yield* world.filesystem.readFileString("/workspace/a.ts"), "successful")
    }).pipe(
      Effect.provide(
        SnapshotHooks({ autoRevertOnFailure: true }).pipe(
          Layer.provideMerge(Snapshot.memory()),
          Layer.provideMerge(ExecutionWorld.memory({ root: "/workspace" })),
          Layer.provideMerge(NodePath.layer),
          Layer.provideMerge(layerNoop),
        ),
      ),
    ),
  )

  it.effect("Snapshot.layer restores new files without staging its index or .roop", () => {
    const platform = Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      NodeChildProcessSpawner.layer.pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(NodePath.layer),
      ),
    )
    return Effect.gen(function* () {
      const filesystem = yield* FileSystem.FileSystem
      const root = yield* filesystem.makeTempDirectoryScoped({ prefix: "roop-snapshot-" })
      yield* Effect.sync(() => {
        execFileSync("git", ["init", "-q"], { cwd: root })
      })

      yield* Effect.gen(function* () {
        const world = yield* ExecutionWorld
        const snapshot = yield* Snapshot
        yield* world.filesystem.writeFileString(`${root}/tracked.txt`, "before")
        const initial = yield* snapshot.track({ label: "initial" })

        yield* world.filesystem.writeFileString(`${root}/tracked.txt`, "after")
        yield* world.filesystem.writeFileString(`${root}/new.txt`, "new")
        const report = yield* snapshot.revert(initial)

        assert.strictEqual(report.revertedTo, initial)
        assert.strictEqual(yield* world.filesystem.readFileString(`${root}/tracked.txt`), "before")
        assert.strictEqual(
          (yield* world.filesystem.readFileString(`${root}/new.txt`).pipe(Effect.option))._tag,
          "None",
        )
        const snapshotFiles = execFileSync(
          "git",
          ["ls-tree", "-r", "--name-only", String(initial)],
          { cwd: root, encoding: "utf8" },
        )
        assert.notMatch(snapshotFiles, /\.roop/)
        // A regular staging area stays empty: only the shadow GIT_INDEX_FILE moved.
        execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root })
      }).pipe(Effect.provide(Snapshot.layer().pipe(Layer.provideMerge(ExecutionWorld.local(root)))))
    }).pipe(Effect.provide(platform))
  })
})
