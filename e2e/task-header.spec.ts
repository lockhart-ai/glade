import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList } from './selectors'

test('task header: fills in from the agent, pins the task, and marks it done', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()

  // A new task's header shows stand-ins until the agent fills it in, and no Mark done yet.
  const header = taskHeader(window)
  await expect(header.title).toHaveText('New task')
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(header.header).toContainText('created just now')
  await expect(header.field('Objective')).toHaveText('Set by your first message.')
  await expect(header.field('Status')).toHaveText('Nothing yet.')
  await expect(header.markDone).toHaveCount(0)

  const bar = inputBar(window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')

  // The header follows what the agent sets with its Glade tools.
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.field('Objective')).toHaveText('Make the date formatting test pass in every timezone.')
  await expect(header.field('Status')).toHaveText('Fixed the timezone bug; the tests pass. · just now')
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(header.header).toContainText('started just now')

  // Pinning moves the task into Pinned.
  await header.pin.click()
  await expect(header.unpin).toHaveAttribute('aria-pressed', 'true')
  await expect(list.rows('Pinned')).toHaveCount(1)
  await expect(list.rows('Pinned').first()).toContainText('Fix the flaky date test')
  await expect(list.rows('Active')).toHaveCount(0)

  // Mark done switches the header to its done presentation: the status is the outcome.
  await header.markDone.click()
  await expect(header.pill).toHaveText(/^Done · [A-Z][a-z]{2} \d{1,2}$/)
  await expect(header.field('Outcome')).toHaveText('Fixed the timezone bug; the tests pass.')
  await expect(header.markDone).toHaveCount(0)
})
