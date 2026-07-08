import { SessionHub, SessionHubLive } from "@roop/core/SessionHub.ts"
import { SessionLog, SessionLogLive } from "@roop/core/SessionLog.ts"
import { SessionSearch, SessionSearchFromStoreLive } from "@roop/core/SessionSearch.ts"
import { SessionStore, SessionStoreJsonlLive } from "@roop/core/SessionStore.ts"
import { FileSystem, Layer, Path } from "effect"

import { SessionStoreSqliteLive } from "./SessionStoreSqlite.ts"

export type SessionStack = {
  readonly store: Layer.Layer<SessionStore>
  readonly hub: Layer.Layer<SessionHub>
  readonly log: Layer.Layer<SessionLog>
  readonly search: Layer.Layer<SessionSearch>
}

/** Hub + SessionLog facade + search on top of any store layer. */
const stackFromStore = (store: Layer.Layer<SessionStore>): SessionStack => {
  const hub = SessionHubLive
  const log = SessionLogLive.pipe(Layer.provide(store), Layer.provide(hub))
  const search = SessionSearchFromStoreLive.pipe(Layer.provide(store))
  return { store, hub, log, search }
}

/**
 * JSONL store stack. Provide FileSystem and Path as separate sequential
 * `Layer.provide`s — `mergeAll(fs, path)` does not eliminate both R tags.
 */
export const makeJsonlSessionStack = (
  directory: string,
  fileSystem: Layer.Layer<FileSystem.FileSystem>,
  path: Layer.Layer<Path.Path>,
): SessionStack =>
  stackFromStore(
    SessionStoreJsonlLive(directory).pipe(Layer.provide(fileSystem), Layer.provide(path)),
  )

export const makeSqliteSessionStack = (dbPath: string): SessionStack =>
  stackFromStore(SessionStoreSqliteLive(dbPath))
