import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { MessageRole, TaskActivity, ToolCallState } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { firstRun, regions } from './selectors'
import { chat, invoke, taskHeader, toolLog } from './task-view'

test('new task, first message, scripted reply', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })

  await firstRun(window).openFolder.click()
  await expect(regions(window).task).toBeVisible()

  // Until the New task button and the input bar land (P1-06, P1-10), the spec creates the task and sends the message
  // through the renderer's bridge, as those controls will.
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const workspaceId = workspaces[0]?.id ?? ''
  const { task } = await invoke(window, CommandName.TasksCreate, { workspaceId })
  await invoke(window, CommandName.TasksSend, { id: task.id, text: 'The date test is flaky. Can you fix it?' })

  await expect
    .poll(() => chat(window, task.id))
    .toEqual([
      { role: MessageRole.User, body: 'The date test is flaky. Can you fix it?' },
      {
        role: MessageRole.Agent,
        body: expect.stringMatching(/^The failing test was a timezone bug/) as unknown,
      },
    ])

  const done = ToolCallState.Done
  expect(await toolLog(window, task.id)).toEqual([
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

  expect(await taskHeader(window, workspaceId, task.id)).toEqual({
    title: 'Fix the flaky date test',
    objective: 'Make the date formatting test pass in every timezone.',
    status: 'Fixed the timezone bug; the tests pass.',
    activity: TaskActivity.Waiting,
  })
})
