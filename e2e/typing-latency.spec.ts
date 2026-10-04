// Typing in a task with a very long history (#413): about 500 messages, 1,300 tool events, 90 subagents, 45 artifacts
// and 40 todos (`./long-history`). Each key must reach the screen promptly, both while nothing else happens and while
// the agent works a turn, its tool calls streaming into the chat and the tool log. Before the fix, each event of a turn
// rendered the whole chat and tool log again and laid them out twice over, so keys waited a second or more.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  HUB_CHILDREN_UNDER_FIRST,
  LONG_HISTORY,
  LONG_TASK_TITLE,
  SelectedHistory,
  writeLongHistorySeed,
} from './long-history'
import { agentsTab, chat, inputBar, taskHeader, taskPanel, todoHub } from './selectors'

/** A key every 60 ms: fast typing, about 200 words a minute. */
const PACE_MS = 60
const TEXT = 'the quick brown fox jumps over the lazy dog'

/**
 * The slowest a key may be to show, at the median: generous, for a slow CI runner. It took 2 to 8 ms after the fix on
 * the machine that measured it, and 400 to 1,100 ms before it while the agent worked.
 */
const MEDIAN_LIMIT_MS = 150

/** A key as the page saw it: when it was pressed, and when the frame after it had been drawn. */
interface KeySample {
  readonly at: number
  paint: number | null
}

interface MeasuredWindow {
  __keys?: KeySample[]
}

/** Starts recording each keydown's time and the end of the frame that follows it. */
async function recordKeys(window: Page): Promise<void> {
  await window.evaluate(() => {
    const keys: KeySample[] = []
    ;(globalThis as MeasuredWindow).__keys = keys
    document.addEventListener(
      'keydown',
      (event) => {
        const key: KeySample = { at: event.timeStamp, paint: null }
        keys.push(key)
        // A message posted from the next animation frame is handled once that frame has been drawn.
        requestAnimationFrame(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => {
            key.paint = performance.now()
          }
          channel.port2.postMessage(null)
        })
      },
      { capture: true },
    )
  })
}

/**
 * Types `text` at a steady pace, without waiting on the window between keys, as a person does, and answers each key's
 * time to the screen, in milliseconds, in order of size.
 */
async function typeAndMeasure(window: Page, text: string): Promise<number[]> {
  await window.evaluate(() => {
    ;(globalThis as MeasuredWindow).__keys?.splice(0)
  })
  const presses: Promise<void>[] = []
  for (const char of text) {
    presses.push(window.keyboard.press(char === ' ' ? 'Space' : char))
    await new Promise((resolve) => setTimeout(resolve, PACE_MS))
  }
  await Promise.all(presses)
  await window.waitForFunction((count) => {
    const keys = (globalThis as MeasuredWindow).__keys ?? []
    return keys.length === count && keys.every(({ paint }) => paint !== null)
  }, text.length)
  const latencies = await window.evaluate(() =>
    ((globalThis as MeasuredWindow).__keys ?? []).map(({ at, paint }) => (paint ?? at) - at),
  )
  return latencies.sort((a, b) => a - b)
}

function median(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

test('typing stays prompt in a task with a very long history, idle and while the agent works', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  // The whole history is there: every message, and the tool log's rows.
  await expect(chat(window).userMessages).toHaveCount(LONG_HISTORY.messages / 2)
  await expect(chat(window).agentReplies).toHaveCount(LONG_HISTORY.messages / 2)
  await expect(taskPanel(window).tab(/^Subagents/)).toHaveText(`Subagents ${String(LONG_HISTORY.subagents)}`)

  await typesPromptly(window)
})

/** Types a message while nothing else happens, then another while the agent works a turn: each key shows promptly. */
async function typesPromptly(window: Page): Promise<void> {
  const bar = inputBar(window)
  await bar.field.click()
  await recordKeys(window)

  const idle = await typeAndMeasure(window, TEXT)
  expect(median(idle)).toBeLessThan(MEDIAN_LIMIT_MS)
  await expect(bar.field).toHaveValue(TEXT)

  // A turn: its notes, tool calls and status changes arrive as you type the next message.
  await bar.field.fill('Check the date test.')
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()
  const working = await typeAndMeasure(window, TEXT)
  expect(median(working)).toBeLessThan(MEDIAN_LIMIT_MS)
  await expect(bar.field).toHaveValue(TEXT)
  await expect(chat(window).agentReplies).toHaveCount(LONG_HISTORY.messages / 2 + 1)
}

// The same task with the Agents tab open on it (P16, #536), which the panel shows in place of Tool calls and
// Subagents while the todo hub's switch is on: a tab for each of its 90 subagents and Main, and Main's list, the whole
// tool log of the task's own agent. Every event of the turn reaches them; a tab renders only when its own agent's
// name or state changed, and a row only when its own event did, so the keys don't wait on them. (With the switch off,
// the test above waits on the Subagents tab's count, as it always has.)
test('typing stays prompt with the Agents tab open on a task with a very long history', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long, 'agents', true)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  await expect(chat(window).agentReplies).toHaveCount(LONG_HISTORY.messages / 2)
  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await expect(panel.tabs).toHaveCount(3)
  await expect(panel.tab(/^Agents/)).toHaveText(`Agents ${String(LONG_HISTORY.subagents + 1)}`)
  await expect(agents.tabs).toHaveCount(LONG_HISTORY.subagents + 1)
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
  // Main's list is there, with every subagent it started as a call of its own.
  await expect(agents.list.locator('[data-agent-call]')).toHaveCount(LONG_HISTORY.subagents)

  await typesPromptly(window)
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
})

// The same task with the todo hub open on it (P16, #497): 40 todos, each a card, three of them open, the first over 50
// tiles, two of them subagents still running, and each todo's title naming a PR the task has as a link, so each is a
// link to it (#500). Every event of the turn reaches the hub, which works out each todo's children again; a card or a
// tile renders only when its own data changed, so the keys don't wait on it.
test('typing stays prompt with the todo hub open on a task with a very long history', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long, 'todos', true)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  await expect(chat(window).agentReplies).toHaveCount(LONG_HISTORY.messages / 2)
  const hub = todoHub(window)
  await expect(hub.cards).toHaveCount(LONG_HISTORY.todos)
  await expect(hub.tiles(hub.cards.first())).toHaveCount(HUB_CHILDREN_UNDER_FIRST)
  await expect(hub.liveTiles(hub.cards.first())).toHaveCount(2)
  await expect(hub.cards.locator('[data-todo-head][aria-expanded="true"]')).toHaveCount(3)
  await expect(hub.links(hub.heads)).toHaveCount(LONG_HISTORY.todos)

  await typesPromptly(window)
  await expect(hub.links(hub.heads)).toHaveCount(LONG_HISTORY.todos)
})
