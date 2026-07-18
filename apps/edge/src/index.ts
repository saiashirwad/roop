import type { Env } from "./env.ts"
import { Room } from "./room.ts"

export { Room }

const ROOM_PATH = /^\/room\/([^/]+)\/ws$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/health") {
      return Response.json({ ok: true })
    }

    const match = ROOM_PATH.exec(url.pathname)
    if (match === null) {
      return new Response(
        "roop-edge\n\nConnect: GET /room/<name>/ws?name=<you> (WebSocket upgrade)\n",
        { status: 404 },
      )
    }

    const roomName = decodeURIComponent(match[1]!).slice(0, 80)
    if (roomName.length === 0) {
      return new Response("Room name must not be empty", { status: 400 })
    }

    const id = env.ROOM.idFromName(roomName)
    return env.ROOM.get(id).fetch(request)
  },
} satisfies ExportedHandler<Env>
