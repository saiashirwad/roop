import { Plugin } from "@roop/agent/Plugin.ts"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

const Todo = Schema.Struct({
  text: Schema.String,
  state: Schema.Literals(["pending", "active", "done"]),
})

type Todo = typeof Todo.Type

export const Todos = (): Plugin => {
  const toolkit = Toolkit.make(
    Tool.make("writeTodos", {
      description:
        "Replace the todo list with the given items. Send the full list every time; use it to plan multi-step work and keep exactly one item active.",
      parameters: Schema.Struct({ todos: Schema.Array(Todo) }),
      success: Schema.Struct({ todos: Schema.Array(Todo) }),
    }),
  )

  return Plugin({
    name: "todos",
    toolkit,
    handlers: toolkit.toLayer({
      writeTodos: ({ todos }) => Effect.succeed({ todos }),
    }),
    systemPrompt:
      "For any task with more than one step, first write a todo list with the writeTodos tool, then keep it current as you work: mark the item you are working on active and finished items done.",
  })
}
