export type Chunk = {
  readonly old: ReadonlyArray<string>
  readonly next: ReadonlyArray<string>
  readonly ctx?: string | undefined
  readonly eof?: boolean | undefined
}

export type FilePatch =
  | {
      readonly type: "add"
      readonly path: string
      readonly content: string
    }
  | {
      readonly type: "delete"
      readonly path: string
    }
  | {
      readonly type: "update"
      readonly path: string
      readonly chunks: ReadonlyArray<Chunk>
      readonly movePath?: string | undefined
    }

export type StagedOperation =
  | {
      readonly type: "add"
      readonly relPath: string
      readonly fullPath: string
      readonly content: string
    }
  | {
      readonly type: "update"
      readonly relPath: string
      readonly fullPath: string
      readonly content: string
    }
  | {
      readonly type: "move"
      readonly fromRelPath: string
      readonly fromFullPath: string
      readonly toRelPath: string
      readonly toFullPath: string
      readonly content: string
    }
  | {
      readonly type: "delete"
      readonly relPath: string
      readonly fullPath: string
    }

export type ApplyPatchResult = {
  readonly summary: string
  readonly files: ReadonlyArray<string>
}
