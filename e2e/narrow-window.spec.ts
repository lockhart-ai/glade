import { expect, seedPath, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, inputBar, regions, settings, taskHeader, taskPanel } from './selectors'
import { boxOf, MIN_WINDOW, resize } from './window-layout'

/**
 * The tallest the header may be in the smallest window: one line of title, the pill and timing, and one line each of
 * objective and status. Wrapped, it was about four times the lines and pushed the chat under the input bar.
 */
const MAX_HEADER_HEIGHT = 120

/** The chat keeps at least this much height in the smallest window. */
const MIN_CHAT_HEIGHT = 80

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

test('narrow window: the panel tabs fade where more of them scroll, the input bar settings fit, and the keycaps clear the scrollbar', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)

  // The tabs don't all fit: the row fades at the end with more past it, and at the start once it has scrolled there.
  const panel = taskPanel(window)
  const tabRow = panel.panel.getByRole('tablist', { name: 'Task panels' })
  await expect(tabRow).toHaveAttribute('data-overflow-end', 'true')
  await expect(tabRow).toHaveAttribute('data-overflow-start', 'false')
  await tabRow.hover()
  await window.mouse.wheel(400, 0)
  await expect(tabRow).toHaveAttribute('data-overflow-start', 'true')
  await expect(tabRow).toHaveAttribute('data-overflow-end', 'false')
  // Whole but for a subpixel at the rounded end.
  await expect(panel.tab('Subagents')).toBeInViewport({ ratio: 0.98 })

  // The input bar's settings fit in its row, the last one clear of the bar's edge, with the context meter after it.
  const bar = inputBar(window)
  const row = regions(window).inputBar.getByTestId('context-meter-slot').locator('..')
  expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const permissions = await boxOf(bar.setting('Permissions'))
  const barBox = await boxOf(regions(window).inputBar)
  expect(barBox.x + barBox.width - (permissions.x + permissions.width)).toBeGreaterThanOrEqual(8)

  // Settings › Keyboard: the keycaps end short of the section's scrollbar gutter, and the fixed ones look apart.
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const modal = settings(window)
  await modal.section('Keyboard').click()
  const newTask = modal.dialog.getByRole('button', { name: /^New task: / })
  const clearance = await newTask.evaluate((keycap) => {
    let body = keycap.parentElement
    while (body !== null && getComputedStyle(body).overflowY !== 'auto') body = body.parentElement
    if (body === null) throw new Error('No scrolling section')
    const style = getComputedStyle(body)
    return {
      gutter: Number.parseFloat(style.paddingRight),
      clear: body.getBoundingClientRect().right - keycap.getBoundingClientRect().right,
      stable: style.scrollbarGutter,
    }
  })
  expect(clearance.gutter).toBeGreaterThanOrEqual(12)
  expect(clearance.clear).toBeGreaterThanOrEqual(clearance.gutter)
  expect(clearance.stable).toBe('stable')
  const look = (keycap: string) =>
    modal.dialog
      .getByText(keycap, { exact: true })
      .first()
      .evaluate((kbd) => {
        const style = getComputedStyle(kbd)
        return { color: style.color, cursor: style.cursor }
      })
  const fixed = await look('⌘W')
  const rebindable = await look('⌘N')
  expect(fixed.color).not.toBe(rebindable.color)
  expect(fixed.cursor).toBe('default')
})
