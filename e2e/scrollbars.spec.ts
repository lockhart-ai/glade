// Every scroll bar is a thin rounded thumb on a transparent track (docs/design/tokens.md, Scroll bars), checked with
// macOS's legacy, always-on scroll bars: what a Mac with a mouse, or "Show scroll bars: Always", draws. Unstyled, those
// are 15px wide with a light track (#247). Each area is measured, and its scroll bar's pixels are read from a screenshot.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import type { Locator, Page } from '@playwright/test'
import { colors, scrollbarTokens, type ColorToken } from '../src/renderer/tokens'
import { expect, test, type Glade, type LaunchOptions } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, settings, taskHeader, taskList, taskPanel, terminal, workspaceSwitcher } from './selectors'
import { boxOf, MIN_WINDOW, resize } from './window-layout'

/** The sample workspace of the design screens: enough tasks, messages and tool calls to scroll in a small window. */
const SEED = resolve(__dirname, '..', 'scripts', 'fixtures', 'task-workspace.json')

/** tokens.css's --scrollbar-size and --scrollbar-inset: the room the bar takes, and the thumb's gap from its edges. */
const BAR = 10
const INSET = 2
/** tokens.css's --scrollbar-thumb-min: the shortest the thumb gets. */
const THUMB_MIN = 32

/**
 * How far in from an area's end to look at its track: clear of the rounded corner of the card it runs to the end of
 * (the task list), whose border would show there.
 */
const TRACK_CLEARANCE = 16

/**
 * How far a screenshot's colour may stray from the token's: the display's colour conversion, and the soft shadows of the
 * cards floating over an area. Unstyled, the thumb and track are far lighter than any of these.
 */
const COLOUR_TOLERANCE = 6

/** An sRGB colour, 0–255 a channel. */
interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff }
}

/** `rgb(35, 37, 49)` or `rgba(0, 0, 0, 0)`, as getComputedStyle writes a colour. */
function cssToRgb(css: string): Rgb {
  const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).map(Number)
  return { r, g, b }
}

function near(actual: Rgb, expected: Rgb): boolean {
  return (
    Math.abs(actual.r - expected.r) <= COLOUR_TOLERANCE &&
    Math.abs(actual.g - expected.g) <= COLOUR_TOLERANCE &&
    Math.abs(actual.b - expected.b) <= COLOUR_TOLERANCE
  )
}

/**
 * The colour of the pixel at (x, y), in CSS pixels, from a screenshot of just that spot. Its PNG's first pixel is its
 * first row's first, which every PNG filter stores as is (they all predict it from zeros), so no full decoder is needed.
 */
async function pixelAt(window: Page, x: number, y: number): Promise<Rgb> {
  const png = await window.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } })
  const chunks: Buffer[] = []
  let channels = 0
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    // Colour type 2 is RGB, 6 is RGBA; screenshots are 8 bits a channel.
    if (type === 'IHDR') channels = data[9] === 6 ? 4 : 3
    if (type === 'IDAT') chunks.push(data)
    at += 12 + length
  }
  expect(channels).toBeGreaterThan(0)
  const pixels = inflateSync(Buffer.concat(chunks))
  // Byte 0 is the row's filter type.
  return { r: pixels[1] ?? 0, g: pixels[2] ?? 0, b: pixels[3] ?? 0 }
}

/** Where a scroll area's vertical scroll bar is, and what shows through its track. */
interface Scrollbar {
  /** How much room the bar takes across: the element's width less its content and borders. */
  readonly width: number
  /** The middle of the thumb, across and down. */
  readonly thumbX: number
  readonly thumbY: number
  /** A point in the track clear of the thumb: near the bar's far end from it. */
  readonly trackY: number
  /** Where the track starts, down the window, and where the thumb starts. */
  readonly trackTop: number
  readonly thumbTop: number
  /** The first background behind the track: the area's own, or its nearest ancestor's that has one. */
  readonly behind: Rgb
}

/** Where to look at a scroll area's bar. */
interface ScrollbarOptions {
  /** How far through its scroll range to scroll the area first, 0 (the top) to 1 (the end). Halfway by default. */
  readonly scrolled?: number
  /** How far down the area its track starts: the chat's starts below the header card it scrolls under. */
  readonly trackMarginTop?: number
}

/**
 * Scrolls `area` (halfway by default) and finds its vertical scroll bar once it has settled: an area that follows its
 * newest rows may scroll itself back to the end.
 */
