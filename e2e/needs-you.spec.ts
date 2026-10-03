// What "needs you" means (#430, corrected by #461), end to end with the scripted agent: a task needs you when it's
// blocked on you (a question, a permission card, an error) or has a reply you haven't read, whether or not it left
// subagents or watchers running in the background; a read reply with nothing running is idle, and with background
// work still running is working. Each is read off the two places the rule shows first, the workspace switcher's
// count and the sidebar row's dot (with the header's dot, the menu bar's count and ⌘⌥↓ along the way), and again
// after a relaunch.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { PERMISSION_AT_QUIT, STOP_SPARES_BACKGROUND } from '../src/main/agent/scripts'
import { clickMenuBarIcon, expect, menuBarIcon, sendAndOpenNewTask, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import {
  chat,
  contextMenu,
  firstRun,
  inputBar,
  menuBarPopover,
  subagentsTab,
  taskHeader,
  taskList,
  taskPanel,
  watchersTab,
  workspaceSwitcher,
} from './selectors'

/** The workspace every test opens: a folder named for it, under the test's own temporary folder. */
const WORKSPACE = 'acme-api'
/** What a task without a title yet is called. */
const NEW_TASK = 'New task'
/** The titles the scripted agents give their tasks (`src/main/agent/scripts.ts`). */
const FLAKY = 'Fix the flaky date test'
const RELEASE_NOTES = 'Draft release notes for 2.4'
const LOGIN_TEST = 'Fix flaky login test'
const DOCS = 'Build the docs site'

function workspaceRoot(tempFolder: () => string): string {
  const root = join(tempFolder(), WORKSPACE)
  mkdirSync(root)
  return root
}

/** Opens the first-run folder as the workspace, and a new task in it. */
async function openWorkspace(window: Page): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
}

async function send(window: Page, message: string): Promise<void> {
  const bar = inputBar(window)
  await bar.field.fill(message)
  await bar.field.press('Enter')
}

/** Checks what the workspace switcher says of the workspace: "1 needs you", "2 active". */
async function expectSwitcher(window: Page, status: string): Promise<void> {
  const switcher = workspaceSwitcher(window)
  await switcher.trigger.click()
  await expect(switcher.row(WORKSPACE)).toContainText(new RegExp(`${status}$`))
  await window.keyboard.press('Escape')
  await expect(switcher.menu).toHaveCount(0)
}

/** Checks a task's dot in the sidebar: `waiting` is the purple needs-you dot. */
async function expectDot(window: Page, title: string, state: 'waiting' | 'working' | 'idle' | 'error'): Promise<void> {
  const list = taskList(window)
  await expect(list.dot(list.taskRow(title))).toHaveAttribute('data-state', state)
}

/** Checks the count beside Glade's icon in the menu bar: how many tasks need you, or nothing. */
async function expectMenuBarCount(glade: Glade, count: string): Promise<void> {
  await expect.poll(async () => (await menuBarIcon(glade)).title).toBe(count)
}

