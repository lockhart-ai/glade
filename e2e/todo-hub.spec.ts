// The todo hub's groundwork (P16, #494), end to end with the scripted agent: the Todos tab is the hub (#497,
// `./todo-hub-tab.spec.ts`), main answers with a task's children grouped by todo, and remembers each todo's panel
// across a relaunch.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { SUBAGENT_BACKGROUND_WORK as WORK } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ChildKind, UNFILED_TODO_ID } from '../src/shared/todoHub'
import { ToolEventKind } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList, taskPanel, todoHub } from './selectors'
import { invoke } from './task-view'

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

test('the todo hub: a task that has only a subagent and watchers has produced nothing, and shows nothing', async ({
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

  // The agent tails the deploy log; its subagent lints (done a moment later) and runs the e2e suite: a subagent and
  // three watchers, which are what's going on, and nothing the task has produced.
  await expect
    .poll(async () => (await invoke(window, CommandName.TasksHistory, { id: taskId })).watchers.length)
    .toBe(3)
  const history = await invoke(window, CommandName.TasksHistory, { id: taskId })
  expect(
    history.toolEvents.filter((event) => event.kind === ToolEventKind.ToolCall && event.name === 'Agent'),
  ).toHaveLength(1)

  // So nothing is under no todo, whatever kind it is, and main has no group for it.
  const hub = await invoke(window, CommandName.TodoHubGet, { taskId })
  expect(hub.children.todos).toEqual([])
  expect(hub.children.unfiled).toEqual({
    todoId: UNFILED_TODO_ID,
    children: [],
    tallies: { [ChildKind.File]: 0, [ChildKind.Link]: 0, [ChildKind.Commit]: 0 },
  })
  expect(hub.filings).toEqual([])

  // And the Todos tab says what it says of a task with nothing at all, with no card and no tile.
  await taskPanel(window)
    .tab(/^Todos/)
    .click()
  await expect(todoHub(window).nothing).toBeVisible()
  await expect(todoHub(window).noTodos).toHaveCount(0)
  await expect(todoHub(window).cards).toHaveCount(0)
  await expect(taskPanel(window).tabPanel.locator('[data-kind]')).toHaveCount(0)
})
