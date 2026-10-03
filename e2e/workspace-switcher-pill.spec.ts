// #472, corrected by #480: the closed switcher's own pill totals every task that needs you, across every workspace,
// the one shown included, live.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { chooseFolder, expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { firstRun, inputBar, regions, taskList, workspaceSwitcher } from './selectors'
import { invoke } from './task-view'

/** Each workspace's long-running task's first message: it plays `long-running`, which works until it's stopped. */
const RUN_SUITE = 'Run the e2e suite.'
/** What its agent is told once stopped: its reply makes the task need you. */
const UNIT_ONLY = 'Only run the unit tests.'
/** The title `long-running`'s first turn sets with `set_title` (`describeTask` in `scripts.ts`). */
const SUITE_TITLE = 'Run the e2e suite'

/** Stops a task mid-run and sends it a message, as if its agent replied while you weren't viewing it: needs you. */
async function makeItNeedYou(window: Page, taskId: string): Promise<void> {
  await invoke(window, CommandName.TasksStop, { id: taskId })
  await invoke(window, CommandName.TasksSend, { id: taskId, text: UNIT_ONLY })
}

test('the pill totals every task that needs you, the shown workspace’s own included, live', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const rootA = join(parent, 'acme-api')
  const rootB = join(parent, 'acme-web')
  mkdirSync(rootA)
  mkdirSync(rootB)
  const glade = await launch({ agentScriptsByFirstMessage: { [RUN_SUITE]: 'long-running' }, chosenFolder: rootA })
  const { window } = glade
  const switcher = workspaceSwitcher(window)
  const list = taskList(window)
  const bar = inputBar(window)
  const workspace = regions(window).workspace

  await firstRun(window).openFolder.click()
  await expect(workspace).toContainText('acme-api')
  await expect(switcher.pill).toHaveCount(0)
  await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace')

  // Task A1: started, then left running in the background once A2 (below) is the one shown instead.
  await list.newTask.click()
  await bar.field.fill(RUN_SUITE)
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()

  // Task A2: created after it, so from here on A2 (not A1) is the one shown in A.
  await list.newTask.click()
  await expect(switcher.pill).toHaveCount(0)

  // Add B and start a task there the same way.
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('acme-web')
  await list.newTask.click()
  await bar.field.fill(RUN_SUITE)
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()

  // Back to A: switching restores A2 as the one shown there.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(workspace).toContainText('acme-api')
  await expect(switcher.pill).toHaveCount(0)

  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const workspaceA = workspaces.find((each) => each.rootPath === rootA)
  const workspaceB = workspaces.find((each) => each.rootPath === rootB)
  const { tasks: tasksA } = await invoke(window, CommandName.TasksList, { workspaceId: workspaceA?.id ?? '' })
  const { tasks: tasksB } = await invoke(window, CommandName.TasksList, { workspaceId: workspaceB?.id ?? '' })
  const taskA1 = tasksA.find((task) => task.title === SUITE_TITLE)?.id ?? ''
  const taskB1 = tasksB[0]?.id ?? ''

  // A1 replies while A2 is the one shown (needs you in the CURRENT workspace, A): the pill lights up live, named in
  // the tooltip, without a reload. Waiting for it here (rather than firing both replies and waiting once at the
  // end) settles A1's turn fully before B1's is touched, so the two scripted sessions don't race each other.
  await makeItNeedYou(window, taskA1)
  await expect(switcher.pill).toHaveText('1')
  await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace — 1 task needs you')

  // B1 replies too (needs you in B, elsewhere): the pill adds its own.
  await makeItNeedYou(window, taskB1)
  await expect(switcher.pill).toHaveText('2')
  await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace — 2 tasks need you')

  // Pins the pill's rendered size to the design's box (`docs/design/html/14-workspace-switcher.html`, ~27×16 for a
  // one-digit count), so a CSS change that shrinks it (min-width meeting padding under the wrong box-sizing, say)
  // fails here even though `check-design` only compares the design HTML to its own PNG.
  const box = await switcher.pill.boundingBox()
  expect(box?.width).toBeGreaterThan(24)
  expect(box?.width).toBeLessThan(31)
  expect(box?.height).toBeGreaterThan(14)
  expect(box?.height).toBeLessThan(18)

  // Opening A1 (in A, the shown workspace) reads it: only B1, elsewhere, still needs you.
  await list.taskRow(SUITE_TITLE).click()
  await expect(switcher.pill).toHaveText('1')
  await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace — 1 task needs you')

  // Switching to B restores its own selection (B1), reading it too: nothing needs you anywhere now.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-web')
  await expect(workspace).toContainText('acme-web')
  await expect(switcher.pill).toHaveCount(0)
  await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace')
})
