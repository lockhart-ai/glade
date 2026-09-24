import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { TaskState, type Task } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, regions, taskHeader, taskList, toasts } from './selectors'
import { invoke } from './task-view'

const MARKED_DONE = 'Marked done. The latest status is kept as the outcome.'

/** The workspace's only task, as main has it. */
async function onlyTask(window: Page): Promise<Task> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  const [task] = tasks
  if (task === undefined) throw new Error('No task')
  return task
}

test('mark done: moves the task to Done with an Undo toast, and Undo puts it back', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()

  const bar = inputBar(window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')
  const header = taskHeader(window)
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(list.rows('Active')).toHaveCount(1)
  const before = await onlyTask(window)
  // Done starts collapsed.
  await expect(list.sectionHeader('Done')).toHaveAttribute('aria-expanded', 'false')

  // Mark done: no dialog, the row moves to Done (which opens to show it), the header shows the done presentation, and
  // a toast above the input bar offers Undo.
  const toast = toasts(window)
  await header.markDone.click()
  await expect(header.pill).toHaveText(/^Done · [A-Z][a-z]{2} \d{1,2}$/)
  await expect(header.field('Outcome')).toHaveText('Fixed the timezone bug; the tests pass.')
  await expect(header.markDone).toHaveCount(0)
  await expect(list.rows('Done')).toHaveCount(1)
  await expect(list.rows('Done').first()).toContainText('Fix the flaky date test')
  await expect(list.rows('Active')).toHaveCount(0)
  await expect(window.getByRole('dialog')).toHaveCount(0)
  await expect(toast.region).toContainText(MARKED_DONE)
  await expect(list.sectionHeader('Done')).toHaveAttribute('aria-expanded', 'true')
  await expect(list.rows('Done').first()).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toHaveAttribute('placeholder', 'Send a message to reopen this task…')
  const toastBox = await toast.region.getByText(MARKED_DONE).locator('..').boundingBox()
  const barBox = await regions(window).inputBar.boundingBox()
  const chatBox = await regions(window).chat.boundingBox()
  if (toastBox === null || barBox === null || chatBox === null) throw new Error('Nothing to measure')
  expect(toastBox.y + toastBox.height).toBeLessThan(barBox.y)
  expect(toastBox.y).toBeGreaterThan(chatBox.y)
  expect(Math.abs(toastBox.x + toastBox.width / 2 - (chatBox.x + chatBox.width / 2))).toBeLessThan(2)

  // Undo puts the task back exactly as it was: only when it last changed moves on.
  await toast.undo.click()
  await expect(toast.region).toBeEmpty()
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(header.markDone).toBeEnabled()
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.field('Objective')).toHaveText('Make the date formatting test pass in every timezone.')
  await expect(header.field('Status')).toContainText('Fixed the timezone bug; the tests pass.')
  await expect(header.pin).toHaveAttribute('aria-pressed', 'false')
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(list.rows('Done')).toHaveCount(0)
  const restored = await onlyTask(window)
  expect(restored).toEqual({ ...before, updatedAt: restored.updatedAt })

  // Task › Mark done (⌘⇧D) marks it done again; left alone, the toast goes after a few seconds and the task stays done.
  await chooseMenuItem(glade, 'Task', 'Mark done')
  await expect(toast.region).toContainText(MARKED_DONE)
  await expect(list.rows('Done')).toHaveCount(1)
  await expect(toast.region).toBeEmpty()
  await expect(header.pill).toHaveText(/^Done · /)
  expect((await onlyTask(window)).state).toBe(TaskState.Done)
})
