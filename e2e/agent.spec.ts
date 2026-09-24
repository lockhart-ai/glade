import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { TaskActivity } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chat, firstRun, taskList, taskPanel } from './selectors'
import { invoke, taskHeader } from './task-view'

test('new task, first message, scripted reply', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(1)

  // Until the input bar lands (P1-06), the spec sends the message through the renderer's bridge, as the input bar will.
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const workspaceId = workspaces[0]?.id ?? ''
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId })
  const taskId = tasks[0]?.id ?? ''
  await invoke(window, CommandName.TasksSend, { id: taskId, text: 'The date test is flaky. Can you fix it?' })

  // The chat shows the message and the agent's reply.
  const { userMessages, agentReplies } = chat(window)
  await expect(userMessages).toHaveCount(1)
  await expect(userMessages.first()).toContainText('The date test is flaky. Can you fix it?')
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('The failing test was a timezone bug')

  // The sidebar shows the title and status the agent set with its Glade tools.
  const row = list.rows('Active').first()
  await expect(row).toContainText('Fix the flaky date test')
  await expect(row).toContainText('Fixed the timezone bug; the tests pass.')

  // Until the task header lands, this reads what it will show through the bridge.
  expect(await taskHeader(window, workspaceId, taskId)).toEqual({
    title: 'Fix the flaky date test',
    objective: 'Make the date formatting test pass in every timezone.',
    status: 'Fixed the timezone bug; the tests pass.',
    activity: TaskActivity.Waiting,
  })

  // The tool log shows every call the turn made, all done, with the subagent's calls under its Agent call.
  const panel = taskPanel(window)
  await expect(panel.tab(/^Tool calls/)).toHaveText('Tool calls 12')
  await expect(panel.log).toContainText(
    "I'll find where the date is formatted, then fix the timezone bug and run the tests.",
  )
  await expect(panel.log.getByRole('button', { name: /^Done/ })).toHaveCount(12)
  await expect(panel.call(/^Done\s*set_title/)).toBeVisible()
  await expect(panel.call(/^Done\s*Read\s*src\/date\.ts/)).toBeVisible()
  await expect(panel.subagentCalls('Agent').getByRole('button')).toHaveCount(2)
})
