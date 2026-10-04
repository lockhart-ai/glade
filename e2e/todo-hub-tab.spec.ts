// The Todos tab as the todo hub (P16, #497), end to end with the scripted agent and the hidden `todoHubEnabled` setting
// on: each todo a card with what it produced under it (its files, links and commits; #535), counted closed and listed
// open, remembered across todos, tasks and a relaunch; children filed and moved while the tab shows; the placeholder
// group; and the keyboard. No subagent or watcher is under a todo, whatever the task has going on.
//
// These get filed children in two ways, both through main's own filing service (`fileChildren` in
// `src/main/todo-hub`): a seed fixture that files its sample children as it's applied
// (`scripts/fixtures/todo-hub.json`), and, while the app runs, the `fileChildren` fixture (`./fixtures`), which calls
// the service in main as the agent's tools do, so the window hears of it the same way (`filings.changed`).
import { mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { FILES_CHILDREN } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ToolCallState, ToolEventKind, WatcherState } from '../src/shared/domain'
import { ChildKind, commitChildKey, FilingSource, type ChildRef, type NewFiling } from '../src/shared/todoHub'
import { expect, fileChildren, test, unfileChildren } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel, todoHub } from './selectors'
import { invoke } from './task-view'

/** The hub's sample data (screens 46 to 49): a task in flight, one from before the hub, and one that never wrote todos. */
const HUB_SEED = resolve(__dirname, '../scripts/fixtures/todo-hub.json')

const SHIP = 'Ship the rate-limit fixes for 2.5'
const BEFORE = 'Fix the UTC date test'
const NO_TODOS = 'Tidy the API reference'
const UNFILED = 'Not under a todo'

/** The only task's id, as main has it. */
async function onlyTaskId(window: Page): Promise<string> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]?.id ?? ''
}

/** The task showing: its id, as main has it. */
async function shownTaskId(window: Page, title: string): Promise<string> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks.find((task) => task.title === title)?.id ?? ''
}

/** Opens the sidebar's Done section, unless it's open already: it starts closed, and stays as you leave it. */
async function showDone(window: Page): Promise<void> {
  const header = taskList(window).sectionHeader('Done')
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

/** A card's row of icons, as its counts' or pills' names, in order. */
async function kindsOf(window: Page, card: string): Promise<string[]> {
  const hub = todoHub(window)
  return hub
    .kinds(hub.card(card))
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''))
}

/** The names of the tiles a card shows, in order. */
async function tilesOf(window: Page, card: string): Promise<string[]> {
  const hub = todoHub(window)
  return hub.tiles(hub.card(card)).evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('aria-label') ?? ''))
}

