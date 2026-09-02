/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- the authoring layer closes the tool handler existential once, in `tool`; metadata is an open annotation bag by design. */

import { Effect, Function, Option, Pipeable, Schema, Stream } from "effect"
import { Tool, type Toolkit } from "effect/unstable/ai"

import type { AgentContext } from "./AgentContext.ts"
import { AgentEmit, type AgentEvent } from "./AgentEvents.ts"
import type { AgentPlan } from "./AgentPlan.ts"
import { session as makeSession, type SessionRunOptions } from "./AgentSession.ts"
import {
  type Capability,
  type ElementErrors,
  type ElementRequirements,
  type Elements,
  capability as makeCapability,
} from "./Capability.ts"
import { all as middlewareAll, type Middleware } from "./Middleware.ts"
import { all as moduleAll, type Module, tool as moduleTool, when as moduleWhen } from "./Module.ts"
import { mergePolicy, type RunPolicy } from "./RunPolicy.ts"
import { AgentRuntime, type AgentRuntimeRequest } from "./Runtime.ts"
import { Tasks } from "./Tasks.ts"
import { ToolExecutionContext } from "./ToolExecutionContext.ts"

/** An explicit value that the runtime renders before each model request. */
export interface AgentDefinition<out R = never, out E = never> extends Pipeable.Pipeable {
  readonly name: string
  readonly render: (context: AgentContext) => Effect.Effect<AgentPlan<R, E>, E, R>
  readonly middleware?: Middleware<R, E> | undefined
  readonly policy?: RunPolicy | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

const definition = <R, E>(fields: Omit<AgentDefinition<R, E>, "pipe">): AgentDefinition<R, E> => ({
  ...fields,
  pipe() {
    return Pipeable.pipeArguments(this, arguments)
  },
})

export type AgentSource<R, E> =
  | Module<R, E>
  | ((context: AgentContext) => Effect.Effect<AgentPlan<R, E>, E, R>)

export interface ToolMetadata {
  readonly name: string
  readonly description?: string | undefined
}

export interface AgentTool<out R = never, out E = never> extends Module<R, E> {
  readonly module: Module<R, E>
  readonly metadata: ToolMetadata
  readonly tool: Tool.Any
}

export interface AgentOptions<
  Tools extends Elements = [],
  Caps extends Elements = [],
  MwR = never,
  MwE = never,
> {
  readonly name: string
  readonly instructions?: string | undefined
  readonly tools?: Tools | undefined
  readonly capabilities?: Caps | undefined
  readonly middleware?: Middleware<MwR, MwE> | undefined
  readonly policy?: RunPolicy | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

export function make<
  const Tools extends Elements = [],
  const Caps extends Elements = [],
  MwR = never,
  MwE = never,
>(
  options: AgentOptions<Tools, Caps, MwR, MwE>,
): AgentDefinition<
  ElementRequirements<Tools[number] | Caps[number]> | MwR,
  ElementErrors<Tools[number] | Caps[number]> | MwE
>
export function make<R = never, E = never>(
  name: string,
  source: AgentSource<R, E>,
): AgentDefinition<R, E>
export function make(
  nameOrOptions: string | AgentOptions<Elements, Elements, any, any>,
  source?: AgentSource<any, any>,
): AgentDefinition<any, any> {
  if (typeof nameOrOptions === "string") {
    const render = source!
    return definition({
      name: nameOrOptions,
      render: typeof render === "function" ? render : render.build,
    })
  }
  const { name, middleware, policy, metadata } = nameOrOptions
  return definition({
    name,
    render: makeCapability(nameOrOptions).build,
    middleware,
    policy,
    metadata,
  })
}

export function tool<const T extends Tool.Any, E = never, R = never>(
  definition: T,
  handler: (
    params: Tool.Parameters<T>,
    context: Toolkit.HandlerContext<T>,
  ) => Effect.Effect<Tool.Success<T>, E, R>,
  contributor?: string,
): AgentTool<Exclude<R, RuntimeProvided> | Tool.HandlerServices<T>, E> {
  const mod = moduleTool(definition, handler, contributor)
  return {
    ...mod,
    module: mod,
    metadata: { name: definition.name, description: definition.description },
    tool: definition,
    /* SAFETY: the runtime provides ToolExecutionContext, AgentEmit, and Tasks to every handler. */
  } as AgentTool<Exclude<R, RuntimeProvided> | Tool.HandlerServices<T>, E>
}

/** Services the runtime provides to every tool handler. */
type RuntimeProvided = ToolExecutionContext | AgentEmit | Tasks

export interface DelegateOptions<P> {
  readonly name: string
  readonly description?: string | undefined
  readonly parameters?: Schema.Schema<P> | undefined
  readonly prompt: (params: P) => string
  readonly failureMode?: "return" | undefined
  readonly preliminary?: ((params: P) => string) | undefined
}

const childTool = <P>(child: AgentDefinition<any, any>, options: DelegateOptions<P>) =>
  Tool.make(options.name, {
    description: options.description ?? `Delegate task to ${child.name}`,
    parameters:
      options.parameters ??
      (Schema.Struct({ prompt: Schema.String }) as unknown as Schema.Schema<P>),
    success: Schema.String,
    failure: Schema.String,
    failureMode: options.failureMode ?? "return",
  })

/**
 * Run a child agent from inside a tool call. The child's session id is derived
 * from the parent session and tool call, its events are forwarded to the parent
 * wrapped in `Subagent`, and its text is the result.
 */
const runChild = <ChildR, ChildE>(child: AgentDefinition<ChildR, ChildE>, prompt: string) =>
  Effect.gen(function* () {
    const runtime = yield* AgentRuntime
    const parent = yield* Effect.serviceOption(ToolExecutionContext)
    const emitter = yield* Effect.serviceOption(AgentEmit)

    const sessionId = Option.match(parent, {
      onNone: () => `child/${child.name}`,
      onSome: (context) => `${context.sessionId}/agents/${child.name}/${context.callId}`,
    })
    const wrap = (event: AgentEvent): AgentEvent =>
      Option.match(parent, {
        onNone: () => ({ _tag: "Subagent", name: child.name, event }),
        onSome: (context) => ({
          _tag: "Subagent",
          name: child.name,
          toolCallId: context.callId,
          event,
        }),
      })
    const forward = (event: AgentEvent) =>
      Option.match(emitter, {
        onNone: () => Effect.void,
        onSome: ({ emit }) => emit(wrap(event)),
      })

    return yield* runtime.run(child, { sessionId, prompt }).pipe(
      Stream.tap(forward),
      Stream.filter(
        (event): event is Extract<AgentEvent, { readonly _tag: "TextDelta" }> =>
          event._tag === "TextDelta",
      ),
      Stream.runFold(
        () => "",
        (text, event) => text + event.delta,
      ),
    )
  }).pipe(Effect.mapError((error) => (error instanceof Error ? error.message : String(error))))

/**
 * Turn a child agent into a tool. The call blocks until the child finishes and
 * returns the child's text.
 */
export function delegate<P, ChildR = never, ChildE = never>(
  child: AgentDefinition<ChildR, ChildE>,
  options: DelegateOptions<P>,
): AgentTool<ChildR | AgentRuntime, ChildE> {
  const definition = childTool(child, options)
  return tool(
    definition,
    (params: P, toolContext: Toolkit.HandlerContext<typeof definition>) =>
      Effect.gen(function* () {
        if (options.preliminary !== undefined) {
          yield* toolContext.preliminary(options.preliminary(params))
        }
        return yield* runChild(child, options.prompt(params))
      }),
    child.name,
    /* SAFETY: the model and journal the child needs are the run's own; only the
     * child's declared services and the runtime remain in R. */
  ) as unknown as AgentTool<ChildR | AgentRuntime, ChildE>
}

export const asTool = delegate

export interface SpawnOptions<P> extends DelegateOptions<P> {
  /** Name of the collecting tool. Defaults to `await_<name>`. */
  readonly awaitName?: string | undefined
}

/**
 * Turn a child agent into a pair of tools: one that starts the child in the
 * background and returns a task id at once, and one that waits for a task (or
 * every task started so far) and returns its text. The model can start several
 * children in one step and collect them later. Tasks live in the run's scope,
 * so a run that ends interrupts the children it never collected.
 */
export function spawn<P, ChildR = never, ChildE = never>(
  child: AgentDefinition<ChildR, ChildE>,
  options: SpawnOptions<P>,
): Capability<ChildR | AgentRuntime, ChildE> {
  const awaitName = options.awaitName ?? `await_${options.name}`
  const start = childTool(child, {
    ...options,
    description:
      options.description ??
      `Start ${child.name} on a task in the background. Returns a task id; call ${awaitName} to collect the result.`,
  })
  const collect = Tool.make(awaitName, {
    description: `Wait for a task started by ${options.name}. Omit taskId to wait for every task started so far.`,
    parameters: Schema.Struct({ taskId: Schema.optionalKey(Schema.String) }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  })

  const startTool = tool(
    start,
    (params: P) =>
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const id = yield* tasks.spawn(child.name, runChild(child, options.prompt(params)))
        return `Started task ${id}. Call ${awaitName} to collect its result.`
      }),
    child.name,
  )
  const awaitTool = tool(
    collect,
    ({ taskId }) =>
      Effect.gen(function* () {
        const tasks = yield* Tasks
        if (taskId !== undefined) {
          return yield* tasks.await(taskId)
        }
        const started = yield* tasks.list
        const results = yield* Effect.forEach(
          started.filter((task) => task.name === child.name),
          (task) => tasks.await(task.id).pipe(Effect.map((text) => `## ${task.id}\n${text}`)),
        )
        return results.join("\n\n")
      }).pipe(Effect.mapError((error) => error.message)),
    child.name,
  )

  /* SAFETY: as in delegate, the child's model and journal are the run's own. */
  return makeCapability(options.name, moduleAll(startTool, awaitTool)) as unknown as Capability<
    ChildR | AgentRuntime,
    ChildE
  >
}

export const capability = makeCapability

export const when = moduleWhen

export const withMiddleware: {
  <R1, E1>(
    middleware: Middleware<R1, E1>,
  ): <R, E>(agent: AgentDefinition<R, E>) => AgentDefinition<R | R1, E | E1>
  <R, E, R1, E1>(
    agent: AgentDefinition<R, E>,
    middleware: Middleware<R1, E1>,
  ): AgentDefinition<R | R1, E | E1>
} = Function.dual(
  2,
  <R, E, R1, E1>(
    agent: AgentDefinition<R, E>,
    middleware: Middleware<R1, E1>,
  ): AgentDefinition<R | R1, E | E1> => ({
    ...agent,
    middleware:
      agent.middleware === undefined
        ? middleware
        : middlewareAll<R | R1, E | E1>(agent.middleware, middleware),
  }),
)

export const withPolicy: {
  (policy: RunPolicy): <R, E>(agent: AgentDefinition<R, E>) => AgentDefinition<R, E>
  <R, E>(agent: AgentDefinition<R, E>, policy: RunPolicy): AgentDefinition<R, E>
} = Function.dual(
  2,
  <R, E>(agent: AgentDefinition<R, E>, policy: RunPolicy): AgentDefinition<R, E> => ({
    ...agent,
    policy: mergePolicy(agent.policy, policy),
  }),
)

export const annotate: {
  (
    metadata: Readonly<Record<string, unknown>>,
  ): <R, E>(agent: AgentDefinition<R, E>) => AgentDefinition<R, E>
  <R, E>(
    agent: AgentDefinition<R, E>,
    metadata: Readonly<Record<string, unknown>>,
  ): AgentDefinition<R, E>
} = Function.dual(
  2,
  <R, E>(
    agent: AgentDefinition<R, E>,
    metadata: Readonly<Record<string, unknown>>,
  ): AgentDefinition<R, E> => ({
    ...agent,
    metadata: { ...agent.metadata, ...metadata },
  }),
)

const toSessionOptions = <RM, EM>(
  request: AgentRuntimeRequest<RM, EM>,
): SessionRunOptions<RM, EM> => ({
  runId: request.runId,
  policy: request.policy,
  middleware: request.middleware,
  meta: request.meta,
})

export const events = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
) => makeSession(agent, request.sessionId).events(request.prompt, toSessionOptions(request))

export const streamText = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
) => makeSession(agent, request.sessionId).streamText(request.prompt, toSessionOptions(request))

export const run = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
) => makeSession(agent, request.sessionId).run(request.prompt, toSessionOptions(request))

export const session = makeSession

export const Agent = {
  make,
  tool,
  delegate,
  asTool,
  spawn,
  capability,
  when,
  withMiddleware,
  withPolicy,
  annotate,
  events,
  streamText,
  run,
  session,
}
