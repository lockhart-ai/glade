# Decisions

![Decisions board](design/screens/decisions.png)

## Decided

- **Desktop shell:** Electron. macOS first.
- **Agent runtime:** Claude Agent SDK (TypeScript), running in Electron's main process. It streams typed events, takes
  custom tools in-process, resumes sessions and reads CLAUDE.md files. (Recommended over driving the Claude Code CLI.)
- **Auth:** login-based. Glade runs on the user's own Claude Code login. Glade never handles credentials itself: no
  claude.ai login screen, no reading or storing OAuth tokens. It runs the SDK's unmodified bundled Claude Code binary,
  which still uses `ANTHROPIC_API_KEY` if one happens to be set. When that login expires or goes, **Log in** (#409) runs
  the same binary's own `claude auth login`, which opens Anthropic's sign-in page in the browser and saves the login
  itself: Glade sees only whether it worked. Policy risk: Anthropic's docs don't clearly permit subscription use by a
  third-party app (see `sdk-notes.md` §1 and Open risks).
- **State:** everything in SQLite — workspaces, tasks, chat, tool log, todos, artifacts, queue, UI state. Reopening
  after a crash resumes from the database.
- **Agent sessions run in the workspace root** (the SDK session's `cwd`), so the workspace's own `CLAUDE.md` (the
  user's conventions and personal context) loads for every task.
- **Task metadata lives only in SQLite.** Glade keeps nothing of its own on disk in the workspace.
- **On-disk layout is convention, not app logic.** Where a task keeps its files (e.g. a folder per task, worktrees
  inside it) is described in the workspace `CLAUDE.md`. When Glade creates a workspace whose root has no `CLAUDE.md`,
  it writes a starter one describing a task-folder convention; it never modifies an existing one. The system prompt
  gives the agent its task's id and title so conventions can use them.
- **Compaction** relies on the SDK's own summary. Any note-keeping before compaction is up to the workspace
  conventions, not Glade.
- **Deleting a task** removes its database rows only; it never touches files on disk.
- **Model ↔ app surface:** the app exposes tools the model uses to drive the UI (see `model-surface.md`). The agent
  sets the title and objective from your first message and keeps the status current.
- **Two task states:** Active and Done. Done stays chat-able; a message reopens it. No follow-up tasks.
- **Workspace** = name + root folder, top level. Switcher in the sidebar and the macOS menu bar.
- **Chat shows final replies only.** Preamble goes to the tool log.
- **Compaction:** automatic at the SDK's default auto-compact threshold; manual from the context meter or ⌘⇧K. The
  meter shows the threshold the SDK reports (`getContextUsage`), which follows the user's own Claude Code settings
  (#279).
- **Permissions:** default Allow all. Each task can switch to "Ask before edits and commands" instead (P11, see
  below).
- **Message queue:** messages sent while the agent works are queued and delivered after its current step. They can be
  edited or removed. No "send now", no reordering. Stop with messages queued stops the turn and then sends the queue
  as the next turn, as when a turn ends on its own (#441); a task found stuck with a queue sends it at launch.
- **Notifications:** native OS notifications for any agent message in a task you're not viewing, even while Glade is
  focused. Task name + start of the message. Sound off. Focus/DND handled by the OS.
- **Needs you (#430, corrected by #461):** a task needs you when it's blocked on you or has a reply you haven't read:
  asking a question, waiting on a permission card, stopped on an error (or declined by a safety check), or its turn
  ended with a reply and the task is unread. Background work it left running masks none of these: an unread reply
  needs you whether or not subagents or watchers still run (#430 shipped with the opposite call — background work
  took precedence over an unread reply — which hid replies from a supervisor task that nearly always has subagents
  running; Jared corrected it). A read reply with nothing running is neither needs-you nor working (idle). A task
  whose turn has ended, whose reply is read, but which still has subagents or watchers running counts as working
  until they finish, or it asks, waits on permission or errors. Mark as unread makes a read task need you again. One
  rule drives the dots, the switcher, the menu bar, ⌘⌥↓ and the plugin feed.
- **Terminal** is per workspace, not per task (#347): each workspace has its own tabs, and the bottom bar shows the
  tabs of the workspace you're looking at, with the one you last picked there. Switching workspace never ends a shell;
  the others keep running, and their output is kept. Close workspace is a switch too: its shells keep running for
  when it's opened again. Only Remove from list… ends a workspace's shells and deletes its tabs. The bottom bar's
  size and collapsed state, and the plugin panel, stay app-wide. **Settings** are a modal.
- **Name:** Glade. **Icon:** "Stepping up" — three grass blades rising into the wind, the middle one lit
  (`assets/icon/`).

- **Stack:** well-established, widely adopted tools only. electron-vite (build/dev), React + TypeScript (strict), CSS
  Modules with the design tokens as CSS variables, Zustand (renderer store), better-sqlite3 (main process), Vitest +
  React Testing Library (unit/integration, 100% line coverage), ESLint (typescript-eslint) + Prettier, electron-builder
  (packaging), xterm.js + node-pty (terminal).
- **Terminal internals:** main owns the shells, one node-pty pseudo-terminal per tab, each your login shell (`$SHELL
  -l`) started in the root of the workspace the tab belongs to. The renderer draws them with xterm.js (`@xterm/xterm`
  and its fit addon) and reaches them only through typed, zod-validated bridge commands (attach, type, resize, clear,
  interrupt, close): it can't name a program or a folder to run, only type into a shell you opened. node-pty is a
  Node-API addon with prebuilt macOS binaries, so it loads under Node and Electron alike and needs no rebuild
  (`npmRebuild: false`, as for better-sqlite3); `scripts/fix-node-pty.mjs` makes its prebuilt spawn-helper executable
  after install (1.1.0 ships it without the bit), and electron-builder unpacks it from the asar archive. Unit tests run
  on a fake pseudo-terminal; only the app and the e2e specs start real shells (e2e mode runs a plain bash). Tabs,
  their workspaces, names, folders and each tab's last 100,000 characters of output live in SQLite, and the tab each
  workspace shows in `ui_state` (`terminal_selection`); every workspace's tabs keep their xterm.js screens in the page,
  hidden while another workspace shows; a relaunch shows that output above a
  new shell under a dim "restored" divider, since processes don't survive a restart. The screens open only once Geist
  Mono has loaded (`document.fonts.load`), since xterm.js measures its cell in whatever font has loaded, and they refit
  whenever xterm.js measures its cell again (after a resize, or a change of pixel ratio), so their rows always fit the
  card (#412).
- **Icons:** Font Awesome (free regular + solid SVG icons via the official React packages), bundled locally; regular
  style preferred to match the designs' thin strokes.
- **File editor (#351):** the Files tab edits workspace files in place with CodeMirror 6 (the official `@codemirror/*`
  packages), the mainstream embeddable editor: small, modular, accessible, and fast on large files. It's styled only
  from Glade's tokens, with none of CodeMirror's default theme and only the extensions plain-text editing needs (line
  numbers, undo history, the drawn caret and selection, find, the standard keys, Tab to indent), so at rest it looks
  exactly as the read-only viewer did. Its syntax colours come from the same Shiki tokens the viewer uses, laid over the
  text as marks, and are highlighted again from the edited chunk on, off the typing path. ⌘S saves through main
  (`files.write`), scoped to the workspace as reading is. Unsaved edits live in the window, not SQLite: the file on
  disk is the file, and closing a file's tab, switching task, closing the window or quitting asks Save / Discard /
  Cancel first. Files from a commit, binary files and files too large to show whole stay read-only.
- **Overlays:** Floating UI (`@floating-ui/react`) positions menus and popovers and handles their focus, dismissal and
  list keyboard navigation; overlays render in a portal.
- **Menu bar popover (#287/#319/#365):** the popover's window (`src/main/menu-bar/electron.ts`) is a `type: 'panel'`
  `BrowserWindow`. On macOS, Electron's docs say `panel` "enables the window to float on top of full-screened apps by
  adding the `NSWindowStyleMaskNonactivatingPanel` style mask... Also, the window will appear on all spaces
  (desktops)" — that alone, not the app's process type, is what keeps it above full-screen apps and on every Space.
  Its `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` call must also pass
  `skipTransformProcessType: true`: without it, Electron flips the whole app's process type between
  `ForegroundApplication` and `UIElementApplication` on every call (a workaround for *non*-panel windows, added in
  [electron/electron#24956](https://github.com/electron/electron/pull/24956)), which drops Glade out of ⌘Tab and the
  Dock (the same as `LSUIElement`) for as long as the popover window exists
  ([electron/electron#26350](https://github.com/electron/electron/issues/26350) is the same regression upstream).
  The window can close without the menu bar destroying it: quitting closes every window before `will-quit`, where
  the menu bar is closed. Anything asked of a closed window throws ("Object has been destroyed"), and from the menu
  bar's catch-up timer that was an uncaught exception, whose dialog blocked the quit (#439). So the popover says when
  its window has closed, and the menu bar lets go of it: nothing more is sent to it, and the next click makes a new one.
- **Long lists:** the Done section loads from SQLite a page at a time (keyset pagination on the list's own order, over
  an index), and renders only the rows in view with TanStack Virtual (`@tanstack/react-virtual`); everything outside it
  is loaded whole. No archiving (L-02, #67).
- **Validation:** zod at every boundary (IPC requests, SDK events, tool inputs, JSON from disk); schemas are checked
  against the named interfaces.
- **No remote content in the renderer; links open in the browser (#349).** The window only ever shows the app's own
  page: it loads nothing remote (a Markdown image shows as its alt text), opens no new windows and never navigates.
  Links in what the agent and you write are clickable everywhere text is shown (replies, your messages, cards, the tool
  log, the header, todos, watchers, the queue): Markdown links and bare URLs and email addresses, found by GFM's
  autolinking (remark-gfm in Markdown, the same micromark extension for plain text). Code spans and blocks stay plain.
  Clicking one sends it to main (`links.open`), which opens only `http:`, `https:` and `mailto:` links, parsed with
  `new URL`, in the default browser or mail app (`shell.openExternal`); anything else (`file:`, `javascript:`, `data:`,
  custom schemes, text with whitespace or control characters hidden in it) is refused and logged. A link inside a
  control (a row that opens something, an option card) stays plain text, since a link can't sit inside a button.
- **Releases:** one minor release per phase (P1 is 0.1.0), built and published by `.github/workflows/release.yml` from
  a pushed tag (`releasing.md`). Apple silicon only. Builds are **ad-hoc signed** (no certificate, not notarised) so a
  download opens with right-click → Open instead of being reported as damaged. Developer ID signing and notarisation
  come later (L-04, #69).

- **Per-call permission review (P11, #68).**
  - The input bar's permissions picker has two modes: **Allow all** (the default) and **Ask before edits and
    commands**. The mode is saved per task, like model and effort. Settings › Agent › Permissions sets the default
    for new tasks: its "Ask first" option becomes this mode and "Allow edits" stays disabled.
  - In the ask mode, tools with side effects ask first: `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
    `Monitor` (it runs a shell command), `RemoteTrigger` and `SendMessage` (they reach outside), and any tool Glade
    doesn't know to be read-only, including other MCP servers'
    tools. Reads and searches (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, …), Claude Code's todo and subagent
    tools, the agent's follow-up tools that only schedule itself or tell you (`ScheduleWakeup`, `CronCreate`,
    `CronDelete`, `CronList`, `PushNotification`, `ListAgents`), Glade's own MCP tools (`mcp__glade__*`), and the
    reads of Glade's control tools (`glade-control`'s `list_*` and `get_*`, when the SDK says the server is Glade's
    in-process one) never ask. The control tools that change things (`create_task`, `update_task`, `send_message`,
    `stop_task`, `mark_done`, `reopen_task`, `delete_task`) ask, as other MCP servers' tools do: only `glade` is
    pre-approved (`allowedTools`) and trusted wholesale. The user's own settings still apply: their allow
    and deny rules decide without asking, and a user `ask` rule shows the card even for a read.
  - A request shows as a **permission card** in the chat, styled like the `ask` question card: the tool, its input
    (the command, or the file and the change), and, for a subagent's call, which subagent. It offers **Allow once**,
    **Allow for this task** (that tool, or for `Bash` that command prefix) and **Deny**, with an optional note that
    goes back to the agent. When the SDK says a request mustn't be remembered (`suppressAlwaysAllowRule`), Allow for
    this task isn't offered; when it says it mustn't be approved by a stray key (`defaultToNo`), Deny has the focus.
  - **A card is in the chat only while it waits for your answer** (#459, Jared's call in the P15 design review): the
    chat holds your messages and the agent's, and nothing else. Once a card is answered or withdrawn it leaves the
    chat, live and after a relaunch, with no collapsed line left behind. What was decided shows on the tool call's
    row in the Tool calls list (a subagent's call, on the row it already has in the Subagents tab), on a line under
    the call that starts with a filled shield and puts the status first: "Waiting on you" while the card is open,
    then "Allowed once", "Allowed for this task: npm test commands" (naming the rule it granted), "Denied" or
    "Denied: “your note”", or "Withdrawn". The shield's colour is the state: purple waiting on you, teal granted,
    pink denied, slate withdrawn (and the whole line dimmed). The row's dot still says only how the call itself went:
    purple while it waits, pink for a denied call, and slate for one whose request was withdrawn, since it never ran
    rather than failed. A call that never ran (waiting, denied, withdrawn) shows no result line; its output is still
    there when you open the row. This holds for every permission card, the sandbox's (P15) included; the line is one
    component (`PermissionLineView`, `src/renderer/permissions/`), which those reuse.
  - While a card waits, the task needs you, exactly as with an open question: purple dot, Needs you, unread and a
    native notification when you aren't viewing it. A message sent meanwhile is queued as usual; Stop withdraws the
    request.
  - The rules granted by Allow for this task are stored per task in SQLite and apply for the rest of the task,
    across relaunches. Pending requests are stored too: after a relaunch the card is still there and the task still
    needs you. The call itself can't survive (its Claude Code process is gone), so answering then resumes the session
    and tells the agent the decision in a message, as a question answered after a restart does. See
    `sdk-notes.md` §9.
  - The agent sandbox (P15, #445) is **off by default while P15 is being built** (the `sandboxEnabled` setting,
    Settings › Agent › Sandbox's switch): main is released from, and without the sandbox's permission cards a
    sandboxed task would have no way to be granted anything from the chat. The default flips to on in P15's last PR
    (#452).
  - **The sandbox in Settings (P15-06, #451).** The switch is app-wide, in Settings › Agent, and a session reads it
    as it starts: a running session keeps what it started with. Under it are the Glade-wide Folders and Domains,
    which start empty and are filled only there; a workspace's are in Settings › Workspace, its root first, tagged,
    read-write and fixed. A task's grants are listed nowhere. Each granted folder's access is a select on its row
    (Read-only or Read-write), and every add, change and removal goes through the grants' store, so the running
    tasks it covers have it at once, without a restart. While the switch is off both pairs of lists dim and can't be
    changed; the grants are kept. Main owns the lists: Settings reads a scope's as it opens and follows a
    `sandbox.grantsChanged` broadcast, sent whenever the Glade-wide grants or a workspace's change (from Settings,
    or Allow for this workspace on a card), and shows a change only once it's saved. **Add… refuses**, with the
    reason under the list: what the sandbox can't take (a pattern, the whole disk, anything but a bare host or a
    leading `*.` over two labels or more), a folder or domain the list already has (a read-only folder added again
    read-write is upgraded instead), and, for a workspace, its own root or a folder inside it, which its agents can
    already use (the Glade-wide list takes one: it's for other workspaces' agents).
  - With the sandbox on, Allow all runs as Claude Code's `acceptEdits`, never bypassing, and crossing the sandbox's
    bounds asks in either mode: a read outside the workspace root and the granted folders under the home folder,
    `/Users` or `/Volumes` (reads elsewhere, like `/etc` or `/usr`, don't ask), a write outside the root and the
    read-write grants, `WebFetch` to a domain that isn't granted (so `WebFetch` no longer always goes ahead), a
    command's connection to such a domain, and every request to run a command outside the sandbox. `WebSearch` never
    asks. A sandbox that can't start fails every command: the task stops on that error, and every request in that
    session to run outside the sandbox is refused without a card. A session that won't take its sandbox settings is
    closed rather than left running, with the same error, before any message reaches the agent. See `sdk-notes.md`
    §15.
  - With the sandbox on, folders are compared by where they really are (symbolic links followed, `~` and the data
    volume's alias resolved, case ignored), so another spelling of a denied folder asks too. Credential files are
    refused outright. A write that Claude Code's own safety check holds back (`.mcp.json`, `.claude/`, `.git/`, shell
    startup files) asks even in Allow all, on the plain card, allowed once or denied. A whole-tool `Edit` or `Write`
    rule a task was granted in the ask mode applies only inside the workspace root and the read-write grants.
  - The sandbox's cards (P15-05, #450). A boundary crossing asks for what a grant can give, never for a rule: a file
    tool for its folder (the one Claude Code's suggestion names, else the file's own; a read read-only, a write
    read-write), `WebFetch` and a command's connection for the host's domain. The card offers **Allow for this
    task** · **Allow for this workspace** · **Deny** (with the note), and no Allow once. The answer saves the grant
    with it, and the call that waited goes on only once its own session has the grant in force; the workspace's other
    running sessions get it in the background. Running a command outside the sandbox has its own card, with the
    command, **Allow once** · **Deny** only, every time, in either mode, whatever task rules exist. Nothing goes back
    to the SDK with an answer but that the call may run: Claude Code's suggestion (a rule for the project's local
    settings, for a domain) is never returned, so nothing is written to the user's repo or `~/.claude`.
  - A command the sandbox blocked is asked about by the agent itself, with the `glade` server's `request_access`
    (the absolute path, read or write, a short reason): Glade's prompt and the tool's description tell it to, instead
    of retrying outside the sandbox. It opens the folder card with the reason, and returns the decision once the grant
    is live, or at once when there's nothing to decide (the sandbox is off, the path is in the workspace or already
    usable as asked, or it's a credential path, which is refused). It's the one Glade tool a subagent may call; the
    card names the subagent. See `model-surface.md`.
  - The sandbox's decisions on the tool rows (#459's permission line). A sandbox request's line names what it was
    about in every state ("Allowed for this workspace: write to ~/code/acme-web/src/api", "Withdrawn: write to
    ~/.cache/uv"). Where Glade can tell a rule decided a call, it marks the call (`permission_marks`, one per call,
    kept across relaunches, sent to the windows one at a time): a file tool or `WebFetch` a grant covers, by the
    narrowest scope that grants it; in the ask mode, a call a task rule covers; a sandboxed `Bash` or `Monitor` call
    whose result says "Operation not permitted", named once the agent's next `request_access` says what it was blocked
    from; a credential path refused; and a `request_access` answered without a card. Your own answer on a call shows
    over a rule's. A call in the workspace root with no rule involved has no line. In the task list, a task waiting on
    a permission card shows the filled purple shield and "Waiting on you", with what a sandbox card asks for.
  - Calls made without Jared in P15-05: a call the task's own grant covers reads "Allowed by task grant", beside the
    designs' "by workspace grant" and "by Glade-wide grant"; a blocked command is told by "Operation not permitted" in
    its result in any case, failed or not, so a command that only prints those words is marked too; the blocked
    command a `request_access` names is the task's latest one not yet named; a connection's card is put on the command running when it asked (the latest
    started, when several are), since the SDK doesn't say which command made it; a `request_access` path that doesn't
    exist yet is asked for as it is, not by its parent folder; `request_access` takes `~` and `~/…` as the home
    folder; a call whose folder or host can't be granted (a path with a glob character or that can't be resolved, a
    host that isn't a name) keeps the plain card, allowed once or denied; and a session resumed from before the
    sandbox was on keeps its old prompt and learns of `request_access` from the tool's description.
- **Plugins (P12, #66).**
  - A plugin is a folder `~/Library/Application Support/glade/plugins/<id>/` (Glade's `userData`) holding a
    `manifest.json`: `id` (the folder's name), `name`, `version`, `entry` (an HTML file in the folder) and an optional
    `icon`. The manifest is validated with zod; a plugin whose manifest is invalid is listed with the reason and
    doesn't load. Installing is copying a folder there; there's no store or installer.
  - A plugin renders in the bottom bar's right side, beside the terminal (the Nekomata card in `task-workspace.png`),
    in a sandboxed view of its own: a separate process (a `WebContentsView` with its own session), no Node, a preload
    that only relays messages, a CSP that blocks all network except localhost, no navigation and no new windows.
  - Glade sends it typed task and agent events with `postMessage`, in a versioned schema (`plugin-api.md`). The plugin
    sends back only `ready`, a short header status and `openTask`. It can't change anything in Glade.
  - A plugin can navigate, only when you ask it to (#466): `openTask` selects a task, as clicking its row does
    (switching workspace if it has to), and with a subagent opens the Subagents tab on it, as picking it there does.
    Glade honours it only within a second of a click or key press in the plugin's own view, as main hears the input
    the OS routes to that view (never anything the page says, which can't prove a click), one `openTask` per click,
    and only for a task the plugin has been told of and that's still active, or a subagent of it it was told of.
    Anything else is dropped and logged, never shown. No capability switch: it's your click, and only opens what the
    plugin already shows. Additive, so the API stays version 1.
  - A plugin is told how many watchers a task has running, and nothing else of them (#490): `PluginTask.watchers`, in
    the snapshot and in a `task.updated` whenever the count changes. It counts what `Task.backgroundWork` counts of
    the watchers (a monitor or background command whose process runs, the task's own or a subagent's; not a wakeup or
    cron job that's only scheduled), so with the subagent events a plugin can tell a task that's idle from one whose
    turn is over and still waits on something, as Glade's own task list does. Never a watcher's kind, name, command,
    output or outcome. Additive, so the API stays version 1.
  - Nothing about the machine, unless the plugin asks for it and you allow it (#403, replacing P12's "nothing about
    the machine"): a manifest's `capabilities` can ask for `machine`, which Settings › Plugins shows as "Can see your
    Mac's CPU, GPU and Docker load" with a switch per plugin, off until you turn it on (saved in SQLite). With it on,
    the plugin gets the coarse readings Nekomata's dashboard draws (CPU cores in use, all and Claude Code's, the core
    count, the GPU's utilisation, and each Docker container's name, CPU and memory), about every 2 s, sampled in main
    only while such a plugin is showing. Never a process's name, command or path, nor more about a container than its
    name. Docker is read only if it's running, never started.
  - A plugin can declare settings of its own (#435): a manifest's `settings` lists up to 8, one kind so far, `select`
    (a `key`, a `label`, up to 12 `options` and a `default`). Settings › Plugins shows each under the plugin's row,
    beside its capability switches; the value chosen is saved per plugin in SQLite and survives restarts and plugin
    updates, and one an update no longer offers reads as the default. Glade hands the page its own values, key to
    value, in `snapshot`'s `settings`, and again in a `settings.changed` event when one changes while it runs (no
    reload). Additive, so the API stays version 1; a plugin never sees Glade's settings or another plugin's.
  - Settings › Plugins lists the installed plugins, each with an enable/disable toggle, and has **Open plugins
    folder**. Whether each plugin is enabled lives in SQLite.
  - The bottom bar splits into terminal | plugin with a drag handle; the plugin's width is saved in SQLite. With no
    enabled plugin, the terminal takes the whole bar.
  - Nekomata gets a Glade build that consumes these events instead of reading transcripts (work in the nekomata
    repo, tracked in this one).
  - These parts have no design screens. They're built from the existing tokens and components, and their PRs include
    screenshots for review.

- **Programmatic control (P13, #219).** Details in `control-api.md`.
  - Other agents can drive Glade through one MCP server, `glade-control`: list workspaces; list, read, create, update,
    message, stop, mark done, reopen and delete tasks; list and import Claude Code sessions. Its tools are defined once
    in main, over a **control service** that uses the same code as the window's commands, so the API and the UI
    behave the same and every change reaches open windows.
  - It's served two ways: **in-process** to Glade's own tasks, next to `glade` (behind tool search, not `alwaysLoad`),
    and as a **Streamable HTTP endpoint** (the official `@modelcontextprotocol/sdk`) on `127.0.0.1` only, port 45233 by
    default and configurable, falling back to the next nine when taken, behind a random bearer token kept in SQLite
    that Settings can regenerate. Every request's `Host` and `Origin` are checked against DNS rebinding. The same server
    answers plain JSON at `/v1/tools` for scripts (Jared, for backfills of hundreds of tasks), and Glade's own agents get
    `GLADE_CONTROL_URL` and `GLADE_CONTROL_TOKEN` in their environment while it listens.
  - **Settings › Control** has one switch, **Let agents control Glade**, off by default. When it's on it shows the
    endpoint, a copy-ready `claude mcp add --transport http glade-control …` command with the token, Regenerate token,
    the port, and a note that Glade's own tasks get the tools too.
  - **Importing** a Claude Code transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`): Glade parses it itself,
    tolerantly, into a task in the workspace whose root is the transcript's folder (failing when there's none, unless
    the caller asks for that folder to be added as a workspace), with its title, chat, tool log and turn dividers at
    their original times, done by default. The task keeps the session id, so a message resumes the Claude Code
    session. Importing a session twice returns the same task.
  - **Backfilling past tasks (P13-04):** `create_task` can make a past task from its notes: a Markdown **handoff
    note** (at most 32 KB) kept with the task in SQLite, files of its workspace as its **artifacts** (the existing
    artifacts store and tab, so only files inside the workspace, by absolute path), a **start date** that dates and
    orders it, **done** at that date, and an **external id** (unique) that makes running the backfill again safe: the
    same id returns the task already made. A backfilled task never starts its agent by itself. The note shows on a
    **Backfilled** card at the top of the chat (collapsible, rendered Markdown, with the date it was added; never
    edited in the window) and goes at the end of the system prompt of a session Glade starts, so compaction can't lose
    it. Claude Code keeps a resumed session's original prompt, so a session that started without the note, or with an
    older one, is sent it once as a `[Glade: handoff for this task] … [end]` block ahead of the next message (the chat
    shows only the message); what each session has been given is kept in SQLite. `update_task` sets or clears the note
    and adds artifacts without moving the task.
  - **Safety:** a task can't stop, delete or message itself through the API; deletes need `confirm: true`; calls are
    rate limited per caller; everything is logged under `control`, never the token. In the ask mode, `glade-control`
    tools that change things ask like other MCP tools; its reads (`list_*`, `get_*`) never ask when the SDK says the
    server is Glade's in-process one.

## Open

- Exact names and schemas for the model surface tools (a draft is in `model-surface.md`).

## Later

- Customising the auto-compact threshold (see `sdk-notes.md` §5 for the SDK's limits).
