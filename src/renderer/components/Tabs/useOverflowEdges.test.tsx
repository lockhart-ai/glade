import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Tabs, type TabItem } from './Tabs'

const TABS: TabItem<string>[] = [
  { value: 'tool-calls', label: 'Tool calls', count: 7 },
  { value: 'files', label: 'Files' },
  { value: 'subagents', label: 'Subagents' },
]

/** The tab row's layout, as jsdom (which doesn't lay out) reports it. */
const layout = { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }
/** Each ResizeObserver watching the row, by its callback: the row's edges, and its selected tab's place. */
const observers = new Set<() => void>()

/** The row resizing: every observer calls back, as a browser's would. */
function resized(): void {
  for (const callback of observers) callback()
}

beforeEach(() => {
  Object.assign(layout, { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })
  observers.clear()
  for (const property of ['scrollLeft', 'scrollWidth', 'clientWidth'] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(() => layout[property])
  }
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
})

function row(): HTMLElement {
  return screen.getByRole('tablist', { name: 'Task panels' })
}

/** The strip around the row, which carries which ends overflow. */
function strip(): HTMLElement {
  const element = row().parentElement
  if (element === null) throw new Error('The tab row has no strip around it')
  return element
}

function edges(): [string | null, string | null] {
  return [strip().getAttribute('data-overflow-start'), strip().getAttribute('data-overflow-end')]
}

function renderTabs(tabs = TABS): ReturnType<typeof render> {
  return render(<Tabs id="side" label="Task panels" tabs={tabs} value="files" onChange={vi.fn()} />)
}

it('shows no fade when every tab fits', () => {
  renderTabs()

  expect(edges()).toEqual(['false', 'false'])
})

it('fades the end with tabs past it, then the start as it scrolls, then only the start at the far end', () => {
  layout.scrollWidth = 360
  renderTabs()
  expect(edges()).toEqual(['false', 'true'])

  layout.scrollLeft = 30
  fireEvent.scroll(row())
  expect(edges()).toEqual(['true', 'true'])

  layout.scrollLeft = 60
  fireEvent.scroll(row())
  expect(edges()).toEqual(['true', 'false'])

  // A scroll that leaves the edges as they were changes nothing.
  layout.scrollLeft = 59.5
  fireEvent.scroll(row())
  expect(edges()).toEqual(['true', 'false'])
})

it('measures again when the row is resized and when its tabs change', () => {
  const { rerender } = renderTabs()

  layout.clientWidth = 250
  act(() => {
    resized()
  })
  expect(edges()).toEqual(['false', 'true'])

  layout.clientWidth = 400
  rerender(<Tabs id="side" label="Task panels" tabs={TABS.slice(0, 2)} value="files" onChange={vi.fn()} />)
  expect(edges()).toEqual(['false', 'false'])
})

it('stops listening once the row is gone', () => {
  const { unmount } = renderTabs()

  unmount()

  expect(observers.size).toBe(0)
})