test('a reply needs you while it is unread, not once you have read it, and again when marked unread, across relaunches', async ({
  launch,
  tempFolder,
}) => {
  const first = await launch({ agentScript: 'multi-tool-turn', chosenFolder: workspaceRoot(tempFolder) })
  await openWorkspace(first.window)

  // The reply arrives while you're in another task: unread, so it needs you. The new task never has run, so it's idle.
  await sendAndOpenNewTask(first, 'The date test is flaky. Can you fix it?')
  await expectDot(first.window, FLAKY, 'waiting')
  await expectDot(first.window, NEW_TASK, 'idle')
  await expect(taskHeader(first.window).stateDot).toHaveAccessibleName('Active · idle')
  await expectSwitcher(first.window, '1 needs you')
  await expectMenuBarCount(first, '1')
  await first.close()

  // The same after a relaunch.
  const second = await launch({ agentScript: 'multi-tool-turn' })
  await expectDot(second.window, FLAKY, 'waiting')
  await expectDot(second.window, NEW_TASK, 'idle')
  await expectSwitcher(second.window, '1 needs you')
  await expectMenuBarCount(second, '1')

  // Opening it reads the reply: it no longer needs you, and nothing is running, so it's idle and only active.
  const list = taskList(second.window)
  await list.taskRow(FLAKY).click()
  await expect(taskHeader(second.window).title).toHaveText(FLAKY)
  await expectDot(second.window, FLAKY, 'idle')
  await expect(taskHeader(second.window).stateDot).toHaveAccessibleName('Active · idle')
  await expectSwitcher(second.window, '2 active')
  await expectMenuBarCount(second, '')
  // Next task that needs you has nowhere to go.
  await inputBar(second.window).field.blur()
  await second.window.keyboard.press('Meta+Alt+ArrowDown')
  await expect(list.taskRow(FLAKY)).toHaveAttribute('aria-current', 'true')
  await second.close()

  // Read stays read across a relaunch.
  const third = await launch({ agentScript: 'multi-tool-turn' })
  await expectDot(third.window, FLAKY, 'idle')
  await expectSwitcher(third.window, '2 active')
  await expectMenuBarCount(third, '')

  // Mark as unread makes it need you again, while you still view it.
  await chooseMenuItem(third, 'Task', 'Mark as unread')
  await expectDot(third.window, FLAKY, 'waiting')
  await expect(taskHeader(third.window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await expectSwitcher(third.window, '1 needs you')
  await expectMenuBarCount(third, '1')
  await third.close()

  // And that's kept too: a relaunch restores the selection without opening the task.
  const fourth = await launch({ agentScript: 'multi-tool-turn' })
  await expectDot(fourth.window, FLAKY, 'waiting')
  await expectSwitcher(fourth.window, '1 needs you')
})

test('a question needs you though you are viewing the task, across a relaunch', async ({ launch, tempFolder }) => {
  const first = await launch({ agentScript: 'asks-a-question', chosenFolder: workspaceRoot(tempFolder) })
  await openWorkspace(first.window)
  await send(first.window, 'Draft the release notes for 2.4.')

  await expect(chat(first.window).questionCard).toBeVisible()
  await expectDot(first.window, RELEASE_NOTES, 'waiting')
  await expect(taskHeader(first.window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await expectSwitcher(first.window, '1 needs you')
  await expectMenuBarCount(first, '1')
  await first.close()

  const second = await launch({ agentScript: 'asks-a-question' })
  await expect(chat(second.window).questionCard).toBeVisible()
  await expectDot(second.window, RELEASE_NOTES, 'waiting')
  await expect(taskHeader(second.window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await expectSwitcher(second.window, '1 needs you')
  await expectMenuBarCount(second, '1')
})

test('a permission card needs you though you are viewing the task, across a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const first = await launch({ agentScript: 'permission-at-quit', chosenFolder: workspaceRoot(tempFolder) })
  await openWorkspace(first.window)
  const bar = inputBar(first.window)
  await bar.setting('Permissions').click()
  await bar.option('Ask before edits and commands').click()
  await send(first.window, 'Run the pending migrations.')

  const command = (window: Page) => chat(window).permissionCards.first().getByLabel('Command')
  await expect(command(first.window)).toHaveText(PERMISSION_AT_QUIT.command)
  const list = taskList(first.window)
  await expect(list.dot(list.current)).toHaveAttribute('data-state', 'waiting')
  await expect(taskHeader(first.window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await expectSwitcher(first.window, '1 needs you')
  await expectMenuBarCount(first, '1')
  await first.close()

  const second = await launch({ agentScript: 'permission-at-quit' })
  await expect(command(second.window)).toHaveText(PERMISSION_AT_QUIT.command)
  const again = taskList(second.window)
  await expect(again.dot(again.current)).toHaveAttribute('data-state', 'waiting')
  await expect(taskHeader(second.window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await expectSwitcher(second.window, '1 needs you')
  await expectMenuBarCount(second, '1')
})

test('an error needs you though you have seen it, across a relaunch', async ({ launch, tempFolder }) => {
  const first = await launch({ agentScript: 'flaky-api', chosenFolder: workspaceRoot(tempFolder) })
  await openWorkspace(first.window)
  await send(first.window, 'test_login_redirect fails about one run in ten on CI. Find out why and fix it.')

  await expect(chat(first.window).errorCard).toBeVisible()
  await expectDot(first.window, LOGIN_TEST, 'error')
  await expect(taskHeader(first.window).stateDot).toHaveAccessibleName('Active · stopped by an error')
  await expectSwitcher(first.window, '1 needs you')
  await expectMenuBarCount(first, '1')
  await first.close()

  const second = await launch({ agentScript: 'flaky-api' })
  await expect(chat(second.window).errorCard).toBeVisible()
  await expectDot(second.window, LOGIN_TEST, 'error')
  await expectSwitcher(second.window, '1 needs you')
  await expectMenuBarCount(second, '1')
})

test('a read reply with a subagent and a watcher still running is working, until both have ended', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'stop-spares-background', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await openWorkspace(window)
  await send(window, STOP_SPARES_BACKGROUND.prompt)
  const { title } = STOP_SPARES_BACKGROUND

  // Its turn has ended with a reply you're looking at, and its send button is back; but its subagent and its watch
  // run on, so it's working: blue dots, and only "active" in the switcher.
  await expect(chat(window).agentReplies.first()).toContainText(STOP_SPARES_BACKGROUND.started)
  await expect(inputBar(window).send).toBeVisible()
  const panel = taskPanel(window)
  await panel.tab(/^Subagents/).click()
  await expect(subagentsTab(window).tally).toHaveText('1 running')
  await expectDot(window, title, 'working')
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · working')
  await expectSwitcher(window, '1 active')
  await expectMenuBarCount(glade, '')

  // The watch stops: the subagent still runs, so it's still working.
  await panel.tab(/^Watch/).click()
  await watchersTab(window).stop(STOP_SPARES_BACKGROUND.ci).click()
  await expect(watchersTab(window).row(STOP_SPARES_BACKGROUND.ci)).toHaveAttribute('data-state', 'stopped')
  await expectDot(window, title, 'working')
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · working')

  // The subagent stops too: nothing is running and the reply is read, so it's idle, neither working nor needing you.
  await panel.tab(/^Subagents/).click()
  const bisect = subagentsTab(window).header(STOP_SPARES_BACKGROUND.bisect)
  await bisect.click({ button: 'right' })
  await contextMenu(window, 'Subagent actions').item('Stop subagent').click()
  await expect(bisect).toContainText('You stopped the subagent.')
  await expectDot(window, title, 'idle')
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · idle')
  await expectSwitcher(window, '1 active')
  await expectMenuBarCount(glade, '')

  // Mark as unread on it makes it need you.
  await chooseMenuItem(glade, 'Task', 'Mark as unread')
  await expectDot(window, title, 'waiting')
  await expectSwitcher(window, '1 needs you')
  await expectMenuBarCount(glade, '1')
})

test('background work running at a relaunch has ended with it: a read reply is then idle', async ({
  launch,
  tempFolder,
}) => {
  const first = await launch({ agentScript: 'stop-spares-background', chosenFolder: workspaceRoot(tempFolder) })
  await openWorkspace(first.window)
  await send(first.window, STOP_SPARES_BACKGROUND.prompt)
  const { title } = STOP_SPARES_BACKGROUND
  await expect(chat(first.window).agentReplies.first()).toContainText(STOP_SPARES_BACKGROUND.started)
  await expectDot(first.window, title, 'working')
  await expectSwitcher(first.window, '1 active')
  await first.close()

  const second = await launch({ agentScript: 'stop-spares-background' })
  await expectDot(second.window, title, 'idle')
  await expect(taskHeader(second.window).stateDot).toHaveAccessibleName('Active · idle')
  await expectSwitcher(second.window, '1 active')
  await expectMenuBarCount(second, '')
  await taskPanel(second.window)
    .tab(/^Subagents/)
    .click()
  await expect(subagentsTab(second.window).tally).toHaveText('1 interrupted')
})

test('a reply needs you while a subagent and a watch it left running still run, not only once they end (#461)', async ({
  launch,
  tempFolder,
}) => {
  const first = await launch({ agentScript: 'stop-spares-background', chosenFolder: workspaceRoot(tempFolder) })
  await openWorkspace(first.window)
  const { title } = STOP_SPARES_BACKGROUND

  // The reply arrives while you're in another task: its subagent and watch still run, but that doesn't mask it
  // needing you (#461): the purple dot, the switcher and the menu bar all count it, the last under "Unread reply".
  await sendAndOpenNewTask(first, STOP_SPARES_BACKGROUND.prompt)
  const list = taskList(first.window)
  await expect(list.taskRow(title).getByRole('img', { name: 'Unread' })).toBeVisible()
  await expectDot(first.window, title, 'waiting')
  await expectSwitcher(first.window, '1 needs you')
  await expectMenuBarCount(first, '1')
  const popoverPage = await clickMenuBarIcon(first)
  const popover = menuBarPopover(popoverPage)
  await expect(popover.row('Needs you', title)).toContainText('Unread reply')
  await expect(popover.rows('Working')).toHaveCount(0)
  await popoverPage.keyboard.press('Escape')
  await first.close()

  // The same after a relaunch, which ends what was running: still unread, so it needs you the same way.
  const second = await launch({ agentScript: 'stop-spares-background' })
  const again = taskList(second.window)
  await expect(again.taskRow(title).getByRole('img', { name: 'Unread' })).toBeVisible()
  await expectDot(second.window, title, 'waiting')
  await expectSwitcher(second.window, '1 needs you')
  await expectMenuBarCount(second, '1')

  // Next task that needs you goes to it, reading it: nothing is left running, so it's idle.
  await inputBar(second.window).field.blur()
  await second.window.keyboard.press('Meta+Alt+ArrowDown')
  await expect(again.taskRow(title)).toHaveAttribute('aria-current', 'true')
  await expectDot(second.window, title, 'idle')
  await expectSwitcher(second.window, '2 active')
  await expectMenuBarCount(second, '')
})

test('a background command that finishes while you are away leaves its report needing you', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'finishes-in-background', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await openWorkspace(window)

  // The build runs in the background after the turn that started it; when it finishes, the agent reports it in a turn
  // of its own. All of it happens in a task you've left: once the build is over and the report is in, it needs you.
  await sendAndOpenNewTask(glade, 'Build the docs site and check it for broken links.')
  const list = taskList(window)
  await expect(list.taskRow(DOCS)).toContainText('The docs site is built, with no broken links.')
  await expect(list.taskRow(DOCS).getByRole('img', { name: 'Unread' })).toBeVisible()
  await expectDot(window, DOCS, 'waiting')
  await expectSwitcher(window, '1 needs you')
  await expectMenuBarCount(glade, '1')

  // Reading it: idle.
  await list.taskRow(DOCS).click()
  await expectDot(window, DOCS, 'idle')
  await expectSwitcher(window, '2 active')
  await expectMenuBarCount(glade, '')
})
