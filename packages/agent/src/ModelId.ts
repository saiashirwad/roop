import { Schema } from "effect"

export const ModelId = Schema.String.pipe(Schema.brand("roop/ModelId"))

export type ModelId = typeof ModelId.Type

export const is = Schema.is(ModelId)

export const make = (id: string): ModelId => ModelId.make(id)
