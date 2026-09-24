---
id: P0-01
title: "P0-01: Scaffold the Electron + TypeScript + React app"
milestone: "P0 · Foundations"
labels: [phase-0, infra]
depends_on: []
---

# P0-01: Scaffold the Electron + TypeScript + React app

Create the app skeleton so `npm run dev` opens a Glade window with hot reload.

## Scope

- Proposed: electron-vite with React and TypeScript (strict). Confirm the choice before starting.
- Main, preload and renderer processes, each in its own folder.
- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer.
- macOS window with a hidden title bar and inset traffic lights; minimum size 1100×700.
- Scripts: dev, build, typecheck, lint, test.

## Acceptance criteria

- [ ] `npm run dev` opens a window with hot reload for the renderer and restart for main.
- [ ] `npm run build` produces an unsigned macOS app that launches.
- [ ] Security settings above are verified by a test or a startup assertion.
