import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

/** The title the finishes-in-background agent gives its task. */
const TITLE = 'Build the docs site'
const STARTED = "I've started the docs build in the background. I'll report back when it finishes."
const REPORTED = 'The docs site built cleanly: 48 pages and no broken links.'

test('a turn the agent starts itself: its work and reply show, it marks the task unread, and it survives a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'finishes-in-background', chosenFolder: root })
  let window = first.window
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()

  const bar = inputBar(window)
  await bar.field.fill('Build the docs site and check it for broken links.')
  await bar.field.press('Enter')
  const { agentReplies, turnSummaries, workingLine } = chat(window)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText(STARTED)

  // With no message from you, the build finishing wakes the agent: the task works on it, saying what it's doing.
  await expect(workingLine).toHaveText('Working · The docs build finished. Checking its output for broken links.')
  await expect(list.dot(list.taskRow(TITLE))).toHaveAttribute('data-state', 'working')

  // Look away before it replies: its reply marks the task unread.
  await list.newTask.click()
  await expect(chat(window).newTaskPrompt).toBeVisible()
  await expect(list.taskRow(TITLE).getByRole('img', { name: 'Unread' })).toBeVisible()
  await expect(list.dot(list.taskRow(TITLE))).toHaveAttribute('data-state', 'waiting')

  // Its reply is in the chat like any other, with its summary, and the agent has stopped working.
  await list.taskRow(TITLE).click()
  await expect(agentReplies).toHaveCount(2)
  await expect(agentReplies.nth(1)).toContainText(REPORTED)
  await expect(turnSummaries).toHaveCount(2)
  await expect(workingLine).toHaveCount(0)
  await first.close()

  // After a relaunch, it's still there.
  const second = await launch({ agentScript: 'finishes-in-background' })
  window = second.window
  await taskList(window).taskRow(TITLE).click()
  const relaunched = chat(window)
  await expect(relaunched.agentReplies).toHaveCount(2)
  await expect(relaunched.agentReplies.nth(1)).toContainText(REPORTED)
  await expect(relaunched.userMessages).toHaveCount(1)
  await expect(relaunched.turnSummaries).toHaveCount(2)
})
