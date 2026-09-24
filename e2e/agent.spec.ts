import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { ToolCallState } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chat, firstRun, taskHeader, taskList } from './selectors'
import { invoke, toolLog } from './task-view'

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

  // So does the task header, with the objective, and the agent waiting on you once the turn ends.
  const header = taskHeader(window)
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.field('Objective')).toHaveText('Make the date formatting test pass in every timezone.')
  await expect(header.field('Status')).toContainText('Fixed the timezone bug; the tests pass.')
  await expect(header.pill).toHaveText('Active · waiting on you')

  // Until the tool log lands (P1-11), this reads what it will show through the bridge.
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

test('stop a running turn with ⌘., then carry on in the same session', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(1)

  // Until the input bar lands (P1-06), the spec sends messages through the renderer's bridge, as the input bar will.
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const workspaceId = workspaces[0]?.id ?? ''
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId })
  const taskId = tasks[0]?.id ?? ''
  const { pill } = taskHeader(window)
  const sessionId = async (): Promise<string | null | undefined> =>
    (await invoke(window, CommandName.TasksList, { workspaceId })).tasks.find(({ id }) => id === taskId)?.sessionId
  await invoke(window, CommandName.TasksSend, { id: taskId, text: 'Run the e2e suite.' })

  // The agent works, with its command running, until it's stopped.
  await expect
    .poll(async () => (await toolLog(window, taskId)).at(-1))
    .toEqual({ tool: 'Bash', state: ToolCallState.Running, inside: null })
  await expect(pill).toHaveText('Active · working')
  const session = await sessionId()
  expect(session).toBeTruthy()

  await window.keyboard.press('Meta+.')

  // Back to waiting on you: the running command ended as an error, and the tool log says you stopped it.
  await expect(pill).toHaveText('Active · waiting on you')
  expect((await toolLog(window, taskId)).slice(-2)).toEqual([
    { tool: 'Bash', state: ToolCallState.Error, inside: null },
    { narration: 'You stopped the agent.' },
  ])
  const { userMessages, agentReplies } = chat(window)
  await expect(agentReplies).toHaveCount(0)

  // A message after the stop carries on in the same session.
  await invoke(window, CommandName.TasksSend, { id: taskId, text: 'Only run the unit tests.' })
  await expect(userMessages).toHaveCount(2)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('I stopped the suite and will only run the unit tests.')
  await expect(pill).toHaveText('Active · waiting on you')
  expect(await sessionId()).toBe(session)
})
