# Model surface (draft)

The app gives the agent a small set of tools so the model can drive the UI. Expose them to the Claude Agent SDK as an
in-process MCP server (e.g. `createSdkMcpServer`). Names and schemas are a **draft** — confirm with Jared before
freezing them.

## Main agent only (#366)

Jared only ever talks to a task's main agent, never its subagents, so both of Glade's own in-process MCP servers —
`glade` (below) and `glade-control` ("Glade's control tools", below) — refuse a subagent's call to any of their tools,
whatever the tool, present or future: the model gets a tool error, "Only the main agent can use Glade's tools. Report
what you have to the agent that started you instead." Nothing shows in the UI: no question card for a refused `ask`,
no status, title or objective change, nothing opened in the Files tab or added to the Artifacts tab, and the control
API changes, reads or messages no task.

Decided by a `PreToolUse` hook (`src/main/agent/sdk-backend.ts`'s `subagentGladeToolGuard`, `docs/sdk-notes.md` §9)
that denies the call before it ever dispatches, keyed on the SDK's `agent_id` (set only for a subagent's call, never
the main agent's) and `mcp_server.source: 'sdk'` (so only Glade's own in-process servers are covered, never a
configured server whose author names it `glade` too). This can't be `canUseTool`: `glade`'s tools are pre-approved in
`allowedTools`, so Claude Code never asks about them, and Allow all (`bypassPermissions`) skips `canUseTool` for every
tool, `glade-control`'s included; a `PreToolUse` hook fires regardless of permission mode, and is asked first.

## What a user message contains

A message's content (`src/main/agent/user-content.ts`'s `userContent`, called from the runner's `hand`): an image
content block for each image pasted into it, in order, then its text — unless it's blank, which the API refuses as a
text block, so an images-only message sends none.

