# Model surface (draft)

The app gives the agent a small set of tools so the model can drive the UI. Expose them to the Claude Agent SDK as an
in-process MCP server (e.g. `createSdkMcpServer`). Names and schemas are a **draft** — confirm with Jared before
freezing them.

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
