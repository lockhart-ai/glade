import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'src/shared/**/*.test.ts',
            // Integration tests of the renderer's store against the real main process, which needs Node.
            'src/renderer/**/*.integration.test.ts',
            // The design tooling's tested logic (scripts/lib), which the scripts run with Node's type stripping.
            'scripts/lib/**/*.test.ts',
          ],
          // No test may talk to the real Claude API; see src/shared/agent-sdk-guard.ts.
          setupFiles: ['src/shared/agent-sdk-guard.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          exclude: ['src/renderer/**/*.integration.test.ts'],
          // No test may talk to the real Claude API; see src/shared/agent-sdk-guard.ts.
          setupFiles: ['src/shared/agent-sdk-guard.ts', 'src/renderer/test-setup.ts'],
          // Vitest blanks CSS by default; tokens.test.ts reads the token stylesheet's text to check it.
          css: { include: [/tokens\.css/] },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Measure every source file, not just the ones a test imports, so an untested file counts as uncovered.
      include: ['src/**/*.{ts,tsx}', 'scripts/lib/**/*.mts'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/renderer/test-setup.ts',
        // Entry points that are pure wiring and can't run under Vitest; their logic lives in tested modules.
        // Main process entry: calls `startApp()` (src/main/app.ts) at load, which needs a running Electron.
        'src/main/index.ts',
        // Renderer entry: mounts the app (or, in dev, the gallery) into #root with `mountApp()` (src/renderer/mount.tsx).
        'src/renderer/main.tsx',
        // The real pseudo-terminal (node-pty): unit tests must never start a real shell, so they run on a fake
        // (src/main/terminal/fake-pty.ts); the e2e specs drive the real one (e2e/terminal.spec.ts).
        'src/main/terminal/node-pty.ts',
        // xterm.js needs a real browser to draw (a canvas, layout, matchMedia), which jsdom lacks, so unit tests stand
        // in src/renderer/terminal/test-screen.ts; the e2e specs drive the real one (e2e/terminal.spec.ts).
        'src/renderer/terminal/screen.ts',
      ],
      thresholds: { lines: 100 },
    },
  },
})
