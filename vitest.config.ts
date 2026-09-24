import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts', 'src/shared/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/test-setup.ts'],
          // Vitest blanks CSS by default; tokens.test.ts reads the token stylesheet's text to check it.
          css: { include: [/tokens\.css/] },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Measure every source file, not just the ones a test imports, so an untested file counts as uncovered.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/renderer/test-setup.ts',
        // Entry points that are pure wiring and can't run under Vitest; their logic lives in tested modules.
        // Main process entry: calls `startApp()` (src/main/app.ts) at load, which needs a running Electron.
        'src/main/index.ts',
        // Renderer entry: mounts the app into the page's #root with `mountApp()` (src/renderer/mount.tsx).
        'src/renderer/main.tsx',
      ],
      thresholds: { lines: 100 },
    },
  },
})
