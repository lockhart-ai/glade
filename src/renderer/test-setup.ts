import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { STUB_ROW_HEIGHT, STUB_VIEWPORT_HEIGHT } from './test-layout'

// jsdom doesn't load fonts; stand in a `document.fonts` whose fonts have all loaded.
Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })

// jsdom doesn't lay out, so nothing ever resizes: stand in a ResizeObserver that never calls back. Tests that need one
// to fire stub their own.
class InertResizeObserver {
  observe = (): void => undefined
  unobserve = (): void => undefined
  disconnect = (): void => undefined
}
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: InertResizeObserver })

// jsdom lays nothing out, so every element is 0px tall, and a virtualised list (the Done section's rows, see
// src/renderer/task-list/DoneRows.tsx) would render no rows at all. Stand in a layout: a virtualised row (it has a
// `data-index`) is ROW_HEIGHT tall, and anything else VIEWPORT_HEIGHT, so the task list shows a screenful of rows.
// Tests that need another layout stub their own.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset.index === undefined ? STUB_VIEWPORT_HEIGHT : STUB_ROW_HEIGHT
  },
})

afterEach(() => {
  cleanup()
})
