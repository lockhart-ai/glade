/** Glade dispatches these children through separate SDK sessions, on either billing source. */
export const AGENTS_SERVER = 'glade-agents'
export const DISPATCH_AGENT_TOOL = 'mcp__glade-agents__dispatch'
export const AGENT_MODELS_TOOL = 'mcp__glade-agents__list_models'
export const MESSAGE_CHILD_TOOL = 'mcp__glade-agents__message_child'

/** How a dispatched child is kept apart from its parent's checkout: the `Agent` tool's own word for it. */
export enum DispatchIsolation {
  /** In its own git worktree, which Claude Code makes (`--worktree`). */
  Worktree = 'worktree',
}

export interface DispatchAgentInput {
  readonly model: string
  readonly prompt: string
  readonly description: string
  readonly run_in_background?: boolean | undefined
  /** Resume a child returned by an earlier dispatch, retaining its model and history. */
  readonly resume?: string | undefined
  /** Start the child in its own git worktree, not the parent's checkout (#558). A resumed child keeps what it had. */
  readonly isolation?: DispatchIsolation | undefined
}

/** Sends text to a dispatched child while it still runs in the background (#596). */
export interface MessageChildInput {
  /** A child returned by `dispatch` with `run_in_background`, still running in this task. */
  readonly id: string
  readonly text: string
}
