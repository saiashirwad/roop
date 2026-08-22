/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- authoring framework boundary functions and metadata payloads cross open existential types. */

import { Effect, Schema, Stream } from "effect"
import { Tool, type Toolkit } from "effect/unstable/ai"

import type { AgentContext } from "./AgentContext.ts"
import { AgentEmit, type AgentEvent } from "./AgentEvents.ts"
import { AgentPlan, type AgentPlan as AgentPlanValue } from "./AgentPlan.ts"
import { fromEvents } from "./AgentResult.ts"
import { session as makeSession } from "./AgentSession.ts"
import {
  type Capability,
  type CapabilityElement,
  capability as makeCapability,
} from "./Capability.ts"
import { RunId, SessionId } from "./DomainIds.ts"
import { all as middlewareAll, type Middleware } from "./Middleware.ts"
import {
  type AgentContribution,
  type Module,
  all as moduleAll,
  instructions as moduleInstructions,
  tool as moduleTool,
  when as moduleWhen,
} from "./Module.ts"
import { mergePolicy, type RunPolicy } from "./RunPolicy.ts"
import { AgentRuntime, type AgentRuntimeRequest, runAgent } from "./Runtime.ts"
import { ToolExecutionContext } from "./ToolExecutionContext.ts"

/** An explicit value that the runtime renders before each model request. */
export interface AgentDefinition<out R = never, out E = never> {
  readonly name: string
  readonly render: (context: AgentContext) => Effect.Effect<AgentPlanValue<R, E>, E, R>
  readonly middleware?: Middleware<R, E> | undefined
  readonly policy?: RunPolicy | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
  pipe<A, B>(this: A, ab: (a: A) => B): B
  pipe<A, B, C>(this: A, ab: (a: A) => B, bc: (b: B) => C): C
  pipe<A, B, C, D>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D
  pipe<A, B, C, D, E1>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E1,
  ): E1
}

function pipe(this: any, ...fns: ReadonlyArray<(x: any) => any>) {
  return fns.reduce((acc, fn) => fn(acc), this)
}

export type AgentSource<R, E> =
  | Module<R, E>
  | ((context: AgentContext) => Effect.Effect<AgentPlanValue<R, E>, E, R>)

export interface ToolMetadata {
  readonly name: string
  readonly description?: string | undefined
}

export interface AgentTool<out R = never, out E = never> extends Module<R, E> {
  readonly module: Module<R, E>
  readonly metadata: ToolMetadata
  readonly tool: Tool.Any
}

