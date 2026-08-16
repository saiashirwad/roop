import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"

import { parsePort } from "./parsePort.ts"
import { server } from "./Server.ts"

const main = Effect.gen(function* () {
  const apiKey = yield* Config.string("DEEPSEEK_API_KEY")
  const root = yield* Config.string("HARNESS_ROOT").pipe(Config.withDefault(process.cwd()))
  const [arg] = process.argv.slice(2)
  const port = arg === undefined ? 8787 : yield* parsePort(arg)
  return yield* Layer.launch(server({ port, root, apiKey }))
})

NodeRuntime.runMain(main)
