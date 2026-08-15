import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"

import { server } from "./Server.ts"

const apiKey = process.env["DEEPSEEK_API_KEY"]
if (apiKey === undefined) {
  console.error("DEEPSEEK_API_KEY is not set")
  process.exit(1)
}
const [arg] = process.argv.slice(2)
const port = arg === undefined ? 8787 : Number(arg)
const root = process.env["HARNESS_ROOT"] ?? process.cwd()
NodeRuntime.runMain(Layer.launch(server({ port, root, apiKey })))
