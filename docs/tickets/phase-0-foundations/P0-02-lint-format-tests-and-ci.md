---
id: P0-02
title: "P0-02: Lint, format, tests and CI"
milestone: "P0 · Foundations"
labels: [phase-0, infra]
depends_on: [P0-01]
---

# P0-02: Lint, format, tests and CI

Tooling that keeps the codebase honest from day one.

## Scope

- ESLint + Prettier (or Biome), strict TypeScript, Vitest for unit tests.
- GitHub Actions on push and PR: install, typecheck, lint, test, build.

## Acceptance criteria

- [ ] CI is green on main.
- [ ] A failing test or type error fails CI.

## Depends on

P0-01
