// The global terminal in the bottom bar, end to end on real shells (node-pty): e2e mode runs a plain bash with no
// profile, and a prompt of the folder's name. Nothing here waits on a timer: every step waits for the terminal to
// show what it should.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, contextMenu, firstRun, inputBar, taskList, taskPanel, terminal } from './selectors'

/** The prompt of a shell in the workspace `acme-api`. */
const PROMPT = 'acme-api $'

/** Types a line into the terminal showing, and presses ↵. */
async function run(window: Page, line: string): Promise<void> {
  await terminal(window).screen.click()
  await window.keyboard.type(line)
  await window.keyboard.press('Enter')
}

/** The line of the terminal showing that reads exactly `text` (trailing spaces aside). */
function line(window: Page, text: string) {
  return terminal(window).rows.filter({ hasText: new RegExp(`^${text.replace(/[$.]/g, '\\$&')}\\s*$`) })
}

test('terminal: tabs of real shells that start in the workspace, and survive a relaunch with their output', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root, agentScript: 'multi-tool-turn' })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const term = terminal(window)
  await expect(term.empty).toBeVisible()

  // + opens a shell in the workspace's root, with the focus in it.
  await term.newTab.click()
  await expect(term.tabs).toHaveText(['bash'])
  await expect(term.region).toContainText(root)
  await expect(line(window, PROMPT)).toHaveCount(1)
  await run(window, 'echo glade-e2e')
  await expect(line(window, 'glade-e2e')).toHaveCount(1)

  // ⌘T opens another tab, which shows; a program running in it puts a dot on it, and Kill process stops it.
  await window.keyboard.press('Meta+KeyT')
  await expect(term.tabs).toHaveText(['bash', 'bash'])
  await expect(term.tabs.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(line(window, PROMPT)).toHaveCount(1)
  await run(window, 'sleep 600')
  await expect(term.tabs.nth(1)).toHaveAccessibleName('Running sleep')
  const menu = contextMenu(window, 'Terminal tab actions')
  await term.tabs.nth(1).click({ button: 'right' })
  await expect(menu.items).toHaveText(['Rename…', 'Duplicate', 'Clear⌘K', 'Kill process⌃C', 'Close⌘W'])
  await menu.item('Kill process').click()
  await expect(term.tabs.nth(1)).toHaveAccessibleName('bash')
  await expect(line(window, PROMPT)).toHaveCount(1)

  // Rename… names the tab.
  await term.tabs.nth(1).click({ button: 'right' })
  await menu.item('Rename…').click()
  await term.renameField.fill('server')
  await term.renameField.press('Enter')
  await expect(term.tabs).toHaveText(['bash', 'server'])

  // ⌘K clears the tab showing; ⌃⇧⇥ goes back to the first, whose output is still there.
  await run(window, 'echo cleared-away')
  await expect(line(window, 'cleared-away')).toHaveCount(1)
  await window.keyboard.press('Meta+KeyK')
  await expect(line(window, 'cleared-away')).toHaveCount(0)
  await window.keyboard.press('Control+Shift+Tab')
  await expect(term.tab('bash')).toHaveAttribute('aria-pressed', 'true')
  await expect(line(window, 'glade-e2e')).toHaveCount(1)

  // A relaunch brings the tabs back, each with its output over a new shell.
  await glade.close()
  const relaunched = await launch({ agentScript: 'multi-tool-turn' })
  const again = terminal(relaunched.window)
  await expect(again.tabs).toHaveText(['bash', 'server'])
  await expect(line(relaunched.window, 'glade-e2e')).toHaveCount(1)
  await expect(again.rows.filter({ hasText: "Restored from the last session. Processes don't survive" })).toHaveCount(1)
  await expect(line(relaunched.window, PROMPT)).toHaveCount(2)

  // Run again in terminal puts a Bash call's command at the prompt of the tab showing, without running it.
  await taskList(relaunched.window).newTask.click()
  const bar = inputBar(relaunched.window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')
  await expect(chat(relaunched.window).agentReplies).toHaveCount(1)
  await taskPanel(relaunched.window)
    .call(/^Done\s*Bash\s*npm test/)
    .click({ button: 'right' })
  await contextMenu(relaunched.window, 'Tool call actions').item('Run again in terminal').click()
  await expect(line(relaunched.window, `${PROMPT} npm test`)).toHaveCount(1)
  await expect(again.screen.locator('textarea')).toBeFocused()
})

test('terminal: ⌃` opens the collapsed bottom bar with a new shell, and ⌘W closes it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ chosenFolder: root })
  await firstRun(window).openFolder.click()
  const term = terminal(window)
  await window.keyboard.press('Meta+KeyJ')
  await expect(term.empty).toBeHidden()

  await window.keyboard.press('Control+Backquote')
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, PROMPT)).toHaveCount(1)
  await expect(term.screen.locator('textarea')).toBeFocused()

  await window.keyboard.press('Meta+KeyW')
  await expect(term.tabs).toHaveCount(0)
  await expect(term.empty).toBeVisible()
})
