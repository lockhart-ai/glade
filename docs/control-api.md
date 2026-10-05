# Control API

Glade can be driven by other agents: a chat in Claude Code, a script, or one of Glade's own tasks can list, read,
create and change tasks, and port past Claude Code sessions in as tasks. It's one MCP server, **`glade-control`**,
served two ways, and the same tools as plain JSON for scripts. Decided in [`decisions.md`](decisions.md) ("Programmatic
control"); built in P13 (#219) and released in v0.12.0, which froze its names and schemas.

**To connect:** turn on Settings › Control › **Let agents control Glade**, copy the `claude mcp add …` command it
shows, and run it ("Turning it on"). A script uses the same endpoint's `/v1/tools` with the same token ("Scripting").

## Turning it on

Settings › Control ([`21-settings-control.png`](design/screens/21-settings-control.png)) has one switch, **Let
agents control Glade**, off by default. While it's off, nothing is served: the endpoint isn't listening and new
sessions don't get the tools. A session started while it was on keeps the tools, but every call is refused with
`disabled` once it's off.

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
| `invalid_input` | The input fails its schema: the message names each field and why, e.g. `limit: Too big: expected number to be <=100` or `verbose: unknown field`. Every schema is strict: an unknown field fails it. A cursor that's expired or for another listing fails as `cursor: …`, an artifact that isn't a file of the workspace as `artifacts.0.path: …`, and a link that can't be one as `artifacts.0.url: …`. |
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

Times Glade answers with are epoch milliseconds. Ids are Glade's (UUIDs), except `sessionId`, which is the SDK's.

## Dates

The dates the API takes (`create_task`'s `startedAt`, `updatedAt` and `statusUpdatedAt`, and `update_task`'s
`updatedAt` and `statusUpdatedAt`) are ISO 8601 strings, all read the same way (`src/main/control/dates.ts`):

| Given | Means |
|---|---|
| A date and time with its offset: `2026-09-25T09:00:00+01:00`, `2026-09-25T08:00:00Z`, `2026-09-25T08:00:00.250Z` | That instant, exactly, wherever Glade runs. |
| A date alone: `2026-09-25` | That day where Glade runs: **noon, local time**, so it's that day whatever the time zone, never the day before or after. For today, before noon, it's now. |
| A date and time without an offset (`2026-09-25T09:00:00`), anything else, or a number | Refused: `invalid_input`, e.g. `startedAt: must be an ISO 8601 date (2026-09-25) or a date and time with its offset (2026-09-25T09:00:00+01:00, or Z)`. |

A date in the future is refused (`startedAt: 2026-09-26 is in the future`), as is one that isn't a day of its month
(`2026-02-30`). So, where Glade runs in Toronto (UTC−4 in September), `"2026-09-25"` is `2026-09-25T16:00:00Z`, and in
Tokyo it's `2026-09-25T03:00:00Z`: the Sep 25 the sidebar shows either way. To mean a time of day, give it with its
offset.

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
**With the agent sandbox on, a sandboxed command doesn't get them** (#514): a script that calls the endpoint has to
run outside the sandbox, which asks you each time. The agent's own `glade-control` tools need neither.

With `curl`:

```sh
curl -s "$GLADE_CONTROL_URL/v1/tools/list_tasks" \
  -H "Authorization: Bearer $GLADE_CONTROL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"state": "active", "limit": 10}'
```

A Node script (`node backfill.mjs`) that backfills a done task per notes folder, idempotently by `externalId` (see
"Backfilling past tasks"), and backs off on `429`. A refused call (`400` for `invalid_input`, e.g. an artifact that
isn't a file of the workspace) throws with the error's message:

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
const root = '/Users/sample/code/api'
// Dates alone mean that day, local time ("Dates").
const folders = [
  { folder: 'notes/rate-limits', title: 'Rate limit /search', status: 'Shipped behind a flag.', started: '2026-03-12', updated: '2026-03-19', handoff: '### Next\n\nAdd the Retry-After header.' },
  { folder: 'notes/billing-webhooks', title: 'Migrate billing webhooks to v2', status: 'Invoices on v2; subscriptions next.', started: '2026-04-02', updated: '2026-04-21', handoff: '### Next\n\nMap subscription.*.' },
]
// A few at a time; a folder already backfilled returns its task with created: false.
for (let at = 0; at < folders.length; at += 10) {
  const results = await Promise.all(
    folders.slice(at, at + 10).map(({ folder, title, status, started, updated, handoff }) =>
      call('create_task', {
        workspaceId,
        externalId: folder,
        title,
        status,
        handoff,
        artifacts: [{ path: `${root}/${folder}/notes.md`, title: 'Notes' }],
        startedAt: started,
        updatedAt: updated,
        state: 'done',
      }),
    ),
  )
  for (const { task, created } of results) console.log(created ? 'backfilled' : 'already there', task.title)
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
  activity: 'waiting' | 'working' | 'error' | 'paused'   // what the agent's own turn is doing
  // needsYou: asking, awaiting permission, stopped on an error, or its turn ended with a reply that's unread, even
  // while subagents or watchers it left running still run (#461); false once the reply is read
  needsYou: boolean; pinned: boolean; unread: boolean
  updatedAt: number; doneAt: number | null
}

interface TaskDetail extends TaskSummary {
  workspace: WorkspaceSummary
  objective: string; statusUpdatedAt: number | null
  asking: boolean; awaitingPermission: boolean
  model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  permissionMode: 'allow_all' | 'ask_before_edits'
  contextUsedTokens: number; contextWindowTokens: number
  error: { kind: 'transient' | 'permanent' | 'logged_out' | 'usage_limit' | 'offline' | 'safety_refusal'; details: string } | null
  pause: { reason: 'usage_limit' | 'offline'; resumesAt: number } | null
  queuedMessages: number; turns: number
  createdAt: number; sessionId: string | null
  handoff: { body: string; addedAt: number } | null        // its handoff note, from a backfill (P13-04)
  artifacts: ({ kind: 'file'; path: string; title: string; addedAt: number }    // the Artifacts tab: files by absolute path,
             | { kind: 'link'; url: string; title: string; addedAt: number })[]   // links (PRs, issues, tickets) by URL (#407)
  externalId: string | null            // its externalId, as create_task gave it or update_task last changed it
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
  status?: string                       // its one-line status, e.g. a past task's outcome
  model?: string; effort?: Effort; permissionMode?: PermissionMode    // Settings' defaults when left out
  // Backfilling a past task (see "Backfilling past tasks"); dates as "Dates" says:
  handoff?: string                      // its handoff note, Markdown, at most 32 KB of UTF-8
  artifacts?: ({ path: string; title?: string }    // files of the workspace, by absolute path; title: the file name
               | { url: string; title?: string })[]   // or links (#407); title: #412, API-123 or the address
  startedAt?: string                    // when it started (createdAt); now by default
  updatedAt?: string                    // when it was last updated: its place in the sidebar; see below
  statusUpdatedAt?: string              // when its status was set; needs status; updatedAt by default
  state?: 'active' | 'done'             // default 'active'; 'done' takes no message
  externalId?: string }                 // your own id for it, e.g. the notes folder
→ { task: TaskDetail; created: boolean }
```

Like New task, then sending the first message. Without `message` the task waits for one, as a new task in the window
does. `model` is one the input bar's model picker offers, by the id the SDK takes (an alias such as `sonnet`, or the
full id it stands for, such as `claude-sonnet-5`, or an enabled `openrouter:<model>@<provider>` pair); any other is `invalid_input`, listing the ones offered. An `effort`
the model doesn't support falls back to its default (High, where it has it), as the picker's does. The task isn't
selected in the window.
`created` is false only when a task already has the `externalId`: that task is returned as it is, and nothing changes
(not its dates either).

**Its dates.** A task has three: when it started (`createdAt`, the header's "started Mar 12"), when it was last updated
(`updatedAt`, which orders the sidebar and gives each row its relative time) and when its status was set
(`statusUpdatedAt`, the age next to the status in the header). Given explicitly, each is what you give; left out:

| Field | Left out, it's |
|---|---|
| `startedAt` | now |
| `updatedAt` | `statusUpdatedAt` if given, else `startedAt` |
| `statusUpdatedAt` | `updatedAt`, when there's a `status`; none without one |

They must come in that order, `startedAt` ≤ `statusUpdatedAt` ≤ `updatedAt`, none of them in the future, and
`statusUpdatedAt` needs a `status`: otherwise the call is `invalid_input`, naming the field (`updatedAt: 2026-03-11 is
before the task started (2026-03-12T09:00:00.000Z)`, `statusUpdatedAt: needs a status`). A task created done is done
at its `updatedAt`, which is its `startedAt` unless you give one, so it sits in the Done section at that date.

```json
{ "workspaceId": "0b6f7c2e-5a41-4d3e-9c8a-1f2e3d4c5b6a",
  "title": "Rate limit /search",
  "status": "Shipped behind a flag; the Retry-After header is next.",
  "startedAt": "2026-03-12",
  "updatedAt": "2026-03-19T17:40:00-04:00",
  "state": "done",
  "externalId": "notes/rate-limits" }
```

→ started Mar 12 at local noon; last updated, status set and done at `2026-03-19T21:40:00Z`, where the Done section
places it.

### `update_task`

```ts
{ id: string
  patch: { title?: string; objective?: string; status?: string; pinned?: boolean; unread?: boolean
           model?: string; effort?: Effort; permissionMode?: PermissionMode
           handoff?: string | null                          // a new handoff note; null clears it
           artifacts?: ({ path: string; title?: string } | { url: string; title?: string })[]   // more artifacts
           externalId?: string                              // a new externalId for it
           updatedAt?: string                               // when it was last updated, given rather than now
           statusUpdatedAt?: string                         // when its status was set, given rather than now
           updateArtifacts?: ({ path: string; title?: string; newPath?: string }   // rename or repoint (#385)
                             | { url: string; title?: string; newUrl?: string })[]  // a link the same way (#407)
           removeArtifacts?: string[] } }   // take off: files by absolute path (the files stay), links by URL
→ { task: TaskDetail }
```

Texts are trimmed and mustn't be empty, and a patch must change at least one field. `status` is the one-line status
summary. A new `permissionMode` applies from the agent's next tool call, as the picker's does. A new `model` is checked
as `create_task` checks it, and keeps the task's effort only if it supports it: otherwise the task takes the model's
default. Done and active go through `mark_done` and `reopen_task`. A new handoff note reaches the agent from its next
session (the next message after its current one ends, or a relaunch).

**Its place in the sidebar.** The sidebar's sections (and `list_tasks`) put the most recently updated task first, so a
patch that stamps the task's `updatedAt` with now moves it to the top of its section, with "now" as its relative time.
What each field does, alone:

| Field | The task's place |
|---|---|
| `title` | Moves to the top of its section |
| `objective` | Moves to the top |
| `status` | Moves to the top (and its status is dated now, if it's a new status) |
| `pinned` | Moves to the top, and into Pinned (or out of it) |
| `unread` | Keeps it, as marking a task read or unread in the window does |
| `model` | Moves to the top |
| `effort` | Moves to the top |
| `permissionMode` | Moves to the top |
| `handoff` | Keeps it, so a backfilled task keeps its date |
| `artifacts` | Keeps it |
| `updateArtifacts` | Keeps it |
| `removeArtifacts` | Keeps it |
| `externalId` | Keeps it |
| `updatedAt` | Sets it: the task goes where that date puts it |
| `statusUpdatedAt` | Keeps it: only the status's date changes |

A patch with several fields moves the task if any of them does, and a field set to the value it already has still
counts (a `title` patch with the same title moves the task). **Explicit dates win:** with `updatedAt`, the task is dated
then whatever else the patch changes, and a new `status` given with it is dated then too (unless the patch gives
`statusUpdatedAt`). Without it, a `status` is set now, and the task moves to the top, as it always did. `update_task`
never changes when a task was done (`doneAt`), nor when it started.

The dates are read as "Dates" says. Neither may be in the future or before the task started; `statusUpdatedAt` needs a
task with a status (one it has, or the one the patch gives), and can't be after an `updatedAt` given with it. A refused
patch changes nothing.

`externalId` replaces the task's own id for itself (or gives it one, if it was created without); `create_task` finds it
by the new id from then on, and the old one is free. An id another task has is refused, naming that task:
`patch.externalId: another task (7d3c…) already has notes/done/rate-limits`.

For example, a status that was set after a backfill, dated when it really was, so the task stays where it was:

```json
{ "id": "5e1a…", "patch": { "status": "Shipped behind a flag.", "updatedAt": "2026-03-19T17:40:00-04:00" } }
```

A notes folder that moved to `notes/done/`, and a date put right without touching anything else:

```json
{ "id": "5e1a…", "patch": { "externalId": "notes/done/rate-limits" } }
{ "id": "5e1a…", "patch": { "updatedAt": "2026-03-19" } }
```

The three artifact fields are the control API's side of the agent's `add_artifact`, `update_artifact` and
`remove_artifact` ([`model-surface.md`](model-surface.md)). They apply `removeArtifacts` first, then
`updateArtifacts`, one after another, then `artifacts`, each against the list the ones before leave (so a removal
frees its path for a change to take). `artifacts` adds, or renames one given again (its title the file name
when left out), as before. Each of `updateArtifacts` names an artifact by its absolute `path` (its file needn't still be
there) and gives a new `title`, a `newPath` (an absolute path to a file inside the workspace, checked as `artifacts`
checks one, that isn't another of its artifacts), or both; it keeps its place in the Artifacts tab. `removeArtifacts`
takes artifacts off by absolute path, leaving their files. Anything it can't do fails the whole call as
`invalid_input`, naming the field, e.g. `patch.removeArtifacts.0: notes/draft.md isn't one of the task's artifacts`,
`patch.updateArtifacts.0.newPath: … is already one of the task's artifacts` or `patch.updateArtifacts.0: changes
nothing`, and nothing changes, the task's other fields included. The windows get one `artifacts.changed` with the
task's whole list.

**Todos (behind the hidden `todoHubEnabled` setting, P16, #495).** With the todo hub on, an artifact can be filed under
one of its task's todos ([`model-surface.md`](model-surface.md)). The control API names no todo: an artifact added
through it is under no todo ("Not under a todo") until the task's agent files it. One it takes off leaves no filing,
and one it points at another file or page keeps its todo, as with the agent's own tools.

**Links (#407).** Each of the three takes links too, as the agent's tools do: `artifacts` an item with a `url` in
place of a `path` (one or the other: both, or neither, is `give a path (a file) or a url (a link), not both`), its
title `#412` for a GitHub PR or issue, `API-123` for a Jira ticket, or the address without its scheme when left out;
`updateArtifacts` an item that names a link by its `url` and gives a new `title`, a `newUrl`, or both (a file takes a
`newPath` and a link a `newUrl`, never the other way about); `removeArtifacts` a link's URL among the absolute paths.
A URL must be a whole `http:` or `https:` one, with no user name or password and at most 2048 characters, or it's
refused as `invalid_input`, e.g. `patch.artifacts.0.url: must be an http or https address`. Each is kept and matched
as the URL parser writes it out (the scheme and host lower-cased), so the same page given twice is one artifact.
`TaskDetail.artifacts` gives each artifact's `kind`, `file` or `link`.

### `send_message`

`{ id, text }` → `{ delivery: 'sent' | 'queued' | 'answered'; task: TaskDetail }`

What the input bar does with the text: sent when the agent is idle (reopening a done task), queued while it works, a
permission card waits or the task is paused, and taken as the answer when a question card is open. Text only; no
images. The text is trimmed and mustn't be empty.

### `stop_task`, `mark_done`, `reopen_task`

`{ id }` → `{ task: TaskDetail }`. Stop is the Stop button: it interrupts the turn and withdraws an open question or
permission request, and answers once the turn has ended; an idle task is left as it is. If the task has messages
queued, they're sent as its next turn as soon as the stopped one ends, so the task comes back working. Mark done and reopen are the
header's actions: `invalid_transition` for a task already done, or already active.

### `delete_task`

`{ id, confirm: true }` → `{ deleted: string }`. Deletes the task's rows, as Delete task… does (closing its agent's
session first, and deselecting it if it's shown); nothing on disk is touched. Without `confirm: true` it's refused with
`confirm_required`.

### `list_claude_code_sessions`

```ts
{ cwd?: string                 // only sessions started in this folder, by absolute path
  query?: string               // matched, ignoring case, against the title and first prompt
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

Newest first (by `lastActivityAt`, then `sessionId`). It reads the top-level `*.jsonl` files in `~/.claude/projects/*/`
(`$CLAUDE_CONFIG_DIR/projects/*/` when that is set), not subagent transcripts. A Glade task's own session is listed
too, with its `taskId`: Claude Code writes those transcripts as well. A session with no messages, or whose transcript
doesn't say its folder, can't be imported and isn't listed; nor is one whose transcript can't be read.

Unlike `list_tasks`', this cursor is where the last page ended, not a listing kept in memory: it never expires, but a
session with new activity between pages moves ahead of it, so the pages after it leave that session out. A cursor
Glade didn't make isn't refused: the listing starts from the top.

### `import_claude_code_session`

```ts
{ sessionId: string } | { path: string }   // one or the other; a path must be a .jsonl in a project's folder
                                           // (directly: <projects>/<folder>/<sessionId>.jsonl)
& { state?: 'done' | 'active'              // default 'done'
    createWorkspace?: boolean }            // default false
→ { task: TaskDetail; imported: boolean; skipped: { lines: number; images: number } }
```

See "Importing" below. `imported` is false when the session was already in Glade: importing it again returns the
existing task and changes nothing.

## Backfilling past tasks

Past work kept outside Glade (a folder of notes per task, from another editor or tool) can be brought in as tasks, so
any of them can be opened later and picked up where it was left. The agent doing the backfill reads each notes folder
and makes one task from it with `create_task`, giving it:

- a **handoff note** (`handoff`): Markdown saying what the task was, where it got to, the decisions made, what's next,
  and where its notes, artifacts and history are (paths). At most 32 KB of UTF-8; a longer one is refused.
- its **artifacts** (`artifacts`): files of the workspace to show in its Artifacts tab, by absolute path. Each must be a
  file inside the task's workspace (a relative path, a missing file, a folder or a file outside the workspace is
  refused as `invalid_input`, naming it, e.g. `artifacts.1.path: There's no file at …`), and the whole call with it:
  nothing is created. The PRs, issues and tickets it was about can go in too, by `url` (#407, `update_task`).
- its **status** (`status`): the one-line status, e.g. its outcome, which a done task keeps.
- when it **started** (`startedAt`): its created time, which dates it ("started Mar 12"). A date alone is that day,
  local time ("Dates"); a time to come is refused.
- when it was **last updated** (`updatedAt`), e.g. the last date in its notes: its place in the sidebar and its
  relative time there, and the date its status is given. Left out, it's `startedAt`. Give the true date here, rather
  than setting the status with `update_task` afterwards, which dates the task now unless that patch gives `updatedAt`
  too.
- **done** (`state: 'done'`): done at `updatedAt` (so `startedAt`, if it gives none), so it sits in the Done section at
  its date. A done task takes no first message; sending it one later reopens it, as for any done task.
- its **external id** (`externalId`), e.g. the notes folder's path: a second `create_task` with the same id returns the
  task it made, with `created: false`, and changes nothing, so a backfill can be run again, or resumed after it stopped,
  without making duplicates.

A backfilled task never starts its agent by itself: only a `message` given with an active one, or one sent to it
later, does. `update_task` sets, replaces or clears (`null`) the handoff note and adds, changes or removes artifacts;
`get_task` returns both. It also sets the status and puts the dates right (`updatedAt`, `statusUpdatedAt`), and
changes the external id, e.g. when a task's notes folder moves (`externalId`): see `update_task` for which of these
keep the task's place in the sidebar. The window never changes the note.

**What the user sees:** a **Backfilled** card at the top of the task's chat ([`25-backfilled.html`](design/html/25-backfilled.html)), with the
handoff note rendered as Markdown (raw HTML dropped, nothing loaded, links not followed) and the date it was added. It
starts open, and its line closes and opens it.

**What the agent gets:** a session Glade starts for the task has the handoff note at the end of its system prompt, under
"Handoff for this task (backfilled from earlier notes)", with a line saying the paths it names are real and it can read
them. It's in the prompt, not the chat, so a compaction never loses it, and the session keeps it when it's resumed.
But Claude Code keeps the prompt a session started with when it resumes one ([`sdk-notes.md` §8](sdk-notes.md#8-resume-verified)), so a session that
started without the note, or with an older one (the note was set or changed with `update_task` after the task had a
session), is sent it once, as a block ahead of the next message Glade sends it:

```
[Glade: handoff for this task]
## Handoff for this task (backfilled from earlier notes)
…
[end]

Let's pick this up.
```

The chat shows only your message. What each task's session has been given is kept in SQLite, so the block goes exactly
once per version of the note, across relaunches. A cleared note sends nothing. A task without a note gets none of
this.

### Example: one notes folder

A notes folder `~/code/api/notes/billing-webhooks/` holds `notes.md`, `decisions.md` and `log.md`, in the Acme API
workspace (root `~/code/api`). The backfilling agent reads them, then calls:

```json
{ "name": "create_task",
  "arguments": {
    "workspaceId": "0b6f7c2e-5a41-4d3e-9c8a-1f2e3d4c5b6a",
    "title": "Migrate billing webhooks to v2",
    "objective": "Move the billing webhook handlers from the v1 events API to v2, then retire the v1 endpoint.",
    "handoff": "### Where it got to\n\nThe `invoice.*` and `customer.*` handlers are on v2 and live. `subscription.*` still goes through v1.\n\n### Decisions\n\n- Keep the v1 endpoint until subscriptions move over.\n\n### Next\n\nWrite the `subscription.*` mapping, then turn v1 off.\n\n### Where things are\n\nNotes in `/Users/sample/code/api/notes/billing-webhooks/`; the old session log in `log.md` there.",
    "artifacts": [
      { "path": "/Users/sample/code/api/notes/billing-webhooks/notes.md", "title": "Migration notes" },
      { "path": "/Users/sample/code/api/notes/billing-webhooks/decisions.md", "title": "Decisions" }
    ],
    "status": "invoice.* and customer.* on v2; subscription.* next.",
    "startedAt": "2026-03-12T09:00:00+01:00",
    "updatedAt": "2026-04-21T18:30:00+02:00",
    "state": "done",
    "externalId": "notes/billing-webhooks" } }
```

→ `{ "task": { "id": "…", "state": "done", "createdAt": 1773302400000, "updatedAt": 1776789000000,
"statusUpdatedAt": 1776789000000, "doneAt": 1776789000000, "handoff": { "body": "…", "addedAt": … }, "artifacts": [ … ],
"externalId": "notes/billing-webhooks", … }, "created": true }`

It repeats that for each folder (`list_workspaces` first, for the workspace's id). Run again, each call answers
`"created": false` with the task already there. Later, the user opens the task, reads the card, and sends "Let's pick
this up.": the task reopens, and its agent starts with the handoff note in its prompt.

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
- **Resumed sessions keep their system prompt** ([`sdk-notes.md` §8](sdk-notes.md#8-resume-verified)): an imported session has Glade's tools, but not
  the lines Glade adds to its system prompt, so its agent keeps the title and status current only when asked.
- **Model:** the last one the transcript used, if Glade offers it (the same model under an alias counts, dated or not),
  else Settings' default. Effort and permission mode: Settings' defaults, the effort fitted to the model.
- **State:** done by default, stamped with the last entry's time; `state: 'active'` imports it active.
- **Resuming:** the task keeps the transcript's `sessionId`, so the next message you send resumes that Claude Code
  session (the SDK's `resume`, in the same folder), with everything the model knew. Turn numbers carry on from the
  imported ones. A resumed session keeps the system prompt it started with ([`sdk-notes.md` §8](sdk-notes.md#8-resume-verified)), which isn't Glade's,
  so that first message goes after a block with Glade's prompt (`[Glade: instructions for this session] … [end]`),
  once; the chat shows only your message.
- **Idempotent:** a session already in Glade (imported, or a Glade task's own) isn't imported again.
- **Atomic:** the whole import is one transaction; a failure leaves nothing behind.
- A session still open in a terminal can be imported, but don't resume it in both places at once: both would append
  to the same transcript.

To port everything in, an agent pages through `list_claude_code_sessions { imported: false }` and imports each one.

## Safety

- **Loopback only**, bearer token, Host and Origin checks, body size limit (above).
- **A task can't turn on itself:** through the in-process server, a task can't stop, delete or send a message to
  itself (`forbidden`). It can read and update itself.
- **No subagent of a task can call it either**, any of its tools, reads included: Glade refuses the call before it
  dispatches (`docs/model-surface.md`, "Main agent only", #366). Without that, a subagent would inherit the whole
  in-process server, the same as the main agent, since it isn't given a restricted tool set of its own.
- **Deletes need `confirm: true`.**
- **Rate limits,** per caller (each task, and the HTTP endpoint as a whole, MCP and `/v1` together): 3,000 reads and
  1,200 changes a minute, in a sliding window, counted apart, so a script backfilling hundreds of tasks isn't held up.
  A refused call doesn't count. Imports count as changes.
- **The same name in your own config:** a Glade task's session never gets a `glade-control` server from the user's
  Claude Code config (the command above, run in the workspace, adds one); only the in-process one, so each tool is
  there once and calls as the task. See [`sdk-notes.md` §12](sdk-notes.md#12-two-mcp-servers-with-one-name-verified).
- **Permissions:** in a task's ask mode (P11), `glade-control` tools that change things ask like any other MCP tool
  with side effects, since the server isn't `glade`. Its reads (`list_*`, `get_*`) never ask, when the SDK says the
  server is Glade's own in-process `glade-control`. The same tools reached through a user-configured HTTP server
  ask, reads included: a server's name proves nothing (`src/main/permissions/classify.ts`).
- **Everything is logged** under the `control` scope ([`logs.md`](logs.md#scopes)): each call's tool, caller (a task id, or `http`),
  target task, how long it took and its outcome; the endpoint starting (its port, and the one chosen when it fell
  back), stopping and failing to start; the token regenerated; and refused requests (why, the status, the method and
  path), never with the token. Message texts only at debug, cut short as
  usual.

## OpenRouter selections

`create_task.model` and `update_task.patch.model` accept enabled `openrouter:<model>@<provider>` selections curated
in Settings › Models. Providers and credentials are configured through Settings, not overridden in task input.
A change involving OpenRouter restarts the SDK at a safe turn boundary with saved context; active turns, questions,
permissions and background work must be resolved first. Initialization failure keeps the original selection.
The task retains chat, tool results and queued input, and records the applied model change in its Tool calls history.
Independent tasks may use different sources. Native SDK children remain within their parent's billing source.
