// Filing what an agent produces under its todos as it's made (P16-04, #495), end to end with the scripted agent.
// The agent's first turn names a todo in the `Agent` call that starts a
// subagent and in the `Bash` call that commits: Glade records the subagent's todo, files the commit, and takes each
// marker off, so it shows nowhere. Its second turn names none: Glade tells it what its calls made, and it files that
// itself, before its turn ends; the artifacts it declares give `add_artifact` their todo. Its watchers are never
// filed, asked about or held for. What's filed survives a relaunch, and the resumed session keeps filing. The spec
// reads where main puts each thing over the bridge, and Main's tool calls in the Agents tab for what the log shows.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { FILES_CHILDREN as MADE } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ToolEventKind } from '../src/shared/domain'
import { ChildKind, FilingSource, type TodoChildren } from '../src/shared/todoHub'
import { agentReceived, agentSessions, expect, test } from './fixtures'
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

/** Everything main keeps of the task that a marker could show in: its tool log, its watchers, its commits. */
async function everythingShown(window: Page, taskId: string): Promise<string> {
  const { toolEvents, watchers, commits, artifacts } = await invoke(window, CommandName.TasksHistory, { id: taskId })
  return JSON.stringify([toolEvents, watchers, commits, artifacts])
}

/** The todo each of the task's subagents works on, in the order they started: plumbing, which no todo shows. */
async function working(window: Page, taskId: string): Promise<(string | undefined)[]> {
  const { filings } = await invoke(window, CommandName.TodoHubGet, { taskId })
  const { toolEvents } = await invoke(window, CommandName.TasksHistory, { id: taskId })
  return toolEvents
    .filter((event) => event.kind === ToolEventKind.ToolCall && event.name === 'Agent')
    .map((event) => (event.kind === ToolEventKind.ToolCall ? event.toolUseId : ''))
    .map((toolUseId) => filings.find(({ kind, key }) => kind === ChildKind.Subagent && key === toolUseId)?.todoId)
}

test('the todo hub on: a commit is under a todo, and a subagent has one, by the time the turn ends; watchers are left alone', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'files-children', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const panel = taskPanel(window)
  await firstRun(window).openFolder.click()
  // The hub is turned on by hand, before the task's session starts: there's nothing for it in Settings.
  await taskList(window).newTask.click()
  const taskId = await onlyTaskId(window)

  // Its first turn: three todos, a subagent and a commit whose calls name a todo, and four watchers.
  await send(window, MADE.prompt)
  await expect(chat(window).agentReplies.first()).toContainText(MADE.named.reply)
  // The session started with the hub on: its prompt says how to name a todo, asks no marker of a watcher's call, and
  // nothing was sent ahead of the message.
  const [session] = await agentSessions(glade)
  expect(session?.systemPromptAppend).toContain(
    'start the description of an Agent call, and of a Bash call that commits',
  )
  expect(session?.systemPromptAppend).not.toMatch(/ScheduleWakeup|CronCreate/)
  expect(await agentReceived(glade)).toEqual([MADE.prompt])

  // The commit is under the todo its call named, and the subagent's todo is recorded, though the subagent is under
  // none; nothing was asked of the agent. The four watchers are under nothing.
  expect(await placed(window, taskId)).toEqual([[], ['commit named'], [], []])
  expect(await working(window, taskId)).toEqual([MADE.named.subagent.todo])
  const first = await invoke(window, CommandName.TodoHubGet, { taskId })
  expect(first.filings.map(({ kind, todoId, source }) => [kind, todoId, source]).sort()).toEqual([
    [ChildKind.Commit, MADE.named.commit.todo, FilingSource.Named],
    [ChildKind.Subagent, MADE.named.subagent.todo, FilingSource.Named],
  ])
  await panel.tab(/^Agents/).click()
  await expect(panel.call(/^Done\s*file_children/)).toHaveCount(0)
  // The marker shows nowhere: not in what main keeps, nor in Main's tool calls.
  expect(await everythingShown(window, taskId)).not.toMatch(/\[todo/i)
  await expect(panel.log).not.toContainText('[todo')
  // Its watchers are as their calls wrote them.
  const { watchers } = await invoke(window, CommandName.TasksHistory, { id: taskId })
  expect(watchers.map(({ label }) => label)).toEqual([
    MADE.named.monitor,
    MADE.named.command,
    MADE.named.wakeup,
    MADE.named.cron,
  ])

  // Its second turn names no todo. Glade tells it of the subagent, then of the commit, and it files each with one
  // call, without being asked by you. Nothing is said of its watchers. The file and the link it declares as artifacts
  // go under the todo each `add_artifact` call names.
  await send(window, 'And the order totals.')
  await expect(chat(window).agentReplies.last()).toContainText(MADE.unnamed.reply)
  const filed = [[], ['commit asked', 'commit named', 'file named'], ['link named'], []]
  expect(await placed(window, taskId)).toEqual(filed)
  expect(await working(window, taskId)).toEqual(['1', '1'])
  expect((await invoke(window, CommandName.TasksHistory, { id: taskId })).watchers).toHaveLength(8)
  // Two filing calls, in the tool log like any other call.
  await expect(panel.call(/^Done\s*file_children/)).toHaveCount(2)
  // The turn ended once, on its reply: its end was never held, by a watcher or anything else.
  await expect(chat(window).agentReplies).toHaveCount(2)
  const { toolEvents } = await invoke(window, CommandName.TasksHistory, { id: taskId })
  const narrated = toolEvents.filter(
    (event) => event.kind === ToolEventKind.Narration && event.parentToolUseId === null,
  )
  expect(narrated).toEqual([])
  await glade.close()

  // Relaunched: every filing is where it was, and the task's session resumes with the hub.
  const relaunched = await launch({ agentScript: 'files-children' })
  const page = relaunched.window
  await expect(chat(page).agentReplies.last()).toContainText(MADE.unnamed.reply)
  expect(await placed(page, taskId)).toEqual(filed)

  // The resumed session keeps filing. A scripted agent starts its script again on a relaunch, so this turn's calls
  // name a todo once more.
  await send(page, 'Do that again.')
  await expect(chat(page).agentReplies).toHaveCount(3)
  expect(await working(page, taskId)).toEqual(['1', '1', '1'])
  expect((await placed(page, taskId))[3]).toEqual([])
  expect(await everythingShown(page, taskId)).not.toMatch(/\[todo/i)
  // It started with the hub's lines in its prompt, so the session that resumed was sent none of them again.
  const [resumed] = await agentSessions(relaunched)
  expect(resumed?.resumeSessionId).not.toBeNull()
  expect(await agentReceived(relaunched)).toEqual(['Do that again.'])
})
