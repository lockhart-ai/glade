// The todo hub's groundwork (P16, #494), end to end with the scripted agent. The hub is built behind a hidden setting,
// `todoHubEnabled`, off by default and with nothing in Settings: a spec turns it on over the bridge, as these do. With
// it off or on, the Todos tab is what it was (the hub's own tab is #497); with it on, main answers with a task's
// children grouped by todo, and remembers each todo's panel across a relaunch.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { SUBAGENT_BACKGROUND_WORK as WORK } from '../src/main/agent/scripts'
import { BridgeErrorCode, CommandName } from '../src/shared/bridge'
import { ChildFilter, ChildKind, UNFILED_TODO_ID } from '../src/shared/todoHub'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList, taskPanel } from './selectors'
import { invoke, refusal } from './task-view'

function workspaceRoot(tempFolder: () => string): string {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  return root
}

/** The only task's id, as main has it. */
async function onlyTaskId(window: Page): Promise<string> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]?.id ?? ''
}

async function hubEnabled(window: Page): Promise<boolean> {
  return (await invoke(window, CommandName.SettingsGet, {})).settings.todoHubEnabled
}

const PLAN = [
  'Find how uploads are stored today',
  'Add an S3 backend for media files',
  'Check new uploads land in the bucket',
  'Copy the 3,900 existing files',
  'Spot-check a sample of copied files',
  'Update stored paths in the database',
  'Delete local copies',
]

/** The Todos tab partway through the plan, as it reads with the hub off: the copy in progress, three steps done. */
const TODOS = [
  new RegExp(`^Doing: ${PLAN[3] ?? ''}`),
  `To do: ${PLAN[4] ?? ''}`,
  `To do: ${PLAN[5] ?? ''}`,
  `To do: ${PLAN[6] ?? ''}`,
  new RegExp(`^Done: ${PLAN[2] ?? ''}`),
  new RegExp(`^Done: ${PLAN[1] ?? ''}`),
  new RegExp(`^Done: ${PLAN[0] ?? ''}`),
]

test('the todo hub’s switch: off by default, set by hand, kept across a relaunch, with the Todos tab as it was', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'keeps-todos', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const panel = taskPanel(window)
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const taskId = await onlyTaskId(window)

  // Off as the app starts, and both of the hub's commands are refused.
  expect(await hubEnabled(window)).toBe(false)
  expect(await refusal(window, CommandName.TodoHubGet, { taskId })).toMatchObject({
    code: BridgeErrorCode.InvalidTransition,
  })
  const opened = { taskId, todoId: '4', open: true, filter: ChildFilter.Watchers }
  expect(await refusal(window, CommandName.TodoHubSetPanel, opened)).toMatchObject({
    code: BridgeErrorCode.InvalidTransition,
  })

  // The agent plans with TaskCreate, and stops partway on a question.
  await inputBar(window).field.fill('Move the image uploads to S3.')
  await inputBar(window).field.press('Enter')
  await panel.tab(/^Todos/).click()
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/7')
  await expect(panel.todos).toHaveText(TODOS)

  // Each todo reached the window with the id Claude Code gave it.
  const history = await invoke(window, CommandName.TasksHistory, { id: taskId })
  expect(history.todos?.items.map(({ id, text }) => [id, text])).toEqual(
    PLAN.map((text, index) => [String(index + 1), text]),
  )

  // Turned on by hand, over the bridge: there's nothing for it in Settings.
  await invoke(window, CommandName.SettingsUpdate, { patch: { todoHubEnabled: true } })
  expect(await hubEnabled(window)).toBe(true)

  // The Todos tab is still what it was: the hub's own tab isn't built yet.
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/7')
  await expect(panel.todos).toHaveText(TODOS)

  // Main answers with a group per todo, in the agent's order, and nothing under any: this task made nothing else.
  const hub = await invoke(window, CommandName.TodoHubGet, { taskId })
  expect(hub.children.todos.map(({ todoId, children }) => [todoId, children.length])).toEqual(
    PLAN.map((_, index) => [String(index + 1), 0]),
  )
  expect(hub.children.unfiled).toMatchObject({ todoId: UNFILED_TODO_ID, children: [] })
  expect(hub.filings).toEqual([])
  expect(hub.panels).toEqual([])

  // Each todo's panel is remembered as you leave it, the placeholder group's too.
  const placeholder = { taskId, todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.All }
  await invoke(window, CommandName.TodoHubSetPanel, opened)
  await invoke(window, CommandName.TodoHubSetPanel, placeholder)
  // A payload that doesn't fit is refused, and main carries on.
  const bad = { ...opened, filter: 'images' } as unknown as typeof opened
  expect(await refusal(window, CommandName.TodoHubSetPanel, bad)).toMatchObject({
    code: BridgeErrorCode.InvalidRequest,
  })
  expect((await invoke(window, CommandName.TodoHubGet, { taskId })).panels).toEqual([opened, placeholder])

  // A relaunch keeps the switch, the todos' ids and the panels.
  await glade.close()
  const relaunched = await launch({ agentScript: 'keeps-todos' })
  const again = taskPanel(relaunched.window)
  expect(await hubEnabled(relaunched.window)).toBe(true)
  await again.tab(/^Todos/).click()
  await expect(again.tab(/^Todos/)).toHaveText('Todos 3/7')
  await expect(again.todos).toHaveText(TODOS)
  const kept = await invoke(relaunched.window, CommandName.TodoHubGet, { taskId })
  expect(kept.panels).toEqual([opened, placeholder])
  expect(kept.children.todos.map(({ todoId }) => todoId)).toEqual(PLAN.map((_, index) => String(index + 1)))
})

test('the todo hub, turned on: what a task made before it is all under "Not under a todo", counted by kind', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await launch({ agentScript: 'subagent-background-work', chosenFolder: workspaceRoot(tempFolder) })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const taskId = await onlyTaskId(window)
  await inputBar(window).field.fill(WORK.prompt)
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText(WORK.started)

  await invoke(window, CommandName.SettingsUpdate, { patch: { todoHubEnabled: true } })

  // The agent tails the deploy log; its subagent lints (done a moment later) and runs the e2e suite. With no todos
  // and no filings, they're all in the placeholder group: the subagent, and the three watchers as children of their own.
  const unfiled = async () => (await invoke(window, CommandName.TodoHubGet, { taskId })).children.unfiled
  await expect
    .poll(async () => (await unfiled()).children.filter(({ kind, live }) => kind === ChildKind.Watcher && live).length)
    .toBe(2)
  const { children, tallies } = await unfiled()
  expect(tallies).toEqual({
    [ChildKind.File]: { count: 0, live: false },
    [ChildKind.Link]: { count: 0, live: false },
    [ChildKind.Subagent]: { count: 1, live: true },
    [ChildKind.Watcher]: { count: 3, live: true },
    [ChildKind.Commit]: { count: 0, live: false },
  })
  expect(children.every(({ source }) => source === null)).toBe(true)
  // Most recently updated first.
  const times = children.map(({ updatedAt }) => updatedAt)
  expect(times).toEqual([...times].sort((a, b) => b - a))
  expect((await invoke(window, CommandName.TodoHubGet, { taskId })).children.todos).toEqual([])
})
