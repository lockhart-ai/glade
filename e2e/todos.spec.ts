// The Todos tab, end to end with the scripted agent: the list follows Glade's own todo tools (`create_todo` and
// `update_todo`, #609) over a turn, the tab counts what's done, the task's sidebar row shows the same progress, and
// it all survives a relaunch, since the list lives in Glade's own table.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'
import { invoke } from './task-view'

function workspaceRoot(tempFolder: () => string): string {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  return root
}

/** Opens the workspace and starts a task, showing its Todos tab, which is empty. */
async function startTask(window: Page): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const panel = taskPanel(window)
  await panel.tab('Todos').click()
  await expect(panel.tabPanel).toHaveText('No todos yet.')
}

async function send(window: Page, message: string): Promise<void> {
  const bar = inputBar(window)
  await bar.field.fill(message)
  await bar.field.press('Enter')
}

/** Whether the only task's agent has questions open. */
async function asking(window: Page): Promise<boolean | undefined> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]?.asking
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

/** A done item of the plan, as the tab reads it: its text, then when it was finished (just now, or minutes ago). */
function done(index: number): RegExp {
  const text = (PLAN[index] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^Done: ${text}Finished (just now|\\d+m ago)$`)
}

/** How an item draws (#308): whether its icon's circle is filled, the icon's colour, and its text's colour and line. */
interface ItemLook {
  readonly filled: boolean
  readonly icon: string
  readonly text: string
  readonly struck: boolean
}

async function look(item: Locator): Promise<ItemLook> {
  return item.evaluate((element) => {
    const head = element.querySelector('[data-todo-head]')
    const icon = head?.children[0] ?? null
    // The item's title: the state read to a screen reader, then the text (head > main > titleRow > title).
    const text = head?.children[1]?.children[0]?.children[0]
    if (icon === null || head === null || text === undefined) throw new Error('An item without its icon or text')
    return {
      filled: icon.querySelector('circle')?.getAttribute('fill') === 'currentColor',
      icon: getComputedStyle(icon).color,
      text: getComputedStyle(text).color,
      struck: getComputedStyle(text).textDecorationLine === 'line-through',
    }
  })
}

/** tokens.css's teal, muted, text, faint and purple, as computed styles give them. */
const TEAL = 'rgb(127, 209, 199)'
const MUTED = 'rgb(174, 179, 195)'
const TEXT = 'rgb(230, 232, 240)'
const FAINT = 'rgb(153, 157, 176)'
const PURPLE = 'rgb(200, 178, 255)'

/** An exact time, as a finish time's tooltip gives it: `Sep 26, 2026, 12:18 AM`. */
const FULL_DATE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M$/

test('todos: the list follows create_todo and update_todo over a turn, counted in the tab, and survives a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'keeps-todos', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const panel = taskPanel(window)
  const list = taskList(window)
  await startTask(window)
  // With no list, the row shows no progress.
  await expect(list.todoProgress(list.rows('Active').first())).toHaveCount(0)
  await send(window, 'Move the image uploads to S3.')

  // Partway through the turn the agent asks a question and waits: 3 of 7 done, the copy in progress.
  await expect.poll(() => asking(window)).toBe(true)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/7')
  await expect(panel.tabPanel).toContainText('3 of 7 done')
  await expect(panel.todoProgress).toHaveAttribute('aria-valuenow', '3')
  // Grouped: the item in progress, then the ones not started, then the done ones (the latest finished first, each with
  // its time), so what's still to do comes before what's done (#322).
  await expect(panel.todos).toHaveText([
    `Doing: ${PLAN[3] ?? ''}Copying files · 1,240 of 3,900`,
    `To do: ${PLAN[4] ?? ''}`,
    `To do: ${PLAN[5] ?? ''}`,
    `To do: ${PLAN[6] ?? ''}`,
    done(2),
    done(1),
    done(0),
  ])
  // Done and not started tell apart at a glance: a filled teal check over dimmed, struck-through text, against a hollow
  // ring with the text at full strength (#308).
  await expect.poll(() => look(panel.todos.nth(4))).toEqual({ filled: true, icon: TEAL, text: FAINT, struck: true })
  await expect
    .poll(() => look(panel.todos.nth(1)))
    .toEqual({
      filled: false,
      icon: MUTED,
      text: TEXT,
      struck: false,
    })
  // Each finish time gives the exact time on hover.
  await expect(panel.todoFinished(panel.todos.nth(4))).toHaveAttribute('title', FULL_DATE)
  await expect(panel.todoFinished(panel.todos.first())).toHaveCount(0)
  // The task's row counts the same, and its tooltip names the item in progress.
  const progress = list.todoProgress(list.rows('Active').first())
  await expect(progress).toHaveText('3/7')
  await expect(progress).toHaveAttribute('title', `3 of 7 todos done · Now: ${PLAN[3] ?? ''}`)
  await expect(progress).toHaveAttribute('data-done', 'false')

  // A reply in words answers it, and the agent works through two more steps before the turn ends.
  await send(window, 'Keep them for now.')
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 6/7')
  await expect(panel.tabPanel).toContainText('6 of 7 done')
  // The item left comes first; the copy moved from the top to the done items as it finished, and the steps after it
  // followed, each on top of them.
  const finished = [`To do: ${PLAN[6] ?? ''}`, done(5), done(4), done(3), done(2), done(1), done(0)]
  await expect(panel.todos).toHaveText(finished)
  // The copy, done now, took the filled check; the item left keeps its hollow ring.
  await expect.poll(() => look(panel.todos.nth(3))).toEqual({ filled: true, icon: TEAL, text: FAINT, struck: true })
  await expect
    .poll(() => look(panel.todos.first()))
    .toEqual({
      filled: false,
      icon: MUTED,
      text: TEXT,
      struck: false,
    })
  const times = await panel.todos.evaluateAll((items) =>
    items.map((item) => item.querySelector('time')?.getAttribute('datetime') ?? null),
  )
  await expect(progress).toHaveText('6/7')
  await expect(progress).toHaveAttribute('title', '6 of 7 todos done')

  // The todo tool calls stay in the tool log like any others (#609).
  await panel.tab(/^Agents/).click()
  await expect(panel.call(/^Done\s*create_todo/)).toHaveCount(7)
  await panel.tab(/^Todos/).click()

  // The list is worked out from the stored tool log, so a relaunch shows it as it was.
  await glade.close()
  const relaunched = await launch({ agentScript: 'keeps-todos' })
  const again = taskPanel(relaunched.window)
  await expect(again.tab(/^Todos/)).toHaveText('Todos 6/7')
  await expect(again.tab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
  await expect(again.tabPanel).toContainText('6 of 7 done')
  await expect(again.todos).toHaveText(finished)
  // Each keeps the time it was finished, stored with the tool log.
  const relaunchedTimes = await again.todos.evaluateAll((items) =>
    items.map((item) => item.querySelector('time')?.getAttribute('datetime') ?? null),
  )
  expect(relaunchedTimes).toEqual(times)
  expect(times.filter((time) => time !== null)).toHaveLength(6)
  const relaunchedList = taskList(relaunched.window)
  await expect(relaunchedList.todoProgress(relaunchedList.rows('Active').first())).toHaveText('6/7')

  // Marked done, its row in the Done section (which opens to show it, still selected) keeps its progress.
  await taskHeader(relaunched.window).markDone.click()
  await expect(relaunchedList.rows('Active')).toHaveCount(0)
  await expect(relaunchedList.sectionHeader('Done')).toHaveAttribute('aria-expanded', 'true')
  await expect(relaunchedList.todoProgress(relaunchedList.rows('Done').first())).toHaveText('6/7')
})

test('todos: two update_todo calls with nothing between them still show, most recent first', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await launch({ agentScript: 'writes-todos', chosenFolder: workspaceRoot(tempFolder) })
  const panel = taskPanel(window)
  await startTask(window)
  await send(window, 'Fix the flaky login test.')

  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 3/3')
  // Two calls finish right after each other with nothing between them (#609): the one called second shows first,
  // then the one before it, then the item an earlier call finished.
  await expect(panel.todos).toHaveText([
    /^Done: Run the test 200 timesFinished /,
    /^Done: Fix the raceFinished /,
    /^Done: Reproduce the flakeFinished /,
  ])
  const [run, fix, reproduce] = await panel.todos.evaluateAll((items) =>
    items.map((item) => Date.parse(item.querySelector('time')?.getAttribute('datetime') ?? '')),
  )
  expect(run).toBeGreaterThanOrEqual(fix ?? 0)
  expect(reproduce).toBeLessThan(fix ?? 0)
  // Every item done: the row shows a check.
  const list = taskList(window)
  const progress = list.todoProgress(list.rows('Active').first())
  await expect(progress).toHaveText('3/3')
  await expect(progress).toHaveAttribute('data-done', 'true')
  await expect(progress).toHaveAttribute('title', '3 of 3 todos done')
})

test('todos: a todo set waiting on you shows first, in purple, with its note, and the tab’s own purple count (#680)', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await launch({ agentScript: 'waits-on-you', chosenFolder: workspaceRoot(tempFolder) })
  const panel = taskPanel(window)
  const list = taskList(window)
  await startTask(window)
  await send(window, 'Add rate limiting to the public API.')

  await expect(chat(window).agentReplies).toHaveCount(1)
  // "1/2", then the tab's own purple badge for what's waiting (asserted below), appended to its text.
  await expect(panel.tab(/^Todos/)).toHaveText('Todos 1/21')
  // Waiting on you comes first, ahead of the done item, in one plain list with no group header. Its icon's "?"
  // (cut out of the filled purple circle, #680) is its own text node, ahead of the screen-reader state label.
  await expect(panel.todos).toHaveText([
    '?Waiting on you: Pick a limit for /searchPick a limit: 60 or 120 requests a minute?',
    /^Done: Return Retry-After on 429sFinished /,
  ])
  // Its icon is a filled circle, in purple rather than the done item's teal or an active item's muted ring, and its
  // note is purple too, not the usual blue (#680).
  await expect.poll(() => look(panel.todos.first())).toEqual({ filled: true, icon: PURPLE, text: TEXT, struck: false })
  const note = panel.todos.first().locator('div').last()
  await expect(note).toHaveText('Pick a limit: 60 or 120 requests a minute?')
  await expect.poll(() => note.evaluate((element) => getComputedStyle(element).color)).toBe(PURPLE)

  // The Todos tab's own small purple count, beside its "1/2", names what's waiting (#680).
  await expect(panel.todoWaitingBadge).toHaveText('1')
  await expect(panel.todoWaitingBadge).toHaveAttribute('title', '1 todo waiting on you')

  // The progress bar gives it a purple segment too, between done and in progress.
  const [done, waiting, doing] = await panel.todoProgress.evaluate((bar) =>
    [...bar.children].map((child) => (child as HTMLElement).style.width),
  )
  expect(done).toBe('50%')
  expect(waiting).toBe('50%')
  expect(doing).toBe('0%')

  // The sidebar row's tooltip names it too, the same as it names an item in progress.
  const rowProgress = list.todoProgress(list.rows('Active').first())
  await expect(rowProgress).toHaveText('1/2')
  await expect(rowProgress).toHaveAttribute('title', '1 of 2 todos done · Waiting on you: Pick a limit for /search')
})
