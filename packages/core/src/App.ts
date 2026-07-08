import { Context, Effect } from "effect"

export class App extends Context.Service<
  App,
  {
    readonly run: Effect.Effect<void, unknown>
  }
>()("roop/App") {}

export const run = Effect.gen(function* () {
  const app = yield* App
  yield* app.run
})
