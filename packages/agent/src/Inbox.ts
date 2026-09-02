import { type Cause, Context, Effect, type Option, Queue, Schema } from "effect"

import { RunId } from "./DomainIds.ts"

/*
 * The per-run inbox: messages delivered to a run while it executes. The
 * interpreter takes every pending message at a step boundary and commits it
 * to the journal as a `user/message`, so the journal stays the full source of
 * truth and the next model request sees the message after that step's tool
 * results. The inbox itself is never durable.
 */

/** A user message steering the run: "also update the tests", "stop, do it differently". */
export const UserMessage = Schema.TaggedStruct("user/message", {
  content: Schema.String,
})
export type UserMessage = typeof UserMessage.Type

/** Everything a caller can deliver to a running run. */
export const InboxMessage = Schema.Union([UserMessage])
export type InboxMessage = typeof InboxMessage.Type

/** The run ended before the message could be delivered. Start a new run instead. */
export class RunEnded extends Schema.TaggedErrorClass<RunEnded>()("RunEnded", {
  runId: RunId,
}) {
  override get message(): string {
    return `Run '${this.runId}' has ended and no longer accepts messages`
  }
}

/**
 * What a run exposes about its inbox. Tool handlers receive it as a service:
 * a long-running handler may `poll` for a message that changes what it should
 * do. A message a handler takes is the handler's to act on; the interpreter
 * only commits the messages it takes itself, so the journal records nothing
 * for it.
 */
export interface InboxService {
  readonly runId: RunId
  /** Deliver a message. Fails once the run has ended. */
  readonly send: (message: InboxMessage) => Effect.Effect<void, RunEnded>
  /** Take the oldest pending message without waiting. */
  readonly poll: Effect.Effect<Option.Option<InboxMessage>>
}

export class Inbox extends Context.Service<Inbox, InboxService>()("roop/Inbox") {}

/** The runtime's view of an inbox: what the interpreter and the run lifecycle need. */
export interface RunInbox extends InboxService {
  /** Take every pending message without waiting; empty when there is none. */
  readonly takeAll: Effect.Effect<ReadonlyArray<InboxMessage>>
  /**
   * Take every pending message; when there is none, close the inbox in the
   * same atomic step so that no message can arrive between the run deciding to
   * finish and refusing further sends.
   */
  readonly takeAllOrClose: Effect.Effect<ReadonlyArray<InboxMessage>>
  /**
   * Close the inbox and return what it still held. Later sends fail with
   * `RunEnded`; the caller decides what happens to the returned messages.
   */
  readonly close: Effect.Effect<ReadonlyArray<InboxMessage>>
}

/** One inbox per run, created by the runtime. */
export const make = Effect.fn("Inbox.make")(function* (runId: RunId) {
  const queue = yield* Queue.unbounded<InboxMessage, Cause.Done>()

  const takePending = (): Array<InboxMessage> => {
    const taken: Array<InboxMessage> = []
    let next = Queue.takeUnsafe(queue)
    while (next !== undefined && next._tag === "Success") {
      taken.push(next.value)
      next = Queue.takeUnsafe(queue)
    }
    return taken
  }

  const inbox: RunInbox = {
    runId,
    send: (message) =>
      Queue.offer(queue, message).pipe(
        Effect.flatMap((accepted) => (accepted ? Effect.void : new RunEnded({ runId }))),
      ),
    poll: Queue.poll(queue),
    takeAll: Effect.sync(takePending),
    takeAllOrClose: Effect.sync(() => {
      const taken = takePending()
      if (taken.length === 0) Queue.endUnsafe(queue)
      return taken
    }),
    close: Effect.sync(() => {
      const taken = takePending()
      Queue.endUnsafe(queue)
      return taken
    }),
  }
  return inbox
})
