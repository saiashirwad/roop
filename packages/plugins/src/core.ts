import { definePlugin } from "@roop/core/Plugin.ts"
import {
  ApplyPatch,
  Bash,
  bashHandlers,
  EditFile,
  fileSystemHandlers,
  Grep,
  grepHandlers,
  ListFiles,
  ReadFile,
  WriteFile,
} from "@roop/tools/index.ts"
import { Effect, FileSystem, Path } from "effect"
import { Toolkit } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"

import { SYSTEM_PROMPT } from "./prompt.ts"

const CoreToolkit = Toolkit.make(ReadFile, ListFiles, WriteFile, EditFile, ApplyPatch, Bash, Grep)

export const CorePlugin = definePlugin({
  id: "core",
  description: "Workspace tools (files, bash, grep) and base system prompt",
  toolkit: CoreToolkit,
  handlers: CoreToolkit.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return {
        ...fileSystemHandlers(fs, path),
        ...bashHandlers(spawner),
        ...grepHandlers(fs),
      }
    }),
  ),
  prompt: [
    {
      id: "core/system",
      content: SYSTEM_PROMPT,
    },
  ],
})