test('the todo hub: counts closed, filters and tiles open, each todo as you left it across todos, tasks and a relaunch', async ({
  launch,
}) => {
  const glade = await launch({ seed: HUB_SEED })
  const { window } = glade
  const hub = todoHub(window)
  await expect(taskHeader(window).title).toHaveText(SHIP)

  // Every todo is a card, in the tab's order, in a panel of three tabs (#536, `./agents-tab.spec.ts`).
  await expect(hub.heading).toHaveText('1 of 4 done')
  await expect(hub.heads).toHaveText([
    /^Doing: #501 Return Retry-After on 429s/,
    /^Doing: #502 Per-key limits for \/search/,
    'To do: Draft the 2.5 release notes',
    /^Done: #503 Document the rate limits/,
  ])
  await expect(taskPanel(window).tabs).toHaveText([/^Agents/, 'Files', /^Todos/])

  // Closed: a count per kind it produced (files, links, changes), a kind with none left out.
  expect(await kindsOf(window, '#502')).toEqual(['3 links', '2 changes'])
  expect(await kindsOf(window, '#503')).toEqual(['2 files', '2 links', '1 change'])
  // A todo with nothing under it is its title alone.
  await expect(hub.card('Draft the 2.5').getByRole('button')).toHaveCount(0)
  await expect(hub.tiles(hub.card('#502'))).toHaveCount(0)

  // Open (as the seed left the first): the icons are filter pills, All in front, over its children, newest first.
  const first = hub.card('#501')
  await expect(hub.head('#501')).toHaveAttribute('aria-expanded', 'true')
  await expect(hub.all(first)).toHaveAttribute('aria-pressed', 'true')
  await expect(hub.all(first)).toHaveText('All4')
  expect(await kindsOf(window, '#501')).toEqual(['2 links', '2 changes'])
  expect(await tilesOf(window, '#501')).toEqual([
    'Link: Return Retry-After on 429s',
    'Change: Test the header under burst traffic',
    'Change: Return Retry-After on 429 responses',
    'Link: 429s don’t say when to retry',
  ])

  // The task has four subagents, one of them running, each working on one of these todos, and three watchers, one of
  // them running: none is under a todo, counted or listed, and nothing in the tab is live.
  const history = await invoke(window, CommandName.TasksHistory, { id: await shownTaskId(window, SHIP) })
  const subagents = history.toolEvents.filter(
    (event) => event.kind === ToolEventKind.ToolCall && event.name === 'Agent',
  )
  expect(subagents).toHaveLength(4)
  expect(subagents.some((event) => 'state' in event && event.state === ToolCallState.Running)).toBe(true)
  expect(history.watchers).toHaveLength(3)
  expect(history.watchers.some(({ state }) => state === WatcherState.Running)).toBe(true)
  await expect(hub.activity).toHaveCount(0)
  await expect(taskPanel(window).tabPanel).not.toContainText(/fix-501-ci|CI checks on PR #51[13]/)

  // A pill shows its kind alone.
  await hub.kind(first, '2 changes').click()
  await expect(hub.kind(first, '2 changes')).toHaveAttribute('aria-pressed', 'true')
  expect(await tilesOf(window, '#501')).toEqual([
    'Change: Test the header under burst traffic',
    'Change: Return Retry-After on 429 responses',
  ])

  // An icon on a closed todo opens it on that kind. The first todo keeps its own filter.
  await hub.kind(hub.card('#502'), '3 links').click()
  await expect(hub.head('#502')).toHaveAttribute('aria-expanded', 'true')
  expect(await tilesOf(window, '#502')).toEqual([
    'Link: Per-key limits for /search',
    'Link: Token buckets, explained',
    'Link: /search needs its own limit',
  ])
  await expect(hub.tiles(first)).toHaveCount(2)
  // Opening it moved nothing above its list: its row of icons is where it was.
  await hub.head('#503').click()
  await expect(hub.tiles(hub.card('#503'))).toHaveCount(5)
  await expect(hub.activity).toHaveCount(0)
  await hub.head('#503').click()
  await expect(hub.tiles(hub.card('#503'))).toHaveCount(0)

  // A task from before the hub: nothing recorded which todo what it produced belongs to, so it's under no todo. The
  // watcher it had is no part of the group.
  await showDone(window)
  await taskList(window).row('Done', BEFORE).click()
  await expect(taskHeader(window).title).toHaveText(BEFORE)
  await expect(hub.heading).toHaveText('4 of 4 done')
  await expect(hub.cards).toHaveCount(5)
  await expect(hub.head(UNFILED)).toHaveAttribute('aria-expanded', 'true')
  expect(await tilesOf(window, UNFILED)).toEqual([
    'Change: Bump the version to 2.4.1',
    'Link: Fix the UTC date test',
    'Change: Fix the UTC date test',
  ])
  await expect(hub.all(hub.card(UNFILED))).toHaveText('All3')
  // Closed, it has its counts, as a closed todo has.
  await hub.head(UNFILED).click()
  await expect(hub.tiles(hub.card(UNFILED))).toHaveCount(0)
  expect(await kindsOf(window, UNFILED)).toEqual(['1 link', '2 changes'])

  // A task that never wrote todos: the line, and the group alone, open, with no heading to open or close it by.
  await taskList(window).row('Done', NO_TODOS).click()
  await expect(taskHeader(window).title).toHaveText(NO_TODOS)
  await expect(hub.noTodos).toBeVisible()
  await expect(hub.heads).toHaveCount(0)
  await expect(hub.cards).toHaveCount(1)
  await expect(hub.all(hub.cards)).toHaveText('All4')
  await expect(hub.tiles(hub.cards)).toHaveCount(4)
  await hub.kind(hub.cards, '2 changes').click()
  await expect(hub.tiles(hub.cards)).toHaveCount(2)

  // Back on the first task, each todo is as it was left: open or closed, on its own filter.
  await taskList(window).taskRow(SHIP).click()
  await expect(taskHeader(window).title).toHaveText(SHIP)
  expect(await tilesOf(window, '#501')).toEqual([
    'Change: Test the header under burst traffic',
    'Change: Return Retry-After on 429 responses',
  ])
  await expect(hub.tiles(hub.card('#502'))).toHaveCount(3)
  await expect(hub.head('#503')).toHaveAttribute('aria-expanded', 'false')

  // And after a relaunch, in every task.
  await glade.close()
  const relaunched = await launch()
  const again = todoHub(relaunched.window)
  await expect(taskHeader(relaunched.window).title).toHaveText(SHIP)
  await expect(again.kind(again.card('#501'), '2 changes')).toHaveAttribute('aria-pressed', 'true')
  await expect(again.tiles(again.card('#501'))).toHaveCount(2)
  await expect(again.activity).toHaveCount(0)
  await expect(again.kind(again.card('#502'), '3 links')).toHaveAttribute('aria-pressed', 'true')
  await expect(again.tiles(again.card('#502'))).toHaveCount(3)
  await expect(again.head('#503')).toHaveAttribute('aria-expanded', 'false')
  await showDone(relaunched.window)
  await taskList(relaunched.window).row('Done', BEFORE).click()
  await expect(again.head(UNFILED)).toHaveAttribute('aria-expanded', 'false')
  await taskList(relaunched.window).row('Done', NO_TODOS).click()
  await expect(again.kind(again.cards, '2 changes')).toHaveAttribute('aria-pressed', 'true')
  await expect(again.tiles(again.cards)).toHaveCount(2)
})

test('the todo hub: a commit filed and moved while the tab shows, no subagent or watcher under a todo, and the keyboard', async ({
  launch,
  tempFolder,
}) => {
  const root = join(realpathSync(tempFolder()), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'files-children', chosenFolder: root })
  const { window } = glade
  const hub = todoHub(window)
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const taskId = await onlyTaskId(window)

  // The agent keeps three todos, and makes a subagent, a commit and four watchers. The subagent's call and the
  // commit's each name a todo, so the commit is under its todo already; the subagent and the watchers show nowhere.
  await inputBar(window).field.fill(FILES_CHILDREN.prompt)
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText(FILES_CHILDREN.named.reply)
  await taskPanel(window)
    .tab(/^Todos/)
    .click()
  await expect(hub.heading).toHaveText('2 of 3 done')
  await expect(hub.heads.filter({ hasText: /^(Doing|Done): / })).toHaveText([
    /^Doing: Watch CI on PR #42/,
    /^Done: Fix the UTC date test/,
    /^Done: Review the date helpers/,
  ])
  await expect(hub.cards).toHaveCount(3)
  expect(await kindsOf(window, 'Fix the UTC date test')).toEqual(['1 change'])
  expect(await kindsOf(window, 'Review the date helpers')).toEqual([])
  expect(await kindsOf(window, 'Watch CI on PR #42')).toEqual([])
  await expect(hub.activity).toHaveCount(0)

  // Which child is which, from what the window has of the task.
  const history = await invoke(window, CommandName.TasksHistory, { id: taskId })
  const subagent = history.toolEvents.find((event) => event.kind === ToolEventKind.ToolCall && event.name === 'Agent')
  const [commit] = history.commits
  if (subagent?.kind !== ToolEventKind.ToolCall || commit === undefined) throw new Error('The agent made no children')
  // The monitor and the command run; the wakeup and the cron job are only scheduled.
  expect(history.watchers).toHaveLength(4)
  expect(history.watchers.filter(({ state }) => state === WatcherState.Running)).toHaveLength(2)
  const children = {
    subagent: { kind: ChildKind.Subagent, key: subagent.toolUseId },
    commit: { kind: ChildKind.Commit, key: commitChildKey(commit) },
  } satisfies Record<string, ChildRef>
  const under = (child: ChildRef, todoId: string, source = FilingSource.Named): NewFiling => ({
    ...child,
    todoId,
    source,
  })

  // With nothing filed, the commit is under no todo, alone there: the subagent and the four watchers, two of them
  // running, make no part of the group, and nothing in it is live.
  await unfileChildren(glade, taskId, Object.values(children))
  await expect(hub.cards).toHaveCount(4)
  expect(await kindsOf(window, UNFILED)).toEqual(['1 change'])
  expect(await kindsOf(window, 'Fix the UTC date test')).toEqual([])
  await hub.head(UNFILED).click()
  await expect(hub.tiles(hub.card(UNFILED))).toHaveCount(1)
  await expect(hub.activity).toHaveCount(0)

  // Filed under its todo, as the agent's tools file it, it shows there at once, and the group, empty, is gone. The
  // subagent's todo is recorded with it, and that todo's card stays its title alone.
  await fileChildren(glade, taskId, [under(children.subagent, '1'), under(children.commit, '2')])
  await expect(hub.cards).toHaveCount(3)
  await expect(hub.head(UNFILED)).toHaveCount(0)
  expect(await kindsOf(window, 'Fix the UTC date test')).toEqual(['1 change'])
  await expect(hub.card('Review the date helpers').getByRole('button')).toHaveCount(0)
  await expect(hub.head('Review the date helpers')).not.toHaveAttribute('aria-expanded')

  // Moved from one todo to another while both show, it leaves the first and shows in the second. An icon on a closed
  // todo opens it on that kind.
  await fileChildren(glade, taskId, [under(children.commit, '3', FilingSource.Moved)])
  expect(await kindsOf(window, 'Fix the UTC date test')).toEqual([])
  expect(await kindsOf(window, 'Watch CI on PR #42')).toEqual(['1 change'])
  const watch = hub.card('Watch CI on PR #42')
  await hub.kind(watch, '1 change').click()
  expect(await tilesOf(window, 'Watch CI on PR #42')).toEqual([`Change: ${FILES_CHILDREN.named.commitSubject}`])

  // Its watchers end: nothing under a todo changes, since nothing there was theirs.
  for (const { id, state } of (await invoke(window, CommandName.TasksHistory, { id: taskId })).watchers) {
    if (state === WatcherState.Running) await invoke(window, CommandName.WatchersStop, { taskId, id })
  }
  expect(await kindsOf(window, 'Watch CI on PR #42')).toEqual(['1 change'])
  await expect(hub.tiles(watch)).toHaveCount(1)
  await expect(hub.activity).toHaveCount(0)

  // The keyboard alone: ← closes the todo and → opens it, on the filter it was on; ↑ and ↓ move between todos; a todo
  // with nothing under it doesn't open; Tab reaches a todo's pills and tiles; ↵ on a pill picks it.
  const watchHead = hub.head('Watch CI on PR #42')
  await watchHead.focus()
  await expect(watchHead).toBeFocused()
  await window.keyboard.press('ArrowLeft')
  await expect(watchHead).toHaveAttribute('aria-expanded', 'false')
  await expect(hub.tiles(watch)).toHaveCount(0)
  await window.keyboard.press('ArrowDown')
  await expect(hub.head('Fix the UTC date test')).toBeFocused()
  await window.keyboard.press('ArrowDown')
  await expect(hub.head('Review the date helpers')).toBeFocused()
  await window.keyboard.press('ArrowDown')
  await expect(hub.head('Review the date helpers')).toBeFocused()
  // The todo the subagent works on has produced nothing: → and ↵ leave it as it is.
  await window.keyboard.press('ArrowRight')
  await window.keyboard.press('Enter')
  await expect(hub.head('Review the date helpers')).not.toHaveAttribute('aria-expanded')
  await expect(hub.tiles(hub.card('Review the date helpers'))).toHaveCount(0)
  await window.keyboard.press('ArrowUp')
  await window.keyboard.press('ArrowUp')
  await expect(watchHead).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(hub.kind(watch, '1 change')).toHaveAttribute('aria-pressed', 'true')
  await window.keyboard.press('Tab')
  await expect(hub.all(watch)).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(hub.all(watch)).toHaveAttribute('aria-pressed', 'true')
  await window.keyboard.press('Tab')
  await expect(hub.kind(watch, '1 change')).toBeFocused()
  await window.keyboard.press('Tab')
  await expect(hub.tiles(watch).first()).toBeFocused()
})
