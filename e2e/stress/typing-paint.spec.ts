// Typing in a task with a very long history (#413) stays prompt, both while nothing else happens and while the agent
// works a turn, its tool calls streaming into the chat and the tool log. A key is timed from the keydown to the frame
// after it had been drawn, the way the launch-paint spec times a launch, in the same three settings CI's
// `../typing-latency.spec.ts` checks: the plain task, the task with the Agents tab open and the task with the todo
// hub open (`../long-history`).
//
// A measurement, not a CI check (Jared, Oct 19, #746: no wall-clock budgets asserted in tests CI runs): CI's spec
// keeps the behaviour — typing keeps every keystroke — without a duration. Run it with
// `GLADE_E2E_STRESS=1 npx playwright test e2e/stress/typing-paint.spec.ts`; it prints each round's idle and working
// medians.
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { HISTORY_PAGE } from '../../src/shared/bridge'
import {
  HUB_CHILDREN_UNDER_FIRST,
  LONG_HISTORY,
  LONG_TASK_TITLE,
  SelectedHistory,
  writeLongHistorySeed,
} from '../long-history'
import { agentsTab, chat, inputBar, taskHeader, taskPanel, todoHub } from '../selectors'
import { MEDIAN_LIMIT_MS, TEXT, median, recordKeys, typeAndMeasure } from '../typing'

/**
 * Types a message while nothing else happens, then another while the agent works a turn: each key shows promptly.
 * Prints both medians and holds the budget.
 */
async function measuredTyping(window: Page, setting: string): Promise<void> {
  const bar = inputBar(window)
  await bar.field.click()
  await recordKeys(window)

  const idle = await typeAndMeasure(window, TEXT)
  console.log(`[746] typing (${setting}): idle median ${String(median(idle))} ms`)
  expect(median(idle)).toBeLessThan(MEDIAN_LIMIT_MS)
  await expect(bar.field).toHaveValue(TEXT)

  // A turn: its notes, tool calls and status changes arrive as you type the next message.
  await bar.field.fill('Check the date test.')
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()
  const working = await typeAndMeasure(window, TEXT)
  console.log(`[746] typing (${setting}): working median ${String(median(working))} ms`)
  expect(median(working)).toBeLessThan(MEDIAN_LIMIT_MS)
  await expect(bar.field).toHaveValue(TEXT)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2 + 1)
}

test('typing stays prompt in a task with a very long history, idle and while the agent works', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  // The chat shows the tail first (#637): the last screenful of messages, older history loading as you scroll up.
  await expect(chat(window).userMessages).toHaveCount(HISTORY_PAGE / 2)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2)
  await expect(taskPanel(window).tab(/^Agents/)).toHaveText(`Agents ${String(LONG_HISTORY.subagents + 1)}`)

  await measuredTyping(window, 'plain task')
})

test('typing stays prompt with the Agents tab open on a task with a very long history', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long, 'agents', true)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2)
  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await expect(panel.tabs).toHaveCount(3)
  await expect(panel.tab(/^Agents/)).toHaveText(`Agents ${String(LONG_HISTORY.subagents + 1)}`)
  // The seed's 2 still-running subagents are tabs with Main; the other 88 finished ones are counted on the caret's
  // dropdown (#617), so they still all load.
  await expect(agents.tabs).toHaveCount(3)
  await expect(agents.caret).toHaveText(String(LONG_HISTORY.subagents - 2))
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')

  await measuredTyping(window, 'Agents tab')
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
})

test('typing stays prompt with the todo hub open on a task with a very long history', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long, 'todos', true)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2)
  const hub = todoHub(window)
  await expect(hub.cards).toHaveCount(LONG_HISTORY.todos)
  await expect(hub.tiles(hub.cards.first())).toHaveCount(HUB_CHILDREN_UNDER_FIRST)
  await expect(hub.activity).toHaveCount(0)
  await expect(hub.cards.locator('[data-todo-head][aria-expanded="true"]')).toHaveCount(3)
  await expect(hub.links(hub.heads)).toHaveCount(LONG_HISTORY.todos)

  await measuredTyping(window, 'todo hub')
  await expect(hub.links(hub.heads)).toHaveCount(LONG_HISTORY.todos)
})
