import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

/** Renders the app into the page's root element. */
export function mountApp(root: HTMLElement | null): void {
  if (root === null) throw new Error('Missing #root element')

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
