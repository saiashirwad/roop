import { Effect } from "effect"

import { RoomClient } from "./RoomClient.ts"

export const Presence = RoomClient.reducer(
  "Presence",
  ({ members }) =>
    (state) =>
      Effect.succeed({ ...state, members }),
)

export const Record = RoomClient.reducer(
  "Record",
  ({ seq }) =>
    (state) =>
      Effect.succeed({
        ...state,
        cursor: Math.max(state.cursor, seq),
        running: true,
      }),
)

/** Human chat is UI-side only; client state is unchanged. */
export const Chat = RoomClient.reducer(
  "Chat",
  () => (state) => Effect.succeed(state),
)
