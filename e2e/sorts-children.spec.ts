// The agent's tools to list and move a task's children (P16-05, #496), end to end with the scripted agent. A task makes
// one of each kind of child with the todo hub off, as every task did before it, so nothing files them. The hidden
// `todoHubEnabled` setting is then turned on and Glade relaunched: the task's session starts again with
// `list_children` and `file_children`, and asked to, its agent sorts what it made under its todos. There's no menu for
// any of it, and the hub's own tab isn't built yet (#497), so the spec reads where main puts each child over the bridge.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { SORTS_CHILDREN as SORT } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ChildKind, type TodoChildren } from '../src/shared/todoHub'
import { agentSessions, expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList, taskPanel } from './selectors'
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

async function send(window: Page, text: string): Promise<void> {
  await inputBar(window).field.fill(text)
  await inputBar(window).field.press('Enter')
}

/** A group's children, each as its kind and how it came under its todo, sorted. */
function kinds({ children }: TodoChildren): string[] {
  return children.map(({ kind, source }) => `${kind} ${source ?? 'unfiled'}`).sort()
}

/** Each todo's children, in the agent's order, then the ones under no todo. */
async function placed(window: Page, taskId: string): Promise<string[][]> {
  const { children } = await invoke(window, CommandName.TodoHubGet, { taskId })
  return [...children.todos, children.unfiled].map(kinds)
}

test('a task from before the todo hub: asked to, its agent lists what it made and files it under its todos', async ({
  launch,
  tempFolder,
}) => {
  // Before the hub: the agent keeps three todos, and makes a file, a link, a subagent (which commits, and leaves its
  // tests running) and a watcher. Nothing says which todo any of them belongs to.
  const glade = await launch({ agentScript: 'unsorted-children', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const taskId = await onlyTaskId(window)
  await send(window, SORT.prompt)
  await expect(chat(window).agentReplies.first()).toContainText(SORT.made)
  // Its session started with the hub off: the prompt says nothing of the tools.
  for (const { systemPromptAppend } of await agentSessions(glade)) expect(systemPromptAppend).not.toContain('children')

  // The hub is turned on by hand: there's nothing for it in Settings. Everything the task made is under no todo.
  await invoke(window, CommandName.SettingsUpdate, { patch: { todoHubEnabled: true } })
  const unfiled = async () => (await invoke(window, CommandName.TodoHubGet, { taskId })).children.unfiled
  // Glade reads git for the subagent's commit once its command has run.
  await expect.poll(async () => (await unfiled()).tallies[ChildKind.Commit].count).toBe(1)
  expect(await placed(window, taskId)).toEqual([
    [],
    [],
    [],
    ['commit unfiled', 'file unfiled', 'link unfiled', 'subagent unfiled', 'watcher unfiled', 'watcher unfiled'],
  ])
  await glade.close()

  // Relaunched, the task's session starts again, with the two tools and the prompt's line about them.
  const relaunched = await launch({ agentScript: 'sorts-children' })
  const page = relaunched.window
  const panel = taskPanel(page)
  await send(page, SORT.sortPrompt)
  await expect(chat(page).agentReplies.last()).toContainText(SORT.sorted)
  const [session] = await agentSessions(relaunched)
  expect(session?.resumeSessionId).not.toBeNull()
  expect(session?.systemPromptAppend).toContain('list_children lists them')

  // It listed them, then filed them all in one call: both show in the tool log like any other call.
  await panel.tab(/^Agents/).click()
  await expect(panel.call(/^Done\s*list_children/)).toBeVisible()
  await expect(panel.call(/^Done\s*file_children/)).toHaveCount(1)
  // The subagent brought its commit and the tests it left running, and the placeholder is empty.
  expect(await placed(page, taskId)).toEqual([
    ['commit inherited', 'subagent asked', 'watcher inherited'],
    ['file asked'],
    ['link asked', 'watcher asked'],
    [],
  ])

  // Asked to move the review, it moves the subagent, and what the subagent made goes with it.
  await send(page, SORT.movePrompt)
  await expect(chat(page).agentReplies.last()).toContainText(SORT.moved)
  const moved = [
    [],
    ['commit inherited', 'file asked', 'subagent moved', 'watcher inherited'],
    ['link asked', 'watcher asked'],
    [],
  ]
  expect(await placed(page, taskId)).toEqual(moved)

  // A todo and a child that aren't there: the call fails, saying which, and nothing moves.
  await send(page, SORT.badPrompt)
  await expect(chat(page).agentReplies.last()).toContainText(SORT.refused)
  await expect(panel.call(/^Failed\s*file_children/)).toHaveAccessibleName(
    /Nothing was filed\. Not a child of this task: c12\..*There's no todo #9 in this task's list\./,
  )
  expect(await placed(page, taskId)).toEqual(moved)
  // Only the three calls that filed or moved something told the windows; main kept each filing.
  const { filings } = await invoke(page, CommandName.TodoHubGet, { taskId })
  expect(filings.map(({ kind, todoId, source }) => `${kind} ${todoId} ${source}`).sort()).toEqual([
    'file 2 asked',
    'link 3 asked',
    'subagent 2 moved',
    'watcher 3 asked',
  ])
})
