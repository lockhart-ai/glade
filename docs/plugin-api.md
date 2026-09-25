# Plugin API (draft)

A plugin is a small web page that Glade shows beside the terminal in the bottom bar and keeps up to date with what the
tasks and their agents are doing. Nekomata, the cat cafe in `design/screens/task-workspace.png`, is the first one.
Decided in `decisions.md` ("Plugins"); built in P12 (#66).

This is a **draft**: names and fields may change until P12-02 lands, and the schema is frozen as version 1 when P12 is
released.

## Installing

A plugin is a folder in Glade's plugins folder, `~/Library/Application Support/glade/plugins/<id>/`. Installing is
copying the folder there; removing is deleting it. Settings › Plugins lists what's there, turns each plugin on or off,
and opens the folder. Glade reads the folder when it starts and when you open Settings › Plugins.

```
plugins/
  nekomata/
    manifest.json
    index.html
    icon.svg
```

## Manifest

`manifest.json`, validated with zod. A plugin whose manifest is missing or invalid is listed in Settings with the
reason and never loads.

| Field | Type | Rule |
|---|---|---|
| `id` | string | Lowercase letters, digits and `-`, starting with a letter or digit, up to 64 characters. Must equal the folder's name. |
| `name` | string | Shown in the panel header and Settings. Not empty, up to 40 characters. |
| `version` | string | The plugin's own version, shown in Settings. Semver (`1.2.0`). |
| `entry` | string | The page to load: a path to an `.html` file inside the folder (no `..`, not absolute). |
| `icon` | string, optional | A path to an `.svg` or `.png` inside the folder, shown in the panel header and Settings. |

Unknown fields are ignored.

```json
{ "id": "nekomata", "name": "Nekomata", "version": "1.0.0", "entry": "index.html", "icon": "icon.svg" }
```

## The sandbox

The page runs in a view of its own, not in Glade's window:

- **Its own process:** an Electron `WebContentsView` with `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, and a session partition per plugin, so it shares no storage with Glade or other plugins.
- **Files:** the page and everything it loads are served from its own folder only, under the `glade-plugin://<id>/`
  scheme. A path outside the folder is refused.
- **Network:** a CSP blocks everything except the plugin's own files and localhost, and the session refuses any other
  request as well:
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data:; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*;
  frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
- **No navigation, no new windows, no permissions** (camera, notifications, …): all refused.
- **The bridge:** a preload that does two things only: forwards Glade's messages to the page as `message` events,
  and exposes `window.glade.post(message)` for the page's messages back. The page can't call anything else in Glade.

## Talking to Glade

Glade to plugin: each message arrives as a `message` event on `window`, with the envelope in `event.data`. Plugin to
Glade: `window.glade.post(message)`.

```js
window.addEventListener('message', (event) => {
  const message = event.data
  if (message?.source !== 'glade' || message.apiVersion !== 1) return
  handle(message.event)
})
window.glade.post({ type: 'ready' })
```

**Handshake.** Glade sends nothing until the page posts `ready`. It then sends `hello` and a `snapshot` of the current
state, followed by events as things change. Posting `ready` again (e.g. after the page reloads itself) starts over with
a new `hello` and `snapshot`. When a plugin is turned off, its view is destroyed; nothing is queued for it.

**Delivery.** Events arrive in order. There's no acknowledgement and no replay: a plugin that loses track posts
`ready` for a fresh snapshot.

### Envelope

```ts
interface GladeMessage {
  readonly source: 'glade'
  /** The schema version this message follows. */
  readonly apiVersion: 1
  /** Counts up from 1 with each message since the last `hello`. */
  readonly seq: number
  readonly event: PluginEvent
}
```

## Events (Glade to plugin)

`PluginEvent` is a union discriminated by `type`. Times are epoch milliseconds. Free text (titles, statuses, notes,
summaries, prompts) is cut to 200 characters.

| `type` | Fields | When |
|---|---|---|
| `hello` | `app: { name: 'Glade', version: string }` | First, after each `ready`. |
| `snapshot` | `tasks: PluginTask[]`, `subagents: PluginSubagent[]`, `questions: PluginQuestion[]`, `permissions: PluginPermissionRequest[]` | After `hello`: every active task in every workspace, their running subagents, and their open questions and permission requests. |
| `task.created` | `task: PluginTask` | A task is created. |
| `task.updated` | `task: PluginTask` | Anything in `PluginTask` changes: title, status, state (active ⇄ done), activity, needs you. |
| `task.deleted` | `taskId: string` | A task is deleted. |
| `agent.toolCall` | `call: PluginToolCall` | A tool call starts, and again when it ends. |
| `agent.note` | `taskId: string`, `subagentId: string \| null`, `text: string`, `at: number` | The agent's working notes between tool calls (the tool log's preamble). |
| `subagent.started` | `subagent: PluginSubagent` | A subagent starts. |
| `subagent.updated` | `subagent: PluginSubagent` | Its state or latest line changes. |
| `question.opened` | `question: PluginQuestion` | The agent asks (`ask`). |
| `question.closed` | `taskId: string`, `questionSetId: string`, `outcome: 'answered' \| 'withdrawn'` | The questions are answered or withdrawn. |
| `permission.opened` | `request: PluginPermissionRequest` | A tool call waits on a permission card (P11). |
| `permission.closed` | `taskId: string`, `requestId: string`, `outcome: 'allowed' \| 'denied' \| 'withdrawn'` | The card is answered or withdrawn. |

