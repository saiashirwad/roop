import { Context, Schema } from "effect"

export const Skill = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
})

export type Skill = typeof Skill.Type

export class Skills extends Context.Service<Skills, { readonly list: ReadonlyArray<Skill> }>()(
  "roop/Skills",
) {}
