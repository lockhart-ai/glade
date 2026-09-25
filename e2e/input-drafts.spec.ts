// Input drafts across a relaunch (#235): each task's unsent message, text and pasted images, is stored as you type, so
// it's there again after quitting or a crash; sending it or deleting its task takes it away.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { BridgeErrorCode, CommandName } from '../src/shared/bridge'
import { UiStateKey } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { paste, screenshot } from './paste'
import { chat, contextMenu, deleteTaskDialog, firstRun, inputBar, taskList } from './selectors'
import { invoke, refusal } from './task-view'

/** The ids of the only workspace's tasks. */
async function taskIds(window: Page): Promise<string[]> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks.map(({ id }) => id)
}

/** The selected task's id, as main has it. */
async function selectedTaskId(window: Page): Promise<string> {
  const { value } = await invoke(window, CommandName.UiStateGet, { key: UiStateKey.SelectedTaskId })
  return value ?? ''
}

/** A task's draft as main has it stored: its text, and how many images it has; null for none. */
async function storedDraft(window: Page, taskId: string): Promise<{ text: string; images: number } | null> {
  const { draft } = await invoke(window, CommandName.DraftsGet, { taskId })
  return draft === null ? null : { text: draft.text, images: draft.images.length }
}

test('quit and relaunch: each task’s draft comes back, text and images; sending one takes it away', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  const list = taskList(first.window)
  await list.newTask.click()
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(2)

  // The top task gets text and two screenshots; the other, typed into just before quitting, text only.
  const bar = inputBar(first.window)
  await bar.field.fill('Why does the upload page look like this?')
  await paste(bar.field, { files: [screenshot('upload-page.png', '#e58fa8'), screenshot('settings.png', '#8fb2f5')] })
  await expect(bar.attachedImages).toHaveCount(2)
  await list.rows('Active').nth(1).click()
  await expect(bar.field).toHaveValue('')
  await bar.field.fill('Check the rate limits first')
  // Quit straight away, before the pause after typing: the draft is stored on the way out.
  await first.close()

  const second = await launch({ agentScript: 'simple-reply' })
  const { window } = second
  const again = inputBar(window)
  const rows = taskList(window).rows('Active')
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true')
  await expect(again.field).toHaveValue('Check the rate limits first')
  await rows.nth(0).click()
  await expect(again.field).toHaveValue('Why does the upload page look like this?')
  await expect(again.attachedImages).toHaveCount(2)
  for (const image of await again.attachedImages.all()) {
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)
  }

  // Sending it takes it away: the message goes with its images, and there's no draft to come back.
  await again.field.press('Enter')
  const conversation = chat(window)
  await expect(conversation.userMessages).toHaveCount(1)
  await expect(conversation.userMessages.first().getByRole('img', { name: 'Pasted image' })).toHaveCount(2)
  await expect(again.field).toHaveValue('')
  await expect(again.attachedImages).toHaveCount(0)
  const sentTo = await selectedTaskId(window)
  const other = (await taskIds(window)).find((id) => id !== sentTo)
  await expect.poll(() => storedDraft(window, sentTo)).toBeNull()
  expect(await storedDraft(window, other ?? '')).toEqual({ text: 'Check the rate limits first', images: 0 })
  await second.close()

  const third = await launch({ agentScript: 'simple-reply' })
  const last = inputBar(third.window)
  await expect(taskList(third.window).rows('Active').nth(0)).toHaveAttribute('aria-current', 'true')
  await expect(chat(third.window).userMessages).toHaveCount(1)
  await expect(last.field).toHaveValue('')
  await expect(last.attachedImages).toHaveCount(0)
})

test('force-quit mid-draft, relaunch: the draft stored as you typed comes back, all of it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  const bar = inputBar(first.window)

  // A long draft pasted in, then typed onto key by key: the store keeps up, last keystroke included.
  const logs = '2026-09-25 12:00:00 GET /api/users 200\n'.repeat(2_000)
  await bar.field.fill(logs)
  await bar.field.press('End')
  await bar.field.pressSequentially('Why so many?')
  const text = `${logs}Why so many?`
  await expect(bar.field).toHaveValue(text)
  const taskId = await selectedTaskId(first.window)
  await expect.poll(() => storedDraft(first.window, taskId)).toEqual({ text, images: 0 })

  // Killed outright: nothing runs on the way out.
  await first.kill()

  const { window } = await launch({})
  await expect(inputBar(window).field).toHaveValue(text)
})

test('deleting a task deletes its draft', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  await list.newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Never mind')
  await paste(bar.field, { files: [screenshot('upload-page.png', '#e58fa8')] })
  await expect(bar.attachedImages).toHaveCount(1)
  const doomed = await selectedTaskId(window)
  await expect.poll(() => storedDraft(window, doomed)).toEqual({ text: 'Never mind', images: 1 })

  await list.rows('Active').first().click({ button: 'right' })
  await contextMenu(window, 'Task actions').item('Delete task…').click()
  await deleteTaskDialog(window).confirm.click()
  await expect(list.rows('Active')).toHaveCount(1)
  await glade.close()

  const again = await launch({})
  expect(await taskIds(again.window)).toHaveLength(1)
  await expect(inputBar(again.window).field).toHaveValue('')
  // The draft, and its image, went with the task: main has nothing for it.
  expect(await refusal(again.window, CommandName.DraftsGet, { taskId: doomed })).toMatchObject({
    code: BridgeErrorCode.NotFound,
  })
})
