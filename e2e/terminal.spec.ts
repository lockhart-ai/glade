// The terminal in the bottom bar, end to end on real shells (node-pty): e2e mode runs a plain bash with no profile,
// and a prompt of the folder's name. Each workspace has its own tabs. Nothing here waits on a timer: every step waits for the terminal to
// show what it should.
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { chooseFolder, expect, holdCommand, openWorkspace, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, contextMenu, inputBar, regions, removeWorkspaceDialog, taskList, taskPanel, terminal } from './selectors'

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
  await openWorkspace(window)
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

test('terminal: ⌃` opens the collapsed bottom bar with a new shell, and File › Close (⌘W) closes it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await openWorkspace(window)
  const term = terminal(window)
  await chooseMenuItem(glade, 'View', 'Toggle bottom bar')
  await expect(term.empty).toBeHidden()

  await window.keyboard.press('Control+Backquote')
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, PROMPT)).toHaveCount(1)
  await expect(term.screen.locator('textarea')).toBeFocused()

  // The menu bar answers ⌘W; with the focus in the terminal, it closes the tab rather than the window.
  await chooseMenuItem(glade, 'File', 'Close')
  await expect(term.tabs).toHaveCount(0)
  await expect(term.empty).toBeVisible()
})

// #265: this spec once pressed ⌃` straight after Open folder…, and on a slow CI runner the folder hadn't opened yet: the
// shell started, but in the fallback folder, so its prompt never read `acme-api $`. Holding main's answer recreates
// that order every time. The specs now wait for the workspace to open (`openWorkspace`) before they open a terminal.
test('terminal: the specs wait for the folder to open, since a shell opened before then starts in the fallback folder', async ({
  launch,
  tempFolder,
  userData,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  const term = terminal(window)
  const hold = await holdCommand(glade, CommandName.WorkspacesCreate)
  let opened = false
  const opening = openWorkspace(window).then(() => {
    opened = true
  })

  // The folder is on its way to main, and the wait holds: a spec goes no further while the folder is opening.
  await hold.reached()
  await expect(taskList(window).newTask).toBeHidden()
  expect(opened).toBe(false)

  // ⌃` now, as the spec used to press it, opens a shell in the fallback folder: never `acme-api $`.
  await window.keyboard.press('Control+Backquote')
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, `${basename(userData)} $`)).toHaveCount(1)
  await expect(line(window, PROMPT)).toHaveCount(0)

  // Once the folder has opened, the wait is over, and a new shell starts in the workspace. The shell opened with no
  // workspace open isn't the workspace's: it shows only while no workspace does.
  await hold.release()
  await opening
  await expect(term.empty).toBeVisible()
  await window.keyboard.press('Meta+KeyT')
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, PROMPT)).toHaveCount(1)
})

// #347: each workspace has its own terminal tabs. Switching shows them, with the one last picked there; the other
// workspaces' shells keep running, and what they print while hidden is there on the way back. A relaunch brings back
// each workspace's tabs, and removing a workspace ends its shells.
test('terminal: each workspace has its own tabs, and switching keeps the others’ shells running with their output', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const api = join(parent, 'acme-api')
  const web = join(parent, 'acme-web')
  mkdirSync(api)
  mkdirSync(web)
  const glade = await launch({ chosenFolder: api })
  const { window } = glade
  await openWorkspace(window)
  const term = terminal(window)
  const workspace = regions(window).workspace

  // acme-api gets two tabs, and the first is picked again.
  await term.newTab.click()
  await expect(line(window, 'acme-api $')).toHaveCount(1)
  await run(window, 'echo api-first')
  await window.keyboard.press('Meta+KeyT')
  await expect(term.tabs).toHaveText(['bash', 'bash'])
  await expect(line(window, 'acme-api $')).toHaveCount(1)
  await term.tabs.nth(0).click()
  await expect(line(window, 'api-first')).toHaveCount(1)

  // acme-web starts with none of acme-api's tabs, and gets its own, in its own root.
  await chooseFolder(glade, web)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('acme-web')
  await expect(term.tabs).toHaveCount(0)
  await expect(term.empty).toBeVisible()
  await term.newTab.click()
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, 'acme-web $')).toHaveCount(1)
  // It prints once a file appears, which the spec makes while acme-web is hidden.
  const go = join(parent, 'go')
  await run(window, `while [ ! -e ${go} ]; do sleep 0.1; done; echo web-while-hidden`)

  // Back in acme-api: its two tabs, the first still picked, with its output.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(workspace).toContainText('acme-api')
  await expect(term.tabs).toHaveText(['bash', 'bash'])
  await expect(term.tabs.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(line(window, 'api-first')).toHaveCount(1)
  writeFileSync(go, '')
  await expect(term.hiddenRows.filter({ hasText: /^web-while-hidden\s*$/ })).toHaveCount(1)

  // acme-web's shell kept running: what it printed is there, and it still answers.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-web')
  await expect(term.tabs).toHaveText(['bash'])
  await expect(line(window, 'web-while-hidden')).toHaveCount(1)
  await run(window, 'echo web-still-here')
  await expect(line(window, 'web-still-here')).toHaveCount(1)

  // A relaunch brings back each workspace's own tabs and output, and the tab picked in each.
  await glade.close()
  const relaunched = await launch({ chosenFolder: api })
  const again = terminal(relaunched.window)
  await expect(regions(relaunched.window).workspace).toContainText('acme-web')
  await expect(again.tabs).toHaveText(['bash'])
  await expect(line(relaunched.window, 'web-still-here')).toHaveCount(1)
  await chooseMenuItem(relaunched, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(again.tabs).toHaveText(['bash', 'bash'])
  await expect(again.tabs.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(line(relaunched.window, 'api-first')).toHaveCount(1)

  // Removing acme-api ends its shells: a program running in one stops, and acme-web's tab is all that's left.
  await again.tabs.nth(1).click()
  // Its restored prompt, above the divider, and its new shell's.
  await expect(line(relaunched.window, 'acme-api $')).toHaveCount(2)
  await run(relaunched.window, 'sleep 6347')
  await expect(again.tabs.nth(1)).toHaveAccessibleName('Running sleep')
  await chooseMenuItem(relaunched, 'Workspace', 'Remove from list…')
  await removeWorkspaceDialog(relaunched.window).confirm.click()
  await expect(regions(relaunched.window).workspace).toContainText('acme-web')
  await expect(again.tabs).toHaveText(['bash'])
  await run(relaunched.window, "while pgrep -f 'sleep 6347' > /dev/null; do sleep 0.1; done; echo api-sleep-ended")
  await expect(line(relaunched.window, 'api-sleep-ended')).toHaveCount(1)
})
