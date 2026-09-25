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

Settings › Agent can turn off **Status summary** and **Task titles** (P7-03). A session started while one is off gets
neither the tool (`set_status` or `set_title`) nor the system prompt's ask for it; the settings are read as each
session starts.

## Implemented: `ask` (P4-01, names unconfirmed)

`mcp__glade__ask` takes `{ questions: Question[] }`, with `Question` exactly as drafted below (`QuestionKind` and the
question interfaces in `src/shared/domain.ts`; the zod schema in `src/main/questions/schema.ts`). Beyond the draft:
every text is trimmed and must not be empty, there is at least one question, a choice or pills question has at least
two options, and a choice's option ids and a question's pills are each unique.

**Sketch format** (P4-02): an option's `sketch` is a few short lines of plain text, up to about 6 lines of 40
characters, drawn as is, monospaced, in a small frame above the option's label ([`03-rich-question.png`](design/screens/03-rich-question.png)). Whitespace
is kept and lines don't wrap (a long one is cut off). A line starting with `#` is a heading: its marks are dropped and
it's shown in the accent blue; every other line is shown muted. Nothing else is Markdown. For a layout, e.g.:

```
# Features
- …
# Fixes
- …
```

**The card** (P4-02, `src/renderer/questions/QuestionCard.tsx`): each question with its option cards (radios, or
checkboxes with `multiple`), pills (the same) or text field, "N of M answered" and Send answers, which is enabled once
every question but an optional text one has an answer. Keyboard: Tab moves between the questions (one stop each) and
Send, ← → between a question's options, ↑ ↓ between questions, 1–9 pick the focused question's options, Space the
focused one, and ↵ sends. Once closed, the card shows each answer, or that it was answered in your words, or that it
was withdrawn. A set opened in a task you aren't viewing marks it unread and sends a notification, as a final reply
does, with its first question as the body.

- **It blocks.** The handler saves an open question set (`QuestionSet`, table `question_sets`) and waits until it's
  answered, however long that takes (`src/main/questions/questions.ts`). Meanwhile the task waits on you: its activity
  is waiting, `task.asking` is true, and it counts under Needs you (`needsYou`). The windows hear `question.opened`,
  then `question.answered` or `question.withdrawn`.
- **Answering with the card:** `questions.answer { id, answers }`, with answers keyed by question index from 0. A
  choice takes an option id, pills a pill's text, text the text typed; `multiple` takes an array of at least one, each
  once. Every question needs an answer except an optional text one, which is dropped when empty
  (`src/shared/questions.ts`). The tool returns the answers as JSON, e.g. `{"0":"by-type","1":"Internal changes"}`.
- **Answering in words:** a message sent (`tasks.send`) while a question is open answers it. It's saved to the chat as
  your reply, in the turn that asked; it isn't queued and starts no turn. The tool returns `{"freeText":"…"}`.
- **Stopped or failed:** a turn that ends while its question is open withdraws it; Stop withdraws it first. The tool
  returns an error saying the questions were withdrawn.
- **Relaunch:** a question the app quit on stays open, and its task waits on you; its `ask` call ends as an error. When
  you answer it, the task's session is resumed and the answer goes to the agent as a message (the runner's
  `answeredAfterRestart`), carrying on the same turn.
- Claude Code's own `AskUserQuestion` tool is disallowed, so questions always come through `ask`.

## Implemented: `show_file` (P5-02, names unconfirmed)

`mcp__glade__show_file` takes `{ path: string, line?: number }`: the path absolute or relative to the workspace root,
the line a whole number from 1. The handler (`showTaskFile` in `src/main/files/files.ts`) opens the file as a tab in
the task's Files tab (kept in the `open_files` table, so it survives a relaunch) and broadcasts `file.shown`. If that
task is the one you're viewing, the right panel switches to Files, opening if it was collapsed, and the viewer marks
the line and scrolls to it. For another task, only its tabs change. The reply is `Showing <path>.` or
`Showing <path> at line <n>.`; a path outside the workspace (a symlink out of it included), or one with no file, is a
tool error and opens nothing.

## Implemented: `add_artifact` (P5-04, names unconfirmed)

`mcp__glade__add_artifact` takes `{ path: string, title: string }`: the path absolute or relative to the workspace
root. The handler (`addTaskArtifact` in `src/main/artifacts/artifacts.ts`) checks the path as `show_file` does (a file
inside the workspace, symlinks included), keeps the artifact in the `artifacts` table with its task (a done task keeps
them; they go only when the task is deleted) and broadcasts `artifacts.changed` with the task's whole list. Declaring a
path again renames it, keeping its place. The reply is `Added <path> to the artifacts as "<title>".` or
`Renamed the artifact <path> to "<title>".`; a bad path is a tool error and adds nothing. The system prompt asks the
agent to declare the deliverables the user asked for with it. The Artifacts tab shows a card per artifact, with its
type (from the extension), lines (from a cheap read, `files.info`) and when the file last changed.

