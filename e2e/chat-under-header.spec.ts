import type { Page } from '@playwright/test'
import { expect, seedPath, test, type Glade } from './fixtures'
import { chat, inputBar, regions, taskHeader } from './selectors'
import { boxOf, MIN_WINDOW, resize } from './window-layout'

/** The windows the chat is checked in: the tests' default, the smallest, and one short but wide. */
const WINDOWS = [
  { name: 'default', width: 1920, height: 1200 },
  { name: 'narrow', width: MIN_WINDOW.width, height: MIN_WINDOW.height },
  { name: 'short', width: 1920, height: MIN_WINDOW.height },
] as const

/** How far the chat's scroll position may sit from its bottom and still count as at it (subpixel layout). */
const AT_BOTTOM_SLACK = 1

async function distanceFromBottom(window: Page): Promise<number> {
  return chat(window).log.evaluate((log) => log.scrollHeight - log.clientHeight - log.scrollTop)
}

/**
 * The chat runs all the way up under the header card: its scroller's top is at or above the header's, and at points
 * over the header, the header's own elements are stacked directly on the chat's, with nothing (opaque or not) between.
 */
async function expectChatUnderTheHeader({ window }: Glade): Promise<void> {
  const header = await boxOf(regions(window).taskHeader)
  const log = await boxOf(chat(window).log)
  expect(log.y).toBeLessThanOrEqual(header.y)
  expect(log.y + log.height).toBeGreaterThan(header.y + header.height)

  const stacks = await window.evaluate(
    ({ header: box }) => {
      const headerElement = document.querySelector('[role="region"][aria-label="Task header"]')
      const logElement = document.querySelector('[role="log"][aria-label="Conversation"]')
      if (headerElement === null || logElement === null) throw new Error('No header or chat')
      // Just inside the header's bottom corners and the middle of its bottom edge.
      const bottom = box.y + box.height
      const points = [
        { x: box.x + 12, y: bottom - 4 },
        { x: box.x + box.width / 2, y: bottom - 4 },
        { x: box.x + box.width - 12, y: bottom - 4 },
      ]
      return points.map(({ x, y }) => {
        const stack = document.elementsFromPoint(x, y)
        const below = stack.filter((element) => !headerElement.contains(element))
        return {
          headerOnTop: stack[0] !== undefined && headerElement.contains(stack[0]),
          // What's directly under the header's elements: the chat (or something in it), with nothing in between but
          // the header's own wrapper, which is transparent.
          between: below
            .slice(
              0,
              below.findIndex((element) => logElement.contains(element)),
            )
            .map((element) => ({ tag: element.tagName, background: getComputedStyle(element).backgroundColor })),
          chatBelow: below.some((element) => logElement.contains(element)),
        }
      })
    },
    { header },
  )
  for (const stack of stacks) {
    expect(stack.headerOnTop).toBe(true)
    expect(stack.chatBelow).toBe(true)
    for (const element of stack.between) expect(element.background).toBe('rgba(0, 0, 0, 0)')
  }
}

/** The header card is opaque with a shadow, so the messages under it don't show through. */
async function expectAnOpaqueHeader({ window }: Glade): Promise<void> {
  const look = await regions(window).taskHeader.evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, shadow: style.boxShadow }
  })
  expect(look.background).toMatch(/^rgb\(/)
  expect(look.shadow).not.toBe('none')
}

/** Scrolled to the top, the first message sits below the header card, whole and clear of it. */
async function expectFirstMessageReachable({ window }: Glade): Promise<void> {
  const conversation = chat(window)
  await conversation.log.hover()
  await window.mouse.wheel(0, -10_000)
  await expect.poll(() => conversation.log.evaluate((log) => log.scrollTop)).toBe(0)
  const header = await boxOf(regions(window).taskHeader)
  const first = await boxOf(conversation.userMessages.first())
  expect(first.y).toBeGreaterThanOrEqual(header.y + header.height)
  await expect(conversation.userMessages.first()).toBeInViewport({ ratio: 1 })
}

/** Scrolled back down, it's at the bottom, and the latest reply sits whole above the input bar. */
async function expectStuckToTheBottom({ window }: Glade): Promise<void> {
  const conversation = chat(window)
  await conversation.log.hover()
  await window.mouse.wheel(0, 10_000)
  await expect.poll(() => distanceFromBottom(window)).toBeLessThanOrEqual(AT_BOTTOM_SLACK)
  const last = conversation.agentReplies.last()
  await expect(last).toBeInViewport({ ratio: 0.9 })
  const bar = await boxOf(regions(window).inputBar)
  const lastBox = await boxOf(last)
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(bar.y)
}

for (const size of WINDOWS) {
  test(`${size.name} window: the chat scrolls all the way under the header card, and its first and last messages are reachable`, async ({
    launch,
  }) => {
    const glade = await launch({ seed: seedPath('long-header.json') })
    const { window } = glade
    await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)
    await resize(glade, size.width, size.height)

    await expectChatUnderTheHeader(glade)
    await expectAnOpaqueHeader(glade)
    await expectFirstMessageReachable(glade)
    await expectStuckToTheBottom(glade)
  })
}

test('scrolled part way, a message shows under the header card rather than being cut off below it', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const conversation = chat(window)
  expect(await conversation.log.evaluate((log) => log.scrollHeight > log.clientHeight)).toBe(true)

  // Scroll so the first message is half under the header card.
  const header = await boxOf(regions(window).taskHeader)
  const offset = await conversation.userMessages
    .first()
    .evaluate(
      (message, headerBottom) => message.getBoundingClientRect().top - headerBottom + 20,
      header.y + header.height,
    )
  await conversation.log.evaluate((log, by) => {
    log.scrollTop += by
  }, offset)
  const first = await boxOf(conversation.userMessages.first())
  expect(first.y).toBeLessThan(header.y + header.height)

  // Under the header's bottom edge, over the message, it's the message there, not a band of the card's background.
  const under = await window.evaluate(
    ({ x, y }) => document.elementsFromPoint(x, y).map((element) => element.closest('article')?.ariaLabel ?? null),
    { x: first.x + first.width - 20, y: header.y + header.height - 2 },
  )
  expect(under).toContain('You')

  await expectChatUnderTheHeader(glade)
})

test('the chat stays stuck to the bottom as a reply comes in, under the header card', async ({ launch }) => {
  const glade = await launch({ seed: seedPath('long-header.json'), agentScript: 'simple-reply' })
  const { window } = glade
  await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const conversation = chat(window)
  const replies = await conversation.agentReplies.count()
  await expect.poll(() => distanceFromBottom(window)).toBeLessThanOrEqual(AT_BOTTOM_SLACK)

  const bar = inputBar(window)
  await bar.field.fill('How heavy is /search compared with the rest?')
  await bar.send.click()

  await expect(conversation.agentReplies).toHaveCount(replies + 1)
  await expect.poll(() => distanceFromBottom(window)).toBeLessThanOrEqual(AT_BOTTOM_SLACK)
  await expect(conversation.agentReplies.last()).toBeInViewport({ ratio: 0.9 })
  await expectChatUnderTheHeader(glade)
})
