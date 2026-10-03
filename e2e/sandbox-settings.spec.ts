// The sandbox in Settings (P15-06, #451), end to end with the scripted agent: the switch in Settings › Agent, which a
// task's next session reads; the Glade-wide lists there and a workspace's in its own section, each change reaching the
// running sessions it covers without restarting them; and all of it kept across a relaunch.
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { agentFlagSettings, agentSessions, chooseFolder, expect, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, settings, taskList, workspaceSwitcher } from './selectors'
import { invoke } from './task-view'

/** A path as Settings shows it: under the home folder, from `~`. */
function shown(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

/** A folder under `parent`, made, as the sandbox keeps it: where it really is (`/var` is `/private/var`). */
function folder(parent: string, name: string): string {
  const path = join(parent, name)
  mkdirSync(path)
  return realpathSync.native(path)
}

/** Starts a new task with a message, and waits for the agent's reply: its session is then running, between turns. */
async function startTask(window: Page, message: string): Promise<void> {
  await taskList(window).newTask.click()
  await inputBar(window).field.fill(message)
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.last()).toContainText('The client retries idempotent requests')
}

/** What the newest change to a running session's sandbox allows: the folders it reads and writes, and its rules. */
async function latestGrants(glade: Glade): Promise<{ read: string[]; write: string[]; rules: string[] }> {
  const latest = (await agentFlagSettings(glade)).at(-1)
  return {
    read: [...(latest?.sandbox?.filesystem?.allowRead ?? [])],
    write: [...(latest?.sandbox?.filesystem?.allowWrite ?? [])],
    rules: [...(latest?.permissions?.allow ?? [])],
  }
}

