# Plan

Get the core loop working first, then one phase per major feature. Each phase is a GitHub milestone with a meta issue
that holds its "done when" criteria and its child issues.

## P0 · Foundations

The empty app: tooling, database, bridge, design system, window layout.
[Meta issue #1](https://github.com/lockhart-ai/glade/issues/1)

## P1 · Core loop

One workspace, one task at a time, end to end: create, chat, tool log, done, reopen, resume.
[Meta issue #15](https://github.com/lockhart-ai/glade/issues/15)

## P2 · Parallel tasks and attention

Many tasks at once, the message queue, and knowing which task needs you.
[Meta issue #33](https://github.com/lockhart-ai/glade/issues/33)

## P3 · Context and resilience

Compaction, errors, usage limits, crash recovery.
[Meta issue #39](https://github.com/lockhart-ai/glade/issues/39)

## P4 · Rich questions

The `ask` tool and the question card.
[Meta issue #45](https://github.com/lockhart-ai/glade/issues/45)

## P5 · Right panel tabs

Files, Todos, Artifacts and Subagents.
[Meta issue #48](https://github.com/lockhart-ai/glade/issues/48)

## P6 · Finding and organising

Search, task actions and context menus.
[Meta issue #54](https://github.com/lockhart-ai/glade/issues/54)

## P7 · Workspaces and app shell

Multiple workspaces, menu bar, settings, keymap, collapsible panels.
[Meta issue #58](https://github.com/lockhart-ai/glade/issues/58)

## P8 · Terminal

The global bottom bar with terminal tabs.
[Meta issue #64](https://github.com/lockhart-ai/glade/issues/64)

## P10 · Scaling the Done list

Keep the Done list fast and tidy as it grows to hundreds of tasks.
[Issue #67](https://github.com/lockhart-ai/glade/issues/67)

## P11 · Permission review

An "Ask before edits and commands" mode: edits and commands wait on a permission card in the chat.
[Meta issue #68](https://github.com/lockhart-ai/glade/issues/68)

## P12 · Plugins

Sandboxed plugins beside the terminal, fed task and agent events (`plugin-api.md`), and Nekomata as the first one.
[Meta issue #66](https://github.com/lockhart-ai/glade/issues/66)

## P13 · Programmatic control

Tasks as an MCP API (`glade-control`, `control-api.md`) for Glade's own agents and, over a local HTTP endpoint, any
other: create, read, change and delete tasks, and import past Claude Code sessions.
[Meta issue #219](https://github.com/lockhart-ai/glade/issues/219)

## P15 · Agent sandbox

Agents run in a sandbox: a task's agent can use only its workspace root and the folders, domains and MCP servers you
grant it, for the task, the workspace or Glade-wide (`decisions.md`, "Agent sandbox"; `sdk-notes.md` §15).
[Meta issue #445](https://github.com/lockhart-ai/glade/issues/445)

| Issue | What it builds |
| --- | --- |
| P15-01 (#446) | Probe the SDK's sandbox and model it in the test backends. |
| P15-02 (#447) | The designs: the Sandbox groups in Settings and the sandbox's permission cards (screens 39 to 44). |
| P15-03 (#448) | The sandbox in the agent session: the `sandboxEnabled` setting, what a session starts with, Allow all as `acceptEdits`, what asks, and a sandbox that can't start. |
| P15-04 (#449) | Grants: `sandbox_grants`, resolving a task's grants, and applying them live with `applyFlagSettings`. |
| P15-05 (#450) | The permission cards for a folder, a domain and running outside the sandbox, and the `request_access` tool. |
| P15-06 (#451) | Settings › Agent › Sandbox and Settings › Workspace's lists. |
| P15-07 (#452) | The docs pass, the probes before launch, telling a resumed session of the sandbox, and turning the sandbox on by default once the phase's security review is done. |
| P15-08 (#459) | Answered permission cards leave the chat; the decision shows on the tool call's row. |
| P15-09 (#487) | Glade's own git calls hardened against config the agent can write. |
| P15-10 (#514) | The fixes from the phase's security review: Glade decides at the sandbox's bounds before Claude Code's rules do. |
| P15-11 (#515) | MCP servers Glade doesn't build, and the tools that reach other agents (`SendMessage`, `RemoteTrigger`), as grants: one card per server, and a third list in Settings. |
| P15-12 (#516) | The zero-grant escape battery: the phase's acceptance test, on every PR (`escape-battery.md`). |

Order: 01 → 02 → (03, 04) → (05, 06, 08, 09) → 07.

## P16 · Agents · Files · Todos

The right panel splits by one question: is this something happening (**Agents**: a tab per agent, each with its tool
calls and its watchers), or something the work produced (**Todos**: each todo with the files, links and commits that
came out of it)? Tool calls, Subagents and Watchers fold into Agents; Artifacts and Changes fold into Todos
(`decisions.md`, "Todos as the hub"; `model-surface.md`, "Implemented: `list_children` and `file_children`").
[Meta issue #491](https://github.com/lockhart-ai/glade/issues/491)

| Issue | What it builds |
| --- | --- |
| P16-01 (#492) | Probe how a child gets its todo on Claude Code's own tools. |
| P16-02 (#493) | Todo hub designs: screens 46 to 49, as first settled; #534 redraws them. |
| P16-03 (#494) | The switch, a todo's id, and the filing store. |
| P16-04 (#495) | File produced work under a todo as it's made: artifacts, a subagent's todo as plumbing, and commits. No watchers. |
| P16-05 (#496) | The agent's tools to list and move children: `list_children` and `file_children`. |
| P16-06 (#497) | The Todos tab as the hub, first built with five kinds; #535 takes it to three. |
| P16-07 (#498) | File and link tiles. |
| P16-08 (#499) | Commit tiles, narrowed from "Subagent, watcher and commit tiles". |
| P16-09 (#500) | Links in a todo's text. |
| P16-10 (#501) | Turn it on: three tabs, the old tabs removed. |
| P16-11 (#534) | Designs for Agents · Files · Todos: the Agents tab's screens, and screens 46 to 49 redrawn for produced work only. |
| P16-12 (#535) | Todos hold produced work only; subagents and watchers come out of the hub. |
| P16-13 (#536) | The Agents tab: a tab per agent, each with its tool calls. |
| P16-14 (#537) | Watchers in the tool calls: pinned while live, in the history once done. |
| P16-15 (#547) | Design screens for three tabs: every screen redrawn, the retired tabs' screens removed. |
| P16-16 (#548) | Docs for three tabs: the reference docs, the user guide and the README, with their screenshots retaken, and a real-model check of the filing prompt. |

Order: 07, 08, 09, 04 and 11 can run now → 12, 13 (after 11) → 14 (after 13) → 10 → (15, 16).

## Later

Signing, notarisation and auto-update (L-04, #69).
[Milestone](https://github.com/lockhart-ai/glade/milestone/10)
