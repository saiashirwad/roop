import { Schema } from "effect"

export const PluginId = Schema.String.pipe(Schema.brand("roop/PluginId"))

export type PluginId = typeof PluginId.Type

export const is = Schema.is(PluginId)

export const make = (id: string): PluginId => PluginId.make(id)