test('the Sandbox switch is read by a task’s next session, and the Glade-wide lists reach running tasks and survive a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = folder(tempFolder(), 'acme-api')
  const toolchain = folder(tempFolder(), 'toolchain')
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  // Whatever the default (off until P15's last PR), this starts with the sandbox off.
  await invoke(window, CommandName.SettingsUpdate, { patch: { sandboxEnabled: false } })
  const modal = settings(window)
  const toggle = modal.toggle('Run agents in a sandbox')

  // Off: a task's session starts unsandboxed, as before the sandbox.
  await startTask(window, 'How does the client retry?')
  expect((await agentSessions(glade)).map(({ flagSettings }) => flagSettings)).toEqual([null])

  // Settings › Agent has the Sandbox group: the switch, off, over both lists, empty, dimmed and disabled.
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await expect(modal.heading).toHaveText('Agent')
  await expect(modal.sandbox.getByRole('heading', { name: 'Sandbox' })).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await expect(modal.grantList('Glade-wide folders')).toContainText('No folders yet.')
  await expect(modal.grantList('Glade-wide domains')).toContainText('No domains yet.')
  await expect(modal.addGrant('Add a Glade-wide folder')).toBeDisabled()
  await expect(modal.addGrant('Add a Glade-wide domain')).toBeDisabled()
  await expect(modal.sandbox).toContainText('While the sandbox is off, agents can use any folder and reach any domain')

  // On: the lists can be changed, and the next task's session starts in the sandbox. The running one keeps what it
  // started with.
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(modal.addGrant('Add a Glade-wide folder')).toBeEnabled()
  await expect(modal.sandbox).toContainText('Each workspace has its own folders and domains too')
  await modal.close.click()
  await startTask(window, 'And how does it time out?')
  const sessions = await agentSessions(glade)
  expect(sessions).toHaveLength(2)
  expect(sessions[1]?.flagSettings?.sandbox).toMatchObject({ enabled: true })
  expect(await latestGrants(glade)).toEqual({ read: [root], write: [root], rules: [] })

  // Add… a Glade-wide folder: the folder picker, then a row to pick its access, read-only to start.
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await chooseFolder(glade, toolchain)
  await modal.addGrant('Add a Glade-wide folder').click()
  const pending = modal.grantRow('Glade-wide folders', `New folder ${shown(toolchain)}`)
  await expect(pending.getByRole('button', { name: 'Add', exact: true })).toBeFocused()
  await expect(modal.grantAccess(shown(toolchain))).toHaveText('Read-only')
  await pending.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(modal.grantRows('Glade-wide folders')).toHaveCount(1)
  await expect(modal.grantRow('Glade-wide folders', shown(toolchain))).toBeVisible()
  // The running sandboxed task has it at once, read-only, without a new session.
  await expect.poll(() => latestGrants(glade)).toMatchObject({ read: [root, toolchain], write: [root] })
  expect(await agentSessions(glade)).toHaveLength(2)

  // Its access changes from its select, and the task has that at once too.
  await modal.grantAccess(shown(toolchain)).click()
  await window.getByRole('menuitemradio', { name: 'Read-write', exact: true }).click()
  await expect(modal.grantAccess(shown(toolchain))).toHaveText('Read-write')
  await expect.poll(() => latestGrants(glade)).toMatchObject({ read: [root, toolchain], write: [root, toolchain] })

  // The same folder again is refused, with why, and a cancelled picker adds nothing.
  await modal.addGrant('Add a Glade-wide folder').click()
  await modal.grantList('Glade-wide folders').getByRole('button', { name: 'Add', exact: true }).click()
  await expect(modal.grantError).toHaveText('That folder is already in the list.')
  await modal.grantList('Glade-wide folders').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(modal.grantError).toHaveCount(0)
  await chooseFolder(glade, null)
  await modal.addGrant('Add a Glade-wide folder').click()
  await expect(modal.grantRows('Glade-wide folders')).toHaveCount(1)

  // Add… a domain: a field in a row. What isn't a domain is refused with why; a wildcard is taken.
  await modal.addGrant('Add a Glade-wide domain').click()
  await expect(modal.newDomain).toBeFocused()
  await modal.newDomain.fill('https://example.com/docs')
  await modal.newDomain.press('Enter')
  await expect(modal.grantError).toHaveText('Can\'t grant "https://example.com/docs": not a domain')
  await modal.newDomain.fill('*.Example.com')
  await modal.newDomain.press('Enter')
  await expect(modal.grantError).toHaveCount(0)
  await expect(modal.grantRow('Glade-wide domains', '*.example.com')).toBeVisible()
  await expect.poll(async () => (await latestGrants(glade)).rules).toContain('WebFetch(domain:*.example.com)')
  await modal.addGrant('Add a Glade-wide domain').click()
  await modal.newDomain.fill('pypi.org')
  await modal.grantRow('Glade-wide domains', 'New domain').getByRole('button', { name: 'Add', exact: true }).click()
  await expect(modal.grantRows('Glade-wide domains')).toHaveText(['*.example.com', 'pypi.org'])

  // Removing takes it from the running task.
  await modal.dialog.getByRole('button', { name: 'Remove *.example.com', exact: true }).click()
  await expect(modal.grantRows('Glade-wide domains')).toHaveText(['pypi.org'])
  await expect.poll(async () => (await latestGrants(glade)).rules).toEqual(['WebFetch(domain:pypi.org)'])

  // Off again: the lists dim, keeping what's granted.
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(modal.grantRow('Glade-wide folders', shown(toolchain))).toBeVisible()
  await expect(modal.dialog.getByRole('button', { name: 'Remove pypi.org', exact: true })).toBeDisabled()
  await expect(modal.grantAccess(shown(toolchain))).toBeDisabled()
  await toggle.click()
  await expect(toggle).toBeChecked()

  // A relaunch keeps the switch and both lists.
  await glade.close()
  const relaunched = await launch()
  const again = settings(relaunched.window)
  await chooseMenuItem(relaunched, 'Glade', 'Settings…')
  await expect(again.toggle('Run agents in a sandbox')).toBeChecked()
  await expect(again.grantRows('Glade-wide folders')).toHaveCount(1)
  await expect(again.grantAccess(shown(toolchain))).toHaveText('Read-write')
  await expect(again.grantRows('Glade-wide domains')).toHaveText(['pypi.org'])

  // Removing the folder leaves its list empty again.
  await again.dialog.getByRole('button', { name: `Remove ${shown(toolchain)}`, exact: true }).click()
  await expect(again.grantList('Glade-wide folders')).toContainText('No folders yet.')
})