| Tool | Input (draft) | Effect |
|---|---|---|
| `set_title` | `{ title: string }` | Names the task. Called once from the first message; the user can rename later. |
| `set_objective` | `{ objective: string }` | Distils the objective from the first message. Set once. |
| `set_status` | `{ status: string }` | Rewrites the status summary shown in the header and the task list. Becomes the outcome on Done. |
| `ask` | `{ questions: Question[] }` | Shows a rich question card in the chat and blocks until answered. See below. |
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

## Todos: Claude Code's own tools, not a Glade tool (P5-03)

The draft had a `todos` tool. Instead, the Todos tab maps the todo tools Claude Code already gives the model, which it
uses without being asked, so the system prompt says nothing about todos (`src/main/todos/`):

- **`TaskCreate` / `TaskUpdate`** are what the bundled Claude Code (2.1.281) exposes: a probe's `system/init` listed
  `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` and no `TodoWrite`. `TaskCreate { subject, activeForm? }` adds a
  pending item, and its result reads `Task #<id> created successfully: <subject>`; `TaskUpdate { taskId, status?,
  subject?, activeForm? }` changes one, and status `deleted` removes it.
- **`TodoWrite { todos: { content, status, activeForm }[] }`**, the older tool, replaces the whole list. Claude Code
  offers it instead when its task tools are off (`CLAUDE_CODE_ENABLE_TASKS=false` in the environment).

`pending`, `in_progress` and `completed` map to todo, doing and done; a doing item's `activeForm` is its note. Only the
main agent's successful calls count. The list isn't stored on its own: main works it out from the task's tool log
(`todoListFor`), sends it with `tasks.history`, and broadcasts `todos.changed` when a todo tool call finishes. Each
task also keeps a summary of it (`todos` on the task: done, total and the items in progress), updated at the same
moment and sent with `task.updated` when it changes, so the task list's rows show the progress without each task's
history (#246). The calls stay in the tool log like any others. The domain's `waiting` state (purple in the design) has no source in Claude
Code's tools, so nothing sets it yet.

## Glade's control tools: `glade-control` (P13-01)

While Settings › Control lets agents control Glade, each session also gets a second in-process server, `glade-control`
(`src/main/control/`), bound to its task: the tools other agents drive Glade with, listing, reading, creating, changing,
messaging and deleting tasks, and importing Claude Code sessions ([`control-api.md`](control-api.md)). Unlike
`glade`'s, they aren't `alwaysLoad` (they sit behind tool search), and in the ask mode the ones that change things wait
on a permission card; the reads don't. A task can't stop, delete or message itself through them. While the HTTP
endpoint listens, the session also gets `GLADE_CONTROL_URL` and `GLADE_CONTROL_TOKEN` in its environment, for scripts
it runs.

## Not tools — from SDK events

Tool calls and preamble (tool log), subagents (Subagents tab), files touched (Files tab list), context usage (meter),
compaction, errors, turn duration and file/line counts (turn summary).

## System prompt

The app's system prompt tells the agent its task id and title and how to use the tools above. Anything about files on
disk (task folders, notes) comes from the workspace `CLAUDE.md`, not from Glade.

It lives in `src/main/agent/system-prompt.ts` and is appended to Claude Code's own. For a new task, with every setting
at its default, it reads:

```
You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.
This session is one Glade task, with one objective.
Its task id is <id>. Its title is not set yet.

The user sees the task through its title, objective and status. Keep them current with the Glade tools:
- After the user's first message, before anything else, even for a quick question, call set_title with a short name for the task and set_objective with its objective.
- Every turn, call set_status with one line on where the work stands, and again before you end the turn if that changed. When the task is done, the status is its outcome.

When you need the user to decide something before you can go on, call ask instead of asking in your reply: it shows your questions on a card and waits for the answers. Ask everything you need at once, with choices or pills when the likely answers are known.

When you make a deliverable the user asked for (a report, a document, a draft), call add_artifact with its path and a short title, so it shows in the Artifacts tab and stays with the task after it is done.
```

The "after the user's first message" line asks only for what isn't set yet, so a resumed session never renames a task
the user has renamed; with both set, the line goes. With Status summary or Task titles off in Settings › Agent, the
prompt leaves out asking for it.

Two more parts are added after that, each after a blank line, when they apply:

- **The control tools:** while the session has them, one line: that it has Glade's control tools (the `glade-control`
  MCP server; find them with tool search), which list, read, create, change, message and delete Glade's tasks, and to
  use them only when the user asks to work with Glade or its other tasks.
- **A handoff note:** for a task backfilled with one ([`control-api.md`](control-api.md#backfilling-past-tasks)), the
  note under `## Handoff for this task (backfilled from earlier notes)`, after a line saying the task was worked on
  before it was in Glade, to pick up from there, and that the paths the note names are real.
