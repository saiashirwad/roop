import { Effect, Layer, Schema as S } from "effect"
import { Worker } from "effect-workerd"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

import { RoomNamespace } from "./RoomNamespace.ts"

/** DO class export — keep name `Room` for wrangler binding / sqlite migrations. */
export { RoomRuntime as Room } from "./RoomRuntime.ts"

const MAX_NAME_LENGTH = 40
const MAX_ROOM_LENGTH = 80

const sanitizeName = (raw: string | undefined): string => {
  const name = (raw ?? "").trim().slice(0, MAX_NAME_LENGTH)
  return name.length > 0 ? name : "anon"
}

const sanitizeCursor = (raw: string | undefined): number | undefined => {
  const value = Number(raw ?? "")
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

const SearchParams = S.Struct({
  name: S.optionalKey(S.String),
  after: S.optionalKey(S.String),
})

const PathParams = S.Struct({
  name: S.String,
})

const upgradeRoom = Effect.gen(function* () {
  const path = yield* HttpRouter.schemaPathParams(PathParams)
  const search = yield* HttpServerRequest.schemaSearchParams(SearchParams).pipe(
    Effect.orElseSucceed(() => ({}) as typeof SearchParams.Type),
  )

  const roomName = decodeURIComponent(path.name).slice(0, MAX_ROOM_LENGTH)
  if (roomName.length === 0) {
    return HttpServerResponse.text("Room name must not be empty", { status: 400 })
  }

  const displayName = sanitizeName(search.name)
  const after = sanitizeCursor(search.after)
  const actorId = crypto.randomUUID()

  const attachments =
    after === undefined
      ? { actorId, name: displayName }
      : { actorId, name: displayName, after }

  return yield* RoomNamespace.bind(roomName).upgrade(attachments)
})

const ApiLive = Layer.mergeAll(
  HttpRouter.add("GET", "/health", Effect.succeed(HttpServerResponse.jsonUnsafe({ ok: true }))),
  HttpRouter.add("GET", "/room/:name/ws", upgradeRoom),
  HttpRouter.cors({
    allowedHeaders: ["*"],
    allowedMethods: ["*"],
    allowedOrigins: ["*"],
  }),
  HttpRouter.add(
    "*",
    "/*",
    HttpServerResponse.text(
      "roop-edge\n\nConnect: GET /room/<name>/ws?name=<you> (WebSocket upgrade, liminal protocol)\n",
      { status: 404 },
    ),
  ),
)

export default Worker.make({
  handler: ApiLive.pipe(HttpRouter.toHttpEffect, Effect.flatten),
  prelude: Layer.mergeAll(RoomNamespace.layer),
})
