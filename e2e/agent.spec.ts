import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { TaskActivity, ToolCallState } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'
import { invoke, taskHeader, toolLog } from './task-view'

test('new task, first message, scripted reply', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(1)

  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const workspaceId = workspaces[0]?.id ?? ''
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId })
  const taskId = tasks[0]?.id ?? ''
  const bar = inputBar(window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')

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

  // Until the task header and the tool log land (P1-11, P1-12), these read what they will show through the bridge.
  expect(await taskHeader(window, workspaceId, taskId)).toEqual({
    title: 'Fix the flaky date test',
    objective: 'Make the date formatting test pass in every timezone.',
    status: 'Fixed the timezone bug; the tests pass.',
    activity: TaskActivity.Waiting,
  })
  const done = ToolCallState.Done
  expect(await toolLog(window, taskId)).toEqual([
    { narration: "I'll find where the date is formatted, then fix the timezone bug and run the tests." },
    { tool: 'mcp__glade__set_title', state: done, inside: null },
    { tool: 'mcp__glade__set_objective', state: done, inside: null },
    { tool: 'mcp__glade__set_status', state: done, inside: null },
    { tool: 'Read', state: done, inside: null },
    { tool: 'Grep', state: done, inside: null },
    { tool: 'Agent', state: done, inside: null },
    { tool: 'Grep', state: done, inside: 'Agent' },
    { tool: 'Read', state: done, inside: 'Agent' },
    { tool: 'Edit', state: done, inside: null },
    { tool: 'mcp__glade__set_status', state: done, inside: null },
    { tool: 'Bash', state: done, inside: null },
    { tool: 'mcp__glade__set_status', state: done, inside: null },
  ])
})
