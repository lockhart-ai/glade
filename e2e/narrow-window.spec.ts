import type { Locator } from '@playwright/test'
import { expect, seedPath, test, type Glade } from './fixtures'
import { chat, regions, taskHeader, taskPanel } from './selectors'

/** The window's minimum size (src/main/app.ts). */
const MIN_WINDOW = { width: 1100, height: 700 } as const

/**
 * The tallest the header may be in the smallest window: one line of title, the pill and timing, and one line each of
 * objective and status. Wrapped, it was about four times the lines and pushed the chat under the input bar.
 */
const MAX_HEADER_HEIGHT = 200

/** The chat keeps at least this much height in the smallest window. */
const MIN_CHAT_HEIGHT = 80

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('The element is not laid out')
  return box
}

async function resize({ app, window }: Glade, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    },
    { width, height },
  )
  await expect.poll(() => window.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}

/** The header stays compact, the chat keeps room and scrolls, and its last message sits above the input bar. */
async function expectChatClearOfTheHeader({ window }: Glade): Promise<void> {
  const header = taskHeader(window)
  const conversation = chat(window)
  const inputBar = regions(window).inputBar

  await expect.poll(async () => (await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_HEADER_HEIGHT)
  await expect(header.markDone).toBeInViewport({ ratio: 1 })

  // The chat keeps room above the input bar, and its latest message shows there, clear of the input bar.
  const chatBox = await boxOf(regions(window).chat)
  const barBox = await boxOf(inputBar)
  expect(chatBox.height).toBeGreaterThanOrEqual(MIN_CHAT_HEIGHT)
  expect(chatBox.y + chatBox.height).toBeLessThanOrEqual(barBox.y)
  const last = conversation.agentReplies.last()
  await expect(last).toBeInViewport({ ratio: 0.9 })
  const lastBox = await boxOf(last)
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y)

  // The rest of the conversation is a scroll away.
  expect(await conversation.log.evaluate((log) => log.scrollHeight > log.clientHeight)).toBe(true)
  await conversation.log.hover()
  await window.mouse.wheel(0, -5000)
  await expect.poll(() => conversation.log.evaluate((log) => log.scrollTop)).toBe(0)
  const first = await boxOf(conversation.userMessages.first())
  expect(first.y).toBeGreaterThanOrEqual(chatBox.y)
  await window.mouse.wheel(0, 5000)
  await expect
    .poll(() => conversation.log.evaluate((log) => log.scrollHeight - log.clientHeight - log.scrollTop))
    .toBeLessThanOrEqual(1)
}

test('narrow window: the header stays compact and the chat stays visible and scrollable above the input bar', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  const header = taskHeader(window)
  await expect(header.title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)

  // The long title truncates to one line, with the whole of it as a tooltip; so do the objective and status.
  await expect(header.title).toHaveAttribute('title', /give the search endpoint its own tighter limit$/)
  expect(await header.title.evaluate((title) => title.scrollWidth > title.clientWidth)).toBe(true)
  await expect(header.field('Objective')).toHaveAttribute('title', /without a deploy\.$/)
  await expect(header.field('Status')).toHaveAttribute('title', /before finishing\.$/)

  // With the side panel at its default width (held down by the chat's minimum in this window)…
  await expectChatClearOfTheHeader(glade)

  // …and at its minimum.
  const panel = taskPanel(window)
  const before = (await boxOf(panel.panel)).width
  await panel.resizeHandle.focus()
  for (let step = 0; step < 4; step++) await window.keyboard.press('ArrowRight')
  await expect.poll(async () => (await boxOf(panel.panel)).width).toBeLessThan(before)
  await expect.poll(async () => (await boxOf(panel.panel)).width).toBe(320)
  await expectChatClearOfTheHeader(glade)
})
