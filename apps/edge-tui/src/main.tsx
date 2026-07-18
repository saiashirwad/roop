/**
 * OpenTUI room client for apps/edge multiplayer rooms.
 *
 *   pnpm --filter=@roop/edge-tui start <url> <name>
 *   e.g. pnpm start http://localhost:8787/room/demo/ws alice
 */
import { render } from "@opentui/solid"

import { App } from "./App.tsx"

const [urlArg, name] = process.argv.slice(2)
if (urlArg === undefined || name === undefined) {
  console.error(
    "usage: start <url> <name>   e.g. start http://localhost:8787/room/demo/ws alice",
  )
  process.exit(1)
}

await render(() => <App url={urlArg} name={name} />)
