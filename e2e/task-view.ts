/**
 * What a spec reads off a task: its header, its chat and its tool log. Each reader gives plain data, so specs assert on
 * what a task shows, not on how it's read.
 *
 * Until the task screens are built, the readers ask main through the renderer's own bridge (`window.glade`), which is
 * what the store and the screens render from. As each screen lands, its reader switches to reading the screen through
 * locators in `./selectors`, and the specs don't change:
 * - `taskHeader`: the task header (title, objective, status) and the sidebar row (P1-05, P1-11).
 * - `chat`: the chat view (P1-10).
 * - `toolLog`: the tool log panel (P1-12).
 */
import type { Page } from '@playwright/test'
import {
  BRIDGE_KEY,
  CommandName,
  type CommandRequest,
  type CommandResponse,
  type GladeBridge,
} from '../src/shared/bridge'
import { ToolEventKind, type MessageRole, type TaskActivity, type ToolCallState } from '../src/shared/domain'

/** Runs a bridge command in the page, as the renderer would. */
export function invoke<C extends CommandName>(
  page: Page,
  command: C,
  request: CommandRequest<C>,
): Promise<CommandResponse<C>> {
  return page.evaluate(
    ({ key, command, request }) => {
      const bridge = (globalThis as unknown as Record<string, GladeBridge>)[key]
      if (bridge === undefined) throw new Error('No bridge on the page')
      return bridge.invoke(command, request)
    },
    { key: BRIDGE_KEY, command, request },
  )
}

export interface TaskHeader {
  readonly title: string
  readonly objective: string
  readonly status: string
  readonly activity: TaskActivity
}

export interface ChatMessage {
  readonly role: MessageRole
  readonly body: string
}

/** A tool log entry: a narration's text, or a tool call's name, state and the name of the subagent call it's inside. */
export type ToolLogEntry =
  | { readonly narration: string }
  | { readonly tool: string; readonly state: ToolCallState; readonly inside: string | null }

export async function taskHeader(page: Page, workspaceId: string, taskId: string): Promise<TaskHeader | undefined> {
  const { tasks } = await invoke(page, CommandName.TasksList, { workspaceId })
  const task = tasks.find(({ id }) => id === taskId)
  return task === undefined
    ? undefined
    : { title: task.title, objective: task.objective, status: task.status, activity: task.activity }
}

export async function chat(page: Page, taskId: string): Promise<ChatMessage[]> {
  const { messages } = await invoke(page, CommandName.TasksHistory, { id: taskId })
  return messages.map(({ role, body }) => ({ role, body }))
}

export async function toolLog(page: Page, taskId: string): Promise<ToolLogEntry[]> {
  const { toolEvents } = await invoke(page, CommandName.TasksHistory, { id: taskId })
  const names = new Map<string, string>()
  const entries: ToolLogEntry[] = []
  for (const event of toolEvents) {
    if (event.kind === ToolEventKind.Narration) entries.push({ narration: event.text })
    if (event.kind !== ToolEventKind.ToolCall) continue
    names.set(event.toolUseId, event.name)
    const inside = event.parentToolUseId === null ? null : (names.get(event.parentToolUseId) ?? null)
    entries.push({ tool: event.name, state: event.state, inside })
  }
  return entries
}
