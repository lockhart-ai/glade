import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Locator } from '@playwright/test'
import { expect, sendAndOpenNewTask, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { firstRun, inputBar, taskHeader, taskList } from './selectors'

/** The title the multi-tool-turn agent gives its task. */
const ASKED = 'Fix the flaky date test'
/** What a task without a title yet is called. */
const NEW_TASK = 'New task'

/**
 * Stores a sidebar filter in the app's database, as a version before #411 did when you picked a chip: the `ui_state`
 * row `task_filter`. The app must be closed.
 */
function storeOldTaskFilter(userData: string, value: string): void {
  const db = new DatabaseSync(join(userData, 'glade.db'))
  try {
    db.prepare("INSERT INTO ui_state (key, value) VALUES ('task_filter', ?)").run(value)
  } finally {
    db.close()
  }
}

/** Checks whether a task's row shows as unread: a bold title and the blue dot. */
async function expectUnread(row: Locator, title: string, unread: boolean): Promise<void> {
  await expect(row.getByRole('img', { name: 'Unread' })).toHaveCount(unread ? 1 : 0)
  await expect(row.getByText(title, { exact: true })).toHaveCSS('font-weight', unread ? '600' : '500')
}

test('unread and needs you: a reply in a task you left marks its row, with no filter chips, and opening it reads it', async ({
  launch,
  tempFolder,
  userData,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  let window = first.window
  await firstRun(window).openFolder.click()
  let list = taskList(window)

  // Task A: ask it something, then move to a new task B before the agent replies.
  await list.newTask.click()
  await sendAndOpenNewTask(first, 'The date test is flaky. Can you fix it?')

  // A's reply arrives while you're on B: A goes bold with the blue dot. B has never run, so it doesn't need you.
  const asked = list.taskRow(ASKED)
  await expect(asked.getByRole('img', { name: 'Unread' })).toBeVisible()
  await expect(list.taskRow(NEW_TASK)).toHaveAttribute('aria-current', 'true')
  await expectUnread(asked, ASKED, true)
  await expectUnread(list.taskRow(NEW_TASK), NEW_TASK, false)

  // The sidebar has no filter chips (#411): the list goes straight from the search field to the sections, and shows
  // both tasks.
  await expect(list.filterChips).toHaveCount(0)
  await expect(window.getByRole('group', { name: 'Filter tasks' })).toHaveCount(0)
  await expect(list.rows('Active')).toHaveCount(2)

  // Quit, and relaunch over a database whose list was filtered to Unread by an older version: A is still unread, and
  // the list shows every task all the same, the read one included.
  await first.close()
  storeOldTaskFilter(userData, 'unread')
  const second = await launch({ agentScript: 'multi-tool-turn' })
  ;({ window } = second)
  list = taskList(window)
  await expectUnread(list.taskRow(ASKED), ASKED, true)
  await expect(list.rows('Active')).toHaveCount(2)
  await expect(list.row('Active', NEW_TASK)).toBeVisible()
  await expect(list.row('Active', ASKED)).toBeVisible()
  await expect(list.filterChips).toHaveCount(0)

  // ⌘⌥↓ still jumps to the next task that needs you: from B, which doesn't, to A. Opening A reads it.
  await expect(list.taskRow(NEW_TASK)).toHaveAttribute('aria-current', 'true')
  await inputBar(window).field.blur()
  await window.keyboard.press('Meta+Alt+ArrowDown')
  await expect(list.taskRow(ASKED)).toHaveAttribute('aria-current', 'true')
  await expect(taskHeader(window).title).toHaveText(ASKED)
  await expectUnread(list.taskRow(ASKED), ASKED, false)
  // Nothing else needs you, so it stays put.
  await window.keyboard.press('Meta+Alt+ArrowDown')
  await expect(list.taskRow(ASKED)).toHaveAttribute('aria-current', 'true')

  // Task › Mark as unread (⌘⇧U) marks it unread again, and it stays unread while you view it, until you next open it.
  await chooseMenuItem(second, 'Task', 'Mark as unread')
  await expectUnread(list.taskRow(ASKED), ASKED, true)
  await expect(list.taskRow(ASKED)).toHaveAttribute('aria-current', 'true')
  await list.taskRow(NEW_TASK).click()
  await expect(list.taskRow(NEW_TASK)).toHaveAttribute('aria-current', 'true')
  await expectUnread(list.taskRow(ASKED), ASKED, true)
  await expect(list.rows('Active')).toHaveCount(2)
  await list.taskRow(ASKED).click()
  await expectUnread(list.taskRow(ASKED), ASKED, false)
})
