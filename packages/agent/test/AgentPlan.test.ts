import { assert, it } from "@effect/vitest"
import { Prompt } from "effect/unstable/ai"

import { AgentPlan, toPrompt } from "../src/AgentPlan.ts"

it("removes blank instructions and preserves the remaining order", () => {
  const plan = AgentPlan({
    instructions: ["first", "   ", { text: "second", contributor: "test" }],
  })

  assert.deepStrictEqual(
    plan.instructions.map((instruction) => instruction.text),
    ["first", "second"],
  )
  assert.match(JSON.stringify(toPrompt(plan, Prompt.make("question"))), /first.*second/)
})
