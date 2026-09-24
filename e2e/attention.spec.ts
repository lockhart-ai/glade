import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList } from './selectors'

/** The title the multi-tool-turn agent gives its task. */
const ASKED = 'Fix the flaky date test'
/** What a task without a title yet is called. */
const NEW_TASK = 'New task'

/** Checks whether a task's row shows as unread: a bold title and the blue dot. */
async function expectUnread(row: Locator, title: string, unread: boolean): Promise<void> {
  await expect(row.getByRole('img', { name: 'Unread' })).toHaveCount(unread ? 1 : 0)
  await expect(row.getByText(title, { exact: true })).toHaveCSS('font-weight', unread ? '600' : '500')
}

test('unread and needs you: a reply in a task you left marks it, the chips filter to it, and opening it reads it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  let window = first.window
  await firstRun(window).openFolder.click()
  let list = taskList(window)

  // Task A: ask it something, then move to a new task B before the agent replies.
  await list.newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')
  await list.newTask.click()
  await expect(chat(window).newTaskPrompt).toBeVisible()

  // A's reply arrives while you're on B: A goes bold with the blue dot, and counts under Needs you and Unread. B has
  // never run, so it doesn't need you.
  const asked = list.row(ASKED)
  await expect(asked.getByRole('img', { name: 'Unread' })).toBeVisible()
  await expect(list.row(NEW_TASK)).toHaveAttribute('aria-current', 'true')
  await expectUnread(asked, ASKED, true)
  await expectUnread(list.row(NEW_TASK), NEW_TASK, false)
  await expect(list.filter('Needs you')).toHaveText('Needs you1')
  await expect(list.filter('Unread')).toHaveText('Unread1')
  await expect(list.filter('All')).toHaveAttribute('aria-pressed', 'true')

  // The chips filter the list.
  await list.filter('Needs you').click()
  await expect(list.filter('Needs you')).toHaveAttribute('aria-pressed', 'true')
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(list.rows('Active').first()).toContainText(ASKED)
  await list.filter('Unread').click()
  await expect(list.filter('Unread')).toHaveAttribute('aria-pressed', 'true')
  await expect(list.filter('Needs you')).toHaveAttribute('aria-pressed', 'false')
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(list.rows('Active').first()).toContainText(ASKED)

  // Quit and relaunch: A is still unread, the counts hold, and the Unread filter is still chosen.
  await first.close()
  ;({ window } = await launch({ agentScript: 'multi-tool-turn' }))
  list = taskList(window)
  await expect(list.filter('Unread')).toHaveAttribute('aria-pressed', 'true')
  await expect(list.rows('Active')).toHaveCount(1)
  await expectUnread(list.row(ASKED), ASKED, true)
  await expect(list.filter('Needs you')).toHaveText('Needs you1')
  await expect(list.filter('Unread')).toHaveText('Unread1')
  await list.filter('All').click()
  await expect(list.rows('Active')).toHaveCount(2)

  // Opening A reads it. It still needs you: its agent is waiting on you.
  await list.row(ASKED).click()
  await expect(taskHeader(window).title).toHaveText(ASKED)
  await expectUnread(list.row(ASKED), ASKED, false)
  await expect(list.filter('Unread')).toHaveText('Unread0')
  await expect(list.filter('Needs you')).toHaveText('Needs you1')

  // ⌘⇧U marks it unread again, and it stays unread while you view it, until you next open it.
  await window.keyboard.press('Meta+Shift+U')
  await expect(list.filter('Unread')).toHaveText('Unread1')
  await expectUnread(list.row(ASKED), ASKED, true)
  await expect(list.row(ASKED)).toHaveAttribute('aria-current', 'true')
  await list.row(NEW_TASK).click()
  await expect(list.row(NEW_TASK)).toHaveAttribute('aria-current', 'true')
  await expectUnread(list.row(ASKED), ASKED, true)
  await list.row(ASKED).click()
  await expectUnread(list.row(ASKED), ASKED, false)
  await expect(list.filter('Unread')).toHaveText('Unread0')
})