async function scrollbarOf(area: Locator, options: ScrollbarOptions = {}): Promise<Scrollbar> {
  const { scrolled = 0.5, trackMarginTop = 0 } = options
  const found = await area.evaluate(async (element, at) => {
    if (!(element instanceof HTMLElement)) throw new Error('A scroll area is an HTML element')
    element.scrollTop = (element.scrollHeight - element.clientHeight) * at
    for (let frame = 0; frame < 2; frame++) await new Promise((done) => requestAnimationFrame(done))
    const style = getComputedStyle(element)
    const left = Number.parseFloat(style.borderLeftWidth)
    const right = Number.parseFloat(style.borderRightWidth)
    const top = Number.parseFloat(style.borderTopWidth)
    const bottom = Number.parseFloat(style.borderBottomWidth)
    const box = element.getBoundingClientRect()
    let behind = 'rgba(0, 0, 0, 0)'
    for (let at: Element | null = element; at !== null; at = at.parentElement) {
      const background = getComputedStyle(at).backgroundColor
      if (!/^rgba\(.*, 0\)$/.test(background)) {
        behind = background
        break
      }
    }
    return {
      scrolls: element.scrollHeight > element.clientHeight,
      width: element.offsetWidth - element.clientWidth - left - right,
      barRight: box.right - right,
      top: box.top + top,
      bottom: box.bottom - bottom,
      scrolled: element.scrollTop / (element.scrollHeight - element.clientHeight),
      shown: element.clientHeight / element.scrollHeight,
      behind,
    }
  }, scrolled)
  expect(found.scrolls, 'the area scrolls').toBe(true)
  const trackTop = found.top + trackMarginTop
  const length = found.bottom - trackTop
  const thumb = Math.max(THUMB_MIN, length * found.shown)
  const thumbTop = trackTop + found.scrolled * (length - thumb)
  const trackY = found.scrolled > 0.5 ? trackTop + TRACK_CLEARANCE : found.bottom - TRACK_CLEARANCE
  expect(trackY < thumbTop || trackY > thumbTop + thumb, 'the track shows clear of the thumb').toBe(true)
  return {
    width: found.width,
    thumbX: found.barRight - BAR / 2,
    thumbY: thumbTop + thumb / 2,
    trackY,
    trackTop,
    thumbTop,
    behind: cssToRgb(found.behind),
  }
}

/** Polls the pixel at (x, y) until it's the colour token's. */
async function expectColour(window: Page, x: number, y: number, token: ColorToken, what: string): Promise<void> {
  const expected = hexToRgb(colors[token])
  await expect
    .poll(async () => near(await pixelAt(window, x, y), expected), { message: `${what} is ${token}` })
    .toBe(true)
}

/**
 * Checks `area`'s scroll bar is the design's: 10px of room, a transparent track, a thumb in the thumb colour that
 * lightens under the pointer and again while it's dragged.
 */
async function expectStyledScrollbar(
  window: Page,
  area: Locator,
  name: string,
  options: ScrollbarOptions = {},
): Promise<void> {
  const bar = await scrollbarOf(area, options)
  expect(bar.width, `${name}: the bar's width`).toBe(BAR)
  expect(near(await pixelAt(window, bar.thumbX, bar.trackY), bar.behind), `${name}: the track is transparent`).toBe(
    true,
  )
  // Clear of the thumb, beside it in the bar, the track shows through too: the thumb is inset.
  expect(
    near(await pixelAt(window, bar.thumbX + BAR / 2 - 1, bar.thumbY), bar.behind),
    `${name}: the thumb is inset`,
  ).toBe(true)
  await expectColour(window, bar.thumbX, bar.thumbY, scrollbarTokens.thumb, `${name}: the thumb`)

  await window.mouse.move(bar.thumbX, bar.thumbY)
  await expectColour(window, bar.thumbX, bar.thumbY, scrollbarTokens.thumbHover, `${name}: the thumb under the pointer`)
  await window.mouse.down()
  await expectColour(window, bar.thumbX, bar.thumbY, scrollbarTokens.thumbActive, `${name}: the thumb being dragged`)
  await window.mouse.up()
  await window.mouse.move(0, 0)
}

/** The nearest ancestor of `inside` that scrolls down (overflow-y auto or scroll), as a locator. */
async function scrollAreaAround(window: Page, inside: Locator, name: string): Promise<Locator> {
  await inside.evaluate((element, mark) => {
    let area = element.parentElement
    while (area !== null && !['auto', 'scroll'].includes(getComputedStyle(area).overflowY)) area = area.parentElement
    if (area === null) throw new Error('Nothing scrolls around it')
    area.setAttribute('data-scroll-area', mark)
  }, name)
  return window.locator(`[data-scroll-area="${name}"]`)
}

