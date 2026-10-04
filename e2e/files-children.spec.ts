// Filing what an agent makes under its todos as it's made (P16-04, #495), end to end with the scripted agent and the
// hidden `todoHubEnabled` setting on. The agent's first turn names a todo in each call that makes a child (and gives
// `add_artifact` each artifact's todo): Glade files what the call made and takes the marker off, so it shows nowhere.
// Its second turn names none: Glade tells it what its calls made, and it files that itself, before its turn ends.
// What's filed survives a relaunch, and the resumed session keeps filing. The hub's own tab is another issue's (#497),
// so the spec reads where main puts each child over the bridge, and the Tool calls tab for what the log shows.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { FILES_CHILDREN as MADE } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ToolEventKind } from '../src/shared/domain'
import { type TodoChildren } from '../src/shared/todoHub'
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

/** The first turn's children: each under the todo its call named. */
const NAMED = [
  ['subagent named'],
  ['commit named', 'file named', 'watcher named'],
  ['link named', 'watcher named', 'watcher named', 'watcher named'],
  [],
]

test('the todo hub on: what an agent makes is under a todo by the time its turn ends, named in the call or filed when told', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'files-children', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const panel = taskPanel(window)
  await firstRun(window).openFolder.click()
  // The hub is turned on by hand, before the task's session starts: there's nothing for it in Settings.
  await invoke(window, CommandName.SettingsUpdate, { patch: { todoHubEnabled: true } })
  await taskList(window).newTask.click()
  const taskId = await onlyTaskId(window)

  // Its first turn: three todos, and a subagent, a commit, a file, a link and four watchers, each call naming a todo.
  await send(window, MADE.prompt)
  await expect(chat(window).agentReplies.first()).toContainText(MADE.named.reply)
  // The session started with the hub on: its prompt says how to name a todo, and nothing was sent ahead of the message.
  const [session] = await agentSessions(glade)
  expect(session?.systemPromptAppend).toContain('Name the todo in the call that makes it')
  expect(await agentReceived(glade)).toEqual([MADE.prompt])

  // Everything is under the todo its call named, with nothing left under no todo, and nothing was asked of the agent.
  expect(await placed(window, taskId)).toEqual(NAMED)
  await panel.tab(/^Tool calls/).click()
  await expect(panel.call(/^Done\s*file_children/)).toHaveCount(0)
  // The marker shows nowhere: not in what main keeps (a call's row, a watcher's label, a cron job's prompt), nor in
  // the Tool calls tab.
  expect(await everythingShown(window, taskId)).not.toMatch(/\[todo/i)
  await expect(panel.log).not.toContainText('[todo')
  await expect(panel.call(new RegExp(`^Done\\s*Monitor\\s*${MADE.named.monitor.text}`))).toBeVisible()
  const { watchers } = await invoke(window, CommandName.TasksHistory, { id: taskId })
  expect(watchers.map(({ label }) => label)).toEqual([
    MADE.named.monitor.text,
    MADE.named.command.text,
    MADE.named.wakeup.text,
    MADE.named.cron.text,
  ])
  expect(watchers.at(-1)?.detail).toBe(MADE.named.cron.text)

  // Its second turn makes the same kinds and names no todo. Glade tells it what each message made, and it files that
  // with one call each time, without being asked by you: by the end of the turn nothing is under no todo.
  await send(window, 'And the order totals.')
  await expect(chat(window).agentReplies.last()).toContainText(MADE.unnamed.reply)
  const filed = [
    ['subagent asked', 'subagent named'],
    ['commit asked', 'commit named', 'file named', 'watcher asked', 'watcher named'],
    [
      'link named',
      'watcher asked',
      'watcher asked',
      'watcher asked',
      'watcher named',
      'watcher named',
      'watcher named',
    ],
    [],
  ]
  expect(await placed(window, taskId)).toEqual(filed)
  // Six messages that made a child, six filing calls, in the tool log like any other call.
  await expect(panel.call(/^Done\s*file_children/)).toHaveCount(6)
  // The turn ended once, on its reply: its end was never held.
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
  // each name a todo once more.
  await send(page, 'Do that again.')
  await expect(chat(page).agentReplies).toHaveCount(3)
  const again = await placed(page, taskId)
  expect(again[0]).toEqual(['subagent asked', 'subagent named', 'subagent named'])
  expect(again[3]).toEqual([])
  expect(await everythingShown(page, taskId)).not.toMatch(/\[todo/i)
  // It started with the hub's lines in its prompt, so the session that resumed was sent none of them again.
  const [resumed] = await agentSessions(relaunched)
  expect(resumed?.resumeSessionId).not.toBeNull()
  expect(await agentReceived(relaunched)).toEqual(['Do that again.'])
})
