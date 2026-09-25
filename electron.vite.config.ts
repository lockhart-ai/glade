import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/** The build mode of the test tools (`scripts/test-build.mjs`: screenshots and e2e tests), which is never packaged. */
const TEST_MODE = 'testing'

export default defineConfig(({ mode }) => ({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        // The window's preload, and a plugin view's (`src/preload/plugin.ts`). Each is sandboxed, so it can't load a
        // shared chunk: they import nothing from each other.
        input: { index: 'src/preload/index.ts', plugin: 'src/preload/plugin.ts' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    // Screenshots and e2e tests can reach the dev-only pages too, such as the component gallery.
    define: mode === TEST_MODE ? { 'import.meta.env.DEV': 'true' } : {},
  },
}))
