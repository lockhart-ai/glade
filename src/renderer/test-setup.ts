import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

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

afterEach(() => {
  cleanup()
})
