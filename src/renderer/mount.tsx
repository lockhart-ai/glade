import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

/** Renders the app (or, in dev, another page such as the component gallery) into the page's root element. */
export function mountApp(root: HTMLElement | null, page: ReactNode = <App />): void {
  if (root === null) throw new Error('Missing #root element')

  createRoot(root).render(<StrictMode>{page}</StrictMode>)
}
