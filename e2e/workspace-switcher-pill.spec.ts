// #472: the closed switcher's own pill totals tasks that need you across every workspace other than the one shown,
// live, and never the shown workspace's own tasks.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { chooseFolder, expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { firstRun, inputBar, regions, taskList, workspaceSwitcher } from './selectors'
import { invoke } from './task-view'

/** Workspace B's task's first message: it plays `long-running`, which works until it's stopped. */
const RUN_SUITE = 'Run the e2e suite.'
/** What B's agent is told once it's stopped: its reply makes it need you. */
const UNIT_ONLY = 'Only run the unit tests.'

test('the pill totals tasks that need you elsewhere, live, and never the shown workspace’s own', async ({
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

  // Add B and start a task there while it's shown: its own activity never counts towards A's pill.
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('acme-web')
  await list.newTask.click()
  await bar.field.fill(RUN_SUITE)
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()
  await expect(switcher.pill).toHaveCount(0)

  // Switch to A: B keeps working in the background, which doesn't need you either.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(workspace).toContainText('acme-api')
  await expect(switcher.pill).toHaveCount(0)

  // B's agent replies while you're in A (stopped and told to change course, as if from elsewhere): the pill lights
  // up live, named in the tooltip, without a reload.
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const workspaceB = workspaces.find((each) => each.rootPath === rootB)
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaceB?.id ?? '' })
  const taskB = tasks[0]?.id ?? ''
  await invoke(window, CommandName.TasksStop, { id: taskB })
  await invoke(window, CommandName.TasksSend, { id: taskB, text: UNIT_ONLY })

  await expect(switcher.pill).toHaveText('1')
  await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace — 1 task in other workspaces needs you')

  // Pins the pill's rendered size to the design's box (`docs/design/html/14-workspace-switcher.html`, ~27×16 for a
  // one-digit count), so a CSS change that shrinks it (min-width meeting padding under the wrong box-sizing, say)
  // fails here even though `check-design` only compares the design HTML to its own PNG.
  const box = await switcher.pill.boundingBox()
  expect(box?.width).toBeGreaterThan(24)
  expect(box?.width).toBeLessThan(31)
  expect(box?.height).toBeGreaterThan(14)
  expect(box?.height).toBeLessThan(18)

  // Opening B's task reads its reply: it no longer needs you, so the pill hides and the tooltip resets.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-web')
  await expect(workspace).toContainText('acme-web')
  await expect(switcher.pill).toHaveCount(0)
  await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace')
})
