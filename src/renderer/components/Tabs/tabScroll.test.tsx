import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tabs, type TabItem } from './Tabs'
import { chevronScroll, ScrollDirection, wheelScroll } from './tabScroll'

// Stress tests for the tab row scrolling sideways when it's too narrow for its tabs (#251): the chevrons at the ends
// with more tabs past them, the wheel, and the selected tab scrolling into view. jsdom lays nothing out, so the row and
// its tabs report a layout from `layout` below, and scrolling it moves `layout.scrollLeft` as a browser would.

const TABS: TabItem<string>[] = [
  { value: 'tool-calls', label: 'Tool calls', count: 7 },
  { value: 'files', label: 'Files' },
  { value: 'todos', label: 'Todos', count: '1/5' },
  { value: 'artifacts', label: 'Artifacts' },
  { value: 'subagents', label: 'Subagents', count: 5 },
]

/** Each tab's width, by its value; the row is as wide as its tabs laid end to end. */
const TAB_WIDTHS: Readonly<Record<string, number>> = {
  'tool-calls': 90,
  files: 50,
  todos: 70,
  artifacts: 70,
  subagents: 90,
  watchers: 80,
}

/** The room the chevron and fade take at each end of the row: its `scroll-padding-inline`. */
const END_ROOM = 44

interface Layout {
  scrollLeft: number
  clientWidth: number
  /** Whether the row reports its scroll padding (as a browser does from its stylesheet; jsdom has none). */
  scrollPadding: boolean
}

const layout: Layout = { scrollLeft: 0, clientWidth: 300, scrollPadding: true }
/** Each ResizeObserver watching the row, by its callback: the row's edges, and its selected tab's place. */
const observers = new Set<() => void>()

/** The row resizing: every observer calls back, as a browser's would. */
function resized(): void {
  for (const callback of observers) callback()
}

function tabsIn(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('[role="tab"]')]
}

/** How much wider than in TAB_WIDTHS a tab has grown since, by its value: e.g. its count has shown. */
const grown: Record<string, number> = {}

function tabWidth(tab: HTMLElement): number {
  const value = tab.id.replace('side-tab-', '')
  return (TAB_WIDTHS[value] ?? 0) + (grown[value] ?? 0)
}

function scrollWidth(row: HTMLElement): number {
  return Math.max(
    tabsIn(row).reduce((sum, tab) => sum + tabWidth(tab), 0),
    layout.clientWidth,
  )
}

/** Scrolls the row to `left`, clamped to its ends, and tells it so, as a browser does. */
function scrollRowTo(row: HTMLElement, left: number): void {
  layout.scrollLeft = Math.min(Math.max(left, 0), scrollWidth(row) - layout.clientWidth)
  fireEvent.scroll(row)
}

const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  scrollRowTo(this, options.left ?? layout.scrollLeft)
})
const scrollBy = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
  scrollRowTo(this, layout.scrollLeft + (options.left ?? 0))
})

beforeEach(() => {
  Object.assign(layout, { scrollLeft: 0, clientWidth: 300, scrollPadding: true })
  observers.clear()
  for (const value of Object.keys(grown)) Reflect.deleteProperty(grown, value)
  scrollTo.mockClear()
  scrollBy.mockClear()
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockImplementation(() => layout.scrollLeft)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => layout.clientWidth)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return scrollWidth(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return tabWidth(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    const row = this.parentElement
    if (row === null) return 0
    const before = tabsIn(row).slice(0, tabsIn(row).indexOf(this))
    return before.reduce((sum, tab) => sum + tabWidth(tab), 0)
  })
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo)
    if (element.getAttribute('role') !== 'tablist' || !layout.scrollPadding) return style
    const room = `${String(END_ROOM)}px`
    return new Proxy(style, {
      get: (target, property) =>
        property === 'scrollPaddingLeft' || property === 'scrollPaddingRight'
          ? room
          : (Reflect.get(target, property) as unknown),
    })
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo })
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', { configurable: true, value: scrollBy })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
      }
      observe(): void {
        observers.add(this.callback)
      }
      disconnect(): void {
        observers.delete(this.callback)
      }
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollBy')
})

function row(): HTMLElement {
  return screen.getByRole('tablist', { name: 'Task panels' })
}

function chevrons(): string[] {
  return screen.queryAllByRole('button').map((button) => button.getAttribute('aria-label') ?? '')
}

function tabs(value: string, onChange = vi.fn(), items = TABS): React.JSX.Element {
  return <Tabs id="side" label="Task panels" tabs={items} value={value} onChange={onChange} />
}

/** The panel narrowing or widening to `width`: the row resizes. */
function resizeTo(width: number): void {
  layout.clientWidth = width
  act(() => {
    resized()
  })
}