```ts
interface PluginTask {
  readonly id: string
  readonly workspaceId: string
  readonly workspaceName: string
  /** Empty until the agent names the task. */
  readonly title: string
  /** The one-line status summary; the outcome once done. Empty until the agent sets one. */
  readonly status: string
  readonly state: 'active' | 'done'
  /** What the agent is doing (`TaskActivity`). */
  readonly activity: 'waiting' | 'working' | 'error' | 'paused'
  /** Whether the task counts under Needs you. */
  readonly needsYou: boolean
  /** What the agent's turn is blocked on, if anything. */
  readonly waitingOn: 'question' | 'permission' | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly doneAt: number | null
}

interface PluginToolCall {
  /** The SDK's tool_use id. */
  readonly id: string
  readonly taskId: string
  /** Null for the task's main agent. */
  readonly subagentId: string | null
  /** The tool's display name, as the tool log shows it (`Bash`, `Edit`, `set_status`). */
  readonly tool: string
  /** The one-line summary the tool log shows: a path, a command, a pattern. */
  readonly summary: string
  readonly state: 'running' | 'done' | 'failed' | 'interrupted'
  readonly startedAt: number
  readonly endedAt: number | null
}

interface PluginSubagent {
  readonly id: string
  readonly taskId: string
  /** Its description, as the Subagents tab shows it. */
  readonly name: string
  readonly state: 'running' | 'done' | 'failed' | 'stopped'
  /** The last thing it said or did; null before it does anything. */
  readonly latest: string | null
  readonly startedAt: number
  readonly endedAt: number | null
}

interface PluginQuestion {
  readonly taskId: string
  readonly questionSetId: string
  /** Each question's prompt, in order. */
  readonly prompts: readonly string[]
  readonly openedAt: number
}

interface PluginPermissionRequest {
  readonly taskId: string
  readonly requestId: string
  readonly subagentId: string | null
  readonly tool: string
  readonly summary: string
  readonly openedAt: number
}
```

**Not sent:** chat messages and final replies, file contents, full tool inputs and results, settings, and anything
about the machine. A plugin sees what the task list, tool log and Subagents tab summarise, and no more.

## Messages (plugin to Glade)

| `type` | Fields | Effect |
|---|---|---|
| `ready` | none | Asks for `hello` and a `snapshot`. |
| `status` | `text: string` | Sets the short status at the right of the panel header (Nekomata's "5 cats · 4 kittens"), up to 40 characters; `''` clears it. |

Anything else, or a message that fails its schema, is dropped and logged. A plugin can't open tasks, send messages or
change anything in Glade.

## Versioning

- Every message carries `apiVersion`. This document is version **1**.
- **Additive changes keep the version:** a new event type, or a new field on an existing one. Plugins must ignore
  event types and fields they don't know.
- **Breaking changes bump it:** removing or renaming an event or field, or changing what one means. Glade speaks one
  version at a time; the change is listed in the release notes.

## Nekomata

Nekomata's Glade build (P12-05) keeps its scene and swaps its data source: instead of fetching `/data` from its Python
server, which reads Claude Code's transcripts, it builds the same session list from these events. A task is a cat, a
subagent a kitten, `waitingOn` raises a paw, `agent.toolCall` and `agent.note` fill the speech bubbles, and a task
leaving the snapshot (done or deleted) is carried out. The room's CPU, GPU and Docker readings have no source in Glade
and stay empty.
