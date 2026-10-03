# Plugin API

A plugin is a small web page that Glade shows beside the terminal in the bottom bar and keeps up to date with what the
tasks and their agents are doing. Nekomata, the cat cafe in [`task-workspace.png`](design/screens/task-workspace.png), is the first one.
Decided in [`decisions.md`](decisions.md) ("Plugins"); built in P12 (#66).

This is **version 1**, built in P12-02 and P12-04 and frozen since P12 was released (v0.11.0): it changes only as
"Versioning" below allows. The types are in `src/shared/plugin-api.ts`,
which imports nothing, and their zod schemas in `src/shared/plugin-api-schema.ts`: a plugin can copy both.

## Installing

A plugin is a folder in Glade's plugins folder, `~/Library/Application Support/glade/plugins/<id>/`. Installing is
copying the folder there; removing is deleting it. Settings › Plugins lists what's there, turns each plugin on or off
(and each capability it asks for, and sets each setting it declares, below), and opens the folder. Glade reads the folder when it starts and when you
open Settings › Plugins.

**Reinstalling.** Copying a new build over a plugin that's running (shown beside the terminal) doesn't need a
restart: the next time Glade reads the folder (opening Settings › Plugins), a plugin whose manifest version or entry
file changed since is reloaded automatically, keeping its place in the bottom bar and its saved panel width. Each
plugin's row also has a **Reload** button, beside its toggle, that reloads its view right away without reading the
folder again — handy while you're iterating on a build and don't want to wait for a rescan. Reloading starts the
handshake over: the page's `ready` posts a fresh `hello` and `snapshot`, as it does whenever the page loads.

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
| `capabilities` | string[], optional | What the plugin asks to see beyond the task and agent events: `"machine"` (see "Capabilities"). Each is off until you turn it on. One this Glade doesn't know is ignored. |
| `settings` | object[], optional | Settings of the plugin's own that you set in Settings › Plugins and Glade hands to the page (see "Settings"). Up to 8. One of a `type` this Glade doesn't know is ignored. |

Unknown fields are ignored.

```json
{ "id": "nekomata", "name": "Nekomata", "version": "1.0.0", "entry": "index.html", "icon": "icon.svg", "capabilities": ["machine"] }
```

## Settings

A plugin can declare settings of its own in its manifest's `settings`. Settings › Plugins shows each one under the
plugin's row, beside its capability switches; what you choose is saved in SQLite, per plugin, and Glade hands the
values to the page. There's one kind so far, `select`: a choice from a fixed list.

```json
{
  "id": "sketchpad", "name": "Sketchpad", "version": "1.1.0", "entry": "index.html",
  "settings": [
    {
      "key": "style",
      "label": "Art style",
      "type": "select",
      "options": [
        { "value": "8bit", "label": "8-bit" },
        { "value": "16bit", "label": "16-bit" },
        { "value": "32bit", "label": "32-bit" }
      ],
      "default": "8bit"
    }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `key` | string | The setting's name in the `settings` the page is handed. The characters an `id` has (lowercase letters, digits and `-`, starting with a letter or digit, up to 64), and unique within the plugin. |
| `label` | string | What Settings › Plugins calls it. Not empty, up to 40 characters. |
| `type` | string | `"select"`. A setting of a type this Glade doesn't know is ignored (not shown, and not sent), as an unknown capability is; it still needs a `key`, unique like the others, and counts towards the 8. |
| `options` | object[] | For `select`: 1 to 12 choices, each `{ "value", "label" }`. `value` has the characters a `key` has, each once; `label` is not empty, up to 40 characters. |
| `default` | string | For `select`: the value chosen until you choose another. One of the options' values. |

Anything else is an invalid manifest, listed in Settings with the reason like any other: a duplicate `key`, a `default`
that isn't one of the options, more than 8 settings or 12 options.

**In Settings › Plugins,** each setting is a row under its plugin with the `label` and a select showing the chosen
option's label, starting at the `default`. Choosing another saves at once. The choice survives restarts, turning the
plugin off, and updating or reinstalling it. A saved value that an update no longer offers reads as the new `default`
(what was saved is kept, so it's back if a later build offers it again).

**What the page gets.** A `settings` object, each declared setting's `key` to its value, always with every declared
setting present (the saved value, or the default):

- on every `snapshot`: `settings: { "style": "16bit" }`;
- and in a `settings.changed` event, with the whole object again, when you change one while the page is running. The
  page is **not** reloaded and gets no new `snapshot`: it applies the change in place. (A capability switch, by
  contrast, reloads the plugin.)

A plugin whose manifest declares no `settings` (or only ones of types this Glade ignores) gets no `settings` field and
no `settings.changed`: exactly what it got before. A Glade older than this sends neither, so read a missing `settings`
as your defaults. A plugin gets only the settings it declared itself: nothing of Glade's own settings, and nothing of
another plugin's.

```js
let style = '8bit'
function handle(event) {
  if (event.type === 'snapshot' || event.type === 'settings.changed') {
    style = event.settings?.style ?? '8bit'
  }
}
```

## Capabilities

Every plugin gets the task and agent events below. A capability is something more that a plugin asks for in its
manifest's `capabilities`, and that you turn on, per plugin, in Settings › Plugins: a switch under the plugin's row,
**off until you turn it on**, whose state is saved in SQLite. Turning one on or off reloads the plugin if it's showing,
so its next `snapshot` has what it may now see, and nothing it no longer may. A capability the manifest doesn't ask
for can't be turned on, and one it stops asking for is off until it asks again.

There's one so far:

**`machine`: "Can see your Mac's CPU, GPU and Docker load."** A plugin with it on gets a `machine.reading` event about
every 2 s while it's showing beside the terminal, and the latest readings (up to the last 60) in its `snapshot`'s
`machine`. Glade samples only while such a plugin is on, showing (not hidden by a collapsed bottom bar) and has said
`ready`, and stops the moment none is. A plugin with it off, or that doesn't ask for it, gets nothing new: no
`machine` in its snapshot and no readings.

- **CPU:** `ps -Ao pid,ppid,pcpu,args`, in main. `total` is every process's `%CPU`, in cores; `claude` is Claude
  Code's share: every process whose command's first word is `claude` (a path or not) and everything under it, each
  counted once — Glade's own tasks and Claude Code in your terminals alike. `cpuCount` is the Mac's logical cores.
- **GPU:** the busiest GPU's `"Device Utilization %"` from `ioreg -r -d 1 -w0 -c IOAccelerator`, which needs no
  elevated rights; null when there's none to read.
- **Docker:** `docker stats --no-stream`, with a timeout, run in your login shell's environment so its PATH finds
  `docker`: each running container's name, CPU and the memory it uses, busiest first; `docker` is their CPU summed, in
  cores. With Docker not installed or not running there are no containers. Glade never starts Docker.

**The privacy line.** A reading holds the coarse numbers above and the containers' names, nothing more: never a
process's name, command, arguments, path or user, nor a container's id, image, command, ports or status. Commands are
read in main only to tell which processes are Claude's, and never leave it.

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

The `hello` is `seq` 1 and the snapshot `seq` 2; each change after it counts on from 3. A change that happens while
the snapshot is read is in the snapshot or follows it, never both and never neither.

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
names, summaries, prompts, workspace names) is cut to 200 characters (UTF-16 code units, never through a character).
Events cover the tasks in every workspace, not only the one the window shows.

| `type` | Fields | When |
|---|---|---|
| `hello` | `app: { name: 'Glade', version: string }` | First, after each `ready`. |
| `snapshot` | `tasks: PluginTask[]`, `subagents: PluginSubagent[]`, `questions: PluginQuestion[]`, `permissions: PluginPermissionRequest[]`, only with the `machine` capability on, `machine?: PluginMachineReading[]`, and only for a plugin that declares settings, `settings?: Record<string, string>` | After `hello`: every active task in every workspace (not done ones, pinned or not), their running subagents, and their open questions and permission requests; the latest machine readings, oldest first, up to 60 (empty before the first); and the plugin's own settings, key to value ("Settings"). |
| `task.created` | `task: PluginTask` | A task is created. |
| `task.updated` | `task: PluginTask` | Anything in `PluginTask` changes: title, status, state (active ⇄ done), activity, needs you, what it waits on, how many watchers it has running, its workspace's name. `updatedAt` alone changing doesn't send one, nor does a change to a watcher that leaves the count as it was. A done task isn't in the snapshot, so one reopened (or a follow-up running in it) can arrive as a `task.updated` for a task the plugin doesn't know: treat it as new. |
| `task.deleted` | `taskId: string` | A task is deleted. |
| `agent.toolCall` | `call: PluginToolCall` | A tool call starts, and again when it ends. Parallel calls each get their own. |
| `agent.note` | `taskId: string`, `subagentId: string \| null`, `text: string`, `at: number` | The agent's (or a subagent's) working notes between tool calls (the tool log's preamble), trimmed. Blank ones aren't sent. |
| `subagent.started` | `subagent: PluginSubagent` | A subagent starts: its `Agent` call starts. Subagents started inside a subagent too. A subagent that had ended and is woken again (the agent messages it, or the SDK starts it again) starts again too, under the same `id`, its `endedAt` null until its new run ends. |
| `subagent.updated` | `subagent: PluginSubagent` | Its state or latest line changes. A background subagent runs on after its call returns, and ends when it finishes. |
| `question.opened` | `question: PluginQuestion` | The agent asks (`ask`). |
| `question.closed` | `taskId: string`, `questionSetId: string`, `outcome: 'answered' \| 'withdrawn'` | The questions are answered or withdrawn. |
| `permission.opened` | `request: PluginPermissionRequest` | A tool call waits on a permission card (P11). |
| `permission.closed` | `taskId: string`, `requestId: string`, `outcome: 'allowed' \| 'denied' \| 'withdrawn'` | The card is answered or withdrawn. |
| `machine.reading` | `reading: PluginMachineReading` | Only with the `machine` capability on: about every 2 s while the plugin is showing ("Capabilities"). |
| `settings.changed` | `settings: Record<string, string>` | Only for a plugin that declares settings: you changed one in Settings › Plugins while its page was running. All of them, key to value, as they now are; the page isn't reloaded ("Settings"). |

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
  /**
   * What the agent is doing (`TaskActivity`): its own turn, not what it left running. `waiting` is a turn that's
   * over, whether the task is idle or still waits on something it started: `watchers`, with the subagent events,
   * says which ("Idle, or waiting on something", below).
   */
  readonly activity: 'waiting' | 'working' | 'error' | 'paused'
  /**
   * Whether the task counts under Needs you: it's asking a question, waiting on a permission card, stopped on an
   * error, or its turn ended with a reply you haven't read. Background work it left running doesn't change this
   * (#461): an unread reply counts whether or not the task still has subagents or watchers running after its turn
   * (`activity` says `waiting` either way: `activity` is the agent's own turn, not what it left running). Once
   * you've read the reply it is false; a task that still has background work running then counts as working rather
   * than idle.
   */
  readonly needsYou: boolean
  /** What the agent's turn is blocked on, if anything. */
  readonly waitingOn: 'question' | 'permission' | null
  /**
   * How many watchers the task has running: the `Monitor` watches and background commands (a `Bash` call with
   * `run_in_background`, or one that ran past its timeout and was moved to the background) whose process is still
   * running, started by the task's agent or by one of its subagents. 0 when none. One counts from when it starts,
   * during the agent's turn or after it, until it finishes, fails, is stopped, or dies with its session (Glade
   * quitting, or the session failing).
   *
   * Not counted: a wakeup or cron job, which the Watchers tab lists too but which runs nothing until it fires, and
   * subagents, which have their own events. Only the count: nothing of a watcher's command, name or output.
   *
   * With the running subagents, it's everything Glade itself counts as the task's background work: a task whose turn
   * is over (`activity` is `waiting`) is waiting on something exactly when `watchers` is over 0 or one of its
   * subagents is running, and idle otherwise.
   */
  readonly watchers: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly doneAt: number | null
}

interface PluginToolCall {
  /** The SDK's tool_use id. */
  readonly id: string
  readonly taskId: string
  /** The subagent that made it (its `PluginSubagent.id`); null for the task's main agent. */
  readonly subagentId: string | null
  /** The tool's display name, as the tool log shows it (`Bash`, `Edit`, `set_status`). */
  readonly tool: string
  /**
   * What it acts on, as the tool log shows it, first line only: the file for `Read`, `Write`, `Edit`, `MultiEdit` and
   * `NotebookEdit` (relative to the workspace root when it's inside it), the pattern for `Grep` and `Glob`, the command
   * for `Bash`, the URL for `WebFetch`, the query for `WebSearch`, the description for `Agent`. Empty for every other
   * tool (MCP tools, Glade's own, the todo tools): their input could hold anything.
   */
  readonly summary: string
  /** `interrupted` is a call cut off by Glade quitting or the task pausing: not a failure. */
  readonly state: 'running' | 'done' | 'failed' | 'interrupted'
  readonly startedAt: number
  readonly endedAt: number | null
}

interface PluginSubagent {
  /** The tool_use id of the `Agent` call that started it: what its calls' and notes' `subagentId` say. */
  readonly id: string
  readonly taskId: string
  /** Its description, else its type, else `Subagent`, as the Subagents tab shows it. */
  readonly name: string
  /** `stopped` is one cut off by Glade quitting or the task pausing: not a failure. */
  readonly state: 'running' | 'done' | 'failed' | 'stopped'
  /**
   * The last thing it said or did: a note, or a tool call's tool and summary (`Bash npm test`). Null before it does
   * anything. Never what it came to: that's a tool result.
   */
  readonly latest: string | null
  readonly startedAt: number
  readonly endedAt: number | null
}

interface PluginQuestion {
  readonly taskId: string
  readonly questionSetId: string
  /** Each question's prompt, in order. Not its options, nor your answers. */
  readonly prompts: readonly string[]
  readonly openedAt: number
}

interface PluginPermissionRequest {
  readonly taskId: string
  readonly requestId: string
  /** The subagent whose call it is; null for the task's main agent. */
  readonly subagentId: string | null
  /** The tool and what it acts on, as its `PluginToolCall` has them. Not the card's prompt. */
  readonly tool: string
  readonly summary: string
  readonly openedAt: number
}

/** The Mac's load at one moment: only with the `machine` capability on. Cores to two decimal places. */
interface PluginMachineReading {
  /** When it was read, in epoch milliseconds. */
  readonly t: number
  /** The Mac's logical CPU cores. */
  readonly cpuCount: number
  /** Cores in use by every process. */
  readonly total: number
  /** Cores in use by Claude Code (every `claude` process) and its children. */
  readonly claude: number
  /** Cores in use by Docker's containers: their `cpu` summed, over 100. */
  readonly docker: number
  /** The GPU's utilisation, in percent; null when it can't be read. */
  readonly gpu: number | null
  /** The running containers, busiest first; empty when Docker isn't installed or isn't running. */
  readonly containers: readonly PluginContainer[]
}

interface PluginContainer {
  /** Its name (`acme-api-db-1`): not its id, image or command. Cut to 200 characters. */
  readonly name: string
  /** Its CPU, in percent of one core, as `docker stats` gives it: 100 is one whole core. */
  readonly cpu: number
  /** The memory it uses, in bytes. */
  readonly memory: number
}
```

A reading mirrors Nekomata's standalone dashboard (`fleet_dashboard.py`): `{ t, claude, docker, total }` is one of its
`history` entries (with `t` in milliseconds here), and `cpuCount`, `gpu` and `containers` are its `cpu_count`, `gpu`
and `docker`.

**Idle, or waiting on something.** `activity` is the agent's own turn: it says `waiting` once the turn is over,
whatever the task left running. A task whose turn is over is still waiting on something, rather than idle, while it
has either of the two things Glade counts as its background work (and shows the task as working for, in its own task
list):

- **a running subagent:** one in the snapshot's `subagents`, or a `subagent.started`, whose `taskId` is the task's and
  that no `subagent.updated` has since ended;
- **a running watcher:** `watchers` over 0 on the task. A `task.updated` carries the new count each time it changes: a
  monitor or background command starts, finishes, fails or is stopped, or its session ends (a subagent's watchers end
  with it when it's stopped, and every watcher's process dies when Glade quits, so a snapshot after a restart says 0).

Nothing else keeps a task from being idle. `watchers` is added to version 1 (#490): a Glade from before it sends no
such field, so read a missing one as 0.

```js
const running = new Map() // subagent id → task id, from the snapshot, `subagent.started` and `subagent.updated`
function waitingOnSomething(task) {
  if (task.activity !== 'waiting') return false
  return (task.watchers ?? 0) > 0 || [...running.values()].includes(task.id)
}
```

**Not sent:** chat messages and final replies, the queue, file contents, tool inputs beyond the summary above and all
tool results (a subagent's outcome included), a running subagent's progress summary, question options and answers,
permission prompts and deny notes, todos, artifacts, anything of a watcher beyond how many its task has running (not
its kind, name, command, schedule, output or how it ended, nor the wakeups and cron jobs that are only scheduled; the
`Bash` call that starts a background command is a tool call like any other, with its command as its summary), the
terminal, Glade's settings and other plugins' (a plugin gets only the ones it declares itself), and anything about the
machine beyond the `machine` capability's coarse readings, and those only with it on. A plugin sees what the task
list, tool log and Subagents tab summarise, and no more.

## Messages (plugin to Glade)

| `type` | Fields | Effect |
|---|---|---|
| `ready` | none | Asks for `hello` and a `snapshot`. |
| `status` | `text: string` | Sets the short status at the right of the panel header (Nekomata's "5 cats · 4 kittens"), up to 40 characters; `''` clears it. |
| `openTask` | `taskId: string`, optional `subagentId: string \| null` | Opens the task, as clicking its row in the task list does, switching to its workspace first if it's in another; with a `subagentId`, also opens the right panel's Subagents tab on that subagent, its log open, as picking it there does. Only right after a click or key press in the plugin's view (below). |

Anything else, or a message that fails its schema, is dropped and logged. So is a message longer than 16 KB as JSON,
and any beyond a burst of 50, then 20 a second: a flood is cut off, not queued. A plugin can't send messages or
change anything in Glade; the most it can do is show you a task, when you click it.

```ts
interface PluginOpenTaskMessage {
  readonly type: 'openTask'
  /** A `PluginTask.id` from the snapshot or a later event, of a task that's still active. */
  readonly taskId: string
  /** A `PluginSubagent.id` of that task's, from the snapshot or a `subagent.started`/`subagent.updated`. */
  readonly subagentId?: string | null
}
```

**Opening a task (`openTask`).** Glade acts on it only when all of these hold; otherwise it's dropped and logged, and
nothing shows:

- **You just clicked or pressed a key in the plugin's view:** a mouse button or key went down there (a click counts
  from its release) less than a second before the message arrives. Glade hears this in main, from the input the OS
  routes to the view; nothing the page does or posts counts, so a page can't fake it with `element.click()`,
  `dispatchEvent` or a message, and can't open a task on a timer or in answer to an event. **One click, one
  `openTask`:** a second message after the same click is dropped. Post it from your click (or key) handler.
- **The plugin can see the task:** it's in the plugin's `snapshot`, or a later `task.created` or `task.updated`, since
  its last `ready`, and it's still active (not done, nor deleted since). A `subagentId` has to be one of that task's
  subagents the plugin was told of (in the snapshot, or a `subagent.started` or `subagent.updated`), running or ended.
- **It's within the rate limit** above, like every message.

The plugin's view stays as it is. Opening the task works as clicking its row would: it asks about unsaved edits in the
Files tab first, the input bar takes the focus, and the right panel shows the tab you last had in that workspace (or
Subagents, for a `subagentId`).

```js
cat.addEventListener('click', () => {
  window.glade.post({ type: 'openTask', taskId: cat.taskId, subagentId: kitten?.id ?? null })
})
```

A Glade from before `openTask` drops it as an unknown message (logged), and nothing else changes.

## Versioning

- Every message carries `apiVersion`. This document is version **1**.
- **Additive changes keep the version:** a new event type, or a new field on an existing one. Plugins must ignore
  event types and fields they don't know.
- **Breaking changes bump it:** removing or renaming an event or field, or changing what one means. Glade speaks one
  version at a time; the change is listed in the release notes.

## Nekomata

[Nekomata](https://github.com/lockhart-ai/nekomata), the cat cafe, is the first plugin (P12-05). Its Glade build keeps
its scene and swaps its data source: instead of fetching `/data` from its Python server, which reads Claude Code's
transcripts, its `web/glade.js` builds the same session list from these events. A task is a cat, a subagent a kitten,
`waitingOn` (or an open question or permission card) raises a paw, `agent.toolCall` and `agent.note` fill the speech
bubbles, and a task leaving the snapshot (done or deleted) is carried out. It posts its count as the header status
("5 cats · 4 kittens"). It asks for the `machine` capability: with it on, the readings drive the room as the
dashboard's do (the window's sun follows `total` over `cpuCount`, the pastry case holds a cake per container, steaming
while it's busy, and the espresso machine follows the GPU); with it off, the room stays quiet. Its art style is a
`select` setting, `style`, in its Glade build's manifest: it draws the scene in whichever style `settings.style` names,
restyles in place on `settings.changed`, and falls back to its default style when there's no `settings` (an older
Glade). Clicking a cat opens its task (`openTask` with the task's id), switching workspace if it's in another, and
clicking a kitten opens its task on that subagent in the Subagents tab (`openTask` with the subagent's id too).

To install it, build the plugin folder in a clone of the nekomata repo and copy it into the plugins folder:

```sh
./build.sh glade
cp -R dist/glade/nekomata ~/Library/Application\ Support/glade/plugins/
```

Nekomata isn't vendored here, so Glade's own checks of it need that built folder:

- `NEKOMATA_PLUGIN=<nekomata>/dist/glade/nekomata npm run test:e2e -- nekomata` runs `e2e/nekomata.spec.ts`, which
  installs it in a temp data folder and drives a scripted task past it. Without the variable, the spec is skipped.
- `npm run screenshot -- --out <dir> --plugins <folder holding nekomata/> --seed scripts/fixtures/subagents.json
  --agent-script asks-a-question --click '[data-testid="plugin-status"]'` captures it beside the terminal. The click
  only waits for its header status to show.
