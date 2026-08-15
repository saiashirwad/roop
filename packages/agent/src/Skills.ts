import { Schema } from "effect"

export const Skill = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
})

export type Skill = typeof Skill.Type
