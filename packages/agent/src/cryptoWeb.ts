import { Crypto, Effect, Layer } from "effect"

/**
 * Portably-constructed `Crypto` service backed by the web-standard
 * `globalThis.crypto` (available in Node >= 19, Workers, and browsers).
 * Platform packages may substitute their own layer (e.g. NodeCrypto.layer).
 */
export const cryptoWeb: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(() =>
        globalThis.crypto.subtle
          .digest(algorithm, new Uint8Array(data))
          .then((bytes) => new Uint8Array(bytes)),
      ),
  }),
)
