import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { chooseFolder, clickNotification, desktop, expect, notifications, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, regions, taskHeader, taskList, workspaceSwitcher } from './selectors'
import { invoke } from './task-view'

/** Workspace A's task's first message: it plays `long-running`, which works until it's stopped. */
const RUN_SUITE = 'Run the e2e suite.'
/** Workspace B's task's first message: it plays `simple-reply`. */
const ASK_RETRIES = 'How does the client retry?'
/** What A's agent is told once it's stopped: its second turn answers it. */
const UNIT_ONLY = 'Only run the unit tests.'
const A_TITLE = 'Run the e2e suite'
const B_TITLE = 'Explain the retry policy'

test('several workspaces: switching restores each one’s task, and background tasks keep running and notifying', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const rootA = join(parent, 'acme-api')
  const rootB = join(parent, 'acme-web')
  mkdirSync(rootA)
  mkdirSync(rootB)
  const glade = await launch({
    agentScriptsByFirstMessage: { [RUN_SUITE]: 'long-running', [ASK_RETRIES]: 'simple-reply' },
    chosenFolder: rootA,
  })
  const { window } = glade
  const switcher = workspaceSwitcher(window)
  const header = taskHeader(window)
  const list = taskList(window)
  const bar = inputBar(window)
  const workspace = regions(window).workspace
  await firstRun(window).openFolder.click()
  await expect(workspace).toContainText('acme-api')

  // Workspace › New workspace… (⌘⇧N) adds a second workspace from the folder dialog and shows it, with nothing
  // selected yet.
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('acme-web')
  await list.newTask.click()
  await bar.field.fill(ASK_RETRIES)
  await bar.field.press('Enter')
  await expect(header.title).toHaveText(B_TITLE)

  // Switch workspace › acme-api (⌘1) goes back to A, which had no task selected; start a long turn there.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(workspace).toContainText('acme-api')
  await expect(header.title).toHaveCount(0)
  await list.newTask.click()
  await bar.field.fill(RUN_SUITE)
  await bar.field.press('Enter')
  await expect(header.title).toHaveText(A_TITLE)
  await expect(bar.stop).toBeVisible()

  // Switching to B (⌘2) while A keeps working: B's own task is back, and the switcher shows A still active.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-web')
  await expect(workspace).toContainText('acme-web')
  await expect(header.title).toHaveText(B_TITLE)
  await expect(chat(window).agentReplies.first()).toContainText('The client retries idempotent requests')
  await switcher.trigger.click()
  await expect(switcher.rows).toHaveText([/^Aacme-api.*1 active$/, /^Aacme-web.*1 needs you$/])
  await expect(switcher.row('acme-web')).toHaveAttribute('aria-checked', 'true')
  await window.keyboard.press('Escape')
  await expect(switcher.menu).toHaveCount(0)

  // A's agent replies while you're in B (stopped and told to change course, as if from elsewhere): it notifies, and
  // the switcher shows A needs you.
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  const taskA = tasks[0]?.id ?? ''
  await invoke(window, CommandName.TasksStop, { id: taskA })
  await invoke(window, CommandName.TasksSend, { id: taskA, text: UNIT_ONLY })
  await expect.poll(() => notifications(glade)).toHaveLength(1)
  const [shown] = await notifications(glade)
  expect(shown).toMatchObject({ title: A_TITLE })
  expect(shown?.body).toMatch(/^Understood\. I stopped the suite/)
  await switcher.trigger.click()
  await expect(switcher.row('acme-api')).toHaveText(/1 needs you$/)

  // Reveal root in Finder shows B's root.
  await switcher.action('Reveal root in Finder').click()
  await expect.poll(async () => (await desktop(glade)).revealed).toEqual([rootB])

  // Clicking the notification switches back to A and opens its task, the reply in it.
  await clickNotification(glade, 0)
  await expect(workspace).toContainText('acme-api')
  await expect(header.title).toHaveText(A_TITLE)
  await expect(chat(window).agentReplies.last()).toContainText('I stopped the suite')

  // With the task list collapsed (⌘B), there's no header to open the switcher from, but the menu bar still switches.
  await chooseMenuItem(glade, 'View', 'Toggle task list')
  await expect(regions(window).sidebar).toHaveCount(0)
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-web')
  await expect(header.title).toHaveText(B_TITLE)
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(header.title).toHaveText(A_TITLE)
  await chooseMenuItem(glade, 'View', 'Toggle task list')
  await expect(workspace).toContainText('acme-api')

  // After a relaunch both workspaces are there, A still shows its task, and switching to B brings B's back.
  await glade.close()
  const relaunched = await launch()
  const again = workspaceSwitcher(relaunched.window)
  await expect(regions(relaunched.window).workspace).toContainText('acme-api')
  await expect(taskHeader(relaunched.window).title).toHaveText(A_TITLE)
  await again.trigger.click()
  await expect(again.rows).toHaveText([/^Aacme-api.*1 needs you$/, /^Aacme-web.*1 needs you$/])
  await again.row('acme-web').click()
  await expect(regions(relaunched.window).workspace).toContainText('acme-web')
  await expect(taskHeader(relaunched.window).title).toHaveText(B_TITLE)
})
