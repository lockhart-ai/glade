// How the question card lays out a crowd of options (issue #269): option cards keep a minimum width and wrap onto more
// rows rather than squeezing onto one, and their text, even a word too long for the card, stays inside them. Pills wrap
// too, and a pill too long for the row breaks inside itself. Checked in the smallest window and a wide one, with the
// scripted agent's `asks-many-choices`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test, type Glade } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'
import { boxOf, MIN_WINDOW, resize } from './window-layout'

/** The narrowest an option card gets while it shares a row, and the most that share one (QuestionCard.module.css). */
const MIN_OPTION_WIDTH = 160
const MAX_PER_ROW = 3

/** The smallest window, and a wide one: the chat column is narrowest in the first, and at its widest in the second. */
const WINDOWS = [
  { name: 'smallest', width: MIN_WINDOW.width, height: MIN_WINDOW.height },
  { name: 'wide', width: 1920, height: 1200 },
] as const

/** The questions `asks-many-choices` asks, by prompt. */
const FIVE_LONG = 'What can I start without asking again? (pick all that apply)'
const TWO = 'How strict should the /search limit be?'
const NINE = 'Which endpoint gets its own limit first?'
const SKETCHES = 'Where should the limits live?'
const PILLS = 'Who should hear about the new limits?'

/** Opens a workspace, starts a task, and waits for the agent's crowd of questions to open on its card. */
async function askManyChoices(glade: Glade, root: string): Promise<Locator> {
  const { window } = glade
  mkdirSync(root)
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Add per-endpoint rate limits.')
  await bar.field.press('Enter')
  const card = chat(window).questionCard
  await expect(card).toContainText('5 questions')
  return card
}

/** A question's options, by its prompt: a radio group, or a group of checkboxes. */
function options(card: Locator, prompt: string): Locator {
  return card.getByRole('radiogroup', { name: prompt, exact: true }).or(card.getByRole('group', { name: prompt }))
}

/**
 * Where each option's text spills out of its card (or the option out of its group), as readable lines: none when it
 * all fits. Text in a box that clips it (a sketch's line) counts only as far as that box shows it.
 */
function spills(group: Locator): Promise<string[]> {
  return group.evaluate((element) => {
    const found: string[] = []
    const within = (inner: DOMRect, outer: DOMRect): boolean =>
      inner.left >= outer.left - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.bottom <= outer.bottom + 0.5
    const groupBox = element.getBoundingClientRect()
    for (const option of Array.from(element.querySelectorAll('button'))) {
      const optionBox = option.getBoundingClientRect()
      const name = option.textContent
      if (!within(optionBox, groupBox)) found.push(`option out of its group: ${name}`)
      if (option.scrollWidth > option.clientWidth) found.push(`scrolls sideways: ${name}`)
      const walker = document.createTreeWalker(option, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          let [left, right] = [rect.left, rect.right]
          for (let box = node.parentElement; box !== null && box !== option; box = box.parentElement) {
            if (getComputedStyle(box).overflowX === 'visible') continue
            const clip = box.getBoundingClientRect()
            left = Math.max(left, clip.left)
            right = Math.min(right, clip.right)
          }
          if (right <= left) continue
          const shown = new DOMRect(left, rect.top, right - left, rect.height)
          if (!within(shown, optionBox)) {
            found.push(`text out of its card: "${node.textContent ?? ''}"`)
            break
          }
        }
      }
    }
    return found
  })
}

/** The options' boxes, in order. */
async function boxes(group: Locator): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const buttons = await group.getByRole('radio').or(group.getByRole('checkbox')).all()
  return Promise.all(buttons.map((button) => boxOf(button)))
}

/** How many options sit on each row, top to bottom. */
function perRow(placed: readonly { y: number }[]): number[] {
  const counts = new Map<number, number>()
  for (const { y } of placed) counts.set(Math.round(y), (counts.get(Math.round(y)) ?? 0) + 1)
  return [...counts.values()]
}

