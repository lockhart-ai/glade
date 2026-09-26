import type { Page } from '@playwright/test'
import { expect, seedPath, test, type Glade } from './fixtures'
import { chat, inputBar, regions, taskHeader } from './selectors'
import { boxOf, MIN_WINDOW, resize, type Box } from './window-layout'

/** The windows the chat is checked in: the tests' default, the smallest, and one short but wide. */
const WINDOWS = [
  { name: 'default', width: 1920, height: 1200 },
  { name: 'narrow', width: MIN_WINDOW.width, height: MIN_WINDOW.height },
  { name: 'short', width: 1920, height: MIN_WINDOW.height },
] as const

/** The header card's and input bar's corner radius (`--radius-nested`): the chat mustn't show past their corners. */
const CARD_RADIUS = 12

/** Layout rounding. */
const SLACK = 1

/**
 * Where the chat's content can show: its scroller's box, cut down by every element around it that clips what
 * overflows it.
 */
async function chatClip(window: Page): Promise<Box> {
  return chat(window).log.evaluate((log) => {
    let { top, right, bottom, left } = log.getBoundingClientRect()
    for (let around = log.parentElement; around !== null; around = around.parentElement) {
      const style = getComputedStyle(around)
      if (style.overflowX === 'visible' && style.overflowY === 'visible' && style.clipPath === 'none') continue
      const box = around.getBoundingClientRect()
      top = Math.max(top, box.top)
      right = Math.min(right, box.right)
      bottom = Math.min(bottom, box.bottom)
      left = Math.max(left, box.left)
    }
    return { x: left, y: top, width: right - left, height: bottom - top }
  })
}

/**
 * The chat is cut off halfway under the header card and halfway under the input bar: it never shows above the header's
 * top edge or below the input bar's bottom edge, nor past their rounded corners, and it's a little narrower than both.
 */
async function expectChatClippedUnderTheCards(glade: Glade): Promise<void> {
  // The cards' heights reach the chat's clip through a resize observer, a frame after they change.
  await expect(() => chatClippedUnderTheCards(glade)).toPass()
}

async function chatClippedUnderTheCards({ window }: Glade): Promise<void> {
  const header = await boxOf(regions(window).taskHeader)
  const bar = await boxOf(regions(window).inputBar)
  const clip = await chatClip(window)

  // Top: under the header, past its rounded corners, about halfway down it.
  expect(clip.y).toBeGreaterThan(header.y + CARD_RADIUS)
  expect(clip.y).toBeLessThan(header.y + header.height - CARD_RADIUS)
  expect(Math.abs(clip.y - (header.y + header.height / 2))).toBeLessThanOrEqual(SLACK)

  // Bottom: under the input bar, past its rounded corners, about halfway down it.
  const clipBottom = clip.y + clip.height
  expect(clipBottom).toBeGreaterThan(bar.y + CARD_RADIUS)
  expect(clipBottom).toBeLessThan(bar.y + bar.height - CARD_RADIUS)
  expect(Math.abs(clipBottom - (bar.y + bar.height / 2))).toBeLessThanOrEqual(SLACK)

  // Sides: inset a little from the header and the input bar, which line up with each other.
  for (const card of [header, bar]) {
    expect(clip.x).toBeGreaterThan(card.x)
    expect(clip.x + clip.width).toBeLessThan(card.x + card.width)
  }
}

