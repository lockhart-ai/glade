// The Todos tab, end to end with the scripted agent: the list follows the agent's own todo tools (Claude Code's
// TaskCreate and TaskUpdate, or its older TodoWrite) over a turn, the tab counts what's done, and it all survives a
// relaunch, since it's worked out from the stored tool log.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList, taskPanel } from './selectors'
import { invoke } from './task-view'

function workspaceRoot(tempFolder: () => string): string {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  return root
}

/** Opens the workspace and starts a task, showing its Todos tab, which is empty. */
async function startTask(window: Page): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const panel = taskPanel(window)
  await panel.tab('Todos').click()
  await expect(panel.tabPanel).toHaveText('No todos yet.')
}

async function send(window: Page, message: string): Promise<void> {
  const bar = inputBar(window)
  await bar.field.fill(message)
  await bar.field.press('Enter')
}

/** Whether the only task's agent has questions open. */
async function asking(window: Page): Promise<boolean | undefined> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]?.asking
}

const PLAN = [
  'Find how uploads are stored today',
  'Add an S3 backend for media files',
  'Check new uploads land in the bucket',
  'Copy the 3,900 existing files',
  'Spot-check a sample of copied files',
  'Update stored paths in the database',
  'Delete local copies',
]

test('todos: the list follows TaskCreate and TaskUpdate over a turn, counted in the tab, and survives a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'keeps-todos', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const panel = taskPanel(window)
  await startTask(window)
  await send(window, 'Move the image uploads to S3.')

  // Partway through the turn the agent asks a question and waits: 3 of 7 done, the copy in progress.
  await expect.poll(() => asking(window)).toBe(true)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/7')
  await expect(panel.tabPanel).toContainText('3 of 7 done')
  await expect(panel.todoProgress).toHaveAttribute('aria-valuenow', '3')
  await expect(panel.todos).toHaveText([
    `Done: ${PLAN[0] ?? ''}`,
    `Done: ${PLAN[1] ?? ''}`,
    `Done: ${PLAN[2] ?? ''}`,
    `Doing: ${PLAN[3] ?? ''}Copying files · 1,240 of 3,900`,
    `To do: ${PLAN[4] ?? ''}`,
    `To do: ${PLAN[5] ?? ''}`,
    `To do: ${PLAN[6] ?? ''}`,
  ])

  // A reply in words answers it, and the agent works through two more steps before the turn ends.
  await send(window, 'Keep them for now.')
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 6/7')
  await expect(panel.tabPanel).toContainText('6 of 7 done')
  const finished = [...PLAN.slice(0, 6).map((text) => `Done: ${text}`), `To do: ${PLAN[6] ?? ''}`]
  await expect(panel.todos).toHaveText(finished)

  // The todo tool calls stay in the tool log like any others.
  await panel.tab(/^Tool calls/).click()
  await expect(panel.call(/^Done\s*TaskCreate/)).toHaveCount(7)
  await panel.tab(/^Todos/).click()

  // The list is worked out from the stored tool log, so a relaunch shows it as it was.
  await glade.close()
  const relaunched = await launch({ agentScript: 'keeps-todos' })
  const again = taskPanel(relaunched.window)
  await expect(again.tab(/^Todos/)).toHaveText('Todos 6/7')
  await expect(again.tab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
  await expect(again.tabPanel).toContainText('6 of 7 done')
  await expect(again.todos).toHaveText(finished)
})

test('todos: the list follows TodoWrite, which replaces it each call', async ({ launch, tempFolder }) => {
  const { window } = await launch({ agentScript: 'writes-todos', chosenFolder: workspaceRoot(tempFolder) })
  const panel = taskPanel(window)
  await startTask(window)
  await send(window, 'Fix the flaky login test.')

  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/3')
  await expect(panel.todos).toHaveText([
    'Done: Reproduce the flake',
    'Done: Fix the race',
    'Done: Run the test 200 times',
  ])
})