/** How many rows the options sit on. */
function rows(placed: readonly { y: number }[]): number {
  return perRow(placed).length
}

for (const size of WINDOWS) {
  test(`question card, ${size.name} window: a crowd of options wraps onto more rows, its text inside each card`, async ({
    launch,
    tempFolder,
  }) => {
    const root = join(tempFolder(), 'acme-api')
    const glade = await launch({ agentScript: 'asks-many-choices', chosenFolder: root })
    const card = await askManyChoices(glade, root)
    await resize(glade, size.width, size.height)

    // Five long options (the bug's), nine short ones, and three with sketches and words too long for a card: all their
    // text stays inside their cards, which keep a minimum width, at most three to a row, and wrap onto more rows.
    for (const prompt of [FIVE_LONG, NINE, SKETCHES]) {
      const group = options(card, prompt)
      expect(await spills(group), prompt).toEqual([])
      const placed = await boxes(group)
      // Three fit on the wide window's row; everywhere else they wrap.
      if (prompt === SKETCHES && size.name === 'wide') expect(rows(placed), prompt).toBe(1)
      else expect(rows(placed), prompt).toBeGreaterThan(1)
      for (const box of placed) expect(box.width, prompt).toBeGreaterThanOrEqual(MIN_OPTION_WIDTH - 0.5)
      for (const count of perRow(placed)) expect(count, prompt).toBeLessThanOrEqual(MAX_PER_ROW)
      expect((await boxOf(group)).width).toBeLessThanOrEqual((await boxOf(card)).width)
    }

    // Two options still share one row, half each, as the design shows.
    const two = options(card, TWO)
    const [first, second] = await boxes(two)
    const row = await boxOf(two)
    expect(first?.y).toBe(second?.y)
    expect(first?.width).toBeCloseTo(second?.width ?? 0, 0)
    expect((first?.width ?? 0) + (second?.width ?? 0)).toBeGreaterThan(row.width - 20)
    expect(await spills(two)).toEqual([])

    // The pills wrap, and the long unbroken one breaks inside itself rather than running out of the card.
    const pills = options(card, PILLS)
    expect(rows(await boxes(pills))).toBeGreaterThan(1)
    expect(await spills(pills)).toEqual([])
    const url = pills.getByRole('checkbox', { name: /^https:/ })
    expect((await boxOf(url)).width).toBeLessThanOrEqual((await boxOf(pills)).width + 0.5)
  })
}

test('question card: the keyboard answers options across wrapped rows', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  const glade = await launch({ agentScript: 'asks-many-choices', chosenFolder: root })
  const card = await askManyChoices(glade, root)
  const { window } = glade
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const nine = options(card, NINE)
  const placed = await boxes(nine)
  expect(rows(placed)).toBeGreaterThan(1)
  // The last option of the first row, and the first of the second.
  const firstRowEnd = placed.findIndex((box) => Math.round(box.y) !== Math.round(placed[0]?.y ?? 0)) - 1
  const radios = nine.getByRole('radio')

  await radios.first().focus()
  // 9 picks the ninth, on the last row; → from there wraps round to the first.
  await window.keyboard.press('9')
  await expect(radios.nth(8)).toHaveAttribute('aria-checked', 'true')
  await expect(radios.nth(8)).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(radios.first()).toHaveAttribute('aria-checked', 'true')
  // → and ← cross from the end of one row to the start of the next and back.
  await window.keyboard.press(String(firstRowEnd + 1))
  await expect(radios.nth(firstRowEnd)).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(radios.nth(firstRowEnd + 1)).toHaveAttribute('aria-checked', 'true')
  await expect(radios.nth(firstRowEnd + 1)).toBeFocused()
  await window.keyboard.press('ArrowLeft')
  await expect(radios.nth(firstRowEnd)).toHaveAttribute('aria-checked', 'true')
  // ↓ moves on to the next question.
  await window.keyboard.press('ArrowDown')
  await expect(options(card, SKETCHES).getByRole('radio').first()).toBeFocused()
})
