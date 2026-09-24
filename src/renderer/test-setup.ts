import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom doesn't load fonts; stand in a `document.fonts` whose fonts have all loaded.
Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } })

afterEach(() => {
  cleanup()
})
