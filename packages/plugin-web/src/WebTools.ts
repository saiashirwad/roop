import { Plugin } from "@roop/agent/Plugin.ts"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { HttpClient } from "effect/unstable/http/HttpClient"

export class WebFailure extends Schema.TaggedErrorClass<WebFailure>()("WebFailure", {
  message: Schema.String,
}) {}

export const WebTools = (options?: {
  readonly maxLength?: number | undefined
}): Plugin<HttpClient> => {
  const maxLength = options?.maxLength ?? 100_000

  const toolkit = Toolkit.make(
    Tool.make("webFetch", {
      description: "Fetch a URL over HTTP GET and return the response body as text",
      parameters: Schema.Struct({ url: Schema.String }),
      success: Schema.Struct({
        status: Schema.Finite,
        body: Schema.String,
        truncated: Schema.Boolean,
      }),
      failure: WebFailure,
      failureMode: "return",
      dependencies: [HttpClient],
    }),
  )

  return Plugin({
    name: "web",
    toolkit,
    handlers: toolkit.toLayer({
      webFetch: ({ url }) =>
        Effect.gen(function* () {
          const client = yield* HttpClient
          const response = yield* client.get(url)
          const body = yield* response.text
          return {
            status: response.status,
            body: body.slice(0, maxLength),
            truncated: body.length > maxLength,
          }
        }).pipe(Effect.catch((error) => new WebFailure({ message: String(error) }))),
    }),
  })
}
