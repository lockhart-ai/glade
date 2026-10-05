# Decisions

![Decisions board](design/screens/decisions.png)

## Decided

- **Desktop shell:** Electron. macOS first.
- **Agent runtime:** Claude Agent SDK (TypeScript), running in Electron's main process. It streams typed events, takes
  custom tools in-process, resumes sessions and reads CLAUDE.md files. (Recommended over driving the Claude Code CLI.)
- **Claude auth:** login-based. Glade runs on the user's own Claude Code login. Glade never handles Claude credentials itself: no
  claude.ai login screen, no reading or storing OAuth tokens. It runs the SDK's unmodified bundled Claude Code binary,
  which still uses `ANTHROPIC_API_KEY` if one happens to be set. When that login expires or goes, **Log in** (#409) runs
  the same binary's own `claude auth login`, which opens Anthropic's sign-in page in the browser and saves the login
  itself: Glade sees only whether it worked. Policy risk: Anthropic's docs don't clearly permit subscription use by a
  third-party app (see `sdk-notes.md` §1 and Open risks).
- **OpenRouter inference (#551, user requirements):** keep the SDK harness and add an optional encrypted inference
  key while Claude login stays active. Discover and curate model/provider pairs in Settings. The parent chooses each
  child's model at dispatch; no blanket child picker or default. Glade's dispatch tool starts another SDK session,
  so either source can dispatch children on either source. Each route pins its provider without fallback and keeps
  its own context window. Child history, identity and model live in SQLite; Agents shows the selected model.
  Model switches retain history and SDK todos and add an Agents/Main log entry. A limit-paused switch ends old
  background work with a recorded reason and resumes the held turn on OpenRouter. Ordinary busy tasks must stop
  before switching source. OpenRouter has separate user configuration and memory; project configuration and Glade
  tools still load. Subscription usage and OpenRouter key USD spend remain separate in the sidebar; metadata reads
  are coalesced with a trailing refresh, and credit failures show as blocked. No management key is requested.
  See [OpenRouter integration](openrouter-integration-spec.md) for the support matrix and validation limits.
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
- **Broadcast (#489):** one message to every Active task, in every workspace, idle ones included, from a modal
  (⌘⇧B, File › Broadcast…) that lists who gets it, read-only. A task that has never been sent anything has no agent,
  so it gets nothing and isn't listed. A busy agent gets it in its queue, like any message:
  there's still no mid-turn delivery. It's stored with each task as its own message, tagged `BROADCAST` in the chat;
  each agent answers in its own chat, and nothing collects the replies. Main decides the recipients as it sends, and
  the windows hear of it all as one batch of events.
- **A usage limit's pause can end early (#519):** the banner's **Resume now** retries every task a usage limit
  paused, in every workspace, each on its own model, with one command and one batch of events. And Glade resumes them
  by itself when a reading of the account's usage says it can run again: the limit that turned the task away is no
  longer spent, or extra usage is on with room left (on, nothing disabling it, its spend limit not reached, under its
  monthly cap). While any task is paused on a usage limit it reads usage again when its window gets the focus and
  every 5 minutes, on one timer for the app, through a session that's already live: it never starts one to ask, so
  after a relaunch nothing is read until a task runs. A task still over the limit pauses again, with no error card. A
  task is resumed once on what a reading says: once on extra usage being available, and once a window on its limit
  having cleared, never on how much is used, which moves with every reading. It's tried again only when availability
  itself changes (extra usage goes and comes back, or the limit's window rolls over), so a reading that's wrong costs
  one refused request a task, not a loop. Which readings count is one pure rule
  (`canRunAgain`, `src/main/agent/pauses.ts`). Offline pauses are untouched.
- **The usage meter shows the money spent on extra usage (#530, Jared, Oct 4):** this replaces #327's "extra usage
  only as a percentage, not in money". With no monthly cap there was no percentage to show, so the one number that
  matters wasn't there. Extra usage's row reads "CA$12.34 spent" with no cap (and has no bar: nothing to be a fraction
  of), and "CA$12.34 of CA$50.00" with one, the bar at its percentage. While the account is running on extra usage (a
  plan limit is spent and the last usage call said extra usage is available, by #519's rule) the sidebar's one line
  shows extra usage and the amount, in blue, in place of the limit that ran out; a spent limit with extra usage not
  available keeps the "limited" highlight. The amount is the usage call's (`extra_usage`: minor units, currency and
  decimal places), kept in SQLite with the reading and never logged; anything missing or malformed means no amount,
  never a guessed one. Money is written in `en-US`, as Glade's dates and numbers are, so a currency other than the US
  dollar is always named ("CA$", "¥") whatever the Mac's locale.
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
- **Agent sandbox (P15, #445).** How it's built, with the evidence, is in `sdk-notes.md` §15; how it behaves for the
  user is in `product.md` and the user guide.
  - **The Claude Agent SDK's built-in `sandbox`.** On macOS that's Seatbelt: nothing to install, and it's what Claude
    Code's own `/sandbox` runs on. The alternatives surveyed were `srt` around the whole CLI, Docker Sandboxes, Apple
    `container` and cloud sandboxes (E2B, Vercel). Each needs something installed or an account, and all are out of
    scope; any of them could become a stronger opt-in tier later, through the SDK's `spawnClaudeCodeProcess` hook.
  - **What it covers.** The agent's commands (`Bash`, `Monitor`) run under Seatbelt. The file tools (`Read`, `Edit`,
    `Write`, `MultiEdit`, `NotebookEdit`), MCP servers and hooks run outside it, so the file tools are held to the
    same folders by Glade's own check instead, taken before Claude Code's rules are (the security review, below). The terminal tabs, Glade's git tracking and
    Glade's own MCP tools run on the host, as before. Every task in a workspace shares the workspace root and the
    workspace's grants; confining a task to its own folder is out of scope.
  - **Nothing is granted by default.** An agent can read and write its workspace root, and read folders outside the
    home folder (`/usr`, `/opt/homebrew`, `/Applications`), so system and Homebrew tools work. The home folder,
    `/Users` and `/Volumes` are blocked apart from what's granted, and no domain is reachable. There's no starter set
    of folders or domains (`github.com`, `registry.npmjs.org`, …). Claude Code always keeps its own temporary and log
    paths writable (`/tmp/claude`, `~/.npm/_logs` and the like); Glade can't remove them.
  - **Three grant scopes,** kept in SQLite (`sandbox_grants`): a **task**'s, from a permission card; a
    **workspace**'s, from a card or Settings › Workspace; and **Glade-wide**, only from Settings › Agent, for what
    every workspace needs. A grant is a folder, a single file or a domain; or (P15-11, below) an MCP server, or
    other agents. A folder is **read-only or read-write**:
    a read asks for read-only access and a write for read-write. A domain is one grant for both the agent's commands
    and `WebFetch`.
  - **The card's actions:** Allow for this task · Allow for this workspace · Deny, with Deny's optional note, and no
    Allow once: the SDK keeps an allowed host for the rest of the session anyway, so the smallest grant is the task.
    The card doesn't offer "Allow everywhere"; the Glade-wide lists are filled only in Settings.
  - **A command the sandbox blocked is surfaced by the agent,** with Glade's `request_access` tool, not by hooks or
    the macOS log. Seatbelt never asks, and in an SDK session a blocked read or write leaves only "Operation not
    permitted" in the command's result. Reading the denials from the system log and holding the turn in a `Bash`
    hook was probed and not taken: the log is best effort and its tag is Claude Code's internal format.
  - **Grants are applied with `applyFlagSettings` after a session starts, never in its start options.**
    `applyFlagSettings` can't narrow what a session started with, only take back what an earlier `applyFlagSettings`
    added. So a session starts with only the fixed parts (the workspace root, the read denies, the credential denies,
    the rule that makes running outside the sandbox ask, no domains), and gets every grant that covers it as one
    overlay before its first message and again on every change. That's what makes removing a grant, or making it
    read-only, take effect from the agent's next call without a restart. One exception: a host a session was allowed
    to reach on a card stays reachable until that session restarts (an SDK limit).
  - **A sandbox that can't start refuses every run outside it.** On macOS the session still starts, and every command
    fails with "Sandbox is required but failed to initialize". Glade spots that text, stops the task on the error
    card with the reason, and denies every request in that session to run outside the sandbox, without a card.
    `failIfUnavailable` stays true, so nothing falls back to running unsandboxed.
  - **Running a command outside the sandbox is only ever allowed once.** It asks every time, in either mode,
    whatever task rules exist, shows the command, and has no "always for this command".
  - **Credential files stay blocked even inside a granted folder,** the home folder included: `~/.ssh`, `~/.aws`,
    `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/Library/Keychains`, `~/.netrc`,
    `~/.git-credentials` and `~/.docker/config.json`; and, since the security review, `~/.claude.json`,
    `~/.config/op`, more registry and cloud tools' token files, and Glade's own data folder. `~/.npmrc` and
    `~/.pypirc` aren't among them (P15-11, below).
  - **The user's own Claude Code settings still merge in** (`settingSources` includes `"user"`), but **can't let a
    call past the sandbox unasked** (the security review, below). Their allow rules and additional directories no
    longer decide a file tool's, `WebFetch`'s or a command's call at the boundary: Glade does, first. What still
    widens it, documented and not fought: a domain or a Unix socket in their own `sandbox` lists, which merge with
    Glade's; and their hooks, which run on the host. Their MCP servers run on the host too, and are granted one by
    one (P15-11, below).
  - **The switch** (`sandboxEnabled`, Settings › Agent › Sandbox) is app-wide and **off by default until the phase's
    security review is done** (#452); the default then flips to on. Existing workspaces and tasks take it on their
    next session start, with no grants. With it off, a session starts exactly as it did before P15.
  - **The shield** is the mark of the sandbox and of permissions: every card, tool-log line and setting that involves
    them carries it, always filled. On a tool call's row its colour is the state (teal granted, pink denied or
    blocked, purple waiting on you, dimmed withdrawn), and the line reads status first.
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
    volume's alias resolved, case ignored), so another spelling of a denied folder asks too. Only a call's own path
    is resolved: a grant is kept by where its folder really was when it was granted, and compared as kept from then
    on, so a granted folder later swapped for a link opens nothing new (#510's review). Credential files are
    refused outright. A write to a file that runs code (`.mcp.json`, `.claude/`, `.git/`, `.vscode/`, shell startup
    files) asks even in Allow all, on the plain card, allowed once or denied, wherever the file is. A whole-tool
    `Edit` or `Write` rule a task was granted in the ask mode applies only inside the workspace root and the
    read-write grants.
  - The sandbox's cards (P15-05, #450). A boundary crossing asks for what a grant can give, never for a rule: a file
    tool for its folder (the one Claude Code's suggestion names, else the file's own; a read read-only, a write
    read-write), `WebFetch` and a command's connection for the host's domain. The card offers **Allow for this
    task** · **Allow for this workspace** · **Deny** (with the note), and no Allow once. The answer saves the grant
    with it, and the call that waited goes on only once its own session has the grant in force; the workspace's other
    running sessions get it in the background. Running a command outside the sandbox has its own card, with the
    command, **Allow once** · **Deny** only, every time, in either mode, whatever task rules exist. Nothing goes back
    to the SDK with an answer but that the call may run: Claude Code's suggestion (a rule for the project's local
    settings, for a domain) is never returned, so nothing is written to the user's repo or `~/.claude`.
  - What a card shows is exactly what it grants (#510's security review). The grant saved is the card's own path,
    never resolved again; if the folder moved while the card was open (it, or a folder above it, swapped for a link),
    allowing it closes the request denied, with Glade's note for the agent, and grants nothing. A card's domain is one
    host by name, never a pattern (`*.github.io` in a URL gets the plain card; a command's connection to such a host
    is refused, since a connection can't be allowed just once). A path's kind and folder are taken where it really is,
    so a link to a file asks for the real file's folder. Only the real home folder is shown as `~`: main tells each
    window the home folder when it makes it (`src/shared/homeFolder.ts`), and captures and e2e runs show their sample
    data from a made-up one (`/Users/sample`).
  - A denial lasts the turn: a folder or domain you denied is answered denied at once, with your note and no card, if
    it's asked for again before your next message, by the agent, a subagent, a file tool, `WebFetch` or a command's
    connection alike. Cards open at the same time each stay. Running outside the sandbox asks every time regardless.
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
    that failed saying "Operation not permitted", named when the same agent's very next call is a `request_access`
    that says what it was blocked from; a credential path refused; and a `request_access` answered without a card. A
    call that crosses the sandbox's bounds is never marked allowed: it's asked about or refused whatever rule covers
    it. Your own answer on a call shows
    over a rule's. A call in the workspace root with no rule involved has no line. In the task list, a task waiting on
    a permission card shows the filled purple shield and "Waiting on you", with what a sandbox card asks for.
  - Calls made without Jared in P15-05: a call the task's own grant covers reads "Allowed by task grant", beside the
    designs' "by workspace grant" and "by Glade-wide grant"; a blocked command is told by "Operation not permitted"
    (in any case) in the error of a command that failed, so one that failed for another reason with those words in its
    output is marked too; a connection's card is put on the command running when it asked (the latest
    started, when several are), since the SDK doesn't say which command made it; a `request_access` path that doesn't
    exist yet is asked for as it is, not by its parent folder; `request_access` takes `~` and `~/…` as the home
    folder; a call whose folder or host can't be granted (a path with a glob character or that can't be resolved, a
    host that isn't a name) keeps the plain card, allowed once or denied; and a session resumed from before the
    sandbox was on kept its old prompt and learnt of `request_access` only from the tool's description (P15-07 now
    tells it, below).
  - Calls made without Jared in #510's security review (the supervisor's): **a card never offers the home folder,
    `/`, `/Users`, `/Volumes`, `/System/Volumes` or a folder above one of them.** A file whose folder is one of those
    is asked for by itself ("The agent wants to read `~/.gitconfig`") and granted alone, read-only or read-write: a
    single-file grant (`FolderGrant.file`, `sandbox_grants.is_file`) that Settings lists with the folders, by its
    path. Such a folder named outright is refused by `request_access` without a card, telling the agent to ask the
    user to add it in Settings, and gets the plain Allow once · Deny card from a file tool. Credential files are still
    refused outright. A single file reaches the session as its own path in the sandbox's lists (that the sandbox
    takes a single file was probed for P15-07, `sdk-notes.md` §15); Claude Code's file tools are told nothing of it,
    and Glade lets the calls to exactly that file through itself (the security review, below). A write to a file that
    runs code gets the plain card, granted or not. Also in that review: a denied read denies a write to the same folder for the turn,
    while a denied write still lets a read ask; a background subagent's requests belong to the turn its `Agent` call
    was made in; a card's grant that matches one the scope already keeps in another case is kept as a grant of its
    own; and an answer refused because its folder moved shows as "Denied" with Glade's note where yours would be.
  - **The phase's security review (P15-10, #514),** with a sandboxed agent taken for an adversary. Its fixes, each
    with its attack as a test; how each works, and what's read from Claude Code's code rather than probed, is in
    `sdk-notes.md` §15.
    - **Glade decides at the boundary, before Claude Code's rules.** A sandboxed session's `PreToolUse` hook takes
      every file-tool, `WebFetch`, `Bash` and `Monitor` call's standing against the bounds, in either mode. A call
      inside them is left to Claude Code; a crossing is refused, or asked about on its card with the hook held until
      you answer, and the hook returns allow or deny. So an allow rule or an additional directory in the user's, the
      project's or the local Claude Code settings can't let a call through. With the sandbox off there's no such hook.
    - **Claude Code is told of no grant for its file tools:** no additional directory, and no `Read` or `Edit` rule.
      It followed a granted folder that a command had swapped for a link. It now asks about every file-tool call
      outside the workspace root, and Glade compares where the call really leads with the grant as kept: a read in a
      granted folder goes ahead, and a write does in Allow all (in the ask mode it asks, as every write does). The
      command sandbox's own lists are unchanged.
    - **macOS's `/.nofollow`, `/.vol` and `/.resolve` paths are refused,** written outright or reached through a
      link, for the file tools, `request_access` and Settings. Each names any file by another path that can't be
      turned back into the real one. A path Glade can't resolve at all (a loop of links) is refused too, where it
      used to get the plain card.
    - **A command the user's settings keep out of the sandbox** (`sandbox.excludedCommands`, in the user's, the
      project's or the local settings) asks with the run-outside-the-sandbox card: once, every time. Glade reads those
      files itself, and asks whenever a word of the command is the command a pattern names: a card too many over one
      too few.
    - **The sandbox's switches are pinned off** in what a session starts with and every overlay
      (`filesystem.disabled`, `allowAppleEvents`, `allowLocalBinding`, `allowAllUnixSockets`,
      `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`; `allowUnixSockets` and `ignoreViolations` empty),
      so one in the user's settings can't fall through.
    - **Files that run code stay write-protected inside a folder granted read-write,** for commands: `.git/hooks`,
      `.git/config`, shell startup files, `.vscode`, `.idea`, `.mcp.json` and Claude Code's own commands, agents,
      skills, hooks and settings, as under the workspace root. The rest of `.git` stays writable, so a command can
      commit there. A file tool's write to one asks on the plain card, **Allow once** · **Deny**, wherever it is; no
      card grants one, and `request_access` is refused for a write to one.
    - **The control endpoint's URL and token never reach sandboxed commands.** A domain's card says when its host is
      this Mac, a bare IP address or a name on the local network; an address in another spelling (`2130706433`) gets
      no card and no grant.
    - **`EnterWorktree` and `ExitWorktree` are disallowed** in a sandboxed session.
    - **Open in editor never runs a file:** it opens in the default text editor (`open -t`), whatever it is; an image
      or a PDF still opens in the app that shows it, and a folder is shown in Finder. So Open in editor now opens a
      Markdown or HTML file in your text editor, not in the app macOS would otherwise pick.
    - **Attachments don't follow links out of the workspace:** the lines added to `.git/info/exclude`, the image read
      when a queued message is delivered, and the folders made and deleted.
    - Calls made without Jared in this review: **the hook answers allow or deny itself, never `ask`** (that an `ask`
      overrides an allow rule is read from Claude Code's code, not probed); a command that reaches Glade in Allow all
      though it wasn't excluded still goes ahead, since some sandboxed commands ask for other reasons; the words on a
      domain's card for a local host ("This is your own Mac. Allowing it lets the agent reach every service running
      on it.", and one each for an address and a local name), which no design shows; `~/.npmrc` and `~/.pypirc` made
      credential paths no grant opens, where the meta listed `~/.npmrc` as something to grant (taken back in P15-11,
      below); and which extensions still open in their own app (PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP, PDF).
    - Left open by the review: hooks from existing settings that run files in the workspace. What it left open about
      MCP servers is decided in P15-11, next.
  - **MCP servers, and the tools that reach other agents, are grants too (P15-11, #515).** Decided with Jared after
    the review: a reasonable guard, not a locked box, and no prompt floods.
    - **An MCP server Glade doesn't build is a third kind of grant,** next to folders and domains: a server from the
      user's Claude Code config, a repository's `.mcp.json`, or a claude.ai connector (Gmail, Drive, Claude Docs).
      It runs outside the sandbox with whatever access it has. With the sandbox on, in either permission mode, the
      first call to any tool of a server that isn't granted shows a card: "The agent wants to use the `<server>` MCP
      server", with the tool being called and its input, and Allow for this task · Allow for this workspace · Deny.
      **One grant per server, never per tool or per call:** a card for every call would be a flood. Calls to the
      same server that arrive while its card is open wait on that card rather than opening their own. Once granted,
      the server's tools behave as with the sandbox off: unasked in Allow all, and asking per call in the ask mode.
    - **Glade's own tools never ask:** `glade` always, and `glade-control` as before P15 (off unless its switch is
      on; in the ask mode its tools that change things ask). A server is Glade's when the SDK says it's in-process
      (`source: 'sdk'`) and it's one the session was given, as the ask mode already told them; the name proves
      nothing, so a configured server that calls itself `glade` asks like any other.
    - **Enforced in the same `PreToolUse` hook** as the bounds (the review, above), so an allow rule for the server's
      tools in the user's or the project's settings can't skip the card.
    - **`SendMessage` and `RemoteTrigger` are granted the same way,** with the same card and scopes, and listed with
      the MCP servers: they reach agents outside the task's sandbox, which a sandboxed agent could have do what it
      may not. `SendMessage` to one of the task's own subagents never asks (they run in the same sandbox); to
      anything else it asks, "The agent wants to message other Claude sessions". `RemoteTrigger` asks, "The agent
      wants to manage cloud agents". One grant covers every other session, or every cloud agent: not one per target.
    - **A grant is kept by the name the server's tools carry** (`mcp__<server>__<tool>`: Claude Code turns every
      character of a server's name outside `[a-zA-Z0-9_-]` into `_`), since that's what each call carries and what
      Claude Code's own rules for a server are written with; the name Claude Code reports it by (`claude.ai Claude
      Docs`) is what the card and Settings show. Nothing of these grants goes into the session's sandbox settings.
    - **Settings has a third list, MCP servers,** under Folders and Domains, in Settings › Workspace and Glade-wide
      in Settings › Agent. Add… offers the servers the workspace's sessions have reported (every workspace's, for the
      Glade-wide list), by name, then the other agents. Glade keeps those names per workspace
      (`reported_mcp_servers`); nothing is granted by a server being reported.
    - **`~/.npmrc` and `~/.pypirc` are grantable again,** as single files, like any other file in the home folder:
      they hold a registry's settings as often as its token, and `npm` and `pip` need them. The review had made them
      credential paths nothing opens.
    - Calls made without Jared here: the card and the list have **no design**, and are built from the folder and
      domain cards and the Folders and Domains lists (`docs/design/README.md` says so); the card's line under its
      title ("It runs outside the sandbox, with whatever access it has. Allowing it covers every tool of the
      server.", and one each for the other agents); the names in Settings, **Messaging other Claude sessions** and
      **Cloud agents**; that only the id the SDK gave a subagent counts as the task's own (a `SendMessage` to a
      subagent by a name it was given, or to `main`, asks: a name can also be another session's, and how Claude Code
      settles that isn't probed); that a granted server's call gets no "Allowed by … grant" line in the ask mode,
      where its own card or task rule already says what was decided; that a call waiting on another call's card is
      withdrawn with it when the turn is stopped; and that a server whose name leaves nothing a tool's name can carry
      gets the plain card (Allow once · Deny).
  - **The escape battery is the sandbox's acceptance test (P15-12, #516):** with nothing granted and every card
    denied, an agent reaches nothing beyond its floor. What the floor is, what the battery tries and how to add an
    entry are in `escape-battery.md`.
    - **The real Claude Code, a stand-in for the model.** A scripted agent would test Glade's model of the sandbox,
      not the sandbox. So the battery's app runs the real backend, with the bundled Claude Code and Seatbelt, against
      a server on the same Mac that replays a fixed list of tool calls. An e2e run takes a stand-in only at
      `http://127.0.0.1:<port>`, with no other endpoint or login in the session's environment, every other host a
      dead end, and a throwaway home folder; every other e2e run and every capture still plays scripts.
    - **Everything it names is a dummy:** a home folder and workspace in the system temp folder, canary files
      holding random tokens, listeners on the loopback address, names under `.invalid`.
    - **It runs on every PR,** as one of the e2e specs on the macOS runners, and a new finding from a review is
      added as an entry in the PR that fixes it.
    - **The live red-team run with a real model is deferred** (decided with Jared: one thing at a time, and the aim
      for now is a reasonable guard against an agent clobbering the system by accident, not a locked box). When
      it's picked up it runs only in a disposable macOS VM, never on a developer's Mac; so do the attacks that would
      act on the real Mac if they got out (`launchctl`, `open`, Apple events).
    - Calls made without Jared: **the dummy home's own Claude Code settings allow everything the sandbox holds
      whatever they say** (every file tool, `WebFetch`, `Bash`, each MCP server's tools, `SendMessage` and
      `RemoteTrigger` allowed whole, the sandbox's switches at their loosest, commands kept out of the sandbox), since that is the harder case and a second pass with no settings
      would double the run for little; **a second test allows every card** in the same dummy world, to check that
      the battery sees an escape when there is one; and **`request_access` is tried only on the dummy home's
      folders**, never on `/`, `/Users` or `/Volumes`, which the unit tests cover.
  - **A session resumed into the sandbox is told of it once (P15-07, #452).** Claude Code keeps a session's system
    prompt when it resumes it, so a session that started before the sandbox was on knows nothing of it, nor that a
    blocked command is answered with `request_access`. When such a session runs sandboxed, Glade sends it what the
    prompt says of the sandbox once, as a `[Glade: this session now runs in a sandbox] … [end]` block ahead of the
    next message (the chat shows only the message), and records it in SQLite (`session_context.sandbox`) so a
    relaunch neither loses nor repeats it. A session that still runs outside the sandbox isn't told.
  - **Known friction.** Anything a command needs from the home folder fails until it's granted: toolchains
    installed there (nvm, pyenv, rustup, cargo, go), `~/.gitconfig` (commits lose their author), `~/.npmrc` and
    package caches. That's what the Glade-wide lists are for (`~/.npmrc`, a single file, is granted from its card). `ssh` git remotes, Docker, localhost databases and some
    tools that check TLS can't work inside the sandbox at all, and ask to run outside it each time. Denying the home
    folder also hides `~/.zshenv` and Claude Code's own shell snapshot from commands: they run with Glade's `PATH`
    but without the user's aliases and functions. A file granted by itself can be written in place but not replaced:
    a tool that saves by writing a new file and renaming it (`sed -i`) fails on it.
  - **Probed before turning it on (P15-07, `sdk-notes.md` §15).** Verified: a tool handler is given its call's
    `tool_use` id; single-file grants work as built, for the file tools and for commands; the credential denies hold
    under a granted parent, by path, link, case, the data volume's alias, hard link and rename; and `Monitor` fails
    with the same text as `Bash` when the sandbox can't start. **Still open:** whether Claude Code's own `git`, run
    in the workspace outside the sandbox, can be made to run a command by git config a sandboxed agent wrote (not
    probed; `sdk-notes.md` covers only Glade's own git); and that a read-write grant covering a shell startup file
    outside the workspace lets a sandboxed command write it (seen in the probe). Both are with the phase's security
    review.
  - **Calls made without Jared, for the release notes (P15).** From #445, accepted as a first pass:
    1. Allow all with the sandbox runs as `acceptEdits`: nothing inside the grants asks, and boundary crossings do.
    2. Credential files stay blocked even inside a granted folder (for example if `~` itself is granted).
    3. The Sandbox switch is app-wide, in Settings › Agent, not per workspace or per task.
    4. Running outside the sandbox can only be allowed once, with no "always for this command".
    5. Existing workspaces and tasks get the sandbox on their next start after updating, with no grants.
    6. `WebSearch` stays ungated: it runs on Anthropic's side and has no domain to check.
    7. The Glade-wide lists can only be filled from Settings: the card doesn't offer "Allow everywhere".

    From the cards (P15-05, #510):

    8. A call the task's own grant covers reads "Allowed by task grant", beside the designs' "by workspace grant"
       and "by Glade-wide grant".
    9. A blocked command is told by "Operation not permitted" (in any case) in the error of a command that failed,
       so one that failed for another reason with those words in its output is marked too.
    10. A connection's card is put on the command running when it asked (the latest started, when several are),
        since the SDK doesn't say which command made it.
    11. A `request_access` path that doesn't exist yet is asked for as it is, not by its parent folder, and
        `request_access` takes `~` and `~/…` as the home folder.
    12. A call whose folder or host can't be granted (a path with a glob character or that can't be resolved, a host
        that isn't a name) keeps the plain card, allowed once or denied.

    From #510's security review (the supervisor's):

    13. A card never offers the home folder, `/`, `/Users`, `/Volumes`, `/System/Volumes` or a folder above one of
        them. A file whose folder is one of those is asked for by itself and granted alone (a single-file grant);
        such a folder named outright is refused by `request_access`, and gets the plain card from a file tool.
    14. A denied read also denies a write to the same folder for the turn; a denied write still lets a read ask.
    15. A background subagent's requests belong to the turn its `Agent` call was made in.
    16. A card's grant that matches one the scope already keeps in another case is kept as a grant of its own.
    17. An answer refused because its folder moved while the card was open shows as "Denied", with Glade's note
        where yours would be.

    From this pass (P15-07, #452):

    18. A session resumed into the sandbox is told of it in a block of its own, `[Glade: this session now runs in a
        sandbox]`, once, ahead of its next message, and not at all while it still runs outside the sandbox. A
        session recorded before this counts as not told, so one that started sandboxed while the sandbox was still
        off by default is told once more.
- **Todos as the hub (P16, #491).** The Todos tab becomes the place for what a task produced: a todo is a step of
  work, and its **children** (files, links and commits) sit under it. The phase first set out to put everything
  under todos, subagents and watchers too; Jared then split it into activity (the Agents tab) and produced work
  (Todos), and "Todos hold produced work only", below, is where the hub got there. What's decided so far is the
  groundwork (P16-03, #494); the rest is in the phase's issues.
  - **Built dark.** The whole phase lands behind a hidden setting, `todoHubEnabled`: a boolean, off by default, with
    nothing in Settings, as P15's `sandboxEnabled` was before its switch was drawn. With it off, nothing of the hub is
    read, written, sent or shown: the tools, the prompt, the hooks and every screen are what they were, and a test
    holds that (`src/main/todo-hub/inert.test.ts`). The phase's last issue (#501) turns it on and removes the four
    tabs it replaces. To try the phase before then, turn it on by hand: quit Glade, run
    `sqlite3 ~/Library/Application\ Support/glade/glade.db "INSERT INTO settings (key, value) VALUES ('todoHubEnabled', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'"`
    and open it again (`'false'` turns it back off). In a dev build (`npm run dev`), View › Toggle Developer Tools
    and `await glade.invoke('settings.update', { patch: { todoHubEnabled: true } })` does the same without a relaunch.
  - **A todo's id is Claude Code's own** (`Task #N`, which the todo parser already read): unique within a task, the
    same across a compaction, a resume and a relaunch, and never used again once its todo is deleted
    (`sdk-notes.md` §16). It reaches the window with each todo, whatever the switch says, and the Todos tab keys its
    rows on it. A `TodoWrite` item has none: nothing can be filed under it, and its row is keyed by its place in the
    list. (Glade keeps Claude Code's task tools on for a session with the hub, #495, so that shouldn't occur.)
  - **A child is named by its kind and its own key:** a file by its artifact's path, a link by its URL, a commit by
    its hash and working tree, and a subagent (which has a todo as plumbing, and is no todo's child) by the
    `tool_use` id of the call that started it. It also has a **short id** within its task (`c1`, `c2`, …), which
    Glade shows the agent and the agent files and moves children by: given the first time Glade names the child,
    kept in SQLite, the same for the life of the task and never given to another child, even after the first is
    removed.
  - **A filing is "this child, this todo, how, when", one per child:** filing a child again replaces its filing. How
    it was filed is one of: named in the call that made it, filed by the agent when Glade asked, inherited from the
    subagent that made it, or moved by the agent.
  - **Where a child shows:** under the todo its filing names. With no filing, or once its todo is no longer in the
    list (deleted), it's under **Not under a todo**, the placeholder group, which has a reserved id (`unfiled`) for
    its own panel state. What a subagent committed (it, or a subagent of its own, however deep) is a child of the
    todo in its own right and follows the subagent's todo, unless it has a filing of its own; so giving a subagent
    another todo brings its commits. A deleted todo's filings are kept, since its id is never reused.
  - **Counts and order.** A todo counts its children by kind: files, links, changes. Nothing under a todo is live, so
    a count is never blue. A todo's list is ordered by last update, newest first: a file's last change, a link's
    last change, a commit's time.
  - **Each todo's panel remembers** whether it's open and its filter, per task in SQLite, for the placeholder group
    too.
  - **Only the agent moves a child** (P16-05, #496), with two Glade tools a session has while the switch is on, for
    the main agent only: `list_children`, which lists what the task made by the todo each is under, each with its
    short id, and `file_children`, which takes several filings in one call (a child's short id and a todo's id each)
    and makes all of them or none. There's no menu for it. It's one tool for filing and moving: it's what the agent
    answers with when Glade asks it to file what it just made (#495), and how a task from before the hub gets sorted
    ("file your things under your todos"). A subagent that's given another todo brings its commits, by the resolver,
    so no row of those is rewritten ([`model-surface.md`](model-surface.md)).
  - **Produced work is filed as it's made** (P16-04, #495), with the rule Jared picked from #492's findings
    (`sdk-notes.md` §16), narrowed when the phase split into Agents (activity) and Todos (produced work). The `Bash`
    call that commits names its todo, `[todo N]` at the start of its description, and Glade files the commit there and
    takes the marker off before the tool runs, so it shows nowhere. A call that names none goes ahead, and Glade tells
    the agent straight after it what it made, which the agent files with one `file_children` call. A turn can't end
    with a filing owed: Glade holds the end, twice at most, then lets it end, and the next turn's end asks again.
    Nothing is refused, and nothing is guessed from which todo is in progress. `add_artifact` takes the todo's id and
    needs it. An agent with no todos is told to create one first, and Glade keeps Claude Code's task tools on for its
    sessions, whatever the user's settings say ([`model-surface.md`](model-surface.md)).
    - **A subagent's todo is plumbing.** The `Agent` call names its todo the same way, and an unnamed one is asked
      about the same way. What's stored is "this subagent works on this todo", one todo each: it's what its commits
      follow, by themselves, and what its tab in the Agents tab says (#536). It's never shown under the todo. A
      subagent's subagent works on its parent's todo unless its call names another, and a subagent is never asked to
      file anything.
    - **Watchers aren't filed at all.** A `Monitor`, background `Bash`, `ScheduleWakeup` or `CronCreate` call is left
      exactly as it is: no marker asked for, read or taken off, no message after it, no hold for it.
  - **The Todos tab as the hub** (P16-06, #497; `design/screens/46-todo-hub.png` to `49-todo-hub-unfiled.png`). With
    the switch on, the Todos tab shows `TodoHub` in place of the list; no other tab changes until #501.
    - **The window groups for itself.** It loads a task's filings and its todos' panels when the tab shows the task
      (`todoHub.get`), keeps the filings current from `filings.changed`, and works out each todo's children with the
      same resolver main has (`groupChildren`), from the lists the store already keeps for the other tabs. So a child
      filed, moved, made or changed shows at once, with no reload. A `filings.changed` that lands while the hub loads
      makes it read again, so an answer made before the change never wins.
    - **Renders stay small** (`CLAUDE.md`, Performance). A todo's card is memoised on its own todo, children and
      panel, and the links its text names; a closed todo builds no list; a tile is given only which child it is and
      reads it from the store through an index made once per list, so one child's update renders that tile alone; and
      every age keeps its own clock. `src/renderer/history-renders.test.tsx` holds it at 100 todos with 50 children
      under one.
    - **The tile** (`src/renderer/todos/tiles/`) is one shell (`Tile`: icon, title, tag, what it says of itself,
      age; at rest, hover, focus, outlined) filled in by a component per kind: a file, a link, a commit. What a tile
      does and opens to is #498 (files and links) and #499 (commits).
    - **Each todo's panel is as you left it:** the window changes it at once and has main remember it
      (`todoHub.setPanel`). A filter whose kind has no children shows All, and is remembered, for when it has some
      again.
  - **Todos hold produced work only** (P16-12, #535; the screens as #534 redrew them). Still behind the switch.
    The hub was built to hold five kinds of thing under a todo (#497); it holds three: files, links and commits.
    - **No subagent and no watcher is under a todo, or under "Not under a todo":** no tile, no count, no filter
      pill, no tooltip. They're activity, and live in the Agents tab (#536, #537). Nothing under a todo is ever
      live, so no count, pill or tile is blue, and the tile's live tint and state colours are gone with the two
      tiles that used them.
    - **A subagent's todo stays, as plumbing.** The store still records which todo a subagent was started for (a
      filing of kind `subagent`, as before). It's what the subagent's commits follow, so they still land under that
      todo, and what its tab in the Agents tab says. `subagentTodo` and `subagentTodos` in `src/shared/todoHub.ts`
      read it from the todos, the subagents and the filings alone; `groupChildren` uses the same rule to place
      commits, and never returns a subagent.
    - **A watcher is no child at all:** not filed, not grouped, not given a short id. `ChildKind` has no watcher, and
      the resolver doesn't take a task's watchers.
    - **"Nothing at all" counts produced work only.** A task with no todos shows the centred "No todos yet." unless
      it has an artifact or a commit: one with only subagents and watchers has produced nothing. A task whose only
      unfiled things are subagents or watchers has no "Not under a todo" group.
    - **The agent's tools.** `list_children` lists files, links and commits, and a subagent only while it has no todo
      (with the ones under no todo, so the agent can say which todo it's for); never a watcher. `file_children` still
      takes a subagent, which sets its todo, and refuses a watcher's id with `Watchers aren't filed under todos`. The
      prompt's line about the tools names artifacts and commits ([`model-surface.md`](model-surface.md)).
    - **No migration.** The hub's tables keep their `kind` checks as they are, `watcher` included, and
      `todo_panels.filter` still allows `subagent` and `watcher`. Rows written while the hub had five kinds stay
      where they are and are read past: a watcher's filing, owed filing and short id are left out of every read
      (and its id is never given to another child), and a panel left on the Subagents or Watchers filter reads as
      All, open or closed as it was. Nothing cleans them up; a panel's row is rewritten the next time you open,
      close or filter it. Nothing writes a row of either kind any more, and the bridge refuses a panel with either
      filter.
    - **What the first design left, tidied:** `src/main/agent/child-calls.ts` knew a marker field for each of the
      five tools that could make a child; it knows the two a todo is read off (`Agent`, `Bash`), both by their
      description.
  - **Links in a todo's text** (P16-09, #500; the states strip of `design/screens/46-todo-hub.png`;
    `src/renderer/todos/todoLinks.ts`). In a todo's title and its status line, done todos included, a PR, an issue or
    a ticket the todo names is a link to it, when the task has it as a link artifact.
    - **What's matched:** `#511` for a GitHub PR or issue among the task's links, with `PR ` before it as part of the
      link when it's there (`PR #511`, as the screens draw it), and a Jira key in capitals (`API-123`) for a ticket.
      What each of the task's links is comes from its address alone (`recogniseLink`): nothing is fetched.
    - **Exact matches only, to the task's own links.** The number or key must be one the task has a link for: `#5`
      isn't found in `#51`, nor `API-12` in `API-123`. One that two of the task's links share (the same number in two
      repositories) could mean either, so it stays text. Nothing ever links to a page the task doesn't have.
    - **It stands on its own.** Not straight after a letter, a digit or `_` (inside a word: `fix#511`), nor after `/`,
      `#`, `=`, `&` or `-` (inside an address, an HTML entity or a branch's name: `example.com/#511`,
      `fix-API-123`), and not straight before a letter, a digit or `_`. A URL that is a link already stays that link,
      whole. A key in lower case (`api-123`) is text.
    - **It's the app's link** (`Link`, [`product.md`](product.md), "Links"): it opens in the browser, underlines under
      the pointer, shows its address as a tooltip, takes the focus with Tab, opens with ↵, and has the link menu
      (Open link, Copy link; no Add to artifacts, since the task has it). Clicking it neither opens nor closes the
      todo, and neither does choosing from its menu.
    - **It follows the task's links:** adding the link artifact later turns the words into a link, and removing it
      turns them back.
    - **Worked out when something changes, not on every render.** The hub works out what the task's todos may name
      once per change of its links (a file artifact that changes rebuilds nothing), then which of it each todo names,
      once per change of the todos or the links, and gives each card only its own. So a link added or removed renders
      the cards that name it and no other, and a card reads its text again only when its text or what it names
      changed. A task with no PR, issue or ticket among its links reads no todo for what it names.
  - **The Agents tab** (P16-13, #536; `design/screens/50-agents.png`, `51-agents-subagent.png`,
    `54-agents-overflow.png`; `src/renderer/agents/`). With the switch on the right panel has three tabs, **Agents ·
    Files · Todos** (⌘⌥1 – ⌘⌥3); with it off, today's seven. Both paths exist until #501.
    - **A tab for every agent.** Main, the task's own agent, is pinned first and stays put; then the subagents that
      are running, then the finished ones, the newest first within each (the order they started, reversed), nested
      ones among the rest. The subagents' part scrolls sideways when they don't fit, as the panel's own tabs do (one
      shared row, `ScrollRow`): no scroll bar, a chevron over a fade at an end with more past it. A subagent's tab has
      a dot, blue while it runs and slate once it has ended; the panel's Agents tab counts the agents, Main included.
    - **A tab's content is that agent's tool calls,** drawn by the Tool calls tab's own list and rows (`ToolLog`): the
      calls, the notes between them, their output. Main's is exactly the Tool calls tab's; a subagent's is its own
      calls and notes, with the panel to itself. A subagent an agent started is an `Agent` call in that agent's list,
      live while it runs ("Running · 29m", on the running call's highlight) and then how it ended, how long it ran and
      the first line of what it came to ("Done · 28m · Opened PR #511."); clicking it goes to the subagent's tab.
    - **The line under the strip,** on a subagent's tab: "Working on <its todo's title>" and "Running · 6m", then
      "Worked on …" and "Done · 28m" once it has ended. The todo is the one it was started for (`subagentTodo`, #495):
      a subagent's own subagent works on its parent's unless it named another. The title is a link: it shows the Todos
      tab with that todo's card scrolled into view and the focus on it. A subagent with no todo, or whose todo was
      deleted, has no line.
    - **Which agent a task is on is remembered** per task, in SQLite (`agent_tabs`, `agents.setTab`), across tasks and
      relaunches, and comes with the task's history. One that's no longer in the task's log shows Main.
    - **What pointed at the old tabs points here:** the chat's tool-calls chip shows Main's tab, scrolled to its turn,
      and a plugin's `openTask` with a subagent shows that subagent's tab.
    - **Performance:** only the list of the agent showing is mounted. The strip reads the order of the task's
      subagents and each tab its own name and state, so picking an agent renders the two tabs that changed and the new
      list, and an event of an agent that isn't showing renders nothing but, at most, that agent's tab. A list reads
      only its own agent's events (`agentEventsSelector`), so it doesn't render when another agent works. A time that
      ticks is its own element with its own clock. With the switch on the panel itself no longer reads the task's
      tool log, so it doesn't render with every event. `src/renderer/history-renders.test.tsx` holds it at 50
      subagents and a 2,000-call list.
  - **Watchers in the tool calls** (P16-14, #537; `design/screens/52-agents-watcher.png`,
    `53-agents-watcher-done.png` and the states under `50-agents.png`; `src/renderer/agents/PinnedWatchers.tsx`,
    `agentWatchersModel.ts`). With the switch on, a watcher is in the Agents tab, under the agent that started it,
    and the Watchers tab isn't shown; with it off, the Watchers and Subagents tabs are exactly as they were.
    - **Whose it is:** the agent whose call started it (`Watcher.parentToolUseId`): Main's, or a subagent's, which
      stays on that subagent's tab after the subagent has finished.
    - **Pinned while live.** A watcher whose process runs (a `Monitor` watch, a background command) is a card under
      its agent's tool calls, outside their scroll, under a **Watching** label: the eye, what the agent called it,
      "Running · 5m" in blue and **Stop**; then its kind and what it runs, the last line it reported, and how many
      times it woke the agent, when it last did and since when it has run. It's on the `live` tint. A wakeup or a cron
      job that's only scheduled is pinned the same way in grey, with when it's due ("Due in 12m", "at 13:50 · 0 wakes ·
      set 13:36"; "next" for a job that comes round again). Several stack, in the order they started.
    - **In the history once it has ended.** When it finishes, fails or is stopped it leaves the bottom and is a row
      of its agent's list at the time it ended, with the eye where a call's dot goes: its kind and label, when it
      ended, "Finished · ran 8m · woke the agent once", and its last line. It reads in order with the rows around it:
      everything logged up to then is before it, and what the agent did on being woken is after it. A watcher that
      ended at the very time of an event is before that event, since a wake ends its watcher and then starts the turn.
    - **The call that started a watcher isn't a row,** while it's live or after: the card, then the watcher's own
      row, stands for it. Until the SDK says the call started a watcher (and for a call that failed to start one), it's
      the plain call it is.
    - **The eye on an agent's tab,** with a count, while the agent has anything pinned, scheduled ones included: blue
      while a watcher's process runs, grey when all it has is scheduled.
    - **Colour:** running is blue; scheduled, finished and stopped are grey; a watcher whose own command failed is
      pink (its eye, "Failed" and how it failed). One that finished after seeing a failure is grey: it did its job.
    - **After a relaunch** it's what the Watchers tab shows: the monitors, commands and wakeups ended with the
      session ("Stopped by the relaunch."), so they're rows at the time of the relaunch; a cron job waits for its
      session, pinned in grey as "Suspended · back when the session resumes", and is scheduled again when it does.
    - **What the Subagents tab did, which #536 left out:** a subagent's tab has a menu, on a right-click and the
      keyboard's menu key, with Copy log and, while it runs, Stop subagent (`context-menus.md`); a running subagent's
      `Agent` call says what it's doing now, the SDK's one-line summary, under "Running · 6m" (#278); and the name of
      the subagent on an opened commit tile goes to that subagent's tab.
    - **Shared, not copied:** what a watcher is called, what it runs, what it last reported and its state are the
      Watchers tab's own (`watchersModel`), and Stop is the same store command.
    - **Performance:** main sends a task's whole list of watchers with every change to one. The store keeps the
      object of each watcher that's as it was (`withWatchers`), so a pinned card reads its own watcher and renders
      alone when it reports a line or wakes the agent; its state is its own element with its own clock. The list above
      reads only the agent's ended watchers and which calls started one (`logWatchersSelector`), so it doesn't render
      for a live watcher at all, and a watcher that ends adds one row and renders none of the others. The eye is read
      by its own tab. A watcher leaving the bottom gives the list its room back without moving it: someone reading back
      stays where they are, and a list at its end follows it. `src/renderer/history-renders.test.tsx` holds it at five
      pinned over a 2,000-call list with twenty ended watchers through it.
  - **Calls made without Jared, for the release notes (P16).** From the groundwork (P16-03, #494):
    1. A child whose own filing names a todo that's gone goes to the placeholder, even when the subagent that made
       it is under a todo that's still there: the agent filed it apart from its subagent, so it doesn't fall back to
       following it.
    2. An inherited filing isn't a filing of the child's own: a child still follows the subagent that made it, and
       the stored filing only places a child whose subagent Glade can't tell (an artifact a subagent declared).
    3. With the switch off, the hub's bridge commands are refused (`invalid_transition`) rather than answered empty.
    4. A todo's panel state isn't broadcast to other windows, as the Artifacts tab's filter isn't.
    5. A task from before the hub gets its children's short ids the first time Glade names them, oldest first within
       each kind: artifacts, then subagents, then commits (watchers too, until #535).

    From the agent's tools (P16-05, #496):
    6. A filing the agent makes is `moved` when the child had a filing of its own, and `asked` when it had none: one
       under no todo, or one that only followed its subagent.
    7. `file_children` is all or none: an unknown child id or a todo that isn't in the task's list is a tool error
       that says which, and nothing moves. So is a child whose artifact was removed since it was listed, and a child
       named for two different todos in one call; one named twice for the same todo counts once.
    8. A child filed under the todo it's already filed under keeps its filing as it was (how it was filed, and when),
       and the windows are told nothing. One that only shows there by following its subagent does get a filing of its
       own, so it stays when the subagent moves: the agent asked for it there.
    9. A child can't be moved back to "Not under a todo": no filing may name the placeholder.
    10. `list_children` groups by todo, every todo listed even when empty, then the ones under no todo; it can be
        narrowed to one todo or to the unfiled ones (`todo: "none"`). Each child is one line (short id, kind, title),
        titles cut to 80 characters, and a child that follows its subagent says so (`follows c3`).
    11. Both tools read ids leniently (`C3`, `#2`) and say a todo's state in Claude Code's own words (`pending`,
        `in progress`, `completed`).
    12. The prompt's one line about the tools is only in a session that starts with the switch on. A session resumed
        from before the switch is sent it with the rest of the hub's lines (26, below).
    13. A session keeps the tools it started with: if the switch is turned off under it, both answer with a tool
        error and do nothing.

    From the hub's tab (P16-06, #497):

    14. A todo with nothing under it doesn't open: it has no chevron, and →, ↵ and a click do nothing. It has nothing
        to show.
    15. A closed todo's counts aren't Tab stops (they're still buttons, for the pointer): → opens the todo, and its
        pills are. Otherwise a task with 100 todos has 500 more stops between its todos.
    16. Clicking a todo's head (its state icon, title and status line) opens and closes it; the space around its tiles
        doesn't.
    17. The hub drops the line under the heading ("The agent writes this list and checks items off as it works."), as
        the screens do.
    18. A task that made things and kept no todos says "No todos for this task." at the top, above **Not under a
        todo**, where the screens put it. One with nothing at all (no todos, and nothing made) keeps today's centred
        "No todos yet.", as the tab shows with the switch off (#500; the hub first said the line at the top for both).
    19. A todo waiting on you keeps its purple icon and status line, as everywhere in the app. Nothing sets that
        state yet.
    20. A link's tile says `#511`, a ticket's key or a page's domain after its title, as the screens draw it, and not
        the Artifacts tab's `#511 · acme/api`. #498 owns the link tile and may change it.
    21. (Gone with #535: a watcher's and a subagent's tile, and the line each showed under its name.)
    22. While the hub shows a task, main watches its file artifacts for outside edits, as it does for the Artifacts
        tab, so a file's place in its todo's list is current.
    23. Until its filings have loaded, the hub shows the todos with nothing under them, and no placeholder group,
        rather than everything under no todo for a moment.
    24. A todo's context menu (Copy, Ask agent about this) opens from its head. The placeholder group has none.

    From the links in a todo's text (P16-09, #500):

    25. `PR ` is part of the link only as it's drawn: in capitals, with one space or none before the `#`. After
        anything else (`pr #511`, `pull request #511`, `issue #501`) the number alone is the link. A number with no
        `#` (`PR 511`) never links, and neither does `owner/repo#511`.
    26. A ticket's key links only in capitals, as Jira writes it: `api-123` stays text. The link's own address may
        write it either way.
    27. A reference stands on its own: not straight after a letter, a digit, `_`, `/`, `#`, `=`, `&` or `-`, and not
        straight before a letter, a digit or `_`. So `#511.` and `(#511)` link, `API-123-backport` links its key, and
        `fix#511`, `example.com/#511` and `fix-API-123` don't.
    28. "Two of the task's links share it" is read as written: one PR given by two of its pages (`pull/511` and
        `pull/511/files`), or `issues/511` beside `pull/511` of one repository, are two links with the number, so it
        stays text, as the same number in two repositories does.
    29. Every link in a todo's text is a Tab stop, as every link in the app is, after its todo and before the todo's
        pills.

    From filing as it's made (P16-04, #495):

    30. A session has the hub for its whole life, or not at all: the switch is read as the session starts, for its
        tools, its prompt, its hooks and the task tools' switch together, as the sandbox's is. Turned on while a
        session runs, it changes nothing for that session; the task gets the hub when its session next starts.
    31. The hub's prompt paragraphs aren't in `INSTRUCTION_UPDATES`: they're tracked by themselves
        (`session_context.todo_hub`), so how many instructions a session has had is the same with the switch on or
        off. A session that started without them and resumes with the hub on is sent all three once (#496's line
        among them), ahead of its next message.
    32. The prompt paragraph is #492's cut down to the two calls a todo is read off (an `Agent` call, a `Bash` call
        that commits), reworded to say a subagent works on a todo and its commits go under it. That wording wasn't
        probed.
    33. What an agent owes a filing for is only a commit or a subagent it made itself, in a call, with the hub on, that
        named no todo. Never what the task made before the hub, a link you added, an artifact added through the
        control API, or something whose todo was deleted later (it drops to the placeholder, and nothing asks).
        What's owed is kept in SQLite, so a relaunch doesn't forget it; how often a turn was held isn't, so a turn
        carried on after a relaunch can be held twice more.
    34. A marker naming a todo that isn't in the list still comes off the call: it counts as naming none, and the
        agent is told afterwards.
    35. When a turn's end is held, the reply the agent had written goes to the tool log, and the chat shows the one
        it ends on; if it files and writes no reply again, the one it had written is the turn's. An agent that
        ignores both holds ends its turn on the reply it wrote third.
    36. A turn you stopped is never held, nor is a compaction. What an interrupted message made is taken in at the end
        of the next turn.
    37. `add_artifact` declared again with another todo moves the artifact there (`moved`). `update_artifact` takes no
        todo: moving is `file_children`'s. An artifact that's removed, by the agent, by you or through the control
        API, leaves no filing, so one added again starts under no todo. One pointed at another file or page keeps its
        todo, and gets a new short id the next time Glade names it.
    38. A named `Agent` call that started no subagent (it failed, or you denied it) leaves no todo recorded.
    39. A `Bash` call in the background is a watcher's call, so no todo is read off it, and a commit it makes is left
        under no todo with nothing asked. A foreground call the SDK moves to the background is still read: what it
        commits is filed, and the watcher it becomes isn't.
    40. A subagent's `Agent` call that names a todo of the task's has its marker taken off, as the agent's own does.
        One that names a todo that isn't there loses the marker too, and stays on its parent's todo. A marker on a
        subagent's `Bash` call is left where it is: its commits follow its todo.
    41. If the switch is turned off under a session that has the hub, its hooks still take markers off (its prompt
        still asks for them), and file, ask and hold nothing; `add_artifact` adds as it did before the hub. A session
        that then starts again has no hooks, while Claude Code keeps the prompt it started with: the markers it
        writes show until the switch is back on. That's only reachable by turning the hidden switch off by hand.
    42. (Settled by #535: the store and the agent's tools no longer know a watcher as a kind of child, and no
        subagent shows in the hub's groups.)

    From the Agents tab (P16-13, #536):

    43. A subagent's tab has two colours, as the screens draw it: blue while it runs, slate for everything else. A
        subagent that failed, was interrupted or is paused has the slate dot and is among the finished ones; its line
        and its `Agent` call say which ("Failed · 3m", "Interrupted", "Paused"). A paused one still reads "Working on".
    44. A subagent's name on its tab is what Glade calls it everywhere (its call's description, else its type). A
        long one is cut short at 200px, with the whole of it as the tab's tooltip, so one agent can't take the strip.
    45. Main's pin is the sidebar's own (the Pinned section's), not the outline the screens draw.
    46. A time reads in seconds through the first minute ("42s"), then as the task header's ages do ("6m", "1h 49m").
        It ticks every second while it reads in seconds, and as often as other ages (30s) after.
    47. Clicking an `Agent` call goes to its subagent's tab and no longer opens the call's output. What the subagent
        came to is on the call's line (its first line) and in the call's menu (Copy output).
    48. (Settled by #537: a subagent's tab has a menu with Copy log and Stop subagent, and a running subagent's
        `Agent` call says what it's doing now.) The Subagents tab's tally and call counts are still not shown: the
        screens draw neither.
    49. With the switch on, a workspace left on a tab the panel no longer shows opens on Agents; what's stored is
        left alone, so turning the switch off shows the tab it was on. One left on Agents shows Tool calls with it off.
    50. ⌘⌥4 – ⌘⌥7 pick nothing with the switch on. The binding, its name in Settings ▸ Keyboard and the menu bar are
        left for #501.
    51. A remembered agent that isn't in the task's log is kept, not cleared: if it shows up again (its log loads
        late), the task is back on it.
    52. The todo's link shows the Todos tab with the todo scrolled into view and the focus on its head; it doesn't
        open the todo.
    53. The agent a task is on isn't broadcast to other windows, as a todo's panel state isn't; with the switch off
        the command is refused and a task's history carries nothing of it.

    From produced work only (P16-12, #535):

    54. A row left from when the hub had five kinds is read past, not cleaned up: no migration deletes a watcher's
        filing or short id, or rewrites a panel left on a filter that's gone. Such rows only exist where the hidden
        switch was turned on by hand.
    55. A subagent is listed by `list_children` whenever it has no todo: one from before the hub, one the agent
        hasn't filed yet, and one whose todo was deleted. It keeps its short id across all three.
    56. When a subagent is given another todo, `file_children`'s reply names the commits that moved with it, and not
        the subagents it started, which work on that todo too: they aren't shown anywhere, and naming one would give
        it a short id for nothing.
    57. A commit that follows a subagent is marked `(follows cN)` only while that subagent is listed, that is, while
        it has no todo. Under a todo, the commit is listed plainly.
    58. A watcher's old short id is refused with its own words (`Watchers aren't filed under todos: c5.`), told apart
        from an id that was never given; any other way of naming a watcher is just not a child of the task.
    59. The bridge refuses `todoHub.setPanel` with the `subagent` or `watcher` filter, as it does any filter it
        doesn't know: only a stored row is read leniently.
    60. `groupChildren` no longer takes a task's watchers, and takes its subagents as their `Agent` calls alone: when
        each last did anything was only for a subagent's place in a todo's list.
    61. The sample task's subagents in the capture fixture keep their todos (as plumbing); its watchers lose theirs.

    From watchers in the tool calls (P16-14, #537):

    62. The call that started a watcher stays out of the list once the watcher has ended too, as screen 53 draws it:
        the watcher's row stands for it. What it ran is the tooltip of the row's label; the row doesn't open, and has
        no menu. So a permission line on that call, and its Copy command, aren't reachable in the Agents tab.
    63. An ended watcher's last line is what it last reported when it finished ("last …"), and how it ended when it
        failed or was stopped ("end You stopped it."), as the three rows under screen 50 have it; each falls back to
        the other, and a watcher with neither has no third line.
    64. A watcher that never woke the agent says "didn’t wake the agent"; then "once", then "4 times".
    65. A pinned watcher that has woken the agent says when it last did, between the count and "since": "3 wakes · last
        13:18 · since 13:02". The screens only draw one with no wakes.
    66. A cron job waiting on its session after a relaunch is pinned like a scheduled one, in grey: "Suspended", and
        "back when the session resumes" where its due time goes. It counts on the tab's eye.
    67. Pinned cards take half the panel's height at most, and scroll among themselves past that, so five watchers
        can't push the tool calls out of a short panel.
    68. Stop's accessible name says which watcher ("Stop CI checks on PR #511"), as the Watchers tab's does; the
        screens' markup names it "Stop".
    69. An agent whose only calls so far started watchers says "No tool calls yet." above what's pinned.
    70. The eye and the Stop glyph are the app's own icons (Font Awesome's, as the sidebar's eye and the Watchers
        tab's Stop), not the outlines the screens draw.
    71. A subagent's tab menu has no Expand log: picking the tab shows its log. Opening the menu doesn't pick the tab,
        and Main's tab has none.
    72. What a running subagent is doing is the Subagents tab's summary line (the body face, in the text colour) under
        "Running · 6m", on one line with the whole of it in its tooltip. The screens don't draw it.
    73. A commit tile's subagent name is a button only when the task's log has that subagent; one it hasn't got
        ("Subagent") stays plain text.
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
    (switching workspace if it has to), and with a subagent opens the Subagents tab on it, as picking it there does
    (with the hidden `todoHubEnabled` setting on, that subagent's tab in the Agents tab, #536).
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
