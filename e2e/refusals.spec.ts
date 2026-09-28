import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList } from './selectors'

test('a safety refusal answered by a fallback model shows a quiet notice, evicts the refused leg, and switches the model', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'safety-refusal-fallback', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Summarize last night’s outage from the incident channel.')
  await bar.field.press('Enter')

  const { agentReplies, refusalFallback, log } = chat(window)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText(
    'Here’s a summary: a misconfigured firewall rule blocked internal traffic for 12 minutes.',
  )
  // The refused leg's own reply never reached the chat: only the retry's does.
  await expect(log).not.toContainText('Let me look at what the logs show')
  await expect(refusalFallback).toHaveText(
    'Answered by claude-sonnet-5: the request was declined by a safety check (cyber).',
  )
  // `scope: session` (the default) switches the task's own model, so its picker shows the swap.
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sonnet')
})

test('a safety refusal with no fallback model declines the turn: a card in the error card’s style, not a crash', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'safety-refusal-no-fallback', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Help me set up a small home lab network for security research.')
  await bar.field.press('Enter')

  const { errorCard, agentReplies } = chat(window)
  await expect(errorCard).toContainText('The agent stopped')
  await expect(errorCard).toContainText(
    'The request was declined by a safety check: cyber. Glade paused the task. Nothing is lost',
  )
  await expect(agentReplies).toHaveCount(0)
  // Needing you for a declined request reads apart from a crash, in the header and the sidebar row alike.
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · declined by a safety check')
  const row = taskList(window).taskRow('Research a home lab network')
  await expect(row).toContainText('Error: declined by a safety check · retry?')
  await expect(taskList(window).dot(row)).toHaveAttribute('data-state', 'error')

  // Retry and Retry with another model are offered like any other error's.
  await expect(chat(window).errorButton('Retry')).toBeVisible()
  await expect(chat(window).errorButton('Retry with another model')).toBeVisible()
})
