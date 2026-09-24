import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'
import { invoke } from './task-view'

test('new task, first message, scripted reply', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(1)

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

  // So does the task header, with the objective, and the agent waiting on you once the turn ends.
  const header = taskHeader(window)
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.field('Objective')).toHaveText('Make the date formatting test pass in every timezone.')
  await expect(header.field('Status')).toContainText('Fixed the timezone bug; the tests pass.')
  await expect(header.pill).toHaveText('Active · waiting on you')

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

test('stop a running turn with ⌘., then carry on in the same session', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(1)

  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const workspaceId = workspaces[0]?.id ?? ''
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId })
  const taskId = tasks[0]?.id ?? ''
  const { pill } = taskHeader(window)
  const sessionId = async (): Promise<string | null | undefined> =>
    (await invoke(window, CommandName.TasksList, { workspaceId })).tasks.find(({ id }) => id === taskId)?.sessionId
  const bar = inputBar(window)
  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')

  // The agent works, with its command running, until it's stopped.
  const panel = taskPanel(window)
  await expect(panel.call(/^Running\s*Bash/)).toBeVisible()
  await expect(pill).toHaveText('Active · working')
  const session = await sessionId()
  expect(session).toBeTruthy()

  await window.keyboard.press('Meta+.')

  // Back to waiting on you: the running command ended as an error, and the tool log says you stopped it.
  await expect(pill).toHaveText('Active · waiting on you')
  await expect(panel.call(/^Failed\s*Bash/)).toBeVisible()
  await expect(panel.call(/^Running/)).toHaveCount(0)
  await expect(panel.log.getByText(/^You stopped the agent\./)).toBeVisible()
  const { userMessages, agentReplies } = chat(window)
  await expect(agentReplies).toHaveCount(0)

  // A message after the stop carries on in the same session.
  await bar.field.fill('Only run the unit tests.')
  await bar.field.press('Enter')
  await expect(userMessages).toHaveCount(2)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('I stopped the suite and will only run the unit tests.')
  await expect(pill).toHaveText('Active · waiting on you')
  expect(await sessionId()).toBe(session)
})