test('Settings › Workspace lists the root, then the workspace’s own folders and domains, changed with the keyboard alone', async ({
  launch,
  tempFolder,
}) => {
  const root = folder(tempFolder(), 'acme-api')
  const shared = folder(tempFolder(), 'acme-shared')
  const inside = folder(root, 'packages')
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await invoke(window, CommandName.SettingsUpdate, { patch: { sandboxEnabled: true } })
  await startTask(window, 'How does the client retry?')
  expect(await latestGrants(glade)).toEqual({ read: [root], write: [root], rules: [] })
  const modal = settings(window)

  const switcher = workspaceSwitcher(window)
  await switcher.trigger.click()
  await switcher.action('Workspace settings…').click()
  await expect(modal.heading).toHaveText('acme-api')
  await expect(modal.sandbox).toContainText('Allow for this workspace, on a permission card, adds here.')

  // The root is first: tagged, read-write, with nothing to change or remove.
  const rootRow = modal.grantRow('Folders', shown(root))
  await expect(modal.grantRows('Folders')).toHaveCount(1)
  await expect(rootRow).toContainText('Workspace root')
  await expect(rootRow).toContainText('Read-write')
  await expect(rootRow.getByRole('button')).toHaveCount(0)
  await expect(modal.grantList('Domains')).toContainText('No domains yet.')

  // A folder inside the root is refused: the workspace's agents can already use it.
  await chooseFolder(glade, inside)
  await modal.addGrant('Add a folder').focus()
  await window.keyboard.press('Enter')
  await expect(
    modal.grantRow('Folders', `New folder ${shown(inside)}`).getByRole('button', { name: 'Add' }),
  ).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(modal.grantError).toHaveText(
    'That folder is inside the workspace root, which its agents can already use.',
  )
  // Tab to Cancel, and ↵: the row closes, and Add… has the focus again.
  await window.keyboard.press('Tab')
  await window.keyboard.press('Enter')
  await expect(modal.grantRows('Folders')).toHaveCount(1)
  await expect(modal.addGrant('Add a folder')).toBeFocused()

  // A folder outside it is added, by the keyboard alone: ↵ on Add…, the picker, then ↵ on Add.
  await chooseFolder(glade, shared)
  await window.keyboard.press('Enter')
  await expect(
    modal.grantRow('Folders', `New folder ${shown(shared)}`).getByRole('button', { name: 'Add' }),
  ).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(modal.grantRows('Folders')).toHaveText([/Workspace root/, /Read-only/])
  await expect(modal.grantRow('Folders', shown(shared))).toBeVisible()
  await expect(modal.addGrant('Add a folder')).toBeFocused()
  await expect.poll(() => latestGrants(glade)).toMatchObject({ read: [root, shared], write: [root] })

  // Its access, from its select: ↵ opens the menu, ↓ ↓ and ↵ choose Read-write.
  await modal.grantAccess(shown(shared)).focus()
  await window.keyboard.press('Enter')
  const access = window.getByRole('menu', { name: 'Access' })
  await expect(access).toBeFocused()
  await window.keyboard.press('ArrowDown')
  await expect(access.getByRole('menuitemradio', { name: 'Read-only', exact: true })).toBeFocused()
  await window.keyboard.press('ArrowDown')
  await expect(access.getByRole('menuitemradio', { name: 'Read-write', exact: true })).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(modal.grantAccess(shown(shared))).toHaveText('Read-write')
  await expect.poll(() => latestGrants(glade)).toMatchObject({ write: [root, shared] })

  // A domain: ↵ on Add…, type, ↵. Esc in the field closes the row, not Settings.
  await modal.addGrant('Add a domain').focus()
  await window.keyboard.press('Enter')
  await expect(modal.newDomain).toBeFocused()
  await window.keyboard.type('github.co')
  await window.keyboard.press('Escape')
  await expect(modal.newDomain).toHaveCount(0)
  await expect(modal.dialog).toBeVisible()
  await expect(modal.addGrant('Add a domain')).toBeFocused()
  await window.keyboard.press('Enter')
  await window.keyboard.type('github.com')
  await window.keyboard.press('Enter')
  await expect(modal.grantRows('Domains')).toHaveText(['github.com'])
  await expect.poll(async () => (await latestGrants(glade)).rules).toEqual(['WebFetch(domain:github.com)'])

  // The workspace's grants aren't Glade-wide: Agent's lists are still empty.
  await modal.section('Agent').click()
  await expect(modal.grantList('Glade-wide folders')).toContainText('No folders yet.')
  await expect(modal.grantList('Glade-wide domains')).toContainText('No domains yet.')
  // With the switch off, the workspace's lists dim too.
  await modal.toggle('Run agents in a sandbox').click()
  await modal.section('acme-api').click()
  await expect(modal.sandbox).toContainText('The sandbox is off in Agent, so these are dimmed too.')
  await expect(modal.addGrant('Add a folder')).toBeDisabled()
  await expect(modal.grantAccess(shown(shared))).toBeDisabled()
  await modal.section('Agent').click()
  await modal.toggle('Run agents in a sandbox').click()
  await modal.section('acme-api').click()

  // Removing, by the keyboard: ↵ on a row's ×, and Add… takes the focus.
  await modal.dialog.getByRole('button', { name: `Remove ${shown(shared)}`, exact: true }).focus()
  await window.keyboard.press('Enter')
  await expect(modal.grantRows('Folders')).toHaveCount(1)
  await expect(modal.addGrant('Add a folder')).toBeFocused()
  await modal.dialog.getByRole('button', { name: 'Remove github.com', exact: true }).focus()
  await window.keyboard.press('Enter')
  await expect(modal.grantList('Domains')).toContainText('No domains yet.')
  await expect.poll(() => latestGrants(glade)).toEqual({ read: [root], write: [root], rules: [] })
  // The same session throughout: nothing restarted.
  expect(await agentSessions(glade)).toHaveLength(1)
})
