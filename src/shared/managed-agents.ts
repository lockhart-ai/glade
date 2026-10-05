/** Glade dispatches these children through separate SDK sessions, on either billing source. */
export const AGENTS_SERVER = 'glade-agents'
export const DISPATCH_AGENT_TOOL = 'mcp__glade-agents__dispatch'
export const AGENT_MODELS_TOOL = 'mcp__glade-agents__list_models'

export interface DispatchAgentInput {
  readonly model: string
  readonly prompt: string
  readonly description: string
  readonly run_in_background?: boolean | undefined
  /** Resume a child returned by an earlier dispatch, retaining its model and history. */
  readonly resume?: string | undefined
}
