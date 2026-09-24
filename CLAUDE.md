# Glade

Glade is a macOS desktop app for running many Claude agent sessions as **tasks**. Each task has one objective, runs in a
**workspace** (a named root folder), and is either **Active** or **Done**. Think of it as a calm, simple alternative to
Nimbalyst: the whole product is the lifecycle of a task plus the panels around it.

## Start here

1. `docs/product.md` — the concepts and how the app behaves.
2. `docs/decisions.md` — everything already decided. Don't reopen these without asking Jared.
3. `docs/design/README.md` — every screen, with screenshots. Build to these.
4. `docs/plan.md` — the phases, in order.
5. GitHub issues — work is tracked there, and they are canonical. Each phase has a meta issue with its "done when"
   criteria and its child issues. Pick the lowest-numbered open child issue in the earliest unfinished phase unless told
   otherwise.

Reference docs: `docs/model-surface.md` (the tools the app gives the model), `docs/design/tokens.md` (colours, type,
spacing), `docs/keymap.md`, `docs/context-menus.md`.

## Working rules

- **Build what the designs show; don't invent workflows.** If a ticket or screen leaves a behaviour open, ask rather
  than adding a feature. (We removed "send now" and queue reordering for exactly this reason.)
- Placeholder content in the screenshots (task names, `[MODEL NAME]`, the Acme API workspace) is sample data, not spec.
- **Work iteratively.** Set a small, well-constrained goal, build towards it, validate it, then move on.
- **Issues are canonical.** Each phase has a meta issue listing its child issues and the phase's acceptance criteria:
  statements that are true when the phase is done, not a list of work. Each child issue has its own acceptance
  criteria; it's done when they all hold and tests cover the code.
- Keep the Electron security defaults: `contextIsolation: true`, `nodeIntegration: false`, a typed preload bridge,
  no remote content in the renderer.
- All app state lives in SQLite so the app can crash and resume. Don't keep important state only in memory.
- Commit messages: imperative subject, reference the ticket id (e.g. `P1-05: stream agent events into the chat`).
- PR descriptions are brief, in this shape:

  ```
  Because:
  - reason
  - reason

  This commit:
  - change
  - change
  ```
- **Kittens use the glade-team GitHub App for every `gh` call:** `GH_TOKEN="$(node scripts/gh-token.mjs)" gh …`,
  minted inline per call. Never fall back to Jared's own `gh` login; if the token is empty, stop. The app's config
  lives outside the repo in `~/.config/glade-team/`.

## Code conventions

- **TypeScript everywhere**, `strict` on. No `any`; parse unknown input (IPC payloads, SDK events, tool input, JSON
  from disk or the DB) at the boundary into typed values.
- **Structured data.** Everything that passes data around (function arguments with several fields, return values, IPC
  commands and events, DB rows, tool inputs, component props) gets a named interface.
- **Enums and discriminated unions.** Use string enums for fixed sets of values (task state, message role, tool event
  kind, …) and discriminated unions for values that come in variants (events, questions, results). Switch over them
  exhaustively so a new variant fails the typecheck.
- **Tests:** unit and integration tests, with **100% line coverage** enforced in CI. Any exclusion from coverage is
  explicit and has a comment saying why.

## Stack

Electron, TypeScript, SQLite, the Claude Agent SDK (TypeScript), electron-vite, React, CSS Modules, Zustand,
better-sqlite3, Vitest + Testing Library, ESLint + Prettier, electron-builder, xterm.js + node-pty. See `docs/decisions.md`.
Prefer well-established, widely adopted libraries and idiomatic use of them; don't pull in small or obscure packages.

## Open source: what gets committed

This repo is public (MIT). Anything committed is public forever, even if deleted later.

- **Never commit:** secrets (API keys, OAuth tokens, `.env` files, credentials); personal data (real names or emails
  beyond git authorship, home-directory paths, real chat transcripts or agent logs); local app state (SQLite
  databases, `.glade/` folders); build output, `node_modules`, logs, OS and editor files. `.gitignore` covers most of
  these; check `git status` and the diff before every commit anyway.
- **Sample data is made up.** Fixtures, tests, screenshots and docs use invented content (like the Acme API workspace),
  never real sessions or real projects.
- **Do commit:** source, tests, docs, design screenshots and markup, icons, the lockfile.
- **Third-party code and assets** only under a licence compatible with MIT, with the licence file included.
- **Binaries:** keep them small. Ask before adding anything over ~1 MB.
- Pushing straight to `main` is fine for now.
