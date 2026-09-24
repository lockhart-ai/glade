/**
 * What a spec reads off a task that the app doesn't show yet: its header. The reader gives plain data, so specs assert
 * on what a task shows, not on how it's read.
 *
 * Until those screens are built, the readers ask main through the renderer's own bridge (`window.glade`), which is
 * what the store and the screens render from. When a screen lands, its reader goes and the spec reads the screen
 * through locators in `./selectors`, as it already does for the chat and the task list:
 * - `taskHeader`: the task header.
 */
import type { Page } from '@playwright/test'
import {
  BRIDGE_KEY,
  CommandName,
  type CommandRequest,
  type CommandResponse,
  type GladeBridge,
} from '../src/shared/bridge'
import type { TaskActivity } from '../src/shared/domain'

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

export async function taskHeader(page: Page, workspaceId: string, taskId: string): Promise<TaskHeader | undefined> {
  const { tasks } = await invoke(page, CommandName.TasksList, { workspaceId })
  const task = tasks.find(({ id }) => id === taskId)
  return task === undefined
    ? undefined
    : { title: task.title, objective: task.objective, status: task.status, activity: task.activity }
}
