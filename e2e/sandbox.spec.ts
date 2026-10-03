// The agent sandbox (#445), end to end with the scripted agent: a task's session starts sandboxed, and when its sandbox
// can't start, every command fails, the agent's requests to run outside the sandbox are refused without a card, and
// the task stops on the error, naming why. Retry starts a new session, so the sandbox gets another go.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { SANDBOX_FAILS } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ToolEventKind, type ToolCallEvent } from '../src/shared/domain'
import { agentSessions, expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'
import { invoke } from './task-view'

/** The only task's tool calls, as main has them. */
async function toolCalls(window: Page): Promise<ToolCallEvent[]> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  const { toolEvents } = await invoke(window, CommandName.TasksHistory, { id: tasks[0]?.id ?? '' })
  return toolEvents.filter((event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall)
}

test('a sandbox that can’t start stops the task on the error, and running outside it is refused with no card', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'sandbox-fails', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Run the tests.')
  await inputBar(window).field.press('Enter')

  const { errorCard, permissionCards } = chat(window)
  await expect(errorCard).toContainText('The agent stopped')
  await expect(errorCard).toContainText(
    `The sandbox couldn’t start, so the agent’s commands failed: ${SANDBOX_FAILS.reason}.`,
  )
  await expect(errorCard).toContainText('Nothing is lost: the chat, tool log and files are as they were.')
  await expect(chat(window).agentReplies.last()).toContainText(SANDBOX_FAILS.reply)
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · stopped by an error')
  const row = taskList(window).rows('Active').first()
  await expect(row).toContainText('Error: the sandbox couldn’t start · retry?')
  await expect(taskList(window).dot(row)).toHaveAttribute('data-state', 'error')

  // No card ever asked: both requests to run outside the sandbox were refused at once.
  await expect(permissionCards).toHaveCount(0)
  await expect(taskPanel(window).call(/^Failed\s*Bash/)).toHaveCount(3)
  const calls = await toolCalls(window)
  expect(calls.map(({ input }) => [input.command, input.dangerouslyDisableSandbox ?? false])).toEqual([
    [SANDBOX_FAILS.command, false],
    [SANDBOX_FAILS.command, true],
    [SANDBOX_FAILS.build, true],
  ])
  for (const refused of calls.slice(1))
    expect(refused.output).toContain('refused to run this command outside the sandbox')

  // The session started sandboxed.
  const [session] = await agentSessions(glade)
  expect(session?.flagSettings?.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true })
  expect(session?.flagSettings?.permissions?.ask).toEqual(['Bash(dangerouslyDisableSandbox:true)'])

  await chat(window).errorButton('Show details').click()
  await expect(chat(window).errorDetails).toContainText('Sandbox is required but failed to initialize')

  // Retry starts a new session, whose sandbox gets another go (this script's fails again).
  await chat(window).errorButton('Retry').click()
  await expect.poll(async () => (await agentSessions(glade)).length).toBe(2)
  await expect(taskPanel(window).call(/^Failed\s*Bash/)).toHaveCount(6)
  await expect(errorCard).toContainText(SANDBOX_FAILS.reason)
  await expect(permissionCards).toHaveCount(0)
})
