import { Context } from "effect"

export type Skill = {
  readonly id: string
  readonly description: string
}

export class Skills extends Context.Service<Skills, { readonly list: ReadonlyArray<Skill> }>()(
  "roop/Skills",
) {}
