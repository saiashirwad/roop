import { Schema } from "effect"

/** LLMs often emit `null` for optional keys; `optionalKey` alone rejects that. */
export const llmOptional = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema))

export const nonEmptyString = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined || value === "") {
    return undefined
  }
  return value
}

export const isTrue = (value: boolean | null | undefined): boolean => value === true
