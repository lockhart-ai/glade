// #412: the terminal's rows outgrew its card after a relaunch, so its prompt sat below the bottom edge, until the tab was
// closed and a new one opened. Each spec fills a terminal with output, drives a sequence that changes its size, and checks that its rows
// fit the card and its prompt (the line the cursor is on) shows. Nothing here waits on a timer: each step polls for the
// terminal to settle at its new size.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, openWorkspace, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { panelToggles, terminal } from './selectors'
import { resize } from './window-layout'

/** The prompt of a shell in the workspace `acme-api`. */
const PROMPT = 'acme-api $'

/** How the terminal showing sits in its card, in CSS pixels. */
interface TerminalFit {
  /** Its width: it changes when the terminal takes another number of columns. */
  readonly width: number
  /** A row's height: the cell xterm.js measured. */
  readonly cell: number | undefined
  /** Whether its rows, each a cell high, fit in the card's height. */
  readonly rowsFit: boolean
  /** Whether the last prompt's row, where the cursor is, ends within the card. */
  readonly promptShows: boolean
}

/**
 * How the terminal showing fits its card: the `.xterm-rows` lines, each a cell high, against the box xterm.js is fitted
 * to (the screen element), and the row of the last prompt against the box's bottom edge.
 */
function terminalFit(window: Page): Promise<TerminalFit> {
  return window.evaluate((prompt) => {
    const box = document.querySelector('[data-testid="terminal-screen"][data-active="true"]')
    const screen = box?.querySelector('.xterm-screen')
    if (!box || !screen) throw new Error('No terminal showing')
    const rows = [...box.querySelectorAll('.xterm-rows > div')]
    const bounds = box.getBoundingClientRect()
    const height = rows.reduce((total, row) => total + row.getBoundingClientRect().height, 0)
    const last = rows.filter((row) => row.textContent.includes(prompt)).at(-1)
    // Half a pixel either way, for the rounding of fractional cells.
    return {
      width: screen.getBoundingClientRect().width,
      cell: rows[0]?.getBoundingClientRect().height,
      rowsFit: height <= bounds.height + 0.5,
      promptShows: last !== undefined && last.getBoundingClientRect().bottom <= bounds.bottom + 0.5,
    }
  }, PROMPT)
}

/** Waits for the terminal showing to take another width than `before`, then checks it fits its card. */
async function expectRefitted(window: Page, before: TerminalFit): Promise<void> {
  await expect.poll(async () => (await terminalFit(window)).width).not.toBe(before.width)
  await expect.poll(() => terminalFit(window)).toMatchObject({ rowsFit: true, promptShows: true })
}

/**
 * Opens a terminal in `acme-api` and fills it with more lines than it shows, then quits the app. Answers with the cell
 * it measured: in Geist Mono, which the window has loaded by the time you open a tab.
 */
async function fillTerminalAndQuit(glade: Glade): Promise<number | undefined> {
  const { window } = glade
  await openWorkspace(window)
  const term = terminal(window)
  await term.newTab.click()
  await expect(term.rows.filter({ hasText: PROMPT })).toHaveCount(1)
  await term.screen.click()
  await window.keyboard.type('seq 1 200')
  await window.keyboard.press('Enter')
  await expect(term.rows.filter({ hasText: /^200\s*$/ })).toHaveCount(1)
  await expect.poll(() => terminalFit(window)).toMatchObject({ rowsFit: true, promptShows: true })
  const { cell } = await terminalFit(window)
  await glade.close()
  return cell
}

/**
 * Relaunches the app on the same data, and waits for the tab's restored output and new prompt, in rows that fit, of the
 * same `cell` as before: the screen measured it in Geist Mono, not the fallback.
 */
async function relaunch(launch: () => Promise<Glade>, cell: number | undefined): Promise<Glade> {
  const glade = await launch()
  await expect(terminal(glade.window).rows.filter({ hasText: PROMPT })).toHaveCount(2)
  await expect.poll(() => terminalFit(glade.window)).toMatchObject({ cell, rowsFit: true, promptShows: true })
  return glade
}

test.describe('terminal fit', () => {
  // The terminal opens as the relaunched window first draws, before Geist Mono has loaded, so xterm.js measured its
  // cell in the fallback font: a shorter one. The next resize measured it again in Geist Mono, after the fit had
  // counted its rows from the shorter cell, so they no longer fit; and nothing fitted it again, since its card hadn't
  // changed size. The screens now wait for Geist Mono before they open, and a fit counts its rows again when its resize
  // measured another cell.
  test('a relaunched terminal still fits its card once the window resizes', async ({ launch, tempFolder }) => {
    const root = join(tempFolder(), 'acme-api')
    mkdirSync(root)
    const cell = await fillTerminalAndQuit(await launch({ chosenFolder: root }))

    const glade = await relaunch(launch, cell)
    const before = await terminalFit(glade.window)
    const [width, height] = await glade.window.evaluate(() => [innerWidth, innerHeight] as const)
    await resize(glade, width - 100, height)

    await expectRefitted(glade.window, before)
  })

  test('a relaunched terminal still fits its card when the bottom bar opens at another width', async ({
    launch,
    tempFolder,
  }) => {
    const root = join(tempFolder(), 'acme-api')
    mkdirSync(root)
    const cell = await fillTerminalAndQuit(await launch({ chosenFolder: root }))

    const glade = await relaunch(launch, cell)
    const { window } = glade
    const before = await terminalFit(window)
    await chooseMenuItem(glade, 'View', 'Toggle bottom bar')
    await expect(panelToggles(window).showBottomBar).toBeVisible()
    const [width, height] = await window.evaluate(() => [innerWidth, innerHeight] as const)
    await resize(glade, width - 100, height)
    await chooseMenuItem(glade, 'View', 'Toggle bottom bar')
    await expect(panelToggles(window).collapseBottomBar).toBeVisible()

    await expectRefitted(window, before)
  })
})
