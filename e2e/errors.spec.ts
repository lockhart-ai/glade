import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'

/** Opens a workspace, starts a task and sends it its first message, which the `flaky-api` script fails. */
async function startFailingTask(window: Page): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('test_login_redirect fails about one run in ten on CI. Find out why and fix it.')
  await bar.field.press('Enter')
}

/** Checks the task shows it was stopped by an overloaded API: the card, the header's state dot, the row and the tool log. */
async function expectStoppedByError(window: Page): Promise<void> {
  const { errorCard, agentReplies } = chat(window)
  await expect(errorCard).toContainText('The agent stopped')
  await expect(errorCard).toContainText('The API returned 529 overloaded. Glade retried 3 times over')
  await expect(errorCard).toContainText('Nothing is lost: the chat, tool log and files are as they were.')
  await expect(agentReplies).toHaveCount(0)
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · stopped by an error')
  const row = taskList(window).taskRow('Fix flaky login test')
  await expect(row).toContainText('Error: API overloaded · retry?')
  await expect(taskList(window).dot(row)).toHaveAttribute('data-state', 'error')
  await expect(taskPanel(window).call(/^Failed\s*API\s*request 4 of 4/)).toContainText('529 overloaded · task paused')
  await expect(inputBar(window).field).toHaveAttribute('placeholder', 'Reply, or press Retry…')
}

/** Checks the retry got through: the card is gone, and the turn finished with a reply. */
async function expectRecovered(window: Page): Promise<void> {
  const { errorCard, agentReplies, userMessages } = chat(window)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('The test passes 200 times in a row against Postgres')
  await expect(errorCard).toHaveCount(0)
  // The retry resumed the same turn: your message wasn't sent again into the chat.
  await expect(userMessages).toHaveCount(1)
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(taskList(window).taskRow('Fix flaky login test')).toContainText(
    'Fixed the race in the test; it passes 200 times on Postgres.',
  )
  await expect(taskPanel(window).call(/^Done\s*Bash\s*pytest/)).toBeVisible()
}

test('an error stops the agent with a card, and Retry resumes the same turn', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'flaky-api', chosenFolder: root })
  await startFailingTask(window)

  // While Claude Code retries the overloaded API, the working line says so.
  await expect(chat(window).workingLine).toHaveText(/^Retrying \(\d of 3\)…$/)
  await expectStoppedByError(window)

  // Show details shows the raw error, and hides it again.
  await chat(window).errorButton('Show details').click()
  await expect(chat(window).errorDetails).toContainText('"type":"overloaded_error"')
  await chat(window).errorButton('Hide details').click()
  await expect(chat(window).errorDetails).toHaveCount(0)

  await chat(window).errorButton('Retry').click()
  await expectRecovered(window)
})

test('Retry with another model picks the model, then retries on it', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'flaky-api', chosenFolder: root })
  await startFailingTask(window)
  await expectStoppedByError(window)
  const bar = inputBar(window)
  // The session has reported the SDK's models: the task's Opus 5.5 is its default.
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Default (recommended)')

  await chat(window).errorButton('Retry with another model').click()
  await window.getByRole('menuitemradio', { name: 'Sonnet', exact: true }).click()

  await expectRecovered(window)
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sonnet')
})
