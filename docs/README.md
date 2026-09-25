# Glade docs

Glade is a macOS app for running Claude agent sessions as tasks. These are its docs, one line each. An agent looking
for where to start can read [`llms.txt`](../llms.txt) at the repo root.

## User

- [README](../README.md): what Glade is, how to install it, and how to build it from source.
- [User guide](user-guide.md): using Glade day to day, from your first task to marking it done.

## Reference

- [Control API](control-api.md): the `glade-control` tools other agents and scripts drive Glade with, over MCP or
  plain JSON, and how to connect to them.
- [Plugin API](plugin-api.md): the events a plugin's page gets, the messages it can post back, its manifest and its
  sandbox.
- [Model surface](model-surface.md): the tools Glade gives each task's agent, and what it adds to the system prompt.
- [Logs](logs.md): where the log is, what each line holds, and what each scope logs.
- [Keymap](keymap.md): every keyboard shortcut, and how rebinding them works.
- [Context menus](context-menus.md): what right-clicking each thing offers.
- [Design tokens](design/tokens.md): the colours, type, spacing, shape and motion the UI is built from.

## Contributors

- [CLAUDE.md](../CLAUDE.md): the working rules, code conventions and stack, for people and agents working on Glade.
- [Product](product.md): the concepts (tasks, workspaces, active and done) and how the app behaves.
- [Decisions](decisions.md): everything already decided, and why.
- [Plan](plan.md): the phases, in order, and what each one builds.
- [Kitten SOP](kitten-sop.md): how a worker agent takes an issue to a PR, and how the supervisor reviews, merges and
  releases.
- [Releasing](releasing.md): cutting a release, from the version bump to the published build.
- [SDK notes](sdk-notes.md): what the Claude Agent SDK does, with evidence, as Glade relies on it.
- [Design](design/README.md): every screen, with screenshots and the markup to build it to.
