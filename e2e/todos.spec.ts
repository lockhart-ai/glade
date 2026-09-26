// The Todos tab, end to end with the scripted agent: the list follows the agent's own todo tools (Claude Code's
// TaskCreate and TaskUpdate, or its older TodoWrite) over a turn, the tab counts what's done, the task's sidebar row
// shows the same progress, and it all survives a relaunch, since it's worked out from the stored tool log.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'
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

/** A done item of the plan, as the tab reads it: its text, then when it was finished (just now, or minutes ago). */
function done(index: number): RegExp {
  const text = (PLAN[index] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^Done: ${text}Finished (just now|\\d+m ago)$`)
}

/** An exact time, as a finish time's tooltip gives it: `Sep 26, 2026, 12:18 AM`. */
const FULL_DATE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M$/

test('todos: the list follows TaskCreate and TaskUpdate over a turn, counted in the tab, and survives a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'keeps-todos', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const panel = taskPanel(window)
  const list = taskList(window)
  await startTask(window)
  // With no list, the row shows no progress.
  await expect(list.todoProgress(list.rows('Active').first())).toHaveCount(0)
  await send(window, 'Move the image uploads to S3.')

  // Partway through the turn the agent asks a question and waits: 3 of 7 done, the copy in progress.
  await expect.poll(() => asking(window)).toBe(true)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/7')
  await expect(panel.tabPanel).toContainText('3 of 7 done')
  await expect(panel.todoProgress).toHaveAttribute('aria-valuenow', '3')
  // Grouped: the item in progress, then the done ones (the latest finished first, each with its time), then the rest.
  await expect(panel.todos).toHaveText([
    `Doing: ${PLAN[3] ?? ''}Copying files · 1,240 of 3,900`,
    done(2),
    done(1),
    done(0),
    `To do: ${PLAN[4] ?? ''}`,
    `To do: ${PLAN[5] ?? ''}`,
    `To do: ${PLAN[6] ?? ''}`,
  ])
  // Each finish time gives the exact time on hover.
  await expect(panel.todoFinished(panel.todos.nth(1))).toHaveAttribute('title', FULL_DATE)
  await expect(panel.todoFinished(panel.todos.first())).toHaveCount(0)
  // The task's row counts the same, and its tooltip names the item in progress.
  const progress = list.todoProgress(list.rows('Active').first())
  await expect(progress).toHaveText('3/7')
  await expect(progress).toHaveAttribute('title', `3 of 7 todos done · Now: ${PLAN[3] ?? ''}`)
  await expect(progress).toHaveAttribute('data-done', 'false')

  // A reply in words answers it, and the agent works through two more steps before the turn ends.
  await send(window, 'Keep them for now.')
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 6/7')
  await expect(panel.tabPanel).toContainText('6 of 7 done')
  // The copy moved from the top to the done items as it finished, and the steps after it followed, each on top.
  const finished = [done(5), done(4), done(3), done(2), done(1), done(0), `To do: ${PLAN[6] ?? ''}`]
  await expect(panel.todos).toHaveText(finished)
  const times = await panel.todos.evaluateAll((items) =>
    items.map((item) => item.querySelector('time')?.getAttribute('datetime') ?? null),
  )
  await expect(progress).toHaveText('6/7')
  await expect(progress).toHaveAttribute('title', '6 of 7 todos done')

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
  // Each keeps the time it was finished, stored with the tool log.
  const relaunchedTimes = await again.todos.evaluateAll((items) =>
    items.map((item) => item.querySelector('time')?.getAttribute('datetime') ?? null),
  )
  expect(relaunchedTimes).toEqual(times)
  expect(times.filter((time) => time !== null)).toHaveLength(6)
  const relaunchedList = taskList(relaunched.window)
  await expect(relaunchedList.todoProgress(relaunchedList.rows('Active').first())).toHaveText('6/7')

  // Marked done, its row in the Done section (which opens to show it, still selected) keeps its progress.
  await taskHeader(relaunched.window).markDone.click()
  await expect(relaunchedList.rows('Active')).toHaveCount(0)
  await expect(relaunchedList.sectionHeader('Done')).toHaveAttribute('aria-expanded', 'true')
  await expect(relaunchedList.todoProgress(relaunchedList.rows('Done').first())).toHaveText('6/7')
})

test('todos: the list follows TodoWrite, which replaces it each call', async ({ launch, tempFolder }) => {
  const { window } = await launch({ agentScript: 'writes-todos', chosenFolder: workspaceRoot(tempFolder) })
  const panel = taskPanel(window)
  await startTask(window)
  await send(window, 'Fix the flaky login test.')

  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/3')
  // The last write finished two at once: the one further down the list shows first, then the one before it, then the
  // item an earlier write finished.
  await expect(panel.todos).toHaveText([
    /^Done: Run the test 200 timesFinished /,
    /^Done: Fix the raceFinished /,
    /^Done: Reproduce the flakeFinished /,
  ])
  const [run, fix, reproduce] = await panel.todos.evaluateAll((items) =>
    items.map((item) => Date.parse(item.querySelector('time')?.getAttribute('datetime') ?? '')),
  )
  expect(run).toBe(fix)
  expect(reproduce).toBeLessThan(fix ?? 0)
  // Every item done: the row shows a check.
  const list = taskList(window)
  const progress = list.todoProgress(list.rows('Active').first())
  await expect(progress).toHaveText('3/3')
  await expect(progress).toHaveAttribute('data-done', 'true')
  await expect(progress).toHaveAttribute('title', '3 of 3 todos done')
})
