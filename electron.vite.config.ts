import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/** The build mode `npm run screenshot` uses (`scripts/screenshot.mjs`), which is never packaged. */
const SCREENSHOT_MODE = 'screenshot'

export default defineConfig(({ mode }) => ({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // Screenshots can capture the dev-only pages too, such as the component gallery.
    define: mode === SCREENSHOT_MODE ? { 'import.meta.env.DEV': 'true' } : {},
  },
}))
