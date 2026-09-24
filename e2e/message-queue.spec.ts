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