export interface AgentOptions<R = never, E = never> {
  readonly name: string
  readonly instructions?: string | undefined
  readonly tools?: ReadonlyArray<CapabilityElement<R, E>> | undefined
  readonly capabilities?: ReadonlyArray<CapabilityElement<R, E>> | undefined
  readonly middleware?: Middleware<R, E> | undefined
  readonly policy?: RunPolicy | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

const extractModule = <R, E>(element: CapabilityElement<R, E>): Module<R, E> => {
  if (
    "module" in element &&
    typeof element.module === "object" &&
    element.module !== null &&
    "build" in element.module
  ) {
    return element.module as Module<R, E>
  }
  return element as Module<R, E>
}

export function make<R = never, E = never>(options: AgentOptions<R, E>): AgentDefinition<R, E>
export function make<R = never, E = never>(
  name: string,
  source: AgentSource<R, E>,
): AgentDefinition<R, E>
export function make<R = never, E = never>(
  nameOrOptions: string | AgentOptions<R, E>,
  maybeSource?: AgentSource<R, E>,
): AgentDefinition<R, E> {
  if (typeof nameOrOptions === "object" && nameOrOptions !== null) {
    const opts = nameOrOptions
    const modules: Array<Module<R, E>> = []
    if (opts.instructions !== undefined && opts.instructions.trim() !== "") {
      modules.push(moduleInstructions(opts.instructions) as Module<R, E>)
    }
    if (opts.tools !== undefined) {
      for (const t of opts.tools) {
        modules.push(extractModule(t))
      }
    }
    if (opts.capabilities !== undefined) {
      for (const c of opts.capabilities) {
        modules.push(extractModule(c))
      }
    }
    const combined = moduleAll(...modules) as Module<R, E>
    return {
      name: opts.name,
      render: (context) =>
        combined
          .build(context)
          .pipe(
            Effect.map(({ instructions, tools }) => AgentPlan.make<R, E>({ instructions, tools })),
          ),
      ...(opts.middleware !== undefined ? { middleware: opts.middleware } : {}),
      ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      pipe,
    }
  }

  const name = nameOrOptions
  const source = maybeSource!
  return {
    name,
    render:
      typeof source === "function"
        ? source
        : (context) =>
            source
              .build(context)
              .pipe(
                Effect.map(({ instructions, tools }) =>
                  AgentPlan.make<R, E>({ instructions, tools }),
                ),
              ),
    pipe,
  }
}

export const dynamic = <R = never, E = never>(
  name: string,
  render: (
    context: AgentContext,
  ) => Effect.Effect<
    AgentPlanValue<R, E> | AgentContribution<R, E> | Capability<R, E> | Module<R, E>,
    E,
    R
  >,
): AgentDefinition<R, E> => ({
  name,
  render: (context) =>
    render(context).pipe(
      Effect.flatMap((result): Effect.Effect<AgentPlanValue<R, E>, E, R> => {
        if ("instructions" in result && "tools" in result && !("build" in result)) {
          const res = result as { readonly tools: { readonly finalize?: unknown } }
          if (typeof res.tools.finalize === "object") {
            return Effect.succeed(result as AgentPlanValue<R, E>)
          }
          return Effect.succeed(AgentPlan.make<R, E>(result as any))
        }
        if (
          "module" in result &&
          typeof (result as { module: { build?: unknown } }).module?.build === "function"
        ) {
          return (result as { module: Module<R, E> }).module
            .build(context)
            .pipe(
              Effect.map(({ instructions, tools }: AgentContribution<R, E>) =>
                AgentPlan.make<R, E>({ instructions, tools }),
              ),
            )
        }
        if ("build" in result && typeof (result as { build: unknown }).build === "function") {
          return (result as Module<R, E>)
            .build(context)
            .pipe(
              Effect.map(({ instructions, tools }: AgentContribution<R, E>) =>
                AgentPlan.make<R, E>({ instructions, tools }),
              ),
            )
        }
        return Effect.succeed(result as AgentPlanValue<R, E>)
      }),
    ),
  pipe,
})

export function tool<const T extends Tool.Any, E = never, R = never>(
  definition: T,
  handler: (
    params: Tool.Parameters<T>,
    context: Toolkit.HandlerContext<T>,
  ) => Effect.Effect<Tool.Success<T>, E, R>,
  contributor?: string,
): AgentTool<Exclude<R, ToolExecutionContext> | Tool.HandlerServices<T>, E> {
  const mod = moduleTool(definition, handler, contributor)
  return {
    ...mod,
    module: mod,
    metadata: {
      name: definition.name,
      description: definition.description,
    },
    tool: definition,
  } as AgentTool<Exclude<R, ToolExecutionContext> | Tool.HandlerServices<T>, E>
}

export interface DelegateOptions<P> {
  readonly name: string
  readonly description?: string | undefined
  readonly parameters?: Schema.Schema<P> | undefined
  readonly prompt: (params: P) => string
  readonly failureMode?: "return" | undefined
  readonly preliminary?: ((params: P) => string) | undefined
}

export function delegate<P, ChildR = never, ChildE = never>(
  child: AgentDefinition<ChildR, ChildE>,
  options: DelegateOptions<P>,
): AgentTool<ChildR | AgentRuntime, ChildE> {
  const paramsSchema =
    options.parameters ?? (Schema.Struct({ prompt: Schema.String }) as unknown as Schema.Schema<P>)
  const toolDef = Tool.make(options.name, {
    description: options.description ?? `Delegate task to ${child.name}`,
    parameters: paramsSchema,
    success: Schema.String,
    failure: Schema.String,
    failureMode: options.failureMode ?? "return",
  })

  return tool(
    toolDef,
    (params: P, toolContext: Toolkit.HandlerContext<typeof toolDef>) =>
      Effect.gen(function* () {
        if (options.preliminary !== undefined) {
          yield* toolContext.preliminary(options.preliminary(params))
        }
        const runtime = yield* AgentRuntime
        const toolExecContext = yield* Effect.serviceOption(ToolExecutionContext)
        const emitService = yield* Effect.serviceOption(AgentEmit)

        const childSessionId =
          toolExecContext._tag === "Some"
            ? `${toolExecContext.value.sessionId}/agents/${child.name}/${toolExecContext.value.callId}`
            : `child/${child.name}`

        const promptText = options.prompt(params)
        const childStream = runtime.run(child, {
          sessionId: childSessionId,
          prompt: promptText,
        })

        const textParts: string[] = []
        yield* childStream.pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (event._tag === "TextDelta") {
                textParts.push(event.delta)
              }
              if (emitService._tag === "Some") {
                const callId =
                  toolExecContext._tag === "Some" ? toolExecContext.value.callId : undefined
                yield* emitService.value.emit({
                  _tag: "Subagent",
                  name: child.name,
                  ...(callId !== undefined ? { toolCallId: callId } : {}),
                  event,
                })
              }
            }),
          ),
          Stream.runDrain,
        )

