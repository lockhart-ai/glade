import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clickNotification, expect, notifications, replyToNotification, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList } from './selectors'

/** Task A's first message: it plays `multi-tool-turn`, which titles the task and replies after a dozen tool calls. */
const FIX_DATE = 'The date test is flaky. Can you fix it?'
/** Task B's first message: it plays `simple-reply`. */
const ASK_RETRIES = 'How does the client retry?'
/** The title A's agent gives it. */
const A_TITLE = 'Fix the flaky date test'
/** The title B's agent gives it. */
const B_TITLE = 'Explain the retry policy'
/** What you reply to A's notification: A's agent answers it with its second turn. */
const FOLLOW_UP = 'Does the report header need the same fix?'

test("a reply in a task you aren't viewing sends a notification you can reply to, and clicking it opens that task", async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({
    agentScriptsByFirstMessage: { [FIX_DATE]: 'multi-tool-turn', [ASK_RETRIES]: 'simple-reply' },
    chosenFolder: root,
  })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const bar = inputBar(window)
  const header = taskHeader(window)
  const replies = chat(window).agentReplies

  // Task A: ask it something, then move to a new task B before its agent replies.
  await list.newTask.click()
  await bar.field.fill(FIX_DATE)
  await bar.field.press('Enter')
  await list.newTask.click()
  await expect(chat(window).newTaskPrompt).toBeVisible()

  // A's reply arrives while you're on B: one notification, with A's title and the start of its reply as plain text.
  const rowA = list.taskRow(A_TITLE)
  await expect(rowA.getByRole('img', { name: 'Unread' })).toBeVisible()
  await expect.poll(() => notifications(glade)).toHaveLength(1)
  const [shown] = await notifications(glade)
  expect(shown).toMatchObject({ title: A_TITLE, silent: true })
  expect(shown?.body).toMatch(/^The failing test was a timezone bug: formatDate used the local date\. .*…$/)

  // B's reply arrives while you're viewing B: no notification for it.
  await bar.field.fill(ASK_RETRIES)
  await bar.field.press('Enter')
  await expect(replies).toHaveCount(1)
  await expect(header.title).toHaveText(B_TITLE)
  expect(await notifications(glade)).toHaveLength(1)

  // Replying from A's notification sends the reply to A, as its input bar would, and leaves you on B. A's agent answers
  // it, in a task you still aren't viewing: another notification.
  await replyToNotification(glade, 0, FOLLOW_UP)
  await expect.poll(() => notifications(glade)).toHaveLength(2)
  const [, answer] = await notifications(glade)
  expect(answer).toMatchObject({ title: A_TITLE })
  expect(answer?.body).toMatch(/^The report header already goes through formatDate/)
  await expect(header.title).toHaveText(B_TITLE)
  await expect(replies).toHaveCount(1)

  // Clicking A's notification opens A, as clicking its row does: selected, read, its chat loaded, the reply in it.
  await clickNotification(glade, 1)
  await expect(rowA).toHaveAttribute('aria-current', 'true')
  await expect(header.title).toHaveText(A_TITLE)
  await expect(rowA.getByRole('img', { name: 'Unread' })).toHaveCount(0)
  await expect(list.filter('Unread')).toHaveText('Unread0')
  await expect(replies.first()).toContainText('The failing test was a timezone bug')
  await expect(chat(window).userMessages).toHaveCount(2)
  await expect(chat(window).userMessages.last()).toContainText(FOLLOW_UP)
  await expect(replies.last()).toContainText('The report header already goes through formatDate')

  // The window stays hidden throughout: an e2e run never shows it.
  const visible = await glade.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.isVisible()),
  )
  expect(visible).toEqual([false])
})