describe('a row too narrow for its tabs', () => {
  // The regression test for #251: on main the row scrolled with no way for a mouse to scroll it.
  it('shows a chevron at the end with tabs past it, and clicking it scrolls about a tab to the right', () => {
    render(tabs('tool-calls'))

    expect(chevrons()).toEqual(['Scroll tabs right'])
    const right = screen.getByRole('button', { name: 'Scroll tabs right' })
    expect(right).toHaveAttribute('tabindex', '-1')
    expect(right).toHaveAttribute('title', 'Scroll tabs right')
    fireEvent.click(right)

    // Five tabs, 370px in all: about a tab is 74px, which in a 300px row is (just) past its far end.
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 74 })
    expect(layout.scrollLeft).toBe(70)
    expect(chevrons()).toEqual(['Scroll tabs left'])
  })

  it('shows both chevrons between the ends, and only the one back at either end', () => {
    render(tabs('tool-calls'))

    scrollRowTo(row(), 30)
    expect(chevrons()).toEqual(['Scroll tabs left', 'Scroll tabs right'])

    // At the far end: only the left chevron, which scrolls back a tab at a time to the start.
    scrollRowTo(row(), 70)
    expect(chevrons()).toEqual(['Scroll tabs left'])
    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs left' }))
    expect(layout.scrollLeft).toBe(0)
    expect(chevrons()).toEqual(['Scroll tabs right'])
  })

  it('scrolls a step at a time from one end to the other with the chevrons, never past an end', () => {
    layout.clientWidth = 150
    render(tabs('tool-calls'))

    for (let step = 0; step < 3; step++) fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
    expect(layout.scrollLeft).toBe(220)
    expect(chevrons()).toEqual(['Scroll tabs left'])
    for (let step = 0; step < 3; step++) fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs left' }))
    expect(layout.scrollLeft).toBe(0)
    expect(chevrons()).toEqual(['Scroll tabs right'])
  })

  it('shows its chevrons as the panel narrows past the tabs, and drops them as it widens to fit them', () => {
    layout.clientWidth = 400
    render(tabs('files'))
    expect(chevrons()).toEqual([])

    resizeTo(371)
    expect(chevrons()).toEqual([])
    resizeTo(360)
    expect(chevrons()).toEqual(['Scroll tabs right'])

    resizeTo(300)
    scrollRowTo(row(), 30)
    expect(chevrons()).toEqual(['Scroll tabs left', 'Scroll tabs right'])

    // Widening past the tabs lets the row fit them from the start, as a browser does.
    layout.scrollLeft = 0
    resizeTo(370)
    expect(chevrons()).toEqual([])
  })

  it('shows its chevrons in a panel far narrower than one tab', () => {
    layout.clientWidth = 40
    render(tabs('files'))

    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
    expect(chevrons()).toEqual(['Scroll tabs left', 'Scroll tabs right'])
  })

  it('shows the right chevron for a tab added past the right edge, and scrolls to it', () => {
    const { rerender } = render(tabs('tool-calls'))
    scrollRowTo(row(), 70)
    expect(chevrons()).toEqual(['Scroll tabs left'])

    rerender(tabs('tool-calls', vi.fn(), [...TABS, { value: 'watchers', label: 'Watchers', count: 2 }]))

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toContain('Watchers 2')
    expect(chevrons()).toEqual(['Scroll tabs left', 'Scroll tabs right'])
    // Six tabs, 450px in all: about a tab is now 75px.
    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
    expect(layout.scrollLeft).toBe(145)
    expect(chevrons()).toEqual(['Scroll tabs left', 'Scroll tabs right'])
    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }))
    expect(layout.scrollLeft).toBe(150)
    expect(chevrons()).toEqual(['Scroll tabs left'])
  })

  it('leaves the row where it was scrolled as a count ticks, rather than jump back to the selected tab', () => {
    const { rerender } = render(tabs('tool-calls'))
    scrollRowTo(row(), 70)
    scrollTo.mockClear()

    rerender(
      tabs(
        'tool-calls',
        vi.fn(),
        TABS.map((tab) => (tab.value === 'tool-calls' ? { ...tab, count: 8 } : tab)),
      ),
    )

    expect(scrollTo).not.toHaveBeenCalled()
    expect(layout.scrollLeft).toBe(70)
  })
})

