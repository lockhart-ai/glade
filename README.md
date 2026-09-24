# Glade

A calm macOS app for running Claude agent sessions as tasks. See `CLAUDE.md` and `docs/` for how it works.

## Getting started

You need macOS, Node 24 (see `.nvmrc`), and Claude Code installed and logged in. Glade runs on your own Claude Code
login and never asks for credentials.

```sh
npm install
npm run dev
```

Since Electron 42, the `electron` package no longer downloads its binary on install, so a `postinstall` script runs its
`install-electron` command. That lets `npm run dev` find the binary.
