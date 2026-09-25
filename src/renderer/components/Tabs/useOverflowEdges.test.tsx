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
let resized: (() => void) | undefined

beforeEach(() => {
  Object.assign(layout, { scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })
  resized = undefined
  for (const property of ['scrollLeft', 'scrollWidth', 'clientWidth'] as const) {
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(() => layout[property])
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe(): void {
        // Nothing to watch: the test calls back itself.
      }
      disconnect(): void {
        resized = undefined
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

function edges(): [string | null, string | null] {
  return [row().getAttribute('data-overflow-start'), row().getAttribute('data-overflow-end')]
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
    resized?.()
  })
  expect(edges()).toEqual(['false', 'true'])

  layout.clientWidth = 400
  rerender(<Tabs id="side" label="Task panels" tabs={TABS.slice(0, 2)} value="files" onChange={vi.fn()} />)
  expect(edges()).toEqual(['false', 'false'])
})

it('stops listening once the row is gone', () => {
  const { unmount } = renderTabs()

  unmount()

  expect(resized).toBeUndefined()
})
