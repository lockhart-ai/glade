import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, taskList } from './selectors'

test('File › New task (⌘N) opens a new task, and the first message has the agent name it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const { newTaskPrompt, userMessages, agentReplies } = chat(window)

  // File › New task (⌘N) adds a selected "New task" row to Active, and the chat asks what the agent should do.
  await chooseMenuItem(glade, 'File', 'New task')
  const row = list.rows('Active').first()
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(row).toContainText('New task')
  await expect(row).toContainText('Waiting for instructions')
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(newTaskPrompt).toBeVisible()
  await expect(chat(window).log).toContainText(`It works in the workspace root, ${root}.`)

  // The input bar has the focus and asks for the task, so you can type the first message straight away.
  const bar = inputBar(window)
  await expect(bar.field).toBeFocused()
  await expect(bar.field).toHaveAttribute('placeholder', 'Describe the task…')
  await window.keyboard.type('The date test is flaky. Can you fix it?')
  await window.keyboard.press('Enter')

  // The prompt gives way to the conversation, and the agent's Glade tools name the task and set its status.
  await expect(userMessages).toHaveCount(1)
  await expect(newTaskPrompt).toBeHidden()
  await expect(agentReplies).toHaveCount(1)
  await expect(row).toContainText('Fix the flaky date test')
  await expect(row).toContainText('Fixed the timezone bug; the tests pass.')

  // Each + or New task opens another new task, even while one is unused.
  await chooseMenuItem(glade, 'File', 'New task')
  await expect(list.rows('Active')).toHaveCount(2)
  await expect(bar.field).toBeFocused()
  await bar.field.blur()
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(3)
  await expect(bar.field).toBeFocused()
  await expect(list.rows('Active').filter({ hasText: 'Waiting for instructions' })).toHaveCount(2)
  await expect(newTaskPrompt).toBeVisible()
})
