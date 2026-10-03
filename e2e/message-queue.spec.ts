import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList, taskPanel } from './selectors'

test('messages sent while the agent works wait in the queue, editable, through a relaunch, until its step ends', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'copy-in-batches', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()

  const bar = inputBar(first.window)
  await bar.field.fill('Move image uploads to S3.')
  await bar.field.press('Enter')
  // The agent is copying: its command runs until it's stopped or the app quits.
  await expect(taskPanel(first.window).call(/^Running\s*Bash/)).toBeVisible()
  await expect(bar.stop).toBeVisible()
  await expect(bar.field).toHaveAttribute(
    'placeholder',
    'Add a message. It will be queued until the agent finishes its current step.',
  )

  // While it works, sending queues: two messages, numbered in order.
  await bar.field.fill('Keep the filenames.')
  await bar.field.press('Enter')
  await bar.field.fill('Use the Glacier storage class.')
  await bar.queue.click()
  await expect(bar.queued).toContainText('Queued · 2')
  await expect(bar.queued).toContainText('Sent when the agent finishes its current step')
  await expect(bar.queuedRows).toHaveText(['1Keep the filenames.', '2Use the Glacier storage class.'])
  await expect(bar.field).toHaveValue('')

  // Remove the second; ↑ in the empty field edits the last one left, in place.
  await bar.queuedButton(2, 'Remove').click()
  await expect(bar.queuedRows).toHaveText(['1Keep the filenames.'])
  await bar.field.press('ArrowUp')
  await expect(bar.queuedEditor).toBeFocused()
  await bar.queuedEditor.fill('Keep the original filenames in the bucket keys.')
  await bar.queuedEditor.press('Enter')
  await expect(bar.queuedRows).toHaveText(['1Keep the original filenames in the bucket keys.'])
  await expect(bar.field).toBeFocused()

  // Nothing has reached the agent yet.
  const { userMessages } = chat(first.window)
  await expect(userMessages).toHaveCount(1)

  // Quit mid-turn with the message still queued.
  await first.close()

  // On relaunch the turn resumes; when its command finishes, the queued message is delivered into the turn and the
  // agent answers it before ending the turn.
  const { window } = await launch({ agentScript: 'copy-in-batches' })
  const relaunched = chat(window)
  await expect(relaunched.agentReplies).toHaveText([
    /All 3,900 files are in the bucket, and their keys keep the original filenames\./,
  ])
  await expect(relaunched.restarts).toHaveCount(1)
  await expect(relaunched.userMessages).toHaveText([
    /Move image uploads to S3\./,
    /Keep the original filenames in the bucket keys\./,
  ])
  await expect(inputBar(window).queued).toHaveCount(0)
  await expect(inputBar(window).stop).toHaveCount(0)
  await expect(taskList(window).rows('Active').first()).toContainText(
    'All 3,900 files copied to S3, keeping their original filenames.',
  )
})

// #441: Stop used to leave the queue stuck, with nothing to send it.
for (const how of ['the Stop button', 'the ⌘. shortcut'] as const) {
  test(`${how} with messages queued stops the turn, then sends them as the next turn`, async ({
    launch,
    tempFolder,
  }) => {
    const root = join(tempFolder(), 'acme-api')
    mkdirSync(root)
    const { window } = await launch({ agentScript: 'long-running', chosenFolder: root })
    await firstRun(window).openFolder.click()
    await taskList(window).newTask.click()

    const bar = inputBar(window)
    await bar.field.fill('Run the e2e suite.')
    await bar.field.press('Enter')
    // The agent runs the suite until it's stopped.
    await expect(taskPanel(window).call(/^Running\s*Bash/)).toBeVisible()

    // Two messages queued while it works.
    await bar.field.fill('Only run the unit tests.')
    await bar.field.press('Enter')
    await bar.field.fill('And tell me which ones fail.')
    await bar.field.press('Enter')
    await expect(bar.queuedRows).toHaveText(['1Only run the unit tests.', '2And tell me which ones fail.'])
    const { userMessages, agentReplies } = chat(window)
    await expect(userMessages).toHaveCount(1)

    if (how === 'the Stop button') await bar.stop.click()
    else await window.keyboard.press('Meta+.')

    // The suite is stopped, and the queue goes to the agent at once, in order, with nothing more from you: it answers.
    await expect(taskPanel(window).call(/^Failed\s*Bash/)).toBeVisible()
    await expect(userMessages).toHaveText([
      /Run the e2e suite\./,
      /Only run the unit tests\./,
      /And tell me which ones fail\./,
    ])
    await expect(agentReplies).toHaveText([/I stopped the suite and will only run the unit tests\./])
    // That turn ended on its own: nothing is left queued, and Send is back.
    await expect(bar.queued).toHaveCount(0)
    await expect(bar.stop).toHaveCount(0)
    await expect(bar.send).toBeVisible()
  })
}

// #455: queued rows moved off the black `bg` fill onto a lighter chip (`inner-2`), with no border until hovered, and
// their text now wraps to two lines before it ellipsises, instead of being cut to one.
test('a queued row is a chip with no border until hovered, and clamps a long message to two lines', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()

  const bar = inputBar(window)
  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')
  await expect(taskPanel(window).call(/^Running\s*Bash/)).toBeVisible()

  const short = 'Keep it brief.'
  const long =
    'When the suite finishes, tell me which tests failed and why, and list every file they touched, so I can ' +
    'check whether the failures share a cause before I start digging through the logs myself, since the last few ' +
    'times they turned out to be unrelated flakes rather than one real regression worth chasing down right away.'
  await bar.field.fill(short)
  await bar.field.press('Enter')
  await bar.field.fill(long)
  await bar.field.press('Enter')
  await expect(bar.queuedRows).toHaveCount(2)

  // The short message fits on one line; the long one wraps, but is clamped to two, not the many it would need.
  const shortBox = await bar.queuedBody(1, short).boundingBox()
  const longBox = await bar.queuedBody(2, long).boundingBox()
  if (shortBox === null || longBox === null) throw new Error('A queued row did not lay out')
  expect(longBox.height).toBeGreaterThan(shortBox.height * 1.4)
  expect(longBox.height).toBeLessThan(shortBox.height * 2.6)

  // No border at rest; a strong one once hovered (the chip's own fill, inner-2, is unaffected by hover).
  const row = bar.queuedRows.nth(1)
  await expect(row).toHaveCSS('background-color', 'rgb(46, 50, 67)')
  await expect(row).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
  await row.hover()
  await expect(row).toHaveCSS('border-top-color', 'rgb(61, 66, 94)')
})
