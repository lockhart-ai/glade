import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { expect, test } from './fixtures'
import { chat, firstRun, taskList } from './selectors'
import { invoke } from './task-view'

test('⌘N opens a new task, and the first message has the agent name it', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const { newTaskPrompt, userMessages, agentReplies } = chat(window)

  // ⌘N adds a selected "New task" row to Active, and the chat asks what the agent should do.
  await window.keyboard.press('Meta+N')
  const row = list.rows('Active').first()
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(row).toContainText('New task')
  await expect(row).toContainText('Waiting for instructions')
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(newTaskPrompt).toBeVisible()
  await expect(chat(window).log).toContainText(`It works in the workspace root, ${root}.`)

  // Until the input bar lands (P1-13), the spec sends the first message through the renderer's bridge, as it will.
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  await invoke(window, CommandName.TasksSend, {
    id: tasks[0]?.id ?? '',
    text: 'The date test is flaky. Can you fix it?',
  })

  // The prompt gives way to the conversation, and the agent's Glade tools name the task and set its status.
  await expect(userMessages).toHaveCount(1)
  await expect(newTaskPrompt).toBeHidden()
  await expect(agentReplies).toHaveCount(1)
  await expect(row).toContainText('Fix the flaky date test')
  await expect(row).toContainText('Fixed the timezone bug; the tests pass.')

  // Each + or ⌘N opens another new task, even while one is unused.
  await window.keyboard.press('Meta+N')
  await expect(list.rows('Active')).toHaveCount(2)
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(3)
  await expect(list.rows('Active').filter({ hasText: 'Waiting for instructions' })).toHaveCount(2)
  await expect(newTaskPrompt).toBeVisible()
})
