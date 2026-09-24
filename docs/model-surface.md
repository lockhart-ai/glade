# Model surface (draft)

The app gives the agent a small set of tools so the model can drive the UI. Expose them to the Claude Agent SDK as an
in-process MCP server (e.g. `createSdkMcpServer`). Names and schemas are a **draft** — confirm with Jared before
freezing them.

## Implemented (P1-09, names unconfirmed)

`src/main/agent/glade-tools.ts` builds an in-process MCP server named `glade` for each task's session, so each handler
knows its task. It sets `alwaysLoad: true`, so the tools are never deferred behind tool search. The model calls them as
`mcp__glade__set_title`, `mcp__glade__set_objective` and `mcp__glade__set_status`, and the tool log stores those names
(`toolDisplayName` in `src/shared/toolName.ts` shows them without the `mcp__glade__` prefix).

| Tool | Input | Handler | Reply |
|---|---|---|---|
| `set_title` | `{ title: string }` | Sets the task's title. | `Title set to "<title>".` |
| `set_objective` | `{ objective: string }` | Sets the objective. Meant to be set once; a second call replaces it, and the tool's description tells the model to call it again only if the user changes what the task is for. | `Objective set.`, or `Objective replaced.` on a second call |
| `set_status` | `{ status: string }` | Replaces the one-line status. | `Status updated.` |

Each field is trimmed and must not be empty. Input that fails its schema, or a task that is gone, comes back to the
model as a tool error and changes nothing. Each write goes through `updateTaskFromAgent`, which emits `task.updated`.

| Tool | Input (draft) | Effect |
|---|---|---|
| `set_title` | `{ title: string }` | Names the task. Called once from the first message; the user can rename later. |
| `set_objective` | `{ objective: string }` | Distils the objective from the first message. Set once. |
| `set_status` | `{ status: string }` | Rewrites the status summary shown in the header and the task list. Becomes the outcome on Done. |
| `ask` | `{ questions: Question[] }` | Shows a rich question card in the chat and blocks until answered. See below. |
| `todos` | `{ items: { text, state: "todo" \| "doing" \| "done" \| "waiting", note? }[] }` | Replaces the Todos tab list. (Or map the SDK's own TodoWrite tool instead — decide in P5-03.) |
| `add_artifact` | `{ path: string, title: string }` | Declares a file as a deliverable of the task (Artifacts tab). |
| `show_file` | `{ path: string, line?: number }` | Opens a file in the Files tab for the user. |

`Question` (draft):

```ts
type Question =
  | { kind: "choice"; prompt: string; options: { id: string; label: string; detail?: string; sketch?: string }[]; multiple?: boolean }
  | { kind: "pills"; prompt: string; options: string[]; multiple?: boolean }
  | { kind: "text"; prompt: string; placeholder?: string; optional?: boolean };
```

Answers return as JSON keyed by question index. The user can ignore the card and reply in words instead; that answers
it too.

## Not tools — from SDK events

Tool calls and preamble (tool log), subagents (Subagents tab), files touched (Files tab list), context usage (meter),
compaction, errors, turn duration and file/line counts (turn summary).

## System prompt

The app's system prompt tells the agent its task id and title and how to use the tools above. Anything about files on
disk (task folders, notes) comes from the workspace `CLAUDE.md`, not from Glade.

It lives in `src/main/agent/system-prompt.ts` and is appended to Claude Code's own. For a new task it reads:

```
You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.
This session is one Glade task, with one objective.
Its task id is <id>. Its title is not set yet.

The user sees the task through its title, objective and status. Keep them current with the Glade tools:
- After the user's first message, before anything else, even for a quick question, call set_title with a short name for the task and set_objective with its objective.
- Every turn, call set_status with one line on where the work stands, and again before you end the turn if that changed. When the task is done, the status is its outcome.
```

The "after the user's first message" line asks only for what isn't set yet, so a resumed session never renames a task
the user has renamed.