async function launchSmall(launch: (options?: LaunchOptions) => Promise<Glade>): Promise<Glade> {
  const glade = await launch({ seed: SEED, classicScrollbars: true })
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  return glade
}

test('scroll bars: the task list, chat and right panel scroll with the design’s thin rounded thumb', async ({
  launch,
}) => {
  const glade = await launchSmall(launch)
  const { window } = glade
  await expect(taskList(window).taskRow('Add rate limiting to public API')).toBeVisible()

  const list = await scrollAreaAround(window, taskList(window).section('Pinned'), 'task list')
  await expectStyledScrollbar(window, list, 'task list')
  // The chat scrolls under the header card, but its track starts below it: scrolled to the top, the thumb starts
  // there, clear of the header, with the gap above the track showing through.
  const log = chat(window).log
  const clearance = await log.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingTop))
  expect(clearance).toBeGreaterThan((await boxOf(taskHeader(window).header)).height)
  await expectStyledScrollbar(window, log, 'chat', { trackMarginTop: clearance })
  const top = await scrollbarOf(log, { scrolled: 0, trackMarginTop: clearance })
  expect(top.thumbTop).toBe(top.trackTop)
  const header = await boxOf(taskHeader(window).header)
  expect(top.trackTop).toBeGreaterThan(header.y + header.height)
  // Low enough in the thumb (at least THUMB_MIN long) to clear the header card's shadow, which darkens its top end.
  await expectColour(window, top.thumbX, top.trackTop + 24, scrollbarTokens.thumb, 'chat: the thumb at the top')
  expect(near(await pixelAt(window, top.thumbX, top.trackTop - 3), top.behind), 'chat: the gap over its track').toBe(
    true,
  )
  await expectStyledScrollbar(window, taskPanel(window).log, 'right panel')
})

test('scroll bars: Settings and menus take the same scroll bar', async ({ launch }) => {
  const glade = await launchSmall(launch)
  const { window } = glade

  // Settings › Keyboard is longer than the modal in a small window.
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const modal = settings(window)
  await modal.section('Keyboard').click()
  const body = await scrollAreaAround(window, modal.dialog.getByRole('button', { name: /^New task: / }), 'settings')
  await expectStyledScrollbar(window, body, 'settings')
  await modal.close.click()
  await expect(modal.dialog).toBeHidden()

  // No menu is long enough to scroll today; held short, the workspace menu shows what one would get.
  const switcher = workspaceSwitcher(window)
  await switcher.trigger.click()
  await expect(switcher.menu).toBeVisible()
  await switcher.menu.evaluate((menu) => {
    menu.style.maxHeight = '120px'
    menu.style.overflowY = 'auto'
  })
  await expectStyledScrollbar(window, switcher.menu, 'menu')
})

test('scroll bars: the terminal’s own scroll bar takes the same thumb', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root, classicScrollbars: true })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const term = terminal(window)
  await term.newTab.click()
  await expect(term.rows.filter({ hasText: 'acme-api $' })).toHaveCount(1)
  await term.screen.click()
  await window.keyboard.type('seq 1 400')
  await window.keyboard.press('Enter')
  await expect(term.rows.filter({ hasText: /^400\s*$/ })).toHaveCount(1)

  // xterm.js draws its scroll bar itself: a slider, thin, rounded and inset like the rest, in the thumb's colours.
  const slider = term.screen.locator('.xterm-scrollable-element > .scrollbar.vertical > .slider')
  const bar = term.screen.locator('.xterm-scrollable-element > .scrollbar.vertical')
  const look = () =>
    slider.evaluate((element) => {
      const style = getComputedStyle(element)
      return { background: style.backgroundColor, width: style.width, radius: style.borderTopLeftRadius }
    })
  const thumb = hexToRgb(colors[scrollbarTokens.thumb])
  const shape = await look()
  expect(near(cssToRgb(shape.background), thumb)).toBe(true)
  expect(shape.width).toBe(`${String(BAR - 2 * INSET)}px`)
  expect(shape.radius).toBe(`${String(BAR)}px`)
  const sliderBox = await boxOf(slider)
  const barBox = await boxOf(bar)
  expect(barBox.x + barBox.width - (sliderBox.x + sliderBox.width)).toBeCloseTo(INSET, 0)

  await window.mouse.move(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2)
  await expect
    .poll(async () => near(cssToRgb((await look()).background), hexToRgb(colors[scrollbarTokens.thumbHover])))
    .toBe(true)
  await window.mouse.down()
  await expect
    .poll(async () => near(cssToRgb((await look()).background), hexToRgb(colors[scrollbarTokens.thumbActive])))
    .toBe(true)
  await window.mouse.up()
})