        return textParts.join("")
      }).pipe(Effect.mapError((err) => (err instanceof Error ? err.message : String(err)))),
    child.name,
  ) as unknown as AgentTool<ChildR | AgentRuntime, ChildE>
}

export const asTool = delegate

export const capability = makeCapability

export const when = moduleWhen

export function withMiddleware<R1, E1>(
  middleware: Middleware<R1, E1>,
): <R, E>(agent: AgentDefinition<R, E>) => AgentDefinition<R | R1, E | E1>
export function withMiddleware<R, E, R1, E1>(
  agent: AgentDefinition<R, E>,
  middleware: Middleware<R1, E1>,
): AgentDefinition<R | R1, E | E1>
export function withMiddleware<R, E, R1, E1>(
  agentOrMiddleware: AgentDefinition<R, E> | Middleware<R1, E1>,
  maybeMiddleware?: Middleware<R1, E1>,
): any {
  if (maybeMiddleware !== undefined) {
    const agent = agentOrMiddleware as AgentDefinition<R, E>
    const mw = maybeMiddleware
    return {
      ...agent,
      middleware: agent.middleware
        ? (middlewareAll(agent.middleware as Middleware, mw as Middleware) as Middleware<
            R | R1,
            E | E1
          >)
        : mw,
    }
  }
  const mw = agentOrMiddleware as Middleware<R1, E1>
  return (agent: AgentDefinition<R, E>) => ({
    ...agent,
    middleware: agent.middleware
      ? (middlewareAll(agent.middleware as Middleware, mw as Middleware) as Middleware<
          R | R1,
          E | E1
        >)
      : mw,
  })
}

export function withPolicy(
  policy: RunPolicy,
): <R, E>(agent: AgentDefinition<R, E>) => AgentDefinition<R, E>
export function withPolicy<R, E>(
  agent: AgentDefinition<R, E>,
  policy: RunPolicy,
): AgentDefinition<R, E>
export function withPolicy<R, E>(
  agentOrPolicy: AgentDefinition<R, E> | RunPolicy,
  maybePolicy?: RunPolicy,
): any {
  if (maybePolicy !== undefined) {
    const agent = agentOrPolicy as AgentDefinition<R, E>
    return {
      ...agent,
      policy: mergePolicy(agent.policy, maybePolicy),
    }
  }
  const policy = agentOrPolicy as RunPolicy
  return (agent: AgentDefinition<R, E>) => ({
    ...agent,
    policy: mergePolicy(agent.policy, policy),
  })
}

export function annotate(
  metadata: Readonly<Record<string, unknown>>,
): <R, E>(agent: AgentDefinition<R, E>) => AgentDefinition<R, E>
export function annotate<R, E>(
  agent: AgentDefinition<R, E>,
  metadata: Readonly<Record<string, unknown>>,
): AgentDefinition<R, E>
export function annotate<R, E>(
  agentOrMetadata: AgentDefinition<R, E> | Readonly<Record<string, unknown>>,
  maybeMetadata?: Readonly<Record<string, unknown>>,
): any {
  if (maybeMetadata !== undefined) {
    const agent = agentOrMetadata as AgentDefinition<R, E>
    return {
      ...agent,
      metadata: { ...agent.metadata, ...maybeMetadata },
    }
  }
  const metadata = agentOrMetadata as Readonly<Record<string, unknown>>
  return (agent: AgentDefinition<R, E>) => ({
    ...agent,
    metadata: { ...agent.metadata, ...metadata },
  })
}

export const events = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
) => runAgent(agent, request)

export const streamText = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
) =>
  events(agent, request).pipe(
    Stream.filter(
      (event): event is Extract<AgentEvent, { readonly _tag: "TextDelta" }> =>
        event._tag === "TextDelta",
    ),
    Stream.map((event) => event.delta),
  )

export const run = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
) =>
  Effect.gen(function* () {
    const sid = SessionId.is(request.sessionId)
      ? request.sessionId
      : SessionId.make(request.sessionId)
    const allEvents: Array<AgentEvent> = []
    yield* events(agent, request).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          allEvents.push(event)
        }),
      ),
    )
    const runId = RunId.make(request.runId ?? `${sid}:0`)
    return fromEvents(sid, runId, allEvents)
  })

export const session = makeSession

export const Agent = {
  make,
  dynamic,
  tool,
  delegate,
  asTool,
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
