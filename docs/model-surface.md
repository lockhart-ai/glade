# Model surface (draft)

The app gives the agent a small set of tools so the model can drive the UI. Expose them to the Claude Agent SDK as an
in-process MCP server (e.g. `createSdkMcpServer`). Names and schemas are a **draft** — confirm with Jared before
freezing them.

## Choosing subagent models

The parent chooses a model when dispatching each native SDK subagent. Glade supplies no blanket subagent picker or
saved default. Claude-account tasks keep native Claude model selection. OpenRouter tasks register one named SDK
agent definition per enabled model/provider pair; its description gives the model name, selected provider,
context window and indicative API prices. Select that definition with `Agent.subagent_type` and omit `model`,
whose SDK schema accepts Claude aliases rather than arbitrary OpenRouter IDs. Built-in types and helper calls use
the parent’s OpenRouter route. Provider routing stays fixed by Settings, and native children use the parent’s
connection. Different Glade tasks can use different connections concurrently.

## Main agent only (#366)

Jared only ever talks to a task's main agent, never its subagents, so both of Glade's own in-process MCP servers —
`glade` (below) and `glade-control` ("Glade's control tools", below) — refuse a subagent's call to any of their tools,
whatever the tool, present or future: the model gets a tool error, "Only the main agent can use Glade's tools. Report
what you have to the agent that started you instead." Nothing shows in the UI: no question card for a refused `ask`,
no status, title or objective change, nothing opened in the Files tab or added to the Artifacts tab, no child listed
or filed under a todo (`list_children` and `file_children`, behind the todo hub's switch, below), and the control API
changes, reads or messages no task.

Decided by a `PreToolUse` hook (`src/main/agent/sdk-backend.ts`'s `subagentGladeToolGuard`, `docs/sdk-notes.md` §9)
that denies the call before it ever dispatches, keyed on the SDK's `agent_id` (set only for a subagent's call, never
the main agent's) and `mcp_server.source: 'sdk'` (so only Glade's own in-process servers are covered, never a
configured server whose author names it `glade` too). This can't be `canUseTool`: `glade`'s tools are pre-approved in
`allowedTools`, so Claude Code never asks about them, and Allow all (`bypassPermissions`) skips `canUseTool` for every
tool, `glade-control`'s included; a `PreToolUse` hook fires regardless of permission mode, and is asked first.

**One exception: `request_access` (#450).** A subagent's commands run in the sandbox as the main agent's do, so a
subagent the sandbox blocked asks for the folder itself, with `glade`'s `request_access` ("Implemented:
`request_access`", below). The guard lets that one tool through, and nothing else: every other tool of `glade`, and
all of `glade-control`, is still refused to a subagent. The card it opens names the subagent, as a subagent's
permission card does. The same hook tells the runner which call each `request_access` is and whose (its `tool_use_id`
and `agent_id`), the main agent's too: an MCP tool's handler is given its call's `tool_use` id (`_meta`'s
`claudecode/toolUseId`, [`sdk-notes.md` §15](sdk-notes.md#15-sandbox)), which is how it finds its call, but never
whose call it is.

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
  your reply, in the turn that asked; it isn't queued and starts no turn. The tool returns `{"freeText":"…"}`. A
  broadcast (`tasks.broadcast`, #489) is the one message that doesn't: it went to every task, so it waits in the queue
  until the question is answered.
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
| `add_artifact` | `{ path: string, title: string }` or `{ url: string, title: string }`; behind `todoHubEnabled`, also `todo: string`, which it needs | Declares a file as a deliverable of the task, or a link (a PR, an issue, a ticket) it's about (Artifacts tab). With the todo hub on, files it under the todo it names. See below. |
| `update_artifact` | `{ path: string, title?: string, newPath?: string }` or `{ url: string, title?: string, newUrl?: string }` | Renames an artifact and/or points it at another file or page, keeping its place. |
| `remove_artifact` | `{ path: string }` or `{ url: string }` | Takes a file or a link off the task's artifacts; a file stays. |
| `show_file` | `{ path: string, line?: number }` | Opens a file in the Files tab for the user. |
| `request_access` | `{ path: string, access: "read" \| "write", reason: string }` | Asks the user for the folder a sandboxed command was blocked from, on a permission card, and blocks until answered. See below. |
| `list_children` | `{ todo?: string }` | Behind `todoHubEnabled`. Lists what the task made (its children) by the todo each is under, each with its short id. See below. |
| `file_children` | `{ filings: { child: string, todo: string }[] }` | Behind `todoHubEnabled`. Files children under todos, or moves them to another, all of them or none. See below. |

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

## The sandbox and other servers' tools (P15-11, #515)

With the agent sandbox on, Glade's own tools are the only MCP tools that never need a grant: `glade`'s always, and
`glade-control`'s as before (its switch, and the ask mode's rules). Any other MCP server's tools (the user's own, a
repository's `.mcp.json`, a claude.ai connector) ask once per server, and `SendMessage` to anything but the task's
own subagents, and `RemoteTrigger`, ask once each ([`sdk-notes.md` §15](sdk-notes.md#15-sandbox), "MCP servers and
other agents"). A server is Glade's when the SDK says it's in-process and the session was given it, never by its
name. The system prompt says nothing of this: a call that's denied tells the agent why in its result.

## Implemented: `request_access` (P15-05, #450)

The agent sandbox (#445, [`sdk-notes.md` §15](sdk-notes.md#15-sandbox)) blocks a command's read or write outside the
folders the task has been granted, and the command just fails with `Operation not permitted`: Glade can't see which
path was blocked, or whether it was a read or a write. So the agent says, with `mcp__glade__request_access`, and then
runs the command again. The system prompt tells it to (below), and so does the tool's own description. A session
resumed from before the sandbox was on has neither in its prompt, so it's told once, ahead of its next message
("Resumed sessions", below).

- **Input:** `{ path, access, reason }`, checked at the boundary. `path` is the absolute path that was blocked, a file
  or a folder (`~` and `~/…` are taken as the home folder); `access` is `"read"` or `"write"`; `reason` is a short
  sentence the user reads on the card. A missing or empty field, or another `access`, is a tool error from the SDK's
  check, and so is a `path` over 4096 characters, a `reason` over 500, or either with a control character (a line
  break, an escape) or a text-direction character (the bidirectional overrides, embeddings and isolates) in it, which
  could make the card read as something it isn't. A relative path is a tool error from the handler (`Give the absolute
  path the command was blocked from…`). None of these opens a card.
- **The card:** the sandbox's folder card, "The agent wants to read `<folder>`" or "…write to `<folder>`", with the
  reason under it (backticks in it are set as code) and **Allow for this task** · **Allow for this workspace** ·
  **Deny**, with Deny's optional note. The folder is the path itself if it's a folder or doesn't exist yet, and
  otherwise the folder the file is in. Both the folder and what kind of thing the path is are taken where the path
  really is (links followed): a link to a file asks for the real file's folder, never the link's. **A file whose
  folder is too much to offer** (the home folder, `/Users`, `/Volumes`, `/System/Volumes`, or a folder above one) is
  asked for by itself, "The agent wants to read `~/.gitconfig`", and the grant is that file alone. A read asks for
  read-only access and a write for read-write. A subagent's call names the subagent at the card's top right. The call waits for the answer,
  however long (the `glade` server's timeout, as for `ask`); meanwhile the task needs you, as with any permission card.
- **Allowed:** the grant is saved for the task or the workspace (`sandbox_grants`) and applied to the running sessions
  it covers; the call returns only once its own session has it, so the retry works:
  `Allowed for this task: you can now read /Users/me/code/acme-shared. Run the command that was blocked again.` (or
  `Allowed for this workspace: you can now read and write …`).
- **Denied:** a tool error, `Denied: the user didn't allow <path>, so nothing was granted. Don't retry outside the
  sandbox.`, then `The user said: <note>` when you left one. Nothing is granted. Allowing a folder that was swapped
  for a link while its card was open is a denial too, with Glade's note in place of yours (`Glade didn’t grant this:
  the folder changed while the request was open…`).
- **Denied earlier in the turn:** the same folder (or a write to a folder whose read was denied) asked for again
  before the user's next message opens no card: a tool error at once, `Denied: the user already denied <path> earlier
  in this turn, so they weren't asked again and nothing was granted…`, with the note they gave then. It holds for a
  subagent repeating the agent's request and the other way round.
- **Withdrawn** (Stop, the turn ending, the session closing): a tool error, `No decision was made: the request was
  withdrawn before the user answered.`
- **No card when there's nothing to decide,** each answered at once:
  - the session isn't sandboxed: `The sandbox is off in this session, so it didn't block anything and there's nothing
    to grant.`
  - the path is in the workspace root, which is always read-write: `<path> is inside the workspace, which you can
    already read and write, so there's nothing to grant…`
  - the sandbox already lets commands use it as asked: `<path> is already granted for this task` (or `this workspace`,
    or `every workspace`) `with that access: nothing more to grant.`, or, for a read outside the home folder, `/Users`
    and `/Volumes`, which the sandbox doesn't deny, `You can already use <path> that way: nothing needs granting.` A
    write to a folder granted read-only does ask, for read-write.
  - the path is a credential file or folder (`~/.ssh`, `~/.aws`, …), which no grant opens: a tool error, `Refused:
    <path> is one of the credential files and folders the sandbox never opens…`
  - the path is a folder that's too much to grant from a request (the home folder, `/Users`, `/Volumes`,
    `/System/Volumes`, or a folder above one, the whole disk included): a tool error, `Refused: <path> is too much to
    grant from a request… Ask for the folder inside it that the command needs. If the task really needs all of it,
    tell the user: they can add it under Sandbox in Settings.`
  - the path can't be granted (a path with a glob character, one that can't be resolved, or one through macOS's
    `/.nofollow`, `/.vol` or `/.resolve`): a tool error saying why.
  - the agent asks to write a file that runs code, or into a folder of them (`.git/hooks`, `.git/config`, a shell
    startup file, `.vscode`, `.idea`, `.mcp.json`, Claude Code's own commands, agents, skills, hooks and settings),
    which no grant lets a command write: a tool error, `Refused: <path> is one of the files that run code later…`
- **After a relaunch:** a card open when Glade quit is still there. Answering it saves the grant, resumes the session
  (which starts with the grant) and tells the agent what was decided, as for any permission request the app quit on.
- **Subagents may call it,** the one Glade tool they may ("Main agent only", above).

The handler is `requestAccess` in `src/main/agent/runner.ts`, reached through `GladeToolContext.requestAccess`; what
it asks for and what it answers are in `src/main/permissions/sandbox-ask.ts`.

## Implemented, behind the switch: `list_children` and `file_children` (P16-05, #496)

**Only with the todo hub on.** The todo hub (P16, #491) is built behind the hidden setting `todoHubEnabled`, off until
its last issue (#501). A session has these two tools only when it starts with the setting on; with it off neither
exists, the prompt says nothing of them, and the app is what it was (`src/main/todo-hub/inert.test.ts`). Names and
schemas are a draft, as the others are.

In the hub, what a task produced (its **children**: the files and links among its artifacts, and its commits) sits
under its todos, and a child with no todo shows in a placeholder group, "Not under a todo"
([`decisions.md`](decisions.md), "Todos as the hub"). Only the agent moves a child from one todo to another, with
these tools: there's no menu for it. It's also how a task from before the hub gets sorted: nothing recorded which todo
its children belong to, so you ask it to ("file your things under your todos") and it lists them and files them.
And when Glade asks the agent to file what it just made (#495, [`sdk-notes.md` §16](sdk-notes.md#16-filing-a-child-under-a-todo)),
the agent answers with one `file_children` call.

**Todos hold produced work only (P16-12, #535).** A subagent and a watcher are what's going on, not what was produced,
and neither is under a todo. A subagent still has a todo, the one it works on, as plumbing ("A subagent's todo is
plumbing", below): the tools name a subagent only while it has none, so the agent can say which. A watcher is no
child at all: the tools never list one and can't file one.

A child is named by a **short id** within its task, `c1`, `c2`, …: given the first time Glade names the child to the
agent, kept in SQLite, and never given to another child. A todo is named by Claude Code's own id for it, the `N` of
`Task #N`.

- **`mcp__glade__list_children`** takes `{ todo?: string }` and lists what the task produced, giving a short id to
  any child that had none. A group per todo, in the agent's order, then the ones under no todo; each group's children
  by short id, lowest first:

  ```
  #1 Review the date helpers (completed), 1 child:
  - c5: commit "9b0c2de Tidy the date helpers"
  #2 Write up the review (in progress), no children
  Not under a todo, 4 children:
  - c1: file "Date helpers review"
  - c2: link "Fix the UTC date test"
  - c3: subagent "Check the date tests"
  - c4: commit "73ad18a Fix the UTC date test" (follows c3)
  ```

  A heading is the todo's id, text and state, in Claude Code's own words (`pending`, `in progress`, `completed`), and
  how many children it holds. A line is the child's short id, its kind (`file`, `link`, `commit`, or `subagent`) and
  its title: an artifact's title, a commit's short hash and subject, a subagent's name. Titles and todos are on one
  line and cut to 80 characters, so a task with 200 children lists in about 200 short lines.
  - **A subagent is listed only while it has no todo,** with the ones under no todo: one started before the hub, one
    whose call named no todo and that the agent hasn't filed yet, or one whose todo has been deleted. Filing it says
    which todo it works on. A subagent that has its todo isn't listed, under that todo or anywhere: its commits are.
  - **A watcher is never listed,** whoever started it.
  - **`(follows cN)`** marks a commit the listed subagent `cN` made that has no filing of its own: it goes under
    whichever todo that subagent is filed under. (A commit of a subagent that has its todo is under that todo, with
    no mark.)

  With `todo`, the list is that todo's group alone (its id, with or without a `#`), or the ones under no todo alone
  (`"none"`); a todo that isn't in the task's list is a tool error that lists the todos there are (`There's no todo #9
  in this task's list. Your todos: #1 … (completed) · #2 …`). Listing files nothing and tells the windows nothing.
- **`mcp__glade__file_children`** takes `{ filings: { child: string, todo: string }[] }`, at least one: each a
  child's short id and the id of the todo to put it under. One tool files and moves: each child goes from wherever it
  is, the placeholder included.
  - **All or none.** A child id that names no child of the task (never given, or its child is gone: an artifact
    removed since it was listed), a todo that isn't in the list (never there, or deleted since), or a child named for
    two todos in one call is a tool error that says which, and nothing is filed: `Nothing was filed. Not a child of
    this task: c12. List the task's children for their ids. There's no todo #9 in this task's list. Your todos: #1 …`
    A task with no todos is told `You have no todos yet: create one with TaskCreate first.`
  - **A watcher is refused.** Watchers had short ids while the hub was first built with five kinds; one of those ids
    is a tool error of its own, `Nothing was filed. Watchers aren't filed under todos: c5.`, and nothing else in the
    call is filed either. Nothing gives a watcher an id any more, so this is only ever an id from then.
  - **How it's recorded.** A child that had a filing of its own is `moved`; one that had none (it was under no todo,
    or only followed its subagent) is `asked`: the agent filed it. A child already filed under that todo keeps its
    filing as it was. A child named twice for the same todo counts once.
  - **A subagent is accepted, and filing it sets the todo it works on,** whether or not it had one (by an id Glade
    gave it when it asked the agent to file it, or from a listing while it had no todo). It still isn't shown under
    that todo. **Its commits come with it,** apart from any filed on its own: the resolver follows the subagent, so
    nothing is written for those, and the reply names them. A subagent it started works on the same todo too, unless
    it has one of its own, which the reply doesn't say.
  - **The reply** says what it did: `Filed 3 children: c1 under #2; c2 under #3; c3 under #1. Moved with their
    subagent: c4.`, with `Already there: c1.` for the ones it left, or `Nothing changed. Already there: c1.`
  - **The windows hear it** as they hear any filing: one `filings.changed` with the filings made.
  - It reads ids leniently: `C3` for `c3`, `#2` for `2`. A todo with no id (a `TodoWrite` item) can't hold anything.
- **Main agent only**, as every Glade tool but `request_access` ("Main agent only", above): a subagent's call to
  either is refused before it runs, and names, files and sends nothing.
- **If the setting is turned off under a session that has them,** both answer with a tool error (`The todo hub is off
  (the todoHubEnabled setting).`) and do nothing.

The handlers are `listForAgent` and `fileForAgent` in `src/main/todo-hub/agent-children.ts`, over the filing store
(`src/main/todo-hub/todo-hub.ts`) and the resolver (`groupChildren` in `src/shared/todoHub.ts`). The prompt says the
tools exist in one line ("System prompt", below).

## Implemented, behind the switch: filing produced work as it's made (P16-04, #495)

**Only with the todo hub on.** A session that starts with `todoHubEnabled` on files what its agent produces under one
of its todos as it's made: its artifacts and its commits. With the setting off, none of this exists: `add_artifact`
takes no `todo`, the prompt has none of these lines, and no hook reads a call, tells the agent anything or holds a turn
(`src/main/todo-hub/inert.test.ts`). The code is `src/main/todo-hub/filing.ts`, and the evidence for each part is in
[`sdk-notes.md` §16](sdk-notes.md#16-filing-a-child-under-a-todo).

The phase first filed everything a task made, subagents and watchers included; Jared then split it into activity (the
Agents tab) and produced work (Todos). So: **a watcher isn't filed at all**, and **a subagent's todo is plumbing**
(below), kept so its commits land under the right todo and its tab can say what it's working on, never shown under
the todo.

**An artifact: `add_artifact` takes `todo`, and needs it.** With the hub on, the tool's input is
`{ path, title, todo }` or `{ url, title, todo }`: `todo` is the id of the todo the artifact belongs under (the `N` of
`Task #N`; `#2` reads as `2`). The artifact is filed there as it's added (`named`), and the windows hear its filing
before they hear of the artifact. The reply ends `It's under todo #2.`

- **Without a `todo`,** or with one that isn't in the task's list (never there, or deleted since), it's a tool error
  that lists the task's todos, and nothing is added: `Nothing was added: give the id of the todo this artifact belongs
  under, as todo (the N of Task #N). Your todos: #1 … (pending) · #2 …`, or `Nothing was added. There's no todo #9 in
  this task's list. Your todos: …`. A task with no todos is told `You have no todos yet: create one with TaskCreate
  first.` A todo that's done is still a todo: an artifact can go under it.
- **Declared again,** an artifact is renamed as before, and stays under its todo; given another todo, it moves there
  (`moved`).
- **`update_artifact` and `remove_artifact` keep the filing in step:** an artifact pointed at another file or page
  (`newPath`, `newUrl`) stays under its todo, and one that's removed, by the agent, by you or through the control
  API, leaves no filing behind. Neither takes a `todo`: moving an artifact to another todo is `file_children`'s.
- **No agent call, no todo.** A link you add yourself (Add to artifacts) and an artifact added through the control
  API have no call to name a todo: they stay under "Not under a todo", and the agent can file them when asked to.
- If the setting is turned off under a session that has this `add_artifact`, the tool adds the artifact as it did
  before the hub, and files nothing.

**A commit, and a subagent's todo: the call names it.** A commit comes from a `Bash` call and a subagent from an
`Agent` call, Claude Code's own tools, which Glade can't add a field to. So the todo travels as a marker at the start
of the call's `description`, `[todo 2] Review the date helpers` (`src/main/agent/child-calls.ts`). The rule, which
Jared picked from #492's findings:

1. **Named in the call.** For an `Agent` call, Glade records the subagent it starts as working on that todo (`named`),
   before the subagent exists. For a `Bash` call in the foreground, it files what the call commits under that todo, as
   each commit is found. Either way it takes the marker off before the tool runs and off the call's row in the tool
   log, so it shows nowhere: not in the subagent's name or the Tool calls tab. `[todo #2]`, other case and space around
   it are read too.
2. **A call that names none goes ahead,** and so does one whose marker names a todo that isn't in the list (the marker
   still comes off). Once the calls of its message have run, Glade tells the agent, with their results, what they made
   and which todos it has, each by its short id, and the agent answers with one `file_children` call (`asked`):

   ```
   Glade: file what you just made under its todo now, before your next step, with one mcp__glade__file_children call.
   Made:
   - c4: subagent "Review the order totals"
   - c5: commit "73ad18a Note the date review"
   Your todos: #1 Review the date helpers (completed) · #2 Fix the UTC date test (in progress)
   If no todo fits, create it first with TaskCreate.
   ```

   A commit Glade finds after an unnamed `Bash` call goes the same way, however it was made (a release script that
   commits, say): the agent's next step waits until git has been read. An agent with no todos is told
   `You have no todos yet: create one with TaskCreate first.`
3. **A turn can't end with a commit, or a subagent's todo, still unfiled.** Glade holds the end of the turn, saying
   what's left, twice a turn at most:

   ```
   Glade: these aren't filed under a todo yet. File them with one mcp__glade__file_children call, then end your turn.
   - c5: commit "73ad18a Note the date review"
   Your todos: #1 Review the date helpers (completed) · #2 Fix the UTC date test (in progress)
   ```

   The agent files them and writes its reply again; the reply it had written before the hold goes to the tool log, so
   the chat shows the one it ended on (or, if it writes none after filing, the one it had written). **If it ignores
   both holds, the turn ends anyway:** what's left stays under "Not under a todo", still owed, and the end of its next
   turn asks again, twice more. What's owed is kept in SQLite (`owed_filings`), so a relaunch doesn't forget it. A turn
   you stopped is never held, nor is a compaction.
4. **Nothing is refused, and nothing is guessed** from which todo is in progress.

**A subagent's todo is plumbing.** What's stored is "this subagent works on this todo": one subagent, one todo
(`subagentTodo` in `src/shared/todoHub.ts` reads it back, for the subagent's tab in the Agents tab, #536). It isn't
produced work, and isn't shown under the todo.

- **Its commits follow it.** What a subagent commits is under the todo it works on, by itself (`inherited`), from the
  moment the commit is found. A subagent is never told to file anything, and nothing it leaves unnamed is ever owed.
- **A subagent it starts works on the same todo,** however deep, unless that `Agent` call names another todo of the
  task's: then the subagent it starts works on that one, and the marker comes off its call too. A marker naming a
  todo that isn't in the list leaves it on its parent's.
- **A subagent's other calls are left alone:** a marker at the start of its `Bash` call's description stays where
  it is.

**A watcher isn't filed.** A `Monitor` call, a `Bash` call with `run_in_background`, a `ScheduleWakeup` and a
`CronCreate` are left exactly as they are, the agent's and a subagent's alike: the prompt asks for no marker on them,
none is read or taken off (a watcher's label is what its call says, whatever that starts with), no message follows
them, and no turn is held for them. A watcher belongs to the agent that started it, and shows with that agent's tool
calls (#537).

Only what the agent made itself, in a call, with the hub on, is ever owed: never what the task made before the hub, a
link you added, or an artifact added through the control API. Those wait under "Not under a todo" until you ask the
agent to sort them.

**The todo tools stay on.** A todo without an id can hold nothing, and Claude Code swaps its task tools for
`TodoWrite`, whose items have none, when a settings file says `CLAUDE_CODE_ENABLE_TASKS=false`. A session with the hub
on sets that switch itself, in the SDK's `settings`, which outrank the user's, the project's and the local settings
files ([`sdk-notes.md` §16](sdk-notes.md#16-filing-a-child-under-a-todo), "`TodoWrite`").

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
`GLADE_CONTROL_TOKEN` in its environment, for scripts it runs. In a sandboxed session they're kept from sandboxed
commands (`sandbox.credentials.envVars`, #514): only a command allowed to run outside the sandbox has them.

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

When you make a deliverable the user asked for (a report, a document, a draft), call add_artifact with its path and a short title, so it shows in the Todos tab and stays with the task after it is done. Keep that list current: if its file moves or it needs a new title, call update_artifact; if it's no longer a deliverable, call remove_artifact.
When you open or work on a pull request, or the task is about an issue or a ticket (GitHub, Jira), call add_artifact with its url and a short title, so the user finds it in the Todos tab next to the files.

When you leave a script running to watch something (a PR, CI, a deploy, a remote job), start it with the Monitor tool or with Bash's run_in_background, not by backgrounding it yourself (nohup, &), so it shows in the task's Agents tab.

Glade files every commit you make under one of your todos, where the user finds it, and each subagent you start works on one of them. Name the todo in the call: start the description of an Agent call, and of a Bash call that commits, with the todo's id in square brackets, like "[todo 2] Review the date helpers". Create the todo first (TaskCreate) if none fits. If a call names none, Glade asks you right after it to file what it made, with mcp__glade__file_children: do that at once, before your next step. What a subagent commits goes under its todo by itself: leave those.

An artifact goes under a todo too: give add_artifact the todo's id as todo, for a file and for a link.

What this task has produced (its artifacts and commits) shows to the user under its todos. list_children lists them, each with a short id and the todo it's under, and file_children files them under a todo or moves them to another, by those ids. When the user asks you to file or sort what you made, list them, then file them all in one call.
```

The line about the last message is for the chat (#301): it shows only the agent's final reply each turn
([`product.md`](product.md), the chat log), and everything before a later tool call goes to the tool log. An agent
that answers and then carries on (files an issue, updates its notes) would otherwise end on a line about that, and
the answer would be buried. Narration between tool calls stays in the tool log.

The line about pull requests, issues and tickets is for link artifacts (#407): tasks depend on remote things that
would otherwise be scattered through the chat, the todos and the tool log, and the Todos tab is the one place to
get back to them.

The line about watch scripts is for the watchers the Agents tab pins (#250, [`sdk-notes.md`](sdk-notes.md) §13): Glade follows what the agent starts
with the SDK's own tools (`Monitor`, background `Bash`, `ScheduleWakeup`, `CronCreate`), whatever script it runs, but
a script backgrounded inside a foreground `Bash` call (`nohup ./watch.sh &`) is invisible to the SDK, so to Glade too.

The last three paragraphs are the todo hub's (`TODO_HUB_LINES`, P16-04 and P16-05, #495 and #496): how its commits
are filed and each subagent gets a todo (`TODO_HUB_FILING_LINE`: what #492 probed,
[`sdk-notes.md` §16](sdk-notes.md#16-filing-a-child-under-a-todo), cut down to the two calls Glade reads a todo off,
with nothing of watchers), that an artifact needs a todo too, and that the hub's tools exist and what they're for.

The "after the user's first message" line asks only for what isn't set yet, so a resumed session never renames a task
the user has renamed; with both set, the line goes. With Status summary or Task titles off in Settings › Agent, the
prompt leaves out asking for it.

Three more parts are added after that, each after a blank line, when they apply:

- **The sandbox:** in a session that runs sandboxed (Settings › Agent › Sandbox on as it starts), one paragraph
  (`SANDBOX_LINE`): that its commands can read and write the workspace folder and, beyond it, only the folders and
  domains the user has allowed, and that when a command fails with "Operation not permitted" on a path outside the
  workspace it should call `request_access` (the absolute path, read or write, a short reason) instead of retrying
  outside the sandbox, and run the command again once it's allowed. With the sandbox off, the prompt doesn't mention
  it. A session resumed from before the sandbox was on keeps its old prompt, and is sent this paragraph once instead
  ("Resumed sessions", below).
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

The sandbox paragraph isn't in that list, since it's only for a session that runs sandboxed (#452). A session that
started outside the sandbox (before the switch was on, or before the sandbox existed) and resumes in it is sent
`SANDBOX_LINE` once, as a `[Glade: this session now runs in a sandbox] … [end]` block ahead of the next message
Glade sends it, after the block of new instructions and before a handoff note's. Whether a session has been told is
kept in SQLite too (`session_context.sandbox`): one that started sandboxed has it in its prompt and is never sent it,
one that still runs outside the sandbox isn't told, and one told once isn't told again, whatever the switch does
later. An imported session gets it in Glade's whole prompt when it runs sandboxed.

The todo hub's paragraphs aren't in that list either: the hub was built behind a switch (#495), so whether a session
has them is tracked by itself, as the sandbox's is (`session_context.todo_hub`), and the count of instructions a
session has had (`session_context.instruction_updates`) is untouched by it. Every session has the hub now (#501). One
that started before that (from before the hub, or from while it was behind its switch and off) resumes with the hub's
tools and hooks when it next starts, and is sent the three paragraphs once, as a
`[Glade: this session now files what it makes under its todos] … [end]` block ahead of the next message Glade sends
it, after the sandbox's block and before a handoff note's. One that started with them has them in its prompt and is
never sent them, and one told once isn't told again. An imported session gets them in Glade's whole prompt.
