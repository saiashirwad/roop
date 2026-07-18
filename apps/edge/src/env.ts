/** Worker bindings for roop-edge. */
export interface Env {
  readonly ROOM: DurableObjectNamespace
  /** Model provider keys — at least one required for agent runs. */
  readonly KIMI_API_KEY?: string | undefined
  readonly ZAI_API_KEY?: string | undefined
  readonly Z_AI_API_KEY?: string | undefined
  readonly DEEPSEEK_API_KEY?: string | undefined
}
