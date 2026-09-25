# Control API (draft)

Glade can be driven by other agents: a chat in Claude Code, a script, or one of Glade's own tasks can list, read,
create and change tasks, and port past Claude Code sessions in as tasks. It's one MCP server, **`glade-control`**,
served two ways, and the same tools as plain JSON for scripts. Decided in `decisions.md` ("Programmatic control"); built in P13 (#219). Names and schemas are a draft
until P13 is released, then frozen.

## Turning it on

Settings › Control (`docs/design/screens/21-settings-control.png`) has one switch, **Let agents control Glade**, off
by default. While it's off, nothing is served: the endpoint isn't listening and new sessions don't get the tools. A
session started while it was on keeps the tools, but every call is refused with `disabled` once it's off.

The endpoint follows the switch: it starts when the switch goes on (and at launch, if it's on), stops when it goes off
(dropping its connections), moves when the port changes, and closes when Glade quits. Changes are made one at a time
in order, so flipping the switch quickly leaves one endpoint or none, never two.

When it's on, the section shows:

- the endpoint URL, `http://127.0.0.1:45233/mcp` by default;
- the command that connects Claude Code to it, ready to copy:

  ```
  claude mcp add --transport http glade-control http://127.0.0.1:45233/mcp --header "Authorization: Bearer <token>"
  ```

- **Regenerate token**, which replaces the token at once (the old one stops working; copy the command again);
- the port, which you can change (1024–65535, saved when you press Return or leave the field), and, when it's taken,
  a notice that Glade is listening on another and that a command copied before points at the old one, or, when every
  port it tried is taken, the error;
- a note that Glade's own tasks get the tools too, from their next session.

## Two transports, one server

The tools are defined once (name, description, zod input schema, handler) in main (`src/main/control/tools.ts`) and
served by:

- **In-process, for Glade's own tasks.** While the switch is on, each task's session gets `glade-control` in its
  `mcpServers`, next to `glade`, as an in-process SDK server (the `{ type: 'sdk' }` config `createSdkMcpServer` makes,
  over an MCP server that serves the definitions itself, so its errors are this API's) that knows which task is
  calling.
  Its tools aren't `alwaysLoad`: they sit behind tool search, so they cost no context until the agent looks for them.
  The system prompt gets one line saying they exist and are for when you ask.
- **HTTP, for everything else.** A Streamable HTTP MCP endpoint (the official `@modelcontextprotocol/sdk`, stateless,
  JSON answers rather than streams) at `/mcp`, listening on `127.0.0.1` only (`src/main/control/http.ts`). The same
  server answers plain JSON at `/v1/tools` for scripts ("Scripting" below).

Both call the same **control service** in main (`src/main/control/service.ts`), a typed layer over the code the window's commands use (the task
service, the agent runner, the repositories). A change made through the API is the change the UI would make: same
checks, same events, so every open window updates at once.

### The HTTP endpoint

- **Port:** 45233 by default ("GLADE" on a phone keypad), changeable in Settings › Control. If it's taken, Glade tries
  the next nine and uses the first free one; Settings then shows the port in use and says it isn't the one you chose,
  since a `claude mcp add` made earlier points at the old one. If none is free, Settings shows the error.
- **Auth:** every request needs `Authorization: Bearer <token>`. The token is 32 random bytes, base64url, made the
  first time the switch goes on and kept in SQLite (never in the repo, never logged). It's compared in constant time.
  A missing or wrong token gets `401`.
- **DNS rebinding:** the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, and an `Origin` header, if
  there is one, must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. Anything else gets `403`.
- **Size:** request bodies over 1 MB get `413`. A body is read and thrown away up to 16 MB, so the client reads the
  answer; past that the connection is dropped.
- **Paths:** `POST /mcp`, `GET /v1/tools` and `POST /v1/tools/<name>`. Any other path, or a tool that isn't one, gets
  `404`; another method `405` (the endpoint is stateless, so there's no `GET /mcp` stream).
- **Order:** `Host` and `Origin`, then the token, then the path and method, then the body's size and JSON (`400` if it
  isn't JSON), then the rate limit. Nothing is said about paths before the token is right.
- **No CORS:** no `Access-Control-*` header is ever sent, so a web page can't read an answer even if it could send.
- **Rate limit:** the endpoint is one caller. Tool calls count as the control API counts them (a `rate_limited` tool
  error over MCP, `429` over `/v1`); any other request (`initialize`, `tools/list`, `GET /v1/tools`) counts as a read,
  and over the limit gets `429` with `Retry-After`. Notifications cost nothing.
- **The token, regenerated,** is refused from the next request; nothing restarts and no connection is closed. A
  refusal over MCP is JSON-RPC's error shape (`{ jsonrpc, error: { code: -32000, message }, id: null }`); over `/v1`
  it's `{ error: { code, message } }` (below).

## Calls, results and errors

Every tool returns its result as `structuredContent` and the same JSON as a text block, for clients that only read
text. A failure is a tool error (`isError: true`) whose JSON (again as `structuredContent` and as text) is
`{ "error": { "code": …, "message": … } }`, with `retryAfterMs` too for `rate_limited`:

| Code | When |
|---|---|
| `invalid_input` | The input fails its schema: the message names each field and why, e.g. `limit: Too big: expected number to be <=100` or `verbose: unknown field`. Every schema is strict: an unknown field fails it. A cursor that's expired or for another listing fails as `cursor: …`. |
| `not_found` | No such task, workspace or session. |
| `invalid_transition` | E.g. marking a done task done, or reopening an active one. |
| `forbidden` | A task stopping, deleting or messaging itself. |
| `confirm_required` | `delete_task` without `confirm: true`. |
| `rate_limited` | Too many calls; `retryAfterMs` says when to try again. |
| `disabled` | The switch is off. Checked before anything else, on every call. |
| `import_failed` | The transcript can't be imported (the message says why: no such file, no messages, no workspace for its folder, …). |
| `internal` | Something went wrong in Glade itself (logged as an error). |

A call is checked in this order: the switch, the caller's rate limit, the input, the self-guard, then the call's own
checks (`not_found`, `invalid_transition`, `confirm_required`). A tool name the server doesn't have is a protocol error
(MCP's invalid params), not a tool error.

Times are epoch milliseconds. Ids are Glade's (UUIDs), except `sessionId`, which is the SDK's.

## Scripting

An agent porting hundreds of sessions in, or anything else that would take hundreds of tool calls, is better off
writing a script. The endpoint serves the same tools as plain JSON beside `/mcp`, on the same server, behind the same
token, `Host`/`Origin` checks, body limit, rate limits and logging, and through the same control API: a call over
`/v1` is the call over MCP.

- **`GET /v1/tools`** → `{ tools: [{ name, description, inputSchema }] }`, as `tools/list` gives them. It counts as a
  read.
- **`POST /v1/tools/<name>`** with the tool's input as the JSON body (none is `{}`) → `200` and the tool's result, the
  `structuredContent` MCP gives. A failure is `{ "error": { "code", "message", "retryAfterMs"? } }` with a status that
  fits its code:

| Status | Codes |
|---|---|
| `400` | `invalid_input` (a body that isn't JSON too) |
| `401` | `unauthorized`: no token, or a wrong one (with `WWW-Authenticate: Bearer`) |
| `403` | `forbidden`, `disabled`, and a bad `Host` or `Origin` (`forbidden`) |
| `404` | `not_found`, and a path or tool that isn't one |
| `405` | `method_not_allowed` (with `Allow`) |
| `409` | `invalid_transition`, `confirm_required` |
| `413` | `too_large` |
| `422` | `import_failed` |
| `429` | `rate_limited`, with `Retry-After` in seconds and `retryAfterMs` |
| `500` | `internal` |

**Glade's own agents** get the endpoint in their environment while it listens, so a script they write and run with
Bash needs no setup: `GLADE_CONTROL_URL` (the base URL, e.g. `http://127.0.0.1:45233`) and `GLADE_CONTROL_TOKEN`. A
session gets them as it starts; with the switch off, or the endpoint not listening, they aren't set. A running session
keeps the values it started with: after **Regenerate token** its old token is refused (`401`) until the task's next
session, and after the port moves its URL is stale. The log redacts every `*_TOKEN` variable, and nothing logs them.

With `curl`:

```sh
curl -s "$GLADE_CONTROL_URL/v1/tools/list_tasks" \
  -H "Authorization: Bearer $GLADE_CONTROL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"state": "active", "limit": 10}'
```

A Node script (`node backfill.mjs`) that creates a task per item, idempotently by `externalId`, and backs off on `429`.
`externalId` and the backfill fields are P13-04's (#225); the example is written against their documented shape:

```js
const base = process.env.GLADE_CONTROL_URL
const headers = { Authorization: `Bearer ${process.env.GLADE_CONTROL_TOKEN}`, 'Content-Type': 'application/json' }

async function call(tool, input) {
  for (;;) {
    const response = await fetch(`${base}/v1/tools/${tool}`, { method: 'POST', headers, body: JSON.stringify(input) })
    const body = await response.json()
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, body.error.retryAfterMs))
      continue
    }
    if (!response.ok) throw new Error(`${tool}: ${body.error.code}: ${body.error.message}`)
    return body
  }
}

const { workspaces } = await call('list_workspaces', {})
const workspaceId = workspaces.find((workspace) => workspace.name === 'Acme API').id
const items = [{ id: 'ticket-101', title: 'Rate limit /search' }, { id: 'ticket-102', title: 'Retry-After header' }]
// A few at a time; creating one with an externalId that's already a task's returns that task.
for (let at = 0; at < items.length; at += 10) {
  await Promise.all(
    items.slice(at, at + 10).map((item) => call('create_task', { workspaceId, externalId: item.id, title: item.title })),
  )
}
```

### Types

```ts
interface WorkspaceSummary { id: string; name: string; rootPath: string; activeTasks: number; doneTasks: number }

interface TaskSummary {
  id: string; workspaceId: string
  title: string                                          // '' until the task is named
  status: string
  state: 'active' | 'done'
  activity: 'waiting' | 'working' | 'error' | 'paused'   // the status dot, with needsYou
  needsYou: boolean; pinned: boolean; unread: boolean
  updatedAt: number; doneAt: number | null
}

interface TaskDetail extends TaskSummary {
  workspace: WorkspaceSummary
  objective: string; statusUpdatedAt: number | null
  asking: boolean; awaitingPermission: boolean
  model: string; effort: 'low' | 'medium' | 'high' | 'max'
  permissionMode: 'allow_all' | 'ask_before_edits'
  contextUsedTokens: number; contextWindowTokens: number
  error: { kind: string; details: string } | null
  pause: { reason: string; resumesAt: number } | null
  queuedMessages: number; turns: number
  createdAt: number; sessionId: string | null
  importedAt: number | null   // set on a task imported from Claude Code (added with the import tools, P13-02)
}

interface ChatTurn {
  turn: number
  startedAt: number | null   // its first message's time, or its turn divider's for a turn the agent started itself
  messages: { role: 'user' | 'agent'; body: string; createdAt: number; truncated: boolean }[]
  // The agent's own calls (not its subagents'), in order: `name` as the tool log shows it (`set_status` for Glade's
  // own `mcp__glade__set_status`, other MCP tools in full), `summary` its row's one-line argument.
  toolCalls?: { name: string; summary: string; state: 'running' | 'done' | 'error' | 'paused' | 'interrupted' }[]
}
```

The enum values are the ones in `src/shared/domain.ts`; the schemas there win if this sketch drifts.

## Tools

Reads never change anything (not even a task's unread flag) and never ask for permission.

### `list_workspaces`

`{}` → `{ workspaces: WorkspaceSummary[] }`, in the switcher's order.

### `list_tasks`

```ts
{ workspaceId?: string                      // all workspaces when left out
  state?: 'active' | 'done' | 'all'         // default 'all'
  query?: string                            // full-text, over the sidebar search's index
  cursor?: string; limit?: number }         // 1–100, default 50
→ { tasks: TaskSummary[]; nextCursor: string | null }
```

Without `query`: pinned first, then by `updatedAt`, newest first. With it: by the search's ranking (the field of each
task's best match, then the most recently updated), across workspaces when there's no `workspaceId`. `query` is
trimmed and mustn't be empty.

A listing's first page fixes its order: the tasks that matched then, in the order they had then. Each `nextCursor`
continues that order, with each task as it is now, so tasks changing between pages (and moving in the sidebar) are
never listed twice or skipped. A task deleted meanwhile is left out; one created meanwhile isn't in the listing, which
a new one (without `cursor`) picks up. A cursor only continues a listing with the same `workspaceId`, `state` and
`query`, and lasts ten minutes after its last page (it's kept in memory, so a relaunch ends it too); past that it
fails as `invalid_input`, and the caller lists again.

### `get_task`

`{ id }` → `{ task: TaskDetail }`: every field the header card and the sidebar row show.

### `get_chat`

```ts
{ id: string
  fromTurn?: number          // default 1
  limit?: number             // turns per page, 1–50, default 20
  includeTools?: boolean }   // default true
→ { turns: ChatTurn[]; totalTurns: number; nextFromTurn: number | null }
```

The chat log (your messages and the agent's final replies) by turn, each turn's start time for its divider and, with
`includeTools`, its tool calls as the tool log's one-line summaries, without their input or output. A message body
over 20,000 characters is cut there, with `truncated: true`. For the last few turns, read `turns` from `get_task`
first. A `fromTurn` past the last turn gives no turns.

### `create_task`

```ts
{ workspaceId: string
  message?: string                      // the first message; sending it starts the agent
  title?: string; objective?: string    // set now, so the agent doesn't set them
  model?: string; effort?: Effort; permissionMode?: PermissionMode }   // Settings' defaults when left out
→ { task: TaskDetail }
```

Like New task, then sending the first message. Without `message` the task waits for one, as a new task in the window
does. `model` is one the input bar's picker offers (`src/shared/models.ts`). The task isn't selected in the window.

### `update_task`

```ts
{ id: string
  patch: { title?: string; objective?: string; status?: string; pinned?: boolean; unread?: boolean
           model?: string; effort?: Effort; permissionMode?: PermissionMode } }
→ { task: TaskDetail }
```

Texts are trimmed and mustn't be empty, and a patch must change at least one field. `status` is the one-line status
summary. A new `permissionMode` applies from the agent's next tool call, as the picker's does. Done and active go
through `mark_done` and `reopen_task`. A patch of only `unread` doesn't move the task in the sidebar, as marking it
read or unread there doesn't.

### `send_message`

`{ id, text }` → `{ delivery: 'sent' | 'queued' | 'answered'; task: TaskDetail }`

What the input bar does with the text: sent when the agent is idle (reopening a done task), queued while it works, a
permission card waits or the task is paused, and taken as the answer when a question card is open. Text only; no
images. The text is trimmed and mustn't be empty.

### `stop_task`, `mark_done`, `reopen_task`

`{ id }` → `{ task: TaskDetail }`. Stop is the Stop button: it interrupts the turn and withdraws an open question or
permission request, and answers once the turn has ended; an idle task is left as it is. Mark done and reopen are the
header's actions: `invalid_transition` for a task already done, or already active.

### `delete_task`

`{ id, confirm: true }` → `{ deleted: string }`. Deletes the task's rows, as Delete task… does (closing its agent's
session first, and deselecting it if it's shown); nothing on disk is touched. Without `confirm: true` it's refused with
`confirm_required`.

### `list_claude_code_sessions`

```ts
{ cwd?: string                 // only sessions started in this folder
  query?: string               // matched against the title and first prompt
  imported?: boolean           // true: only ones already in Glade; false: only ones that aren't
  cursor?: string; limit?: number }   // 1–200, default 50
→ { sessions: ClaudeCodeSession[]; nextCursor: string | null }

interface ClaudeCodeSession {
  sessionId: string; path: string; cwd: string
  title: string | null            // Claude Code's own title for it, when it has one
  firstPrompt: string             // cut to 200 characters
  startedAt: number; lastActivityAt: number
  messages: number                // your prompts plus the agent's replies
  workspaceId: string | null      // the workspace whose root is its cwd
  taskId: string | null           // the Glade task that has this session, if any
}
```

Newest first. It reads the top-level `*.jsonl` files in `~/.claude/projects/*/` (under `$CLAUDE_CONFIG_DIR` when that
is set), not subagent transcripts. A Glade task's own session is listed too, with its `taskId`: Claude Code writes
those transcripts as well. A session with no messages, or whose transcript doesn't say its folder, can't be imported
and isn't listed.

### `import_claude_code_session`

```ts
{ sessionId: string } | { path: string }   // a path must be a .jsonl under the projects folder
& { state?: 'done' | 'active'              // default 'done'
    createWorkspace?: boolean }            // default false
→ { task: TaskDetail; imported: boolean; skipped: { lines: number; images: number } }
```

See "Importing" below. `imported` is false when the session was already in Glade: importing it again returns the
existing task and changes nothing.

## Importing Claude Code sessions

Glade reads the transcript itself, line by line, each line parsed with zod and anything it doesn't know skipped.

- **Workspace:** the task goes in the workspace whose root is exactly the transcript's `cwd`. If there's none, the
  import fails, unless `createWorkspace: true`, which adds that folder as a workspace as Add workspace does (writing
  the starter `CLAUDE.md` if it has none). A `cwd` that no longer exists always fails. Sessions started in a subfolder
  of a workspace aren't moved into it: resuming them needs their own folder.
- **Title:** Claude Code's own title for the session (the one you gave it with `/rename`, else its latest `ai-title`,
  or an older `summary`), else the first line of the first prompt, cut to 80 characters. **Objective:** the first prompt, cut to 500 characters. **Status:**
  "Imported from Claude Code".
- **Chat and tool log**, as Glade would have logged them:
  - Each prompt of yours starts a turn: your message in the chat and a turn divider in the tool log, with the
    prompt's original time.
  - Per turn, the agent's last text is its final reply in the chat, with the turn's summary; its earlier texts are
    narration in the tool log. What the agent did before your first prompt is a turn with no message of yours.
  - Each tool call goes in the tool log with its input and result, done or failed as the result says; a call with no
    result is interrupted. A compaction becomes a compaction row.
  - Left out: thinking, subagents' own transcripts (their `Agent` call is still in the log), meta messages, slash
    commands and their output, interruption markers, and images (counted in `skipped.images`; a prompt that was only
    images shows as "[Image]").
- **Resumed sessions keep their system prompt** (`sdk-notes.md` §8): an imported session has Glade's tools, but not
  the lines Glade adds to its system prompt, so its agent keeps the title and status current only when asked.
- **Model:** the last one the transcript used, if Glade offers it, else Settings' default. Effort and permission mode:
  Settings' defaults.
- **State:** done by default, stamped with the last entry's time; `state: 'active'` imports it active.
- **Resuming:** the task keeps the transcript's `sessionId`, so the next message you send resumes that Claude Code
  session (the SDK's `resume`, in the same folder), with everything the model knew. Turn numbers carry on from the
  imported ones.
- **Idempotent:** a session already in Glade (imported, or a Glade task's own) isn't imported again.
- **Atomic:** the whole import is one transaction; a failure leaves nothing behind.
- A session still open in a terminal can be imported, but don't resume it in both places at once: both would append
  to the same transcript.

To port everything in, an agent pages through `list_claude_code_sessions { imported: false }` and imports each one.

## Safety

- **Loopback only**, bearer token, Host and Origin checks, body size limit (above).
- **A task can't turn on itself:** through the in-process server, a task can't stop, delete or send a message to
  itself (`forbidden`). It can read and update itself.
- **Deletes need `confirm: true`.**
- **Rate limits,** per caller (each task, and the HTTP endpoint as a whole, MCP and `/v1` together): 3,000 reads and
  1,200 changes a minute, in a sliding window, counted apart, so a script backfilling hundreds of tasks isn't held up.
  A refused call doesn't count. Imports count as changes.
- **The same name in your own config:** a Glade task's session never gets a `glade-control` server from the user's
  Claude Code config (the command above, run in the workspace, adds one); only the in-process one, so each tool is
  there once and calls as the task. See `sdk-notes.md` §12.
- **Permissions:** in a task's ask mode (P11), `glade-control` tools that change things ask like any other MCP tool
  with side effects, since the server isn't `glade`. Its reads (`list_*`, `get_*`) never ask, when the SDK says the
  server is Glade's own in-process `glade-control`. The same tools reached through a user-configured HTTP server
  ask, reads included: a server's name proves nothing (`src/main/permissions/classify.ts`).
- **Everything is logged** under the `control` scope (`logs.md`): each call's tool, caller (a task id, or `http`),
  target task, how long it took and its outcome; the endpoint starting (its port, and the one chosen when it fell
  back), stopping and failing to start; the token regenerated; and refused requests (why, the status, the method and
  path), never with the token. Message texts only at debug, cut short as
  usual.