describe('the selected tab', () => {
  it('scrolls into view, clear of the chevron, when selected by the keyboard', () => {
    const onChange = vi.fn()
    const { rerender } = render(tabs('artifacts', onChange))
    // Artifacts ends at 280px, and 44px of room past it is past the 300px row: it was scrolled into view at once.
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 24, behavior: 'instant' })
    expect(layout.scrollLeft).toBe(24)

    // → picks Subagents, the last tab: the row scrolls to its far end.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Artifacts' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('subagents')
    rerender(tabs('subagents', onChange))
    expect(layout.scrollLeft).toBe(70)

    // → wraps to Tool calls, the first: back to the start.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Subagents 5' }), { key: 'ArrowRight' })
    rerender(tabs('tool-calls', onChange))
    expect(layout.scrollLeft).toBe(0)
  })

  it('scrolls into view when selected from outside the row (e.g. by ⌘⌥5), from either end', () => {
    const { rerender } = render(tabs('tool-calls'))
    expect(scrollTo).not.toHaveBeenCalled()

    rerender(tabs('subagents'))
    // Smoothly, by the row's own scroll-behavior (which Reduce motion turns off).
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 70, behavior: 'auto' })

    // Todos (140–210px) shows whole from 70px: nothing moves.
    scrollTo.mockClear()
    rerender(tabs('todos'))
    expect(scrollTo).not.toHaveBeenCalled()

    // Files (90–140px) is under the left chevron at 70px: back far enough to clear it.
    rerender(tabs('files'))
    expect(layout.scrollLeft).toBe(46)
  })

  it('scrolls into view with no room for chevrons where the row keeps none', () => {
    layout.scrollPadding = false
    const { rerender } = render(tabs('tool-calls'))

    rerender(tabs('artifacts'))
    expect(layout.scrollLeft).toBe(0)
    rerender(tabs('subagents'))
    expect(layout.scrollLeft).toBe(70)
  })

  it('stays in view as the panel narrows past it, and is kept clear of the chevrons then', () => {
    layout.clientWidth = 400
    render(tabs('subagents'))
    expect(scrollTo).not.toHaveBeenCalled()

    resizeTo(300)
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 70, behavior: 'instant' })
    expect(layout.scrollLeft).toBe(70)
    expect(chevrons()).toEqual(['Scroll tabs left'])

    // A resize that leaves its width alone (as when an observer starts watching) moves nothing.
    scrollRowTo(row(), 0)
    resizeTo(300)
    expect(layout.scrollLeft).toBe(0)
    resizeTo(301)
    expect(layout.scrollLeft).toBe(69)

    // Narrower still, the row scrolls to its far end to keep Subagents (280–370px) whole.
    resizeTo(120)
    expect(layout.scrollLeft).toBe(250)
  })

  it('stays in view as it grows past the edge, e.g. as its count first shows', () => {
    layout.clientWidth = 380
    const { rerender } = render(
      tabs('subagents', vi.fn(), [...TABS.slice(0, 4), { value: 'subagents', label: 'Subagents' }]),
    )
    expect(chevrons()).toEqual([])

    grown.subagents = 30
    rerender(tabs('subagents'))
    act(() => {
      resized()
    })

    // 400px of tabs in a 380px row: scrolled to its far end.
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 20, behavior: 'instant' })
    expect(chevrons()).toEqual(['Scroll tabs left'])
  })

  it('never scrolls a row that fits its tabs', () => {
    layout.clientWidth = 500
    const { rerender } = render(tabs('tool-calls'))

    rerender(tabs('subagents'))
    rerender(tabs(''))

    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('the wheel', () => {
  function wheel(init: WheelEventInit): WheelEvent {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    row().dispatchEvent(event)
    return event
  }

  it('scrolls the row sideways as it turns up and down', () => {
    render(tabs('tool-calls'))

    const down = wheel({ deltaY: 40 })
    expect(down.defaultPrevented).toBe(true)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 40, behavior: 'instant' })
    expect(layout.scrollLeft).toBe(40)
    expect(chevrons()).toEqual(['Scroll tabs left', 'Scroll tabs right'])

    wheel({ deltaY: -100 })
    expect(layout.scrollLeft).toBe(0)
  })

  it('leaves a sideways swipe, and a row that fits, to the browser', () => {
    const { unmount } = render(tabs('tool-calls'))

    expect(wheel({ deltaX: 30, deltaY: 10 }).defaultPrevented).toBe(false)
    unmount()

    layout.clientWidth = 500
    render(tabs('tool-calls'))
    expect(wheel({ deltaY: 40 }).defaultPrevented).toBe(false)
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('stops listening once the row is gone', () => {
    const { unmount } = render(tabs('tool-calls'))
    const element = row()
    unmount()

    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, cancelable: true }))
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it.each([
    [WheelEvent.DOM_DELTA_PIXEL, 3, 3],
    [WheelEvent.DOM_DELTA_LINE, 3, 48],
    [WheelEvent.DOM_DELTA_PAGE, 1, 300],
  ])('turns a delta in mode %i of %i into %ipx', (deltaMode, deltaY, px) => {
    const element = document.createElement('div')
    Object.defineProperty(element, 'scrollWidth', { value: 600 })

    expect(wheelScroll(element, new WheelEvent('wheel', { deltaMode, deltaY }))).toBe(px)
  })
})

it('steps a whole row for a strip with no tabs', () => {
  const element = document.createElement('div')

  expect(chevronScroll(element, 0, ScrollDirection.End)).toBe(300)
  expect(chevronScroll(element, 0, ScrollDirection.Start)).toBe(-300)
})
