import { Crypto, Effect, Schema } from "effect"

/** A branded, namespaced string id with a validator and a portable generator. */
const domainId = <const Name extends string>(label: Name, brand: `roop/${Name}`) => {
  const schema = Schema.String.pipe(Schema.brand(brand))
  return Object.assign(schema, {
    is: Schema.is(schema),
    generate: Effect.fn(`DomainIds.${label}.generate`)(function* () {
      const crypto = yield* Crypto.Crypto
      return schema.make(yield* Effect.orDie(crypto.randomUUIDv4))
    }),
  })
}

export const SessionId = domainId("SessionId", "roop/SessionId")
export type SessionId = typeof SessionId.Type

export const RunId = domainId("RunId", "roop/RunId")
export type RunId = typeof RunId.Type
