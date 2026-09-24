/**
 * What a spec reads off a task that the app doesn't show yet: its tool log. The reader gives plain data, so specs
 * assert on what a task shows, not on how it's read.
 *
 * Until the screen is built, the reader asks main through the renderer's own bridge (`window.glade`), which is what
 * the store and the screens render from. When the screen lands, its reader goes and the spec reads the screen through
 * locators in `./selectors`, as it already does for the chat, the task list and the task header:
 * - `toolLog`: the tool log panel (P1-11).
 */
import type { Page } from '@playwright/test'
import {
  BRIDGE_KEY,
  CommandName,
  type CommandRequest,
  type CommandResponse,
  type GladeBridge,
} from '../src/shared/bridge'
import { ToolEventKind, type ToolCallState } from '../src/shared/domain'

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

/** A tool log entry: a narration's text, or a tool call's name, state and the name of the subagent call it's inside. */
export type ToolLogEntry =
  | { readonly narration: string }
  | { readonly tool: string; readonly state: ToolCallState; readonly inside: string | null }

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