/** Both cards are opaque, so what's under them doesn't show through. */
async function expectOpaqueCards({ window }: Glade): Promise<void> {
  const header = await regions(window).taskHeader.evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(header).toMatch(/^rgb\(/)
  const bar = await inputBar(window).field.evaluate((field) => {
    let around = field.parentElement
    while (around !== null && getComputedStyle(around).borderTopWidth === '0px') around = around.parentElement
    if (around === null) throw new Error('The field isn’t on a card')
    return getComputedStyle(around).backgroundColor
  })
  expect(bar).toMatch(/^rgb\(/)
}

/** Scrolled to the top, the first message is clear of the header; to the bottom, the last one is clear of the input. */
async function expectEndsReachable({ window }: Glade): Promise<void> {
  const conversation = chat(window)
  await conversation.log.hover()
  await window.mouse.wheel(0, -10_000)
  await expect.poll(() => conversation.log.evaluate((log) => log.scrollTop)).toBe(0)
  const header = await boxOf(regions(window).taskHeader)
  expect((await boxOf(conversation.userMessages.first())).y).toBeGreaterThanOrEqual(header.y + header.height)

  await window.mouse.wheel(0, 10_000)
  await expect
    .poll(() => conversation.log.evaluate((log) => log.scrollHeight - log.clientHeight - log.scrollTop))
    .toBeLessThanOrEqual(SLACK)
  const bar = await boxOf(regions(window).inputBar)
  const last = await boxOf(conversation.agentReplies.last())
  expect(last.y + last.height).toBeLessThanOrEqual(bar.y)
}

/** Scrolls the chat so its last reply's top sits a little under the input bar's top edge. */
async function scrollAReplyUnderTheInput({ window }: Glade): Promise<Box> {
  const conversation = chat(window)
  const bar = await boxOf(regions(window).inputBar)
  const last = conversation.agentReplies.last()
  const by = await last.evaluate((reply, barTop) => reply.getBoundingClientRect().top - (barTop + 6), bar.y)
  await conversation.log.evaluate((log, delta) => {
    log.scrollTop += delta
  }, by)
  const reply = await boxOf(last)
  expect(reply.y).toBeGreaterThan(bar.y)
  expect(reply.y).toBeLessThan(bar.y + bar.height / 2)
  return reply
}

for (const size of WINDOWS) {
  test(`${size.name} window: the chat is cut off halfway under the header card and the input bar, and a little inset from them`, async ({
    launch,
  }) => {
    const glade = await launch({ seed: seedPath('long-header.json') })
    await expect(taskHeader(glade.window).title).toHaveText(/^Add per-key rate limiting/)
    await resize(glade, size.width, size.height)

    await expectChatClippedUnderTheCards(glade)
    await expectOpaqueCards(glade)
    await expectEndsReachable(glade)
    await expectChatClippedUnderTheCards(glade)
  })
}

test('scrolled part way, a reply runs under the input bar rather than stopping short of it', async ({ launch }) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const reply = await scrollAReplyUnderTheInput(glade)

  // Inside the input bar's top half, just over the reply's top: the input bar is on top, and the reply is under it.
  const bar = await boxOf(regions(window).inputBar)
  const stack = await window.evaluate(
    ({ x, y }) => {
      const replies = document.querySelectorAll('[role="log"] article[aria-label="Agent"]')
      const last = replies[replies.length - 1]
      return document.elementsFromPoint(x, y).map((element) => ({
        inInputBar: element.closest('[data-testid="input-bar"]') !== null,
        inReply: last !== undefined && last.contains(element),
      }))
    },
    { x: reply.x + 20, y: reply.y + 4 },
  )
  expect(stack[0]?.inInputBar).toBe(true)
  expect(stack.some(({ inReply }) => inReply)).toBe(true)

  // Just below the input bar's bottom edge, nothing of the chat shows.
  const below = await window.evaluate(
    ({ x, y }) => document.elementsFromPoint(x, y).some((element) => element.closest('[role="log"]') !== null),
    { x: reply.x + 20, y: bar.y + bar.height + 2 },
  )
  expect(below).toBe(false)
  await expectChatClippedUnderTheCards(glade)
})

test('with the message queue open above the input, the chat is cut off halfway under the taller input bar', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-chat-queue.json') })
  const { window } = glade
  await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)
  const bar = inputBar(window)
  await expect(bar.queuedRows).toHaveCount(2)
  for (const size of [MIN_WINDOW, { width: 1920, height: MIN_WINDOW.height }]) {
    await resize(glade, size.width, size.height)
    await expectChatClippedUnderTheCards(glade)
    await expectEndsReachable(glade)
  }
})

test('as the input bar grows and shrinks, the chat’s clip follows it and the latest reply stays in view above it', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const conversation = chat(window)
  const bar = inputBar(window)
  const before = await boxOf(regions(window).inputBar)

  // Several lines in the field make the input bar taller.
  await bar.field.fill(['Burst of 10.', 'Document it.', 'Add a test for it.', 'Then run the suite.'].join('\n'))
  await expect.poll(async () => (await boxOf(regions(window).inputBar)).height).toBeGreaterThan(before.height)
  await expectChatClippedUnderTheCards(glade)
  await expect(conversation.agentReplies.last()).toBeInViewport({ ratio: 0.9 })
  const taller = await boxOf(regions(window).inputBar)
  const last = await boxOf(conversation.agentReplies.last())
  expect(last.y + last.height).toBeLessThanOrEqual(taller.y)

  // Cleared, it shrinks back, and so does the chat's clip.
  await bar.field.fill('')
  await expect.poll(async () => (await boxOf(regions(window).inputBar)).height).toBe(before.height)
  await expectChatClippedUnderTheCards(glade)
})
