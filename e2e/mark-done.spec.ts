import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { TaskState, type Task } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chat, firstRun, taskHeader, taskList, toasts } from './selectors'
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
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()

  // Until the input bar lands (P1-06), the spec sends the message through the renderer's bridge, as the input bar will.
  await invoke(window, CommandName.TasksSend, {
    id: (await onlyTask(window)).id,
    text: 'The date test is flaky. Can you fix it?',
  })
  const header = taskHeader(window)
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(list.rows('Active')).toHaveCount(1)
  const before = await onlyTask(window)
  // Done starts collapsed; open it to see the row arrive.
  await list.sectionHeader('Done').click()

  // Mark done: no dialog, the row moves to Done, the header shows the done presentation, and a toast offers Undo.
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

  // ⌘⇧D marks it done again; left alone, the toast goes after a few seconds and the task stays done.
  await window.keyboard.press('Meta+Shift+D')
  await expect(toast.region).toContainText(MARKED_DONE)
  await expect(list.rows('Done')).toHaveCount(1)
  await expect(toast.region).toBeEmpty()
  await expect(header.pill).toHaveText(/^Done · /)
  expect((await onlyTask(window)).state).toBe(TaskState.Done)
})
