import { Effect, Schema } from "effect"

export class InvalidPort extends Schema.TaggedErrorClass<InvalidPort>()("InvalidPort", {
  value: Schema.String,
  message: Schema.String,
}) {}

export const parsePort = (value: string): Effect.Effect<number, InvalidPort> => {
  // CLI ports are decimal integers; Number() would also accept hexadecimal,
  // exponent, sign, and surrounding-whitespace forms unexpectedly.
  const port = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? Effect.succeed(port)
    : Effect.fail(
        new InvalidPort({
          value,
          message: `Invalid port "${value}": expected an integer from 1 to 65535`,
        }),
      )
}