**Attached files** (#396, `shared/attachedFiles.ts`, `src/main/attachments/attachments.ts`): a file dropped onto the
input bar, or pasted from Finder, is copied byte for byte into the workspace, at `.glade/attachments/<task id>/<name>`
(a name already there gets the next free one, `sales (2).csv`), and the agent gets its path, never its contents: one
line per file, in the order they were attached, at the end of the text, after a blank line (the lines alone when the
message has no text):

```
Attached file: sales.csv (48 KB) at .glade/attachments/<task id>/sales.csv (absolute path: <root>/.glade/attachments/<task id>/sales.csv)
```

The path is relative to the workspace root, where the session runs; the absolute path is there too, for an agent that
has changed folder since. An attached PNG, JPEG, GIF or WebP the API takes (up to 3.75 MB, its bytes its type) also goes
as an image content block, read from its copy as the message is handed over, after any pasted images; any other image,
or one whose copy is gone, gets its line alone. What's stored and shown is only what you typed: the lines are added as
the message is handed over (sent, delivered from the queue, retried, or sent to a new session on launch), never to the
chat, and `TaskDetail.messages` over the control API doesn't list the files. An answer in words to the agent's questions
can't carry files, as it can't carry images.

**Pasted text** (#363, `shared/pastedContent.ts`): a paste of more than one line, or ~80 characters or more, becomes
its own block, kept apart from what was typed (below the API's threshold, it's left as plain typed text). What's
stored and shown carries a short inline token standing for the block among the typed text (never the pasted text
itself, and never the tags below); the text handed to the agent replaces each token, at its place among the rest of
the text, with the block wrapped in tags carrying a short random id, shared by the opening and closing tag (from the
Opus 5.5 prompting guide: a host that marks pasted text this way helps the model resist prompt injection inside it):

```
<pasted_content id="k3f9">
…the pasted text…
</pasted_content id="k3f9">
```

The id is generated fresh for each block, and is never shown in the UI: the input bar's chip and the chat's collapsed
row both just say how many lines it is. Kept everywhere a message is (queued, drafted, across a relaunch, and
`TaskDetail.messages` over the control API, which reads a message's stored text as-is, token included).

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

`mcp__glade__ask` takes `{ preamble?: string, questions: Question[] }`, with `Question` exactly as drafted below
(`QuestionKind` and the question interfaces in `src/shared/domain.ts`; the zod schema in
`src/main/questions/schema.ts`). Beyond the draft: every text is trimmed and must not be empty, there is at least one
question, a choice or pills question has at least two options, and a choice's option ids and a question's pills are
each unique. **Every question is optional** (#397): you can send the card with any of them answered, or none. A text
question's `optional` flag is still taken, so older calls and stored sets parse, but it's ignored.

**Preamble** (#298): the chat shows only the agent's final reply each turn, so what it says before calling `ask` goes
to the tool log, and a card that answers your message straight away can read as jumping to conclusions. `preamble` is
the agent's reply to what you just said (answering your question, reacting to your statement, or saying why it asks),
in Markdown, a few sentences. It's optional, and comes before `questions` in the schema, so the model writes it first.
It's trimmed, and refused when it's empty (a tool error, as for any empty text) or longer than 2,000 characters
(`PREAMBLE_MAX_LENGTH`). The card shows it at its top, above the questions, as a chat reply's Markdown (links shown as
text, images as their alt text, raw HTML dropped); it's saved with the set (`question_sets.preamble`), so it stays on
the card once it's answered or withdrawn and after a relaunch. A set with a preamble shows no lead: the narration just
before the call, which a card without one shows above it. The tool's description and the system prompt ask for it:
"When you ask in response to a message, first respond to it in preamble, then ask."

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
checkboxes with `multiple`; at least 160px wide and at most three to a row, wrapping onto more rows), pills (the same,
wrapping onto more rows) or text field; then, below the last question, an **"Anything else?"** box (#397), always
there and optional, for a note in your own words: why none of the options fit, say. Then "N of M answered" and the send
button, always enabled: it reads Send answers, or Skip questions while nothing is answered or typed. A word too long
for its line breaks inside its option or pill. Keyboard: Tab moves between the questions (one stop each), the box and
Send, ← → between a question's options, ↑ ↓ between questions, the box and Send (in the box, only from its start or
end), 1–9 pick the focused question's options, Space the focused one, and ↵ sends; in the box ↵ starts a new line and
⌘↵ sends. Once closed, the card shows each answer, or "Skipped" for a question you left, and your "Anything else"
text if you typed any; its title says "answered", or "skipped" when you sent it with nothing at all. Or it says that it
was answered in your words, or that it was withdrawn. A set opened in a task you aren't viewing marks it unread and
sends a notification, as a final reply does, with the first line of its preamble as the body, or with none, its first
question.

- **It blocks.** The handler saves an open question set (`QuestionSet`, table `question_sets`) and waits until it's
  answered, however long that takes (`src/main/questions/questions.ts`). It has no timer of its own, but Claude Code
  bounds every MCP tool call (100,000 s, about 28 hours, by default), so the `glade` server raises its bound to the
  most Claude Code allows, 2^31 − 1 ms (about 24.8 days; `GLADE_TOOL_TIMEOUT_MS`, #381). A card still open after that
  is withdrawn and the call ends with a timeout error; a relaunch in the meantime lifts the bound (below;
  `docs/sdk-notes.md` §3). Meanwhile the task waits on you: its activity is waiting, `task.asking` is true, and it
  counts under Needs you (`needsYou`). The windows hear `question.opened`, then `question.answered` or
  `question.withdrawn`.
- **Answering with the card:** `questions.answer { id, answers, anythingElse? }`, with answers keyed by question index
  from 0. A choice takes an option id, pills a pill's text, text the text typed; `multiple` takes an array, each value
  once. Any question may be left out, all of them included; an empty array or blank text counts as left out and is
  dropped (`src/shared/questions.ts`). `anythingElse` is the "Anything else?" box's text, trimmed, and dropped when
  blank; it's saved with the reply (`question_sets.reply`), so it's still there after a relaunch. The tool returns the
  answers as JSON, with the box's text under the reserved key `anythingElse` when there is any, e.g.
  `{"0":"by-type","1":"Internal changes"}`, `{"1":"Internal changes","anythingElse":"Hold the email until 2.4.1."}`,
  or `{}` for a card skipped outright. The tool's description tells the model that any question may come back
  unanswered, and to read `anythingElse` first, since it may hold the real answer.
- **Answering in words:** a message sent (`tasks.send`) while a question is open answers it. It's saved to the chat as
  your reply, in the turn that asked; it isn't queued and starts no turn. The tool returns `{"freeText":"…"}`.
- **Stopped or failed:** a turn that ends while its question is open withdraws it; Stop withdraws it first. The tool
  returns an error saying the questions were withdrawn.
- **Relaunch:** a question the app quit on stays open, and its task waits on you; its `ask` call ends as an error. When
  you answer it, the task's session is resumed and the answer goes to the agent as a message (the runner's
  `answeredAfterRestart`, with the same JSON the tool would have returned, `anythingElse` included), carrying on the
  same turn. No call waits on it any more, so nothing times it out: it waits
  however long you take.
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
agent to declare the deliverables the user asked for with it. The Artifacts tab shows a row per artifact, with a
thumbnail of an image (`files.thumbnail`) or its type (from the extension), newest first by when its file last changed
(noted as it's declared, and again when a tool call writes it or, while the tab is open, the file changes on disk),
under date headers.

## Implemented: `update_artifact` and `remove_artifact` (#385, names unconfirmed)

The agent keeps the list current with two more tools, each taking the artifact's `path` as it was added (absolute or
relative to the workspace root; its file needn't still be there). Both broadcast `artifacts.changed` with the task's
whole list, so the Artifacts tab (and an image viewer open on it) follows at once. A path that isn't one of the task's
artifacts, or is outside the workspace, is a tool error (`<path> isn't one of this task's artifacts.`) and changes
nothing.

- **`mcp__glade__update_artifact`** takes `{ path: string, title?: string, newPath?: string }`, and needs at least one
  of `title` and `newPath` (neither is a tool error). `newPath` is checked as `add_artifact` checks a path (a file
  inside the workspace, symlinks included), and mustn't be another of the task's artifacts (a tool error: remove one
  first). The artifact keeps its place and, without a `title`, its title; its new file's last change is noted, which
  places it in the tab. The handler is `updateTaskArtifact` in `src/main/artifacts/artifacts.ts`. The reply says what
  changed: `Renamed the artifact <path> to "<title>".`, `Moved the artifact "<title>" from <path> to <newPath>.`,
  `Moved the artifact <path> to <newPath>, now called "<title>".`, or, for the same title and file,
  `The artifact <path> is already called "<title>"; nothing changed.` (nothing is written or broadcast).
- **`mcp__glade__remove_artifact`** takes `{ path: string }` and takes the artifact off the list, as the tab's Remove
  from artifacts does, leaving the file alone (`forgetTaskArtifact`). The reply is
  `Removed <path> ("<title>") from the artifacts. The file itself is untouched.`

`add_artifact` still renames an artifact declared again, as before, so older habits keep working; `update_artifact`
is the way to change one on purpose, and the only way to repoint it.

## Implemented: link artifacts (#407, names unconfirmed)

An artifact can be a link instead of a file: a PR the agent opens or works on, or the issue or ticket the task is
about, so the Artifacts tab is the one place to get back to them. The three tools take a `url` in place of a `path`,
one or the other: both, or neither, is a tool error (`Give the artifact's path (a file) or its url (a link): one of
them, not both.`).

- **`add_artifact`** takes `{ url: string, title: string }` too. The URL must be a whole `http:` or `https:` one
  (`checkArtifactUrl` in `src/shared/artifactLinks.ts`): no `javascript:`, `file:`, `data:`, `mailto:` or custom
  scheme, no whitespace or control characters, no user name or password, at most 2048 characters; anything else is a
  tool error (`The url javascript: links can't be artifacts: only http and https.`) and adds nothing. It's kept, and
  keyed, as the URL parser writes it out (the scheme and host lower-cased, a default port dropped), so the same page
  given twice is one artifact, renamed the second time. The handler is `addTaskLinkArtifact` in
  `src/main/artifacts/artifacts.ts`; the reply is `Added <url> to the artifacts as "<title>".` or
  `Renamed the artifact <url> to "<title>".`
- **`update_artifact`** takes `{ url: string, title?: string, newUrl?: string }` for a link (`updateTaskLinkArtifact`),
  with the same replies as for a file, the URLs in place of the paths. A file takes a `newPath` and a link a `newUrl`:
  the other way about is a tool error, since an artifact can't change its kind (remove it and add the other).
- **`remove_artifact`** takes `{ url: string }` for a link (`forgetTaskLinkArtifact`); the reply is
  `Removed <url> ("<title>") from the artifacts.`

The Artifacts tab tells what a link is from its URL alone, with no network call (`recogniseLink`): a GitHub pull
request (`github.com/<owner>/<repo>/pull/<n>`, and the pages under it) shows a PR icon and `#412 · acme/api`, an issue
(`…/issues/<n>`) an issue icon and `#398 · acme/api`, a Jira ticket (a path ending in `/browse/<KEY>-<n>`, on
`*.atlassian.net` or a Jira of your own) a ticket icon and `API-123`, and anything else (a GitHub Enterprise host
included: it can't be told from any other site) a link icon and its domain. A link is dated by when it was declared
or last changed, as it has no file. Clicking one opens it in the browser through `links.open`, never in Glade. Its
status (open, merged, closed) isn't fetched.

| Tool | Input (draft) | Effect |
|---|---|---|
| `set_title` | `{ title: string }` | Names the task. Called once from the first message; the user can rename later. |
| `set_objective` | `{ objective: string }` | Distils the objective from the first message. Set once. |
| `set_status` | `{ status: string }` | Rewrites the status summary shown in the header and the task list. Becomes the outcome on Done. |
| `ask` | `{ preamble?: string, questions: Question[] }` | Shows a rich question card in the chat, led by the agent's reply to your message, and blocks until answered. See below. |
| `add_artifact` | `{ path: string, title: string }` or `{ url: string, title: string }` | Declares a file as a deliverable of the task, or a link (a PR, an issue, a ticket) it's about (Artifacts tab). |
| `update_artifact` | `{ path: string, title?: string, newPath?: string }` or `{ url: string, title?: string, newUrl?: string }` | Renames an artifact and/or points it at another file or page, keeping its place. |
| `remove_artifact` | `{ path: string }` or `{ url: string }` | Takes a file or a link off the task's artifacts; a file stays. |
| `show_file` | `{ path: string, line?: number }` | Opens a file in the Files tab for the user. |

`Question` (draft):

```ts
type Question =
  | { kind: "choice"; prompt: string; options: { id: string; label: string; detail?: string; sketch?: string }[]; multiple?: boolean }
  | { kind: "pills"; prompt: string; options: string[]; multiple?: boolean }
  | { kind: "text"; prompt: string; placeholder?: string; optional?: boolean }; // optional: ignored (#397)
```

Answers return as JSON keyed by question index, for the questions answered (any may be skipped), plus `anythingElse`
when the user typed in the card's "Anything else?" box. The user can ignore the card and reply in words instead; that
answers it too.

## Todos: Claude Code's own tools, not a Glade tool (P5-03)

The draft had a `todos` tool. Instead, the Todos tab maps the todo tools Claude Code already gives the model, which it
uses without being asked, so the system prompt says nothing about todos (`src/main/todos/`):

- **`TaskCreate` / `TaskUpdate`** are what the bundled Claude Code (2.1.281) exposes: a probe's `system/init` listed
  `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` and no `TodoWrite`. `TaskCreate { subject, activeForm? }` adds a
  pending item, and its result reads `Task #<id> created successfully: <subject>`; `TaskUpdate { taskId, status?,
  subject?, activeForm? }` changes one, and status `deleted` removes it.
- **`TodoWrite { todos: { content, status, activeForm }[] }`**, the older tool, replaces the whole list. Claude Code
  offers it instead when its task tools are off (`CLAUDE_CODE_ENABLE_TASKS=false` in the environment).

`pending`, `in_progress` and `completed` map to todo, doing and done; a doing item's `activeForm` is its note, and a
done item's `completedAt` is the time of the call that marked it done (the `TaskUpdate` that set it completed, or the
first `TodoWrite` that has listed it completed since; `TodoWrite`'s items are matched by their text), cleared when it
goes back (#282). The Todos tab groups the items: active, then not started, then done (newest first). Only the
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
on a permission card; the reads don't. A task can't stop, delete or message itself through them. A subagent can't call
any of them either ("Main agent only", above): without that guard it would inherit the whole server, reads included,
the same way the main agent does, since neither `glade-control` nor the SDK's built-in subagent types give it a
restricted tool set of its own. While the HTTP endpoint listens, the session also gets `GLADE_CONTROL_URL` and
`GLADE_CONTROL_TOKEN` in its environment, for scripts it runs.

## Not tools — from SDK events

Tool calls and preamble (tool log), subagents (Subagents tab), files touched (Files tab list), context usage (meter),
compaction, errors, turn duration and file/line counts (turn summary). The Watchers tab follows the monitors,
background commands, wakeups and cron jobs the agent starts with Claude Code's own tools, from the SDK's task messages
and the session's `UserPromptSubmit` and `Stop` hooks ([`sdk-notes.md`](sdk-notes.md) §13); Glade adds no tool for
them.

## System prompt

The app's system prompt tells the agent its task id and title and how to use the tools above. Anything about files on
disk (task folders, notes) comes from the workspace `CLAUDE.md`, not from Glade.

It lives in `src/main/agent/system-prompt.ts` and is appended to Claude Code's own. For a new task, with every setting
at its default, it reads:

```
You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.
This session is one Glade task, with one objective.
Its task id is <id>. Its title is not set yet.

In the chat, the user sees only your last message of each turn: what you write before a tool call goes to the tool log, which they rarely read. So end every turn with a complete reply that answers what they asked or responds to what they said, with any findings, even ones you wrote earlier in the turn. Do follow-up work (tool calls) before that reply, not after it.

The user sees the task through its title, objective and status. Keep them current with the Glade tools:
- After the user's first message, before anything else, even for a quick question, call set_title with a short name for the task and set_objective with its objective.
- Every turn, call set_status with one line on where the work stands, and again before you end the turn if that changed. When the task is done, the status is its outcome.

When you need the user to decide something before you can go on, call ask instead of asking in your reply: it shows your questions on a card and waits for the answers. Ask everything you need at once, with choices or pills when the likely answers are known. When you ask in response to a message, first respond to it in preamble, then ask.

When you make a deliverable the user asked for (a report, a document, a draft), call add_artifact with its path and a short title, so it shows in the Artifacts tab and stays with the task after it is done. Keep that list current: if its file moves or it needs a new title, call update_artifact; if it's no longer a deliverable, call remove_artifact.
When you open or work on a pull request, or the task is about an issue or a ticket (GitHub, Jira), call add_artifact with its url and a short title, so the user finds it in the Artifacts tab next to the files.

When you leave a script running to watch something (a PR, CI, a deploy, a remote job), start it with the Monitor tool or with Bash's run_in_background, not by backgrounding it yourself (nohup, &), so it shows in the task's Watchers tab.
```

The line about the last message is for the chat (#301): it shows only the agent's final reply each turn
([`product.md`](product.md), the chat log), and everything before a later tool call goes to the tool log. An agent
that answers and then carries on (files an issue, updates its notes) would otherwise end on a line about that, and
the answer would be buried. Narration between tool calls stays in the tool log.

The line about pull requests, issues and tickets is for link artifacts (#407): tasks depend on remote things that
would otherwise be scattered through the chat, the todos and the tool log, and the Artifacts tab is the one place to
get back to them.

The last line is for the Watchers tab (#250, [`sdk-notes.md`](sdk-notes.md) §13): Glade follows what the agent starts
with the SDK's own tools (`Monitor`, background `Bash`, `ScheduleWakeup`, `CronCreate`), whatever script it runs, but
a script backgrounded inside a foreground `Bash` call (`nohup ./watch.sh &`) is invisible to the SDK, so to Glade too.

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

**Resumed sessions.** Claude Code keeps a session's system prompt when it resumes it
([`sdk-notes.md` §8](sdk-notes.md#8-resume-verified)), so a line added to the prompt reaches only sessions started
after it. The lines added since sessions first had Glade's prompt are listed, oldest first, in `INSTRUCTION_UPDATES`
(so far the last-message line, #301, and the link artifacts line, #407). A session that started before one was added is sent the ones it hasn't
had once, as a `[Glade: new instructions for this session] … [end]` block ahead of the next message Glade sends it;
the chat shows only your message. How many each session has had is kept in SQLite
(`session_context.instruction_updates`), so a relaunch neither loses nor repeats the block. An imported session gets
Glade's whole prompt instead ([`control-api.md`](control-api.md)), these lines and all.
