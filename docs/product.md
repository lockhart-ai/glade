# Glade — product overview

![Task workspace](design/screens/task-workspace.png)

## Concepts

**Workspace.** The top level: a name and a root folder. Every task's agent runs in the workspace root, so the root's
`CLAUDE.md` (your conventions and personal context) applies to every task. Task records live only in the app's SQLite
database. How tasks organise files on disk (a folder per task, worktrees inside it) is a convention written in that
`CLAUDE.md`, not something Glade enforces; Glade seeds a starter `CLAUDE.md` for a new workspace that has none. You can
have several workspaces and switch between them from the sidebar or the menu bar (⌘1–9). Close workspace (⌘⇧W) shows
the most recently opened other workspace, or the welcome screen when there's none; the workspace stays in the list,
with its terminal tabs and their shells still running.
Remove from list… asks first, then forgets the workspace and deletes its tasks from Glade; its folder is never touched.

**Task.** One agent session with one objective. A task has exactly two states:

- **Active** — created the moment you send the first message. Whether the agent is mid-turn, waiting on you, asking a
  question, stopped by an error or idle is shown in the conversation and by the status dot; it is not a separate
  state.
- **Done** — you mark it done (no dialog; an Undo toast appears). The latest status becomes its **outcome**. A done task
  stays open to chat: sending a message reopens it.

There are no follow-up tasks. One task can refer to another through its folder on disk.

![Lifecycle](design/screens/lifecycle.png)

**The task record.**

| Field | How it changes |
|---|---|
| Title | Set by the agent from your first message (`set_title`). You can rename it. |
| Objective | Set once by the agent from your first message (`set_objective`). |
| Status summary | Rewritten by the agent as work moves (`set_status`). Becomes the outcome when done. |
| Chat log | Append-only. Your messages and the agent's **final reply per turn** only. The system prompt tells the agent so: its final reply must answer you on its own, findings and all, after any follow-up work. |
| Tool log | Append-only. Every tool call, plus the agent's working notes ("preamble") between them. |

## The window

- **Left sidebar** — workspace switcher, search, New task (+), and the task list in three collapsible sections:
  Pinned, Active, Done. Pinned is left out entirely while nothing is pinned, so it doesn't take a row for an empty
  header; Active and Done keep showing, even at zero. Each row shows a state dot, title and relative time, then a
  one-line status. Under them, only while there's something to show, a compact third line of what's going on in the
  task, in this order: its todo progress (a ring and `3/7`, a check once all are done, the item in progress as its
  tooltip), its running subagents and its live watchers, each an icon and a count with a tooltip. Unread rows are bold
  with a blue dot. At its foot, under a divider, the **usage meter** (see Usage). Resizable, collapsible.
- **Task card** (centre) — a header card (state dot, title, age, pin toggle, Mark done, goal and status) floating over
  the top of the chat, and the input bar floating over its bottom. The chat, a little narrower than both, scrolls under
  them and is cut off halfway under each, so it never shows past their outer edges. The input bar has model, effort
  and permissions pickers and a context
  meter at the right. Each task keeps its unsent draft, text, pasted images, pasted text blocks and attached files,
  while you're on another task and across a relaunch or a crash, until it's sent.
- **The queue and Stop** — a message sent while the agent works waits in a numbered **queue** above the input, where
  it can be edited or removed (no "send now", no reordering). The queue goes to the agent when it finishes its current
  step, folded into the running turn; what's still queued when the turn ends starts the next turn, all of it together,
  in order. **Stop** (the square button beside Send, or ⌘.) ends the running turn, withdrawing an open question or
  permission card first; it stops only the turn, so subagents and watchers left running in the background carry on.
  Stop drops what the agent is doing, not what you said next (#441): with messages queued, the turn stops and the
  queue is sent at once as the next turn, exactly as when a turn ends on its own, so the task goes straight back to
  working. With nothing queued, the task waits on you. A queue stays where it is only while something else holds
  it: an open question or permission card (it follows your answer), a pause (it follows the resume), or a turn that
  failed on an error or a done task (it goes first with your next message). A task found waiting on you with messages
  still queued and nothing to deliver them, as a Stop before this left it, sends them when Glade next launches.
  A message's pasted images show as thumbnails above its text in the chat, and small in its row while it's queued.
  Clicking one (or ↵ or Space on it) opens the **image viewer** over the window: the image as large as fits, never
  scaled past its own size, on a dimmed backdrop. With several, ← and → step through the message's images, stopping
  at the first and last rather than going round (#463) — the pager's own Previous / next buttons disable there too,
  and the keys still step back from an end a click on one reached — under a "2 of 3"; Esc, a click on the backdrop or
  × closes it, and the focus goes to the task's input (#415).
  ![Image viewer](design/screens/30-image-viewer.png)
- **Broadcast** (#489) — one message to every Active task that has an agent, at once, in every workspace, for when
  something is happening on the machine and you don't know which agent is doing it ("Is anyone restarting Docker?").
  **Broadcast…** in the
  File menu, or ⌘⇧B, opens a modal over the window, whatever it shows: a message field, a line saying who it goes to
  ("Goes to 9 active tasks in 3 workspaces. Busy agents get it when their turn ends."), and under it the recipients,
  grouped by workspace, each task with its dot and where it stands with you (needs you, working or idle, by the one
  rule under Attention). The list is only there to read: there's nothing to pick. The modal grows with it, and past
  twelve tasks in three workspaces the list scrolls. ↵ or **Send** sends it and ⇧↵ adds a line, as in the input bar;
  Esc or a click outside closes the modal, and what was typed goes with it. With no task to send to it says "No
  active tasks to send to." and can't send.
  ![Broadcast](design/screens/45-broadcast.png)
  Each task takes the broadcast as it takes a message from its own input bar. An idle one starts a turn with it, after
  anything it already had queued; one whose agent is busy (mid-turn, paused, or waiting on a question or permission
  card) gets it at the end of its queue, where it goes when any queued message does. Unlike a message typed into the
  task's own input bar, it never answers a question card: it went to everyone, so it waits behind the question. Done
  tasks get nothing, and aren't reopened. Neither does a task that has never been sent anything: it has no agent, so
  it can't be the one doing something on the machine, and a broadcast would only start a session for nothing; it isn't
  listed or counted. (A task whose first turn is under way has an agent, and gets it; so does one an error stopped.)
  One rule decides this for the list and for the sending (`receivesBroadcast` in `src/shared/broadcast.ts`), and Glade
  decides who gets it as it sends, so the modal's count is the number of tasks that receive it. A task that can't take it (its session won't start) doesn't hold up the rest: it shows its
  error as it does when any send fails, and a toast names it.
  In each task's chat it's your own message, with a small `BROADCAST` tag beside "you" and its time, and on its row
  while it waits in a queue; the tag is kept with the message, so it's there after a relaunch. Each agent answers in
  its own chat, and a task that answers needs you by the usual rule: nothing gathers the replies anywhere else.
  ![Broadcast, in a task](design/screens/45-broadcast-message.png)
  The same viewer opens an image artifact from the Artifacts tab, and the one file showing in the Files tab (#372): for
  an artifact, it also shows the artifact's title, just above the image's left edge (it appears with the image, once
  that has loaded, never before it: #478), and two actions, Open in Files and Reveal in Finder, and steps
  through the image artifacts the Artifacts tab lists, in its order (not those in a folded date group, #378); for a
  Files tab image, it shows that one file alone. Opened either of those ways, closing it returns the focus to the row
  or thumbnail that opened it, not to the task's input: a keyboard user stepping through a list keeps their place in it.
  ![Artifact and file images](design/screens/35-artifact-image.png)
- **Pasted text** (#363) — pasting more than one line, or ~80 characters or more, into the input bar marks it as its
  own block, kept apart from what you typed, rather than dumping it into the field: a short inline token stands for it
  there, and a compact chip shows above the field ("Pasted text · 42 lines"), with a ✕ to remove it and a click to
  expand or edit. A shorter, single-line paste (a path, a word, a URL) isn't worth the ceremony and is left as plain
  typed text. In the chat, your message shows your own words with each pasted block collapsed to its line count,
  expanding in place to the pasted text itself. The agent gets each block wrapped in tags with a matching random id
  (`<pasted_content id="…">…</pasted_content id="…">`, from the Opus 5.5 prompting guide, which helps it resist prompt
  injection inside text you pasted), at its place among what you typed; the tags and the token never show in the UI.
  Kept everywhere a message is: queued, in the draft, across a relaunch, and the sidebar search matches text inside a
  pasted block too. ![Pasted content](design/screens/34-pasted-content.png)
- **Attached files** (#396) — drop any file onto the input bar, or paste one copied in Finder (⌘V), and Glade copies
  it, byte for byte, into the workspace at `.glade/attachments/<task id>/`, under its own name (`sales (2).csv` when
  the name's taken). It shows as a chip beside the image thumbnails, with an icon by its type, its name, type and size,
  and a ✕; clicking the chip reveals the copy in Finder. The agent gets a line with each file's path at the end of your
  message, never the file's contents, so it reads the exact bytes with its own tools (an image the API takes goes as an
  image too). In the chat, your message keeps the chips above its words; clicking one opens the file in the Files tab,
  or reveals it in Finder when the Files tab can't show it (a PDF, say). A folder, or a file over 200 MB, is refused
  with a toast, and a symlink is copied as the file it leads to. Glade keeps the folder out of git without touching a
  file you commit: when the workspace is in a repository, it adds `/.glade/attachments/` to that repository's own
  `.git/info/exclude`, which is never committed. Deleting the task deletes its attached files; a done task keeps them.
  Attachments stay with the draft, the queue and a relaunch, as images do.
  ![Attached files](design/screens/36-attached-files.png)
- **Links** — a link in what the agent or you wrote opens in your browser (a `mailto:` link in your mail app), never in
  Glade: in replies and your messages, the question and permission cards, the tool log's notes and output, the goal
  and status, todos, watchers and queued messages. Markdown links and bare URLs and email addresses are links; URLs in
  code aren't. A link underlines on hover, shows its address as a tooltip when its text says something else, takes the
  focus with Tab and opens with ↵; ⌘-click opens it too. Right-click it for Open link, Copy link and Add to artifacts
  (a web link only, #407). Only web and mail links open: any other kind shows as its text. With the todo hub on (the
  hidden `todoHubEnabled` setting, off until #501), a PR, an issue or a ticket a todo's title or status line names
  (`PR #511`, `#511`, `API-123`) is a link too, when the task has it as a link artifact: an exact match only, with
  nothing fetched ([`decisions.md`](decisions.md), "Links in a todo's text", #500).
- **Click code to copy** (#352) — a code span clicks to copy its exact text, with a small "Copied" tooltip for about a
  second; dragging a selection in it, or a click that ends with one, is left as ordinary text selection instead. It's
  focusable, and Enter copies it. A fenced code block, and a permission card's command or change, get a copy icon in
  their corner, shown on hover and on focus, which copies the whole block the same way. It's everywhere Glade renders
  Markdown code (replies, question cards and their preamble, backfilled notes, the tool log's notes and permission
  cards), but not the Files viewer's preview or the terminal.
- **Right panel** (inside the task card) — tabs: Tool calls, Files, Todos, Artifacts, Subagents, Watchers, Changes (the
  commits the task made; Glade watches git and never drives it). Resizable, collapsible. The selected tab is
  remembered per workspace (#432): switching workspace shows that workspace's own tab, across a relaunch; a workspace
  that's never chosen one starts from Tool calls. Artifacts holds the task's
  deliverable files and, as links (#407), the remote things it depends on: the PRs the agent opens or works on and the
  issues and tickets the task is about, added by the agent (`add_artifact`'s `url`) or by you (Add to artifacts on any
  web link). A link shows what it is from its address alone (a PR or issue's `#412 · owner/repo`, a Jira ticket's
  `API-123`, or the site's domain), opens in the browser, and is dated by when it was added; its live status isn't
  fetched. With both files and links, an All · Files · Links filter shows above the date groups, remembered per task.
  ![Artifacts](design/screens/10-artifacts.png) Files is a plain-text editor:
  a workspace file edits in place and saves with ⌘S, its tab showing a dot while it has unsaved edits, and closing it,
  switching task or quitting asks to Save, Discard or Cancel. When the agent changes a file you're editing, it reloads
  quietly, or, with unsaved edits, a bar offers Reload or Keep mine. Files from a commit, binary files and files too
  large to show whole are read-only. An image (PNG, JPEG, GIF, WebP or SVG, up to 8 MB) shows as a picture instead of
  the binary notice, fit to the panel but never scaled past its own size, on a checkerboard behind transparency;
  clicking it opens the image viewer, above. Too narrow for its tabs, the
  tab row scrolls sideways, with chevrons at the ends that have more tabs past them.
  Before the open files' tabs sits the fixed **Browse** tab (a folder icon, #398), which shows when no file does: the
  workspace's tree, folders first and then files, each by name, loaded a folder at a time as you open them, with the
  agent's changed files marked by their blue dot, right after the name. Each file has an icon for its kind (code,
  prose, a stylesheet, config, a database, an image, a lockfile, a Dockerfile, a dotfile; the plain file for anything
  else), tinted by family (code blue, images teal, data purple, config and prose grey), with its extension dimmed and
  its size at the far edge (B, KB, MB or GB, in thousands as Finder counts, with one decimal under 100; the numbers
  line up, with the unit in its own slot); a folder has a closed or open icon and no size. A name too long for its row
  gives way in the middle, so its end and extension still show, and never runs into the size. Thin guides mark each
  level, one chevron turns as a folder opens, and the folders on the way to the selected row are a little brighter;
  the row under the pointer and the selected row each show as a rounded pill. It reflects only what's on disk: no git
  status. It hides `.git` and Glade's `.glade` always, and in a git repository
  whatever git ignores there (asked of git itself), but never a file git tracks; a symlink shows only when it leads to
  something inside the workspace. The folders you leave open are kept for the task, across a relaunch. Clicking a file,
  or ↩ on it, opens it in a tab. A search at the top finds files by name or path anywhere in the workspace, as a flat
  list with each one's icon, folder and size and the match marked, best first (names that start with it, then names that hold it,
  then paths), stopping at the first 200 with how many more; Esc clears it. ↑↓ move, → and ← open and close a folder,
  and ⌘F, with the focus in the Files tab while Browse shows, goes to its search (the editor's ⌘F still finds in the
  file). The folders it shows are watched, so what the agent (or anything else) makes or deletes shows at once.
  ![Browse files](design/screens/37-browse-files.png)
- **Bottom bar** (full width) — the workspace's terminal, with tabs, and a plugin panel (Nekomata). Resizable,
  collapsible. Each workspace has its own terminal tabs; switching workspace switches them, and the other
  workspaces' shells keep running. Removing a workspace ends its shells. Clicking something in a plugin can open the
  task it shows (a Nekomata cat), switching workspace if it has to, and a subagent of it (a kitten) in the Subagents
  tab; a plugin can't do that without your click (`plugin-api.md`, `openTask`).

Each resizable panel has a drag handle in the gap on its inner edge. Dragging it takes room from the chat or gives it
back, within limits (the chat keeps its minimum width and height); collapsing a panel and showing it again brings it
back at the size you left it, and a relaunch keeps every size. The plugin panel beside the terminal has one too, in
the gap between them: it takes room from the terminal, which keeps its minimum width.

State dot colours: blue = working (the agent's turn, or subagents and watchers it left running), purple = waiting on
you, pink = error, slate = done, and an active task that's idle: nothing running and nothing new for you (see
Attention).

### Usage

The usage meter at the foot of the sidebar (`design/screens/32-usage-meter.png`) is one row: a small ring in the
context meter's colours, the usage limit closest to running out with how much of it is used ("Session 38%"), and when
it resets. Nothing read yet, or nothing said of how much is used, it's an empty ring and "Usage · within limits"; from
70% of a limit the ring and percentage turn purple, as Claude Code's own warning starts there; at a limit the row
takes the question card's highlight ("Session limit · Resets at 15:40"), while the paused tasks' banner shows across
the top as before. Clicking the row opens a popover over it that lists every limit Claude Code has told of (Session,
This week, each model's week, extra usage while it's on), each with a bar, how much is used and when it resets, under
the plan's name and above how long ago it was read ("From Claude Code · updated 2 min ago").

Glade asks Claude Code as each task's session starts and after each turn (its experimental usage call), and also reads
the rate limit events that come as each turn starts; when the call fails, the events alone keep the meter going. It
keeps the latest reading of each limit, so a relaunch shows them again, and drops each when its window resets. An API
key or a cloud provider has no plan limits, so the meter is hidden for them. Extra usage has a row from the moment it's
turned on: with nothing spent yet it reads "Extra usage 0%" (of its monthly cap), and with no cap, "within limits".

### Paused on a usage limit

A turn that runs into a usage limit pauses its task rather than stopping it on an error
(`design/screens/17-usage-limit.png`): one banner across the top for every paused task, in every workspace, saying
when they resume, and each resumes by itself when its limit resets. Messages sent meanwhile wait in the queue. Three
things end the pause sooner (#519):

- **Resume now**, on the banner beside **Switch model**, tries every task a usage limit paused again at once, each on
  its own model. A task still over the limit pauses again, with whatever reset time it's given: the banner comes back
  for it, and there's no error card. (**Switch model** does the same on another model.)
- **Glade resumes them by itself when the account can run again.** While any task is paused on a usage limit, it reads
  the account's usage again when its window gets the focus and every 5 minutes, and the usage meter shows what it
  read. When a reading says the account can run again, it resumes the paused tasks without a click: the limit that
  turned a task away is no longer spent (a bigger plan, say), or extra usage is on with room left (turned on, nothing
  disabling it, its spend limit not reached, under its monthly cap).
- A reading can be wrong, so Glade acts on what it says **once**: on extra usage being available, however much of it
  is spent, and on a limit having cleared, once for that limit's window. A task that's turned away again stays paused
  through every later reading that says the same, whatever the percentages do meanwhile. It's tried again only when
  that changes (extra usage stops being available and comes back, or the limit's window rolls over), when its limit
  resets, or when you press **Resume now**.

Glade reads usage through a session that's already running (a paused task's own stays alive), and never starts one
just to ask. So after a relaunch with every task paused it has nothing to ask until a task runs: until then the
tasks wait for their reset time or for **Resume now**. Nothing is read again while nothing is paused on a usage limit.
A task paused because the network is down is left to the network: it resumes when that's back.

### Logged out

When Claude Code's login expires, is revoked or isn't there (#409), the task stops on a card of its own in the error
card's style, not a generic API error (`design/screens/38-logged-out.png`): "You're logged out of Claude", what happened,
and that nothing is lost. **Log in** runs Claude Code's own login (`claude auth login`, from the binary Glade ships),
which opens Anthropic's sign-in page in your browser; the card waits ("Waiting for the browser…", with **Cancel**), and
once you're in, that task carries on by itself. Every other task the same lost login stopped shows the same card, now
saying you're logged in again: each has **Retry**, and **Retry all N tasks** retries them together; none is retried
without you asking. A login that fails says why, and Log in tries again. The task list's row reads "Error: logged out of
Claude · log in?". Glade never sees the credential: Claude Code saves it, as it would in a terminal.

## Attention

**Needs you.** A task needs you when it's blocked on you or has a reply you haven't read (#430, corrected by #461):
it's **asking a question**, waiting on a **permission card**, stopped on an **error** (or declined by a safety
check), or its turn ended with a **reply and the task is still unread**. Background work it left running (see below)
masks none of these: an unread reply needs you whether or not subagents or watchers still run. Opening the task reads
it, so a reply you've read no longer needs you; Mark as unread (⌘⇧U) makes it need you again. A brand-new task never
does.

**Background work counts as working, once its reply is read.** A task whose own turn has ended, whose reply you've
read, but which still has subagents or watchers running (a `Monitor` watch or a background command whose process
runs; not a wakeup or cron job that's only scheduled) shows as working, until that work finishes or the task asks a
question, waits on permission or errors. A reply that arrives while it's working in the background marks the task
unread and needing you straight away, background work or not.

A task with a read reply and nothing running is neither: it's **idle** (a slate dot, "Active · idle"), and counts only
as active.

One rule (`taskAttention` in `src/shared/attention.ts`) drives every place that shows this: the dot on the task's row
and in its header (purple needs you, blue working, pink error, slate idle), the workspace switcher's "N needs you"
(else "N active"), the menu bar's count and its Needs you and Working lists, Next task that needs you (⌘⌥↓), and the
plugin feed's `needsYou`. It's worked out from what's stored (the unread flag, open questions and permission requests,
the tool log's running subagents and the watchers), so it's right after a relaunch too: a relaunch ends the subagents
and watchers that were running, which changes nothing for a task whose reply was already unread (it still needs you),
and leaves a task whose reply was read idle.

The switcher's closed button shows the same thing before you even open it: a small purple pill, just left of the
chevron, totalling how many tasks need you across *every* workspace, the open one included, "9+" past nine, hidden at
zero. Its tooltip spells it out ("Switch workspace — 3 tasks need you").

Every count Glade shows you is a count of tasks, never of workspaces, and they're all the same rule: the switcher's
pill and the menu bar's number are the same total, and each workspace's row in the switcher's open dropdown shows its
own share of it ("N needs you"), so the rows always add up to the pill (#480).

A task you aren't looking at can still need you. When its agent sends a **final reply**, **asks a question** (`ask`)
or waits on a **permission card**, in a task you're not viewing, Glade marks the task unread, shows it
under "Needs you" in the menu bar's list while it waits on you, and sends a **native macOS notification** — even while
Glade is focused. Working notes and tool calls never notify. The notification shows the task name and the start of the reply (the first question, or the
tool and what it acts on), with **Open task** and an inline **Reply** that sends your answer to the task without
opening Glade. Settings › Notifications turns them off, or their sound on (off by default); Focus and Do Not Disturb
are left to the OS.

**The menu bar.** Glade's icon in the macOS menu bar shows what's waiting on you in every workspace: a monochrome glyph
that follows light and dark menu bars and never moves, with the count of tasks that need you beside it (blank when none
do). Clicking it drops a popover under it: **Needs you** (the task, its workspace and why: asking, permission, error,
declined by a safety check, or an unread reply), **Working** (its status line, todo progress with a thin bar, and how
long its turn has run; a task working only in the background is listed here too) and
**Recent** (the last notifications Glade sent, with their age; kept in the database, so they survive a relaunch), each
hidden while empty, or "Nothing in flight". It updates live while open; a row opens Glade on its task, switching
workspace if needed, and its footer has **Open Glade** and **Quit**. It hides on Esc or when it loses focus
(`design/html/29-menu-bar.html`).

## Permissions and the sandbox

**Two permission modes,** per task, from the input bar's picker: **Allow all**, where the agent edits files and runs
commands without asking, and **Ask before edits and commands**, where each edit, command and other tool with side
effects waits on a **permission card** in the chat (Allow once · Allow for this task · Deny, with an optional note).
A card is in the chat only while it waits; what was decided then shows on the call's row in the Tool calls list, on a
line that starts with a filled shield (`design/README.md`, screens 23 and 24).

**The sandbox** is what an agent can touch at all, in either mode. Settings › Agent › **Sandbox** turns it on for
every workspace and task; it's off to begin with while the phase's security review is open (#452), and a task takes
the switch the next time its agent's session starts. With it on:

- **What an agent can use without asking:** its workspace root, to read and write. Folders outside your home folder
  (`/usr`, `/opt/homebrew`, `/Applications`) to read, so system and Homebrew tools work. Claude Code's own temporary
  folders. And whatever you've granted. Nothing else: not the rest of your home folder, not other users' folders or
  other volumes, and no network domain at all.
- **Nothing is granted to begin with.** There's no starter list of folders or domains.
- **A grant** is a folder (read-only or read-write), one file by itself, or a domain. It has one of three scopes:
  - **This task**, from a card. It ends with the task and is listed nowhere.
  - **This workspace**, from a card or Settings › Workspace. Every task in the workspace has it.
  - **Glade-wide**, only from Settings › Agent, for what every workspace needs: a toolchain or package cache in your
    home folder, the registry it downloads from.
- **What asks.** Reaching past the grants shows a card with the shield: "The agent wants to read `~/code/acme-web`",
  "…write to…" or "…reach `registry.npmjs.org`", answered **Allow for this task** · **Allow for this workspace** ·
  **Deny**. Reading asks for read-only access and writing for read-write. There's no Allow once for a folder or a
  domain. A card never offers your home folder or anything above it: a file directly in it is asked for by itself.
- **A blocked command asks afterwards.** A command can't ask before the sandbox blocks it: it fails with "Operation
  not permitted". The agent then asks for the folder itself (Glade's `request_access` tool, `model-surface.md`), with
  its reason, on the same card, and runs the command again once you allow it. Subagents ask the same way.
- **Running a command outside the sandbox** always asks, in Allow all too, shows the command, and is only ever
  **Allow once** or **Deny**.
- **Credential files** (`~/.ssh`, `~/.aws`, `~/.netrc`, `~/.npmrc` and the like) and Glade's own data are never
  opened, even inside a folder you granted.
- **Files that run code** (git hooks and config, shell startup files, `.vscode`, `.mcp.json`, Claude Code's own
  settings) stay closed to the agent's commands inside a folder granted read-write, and a file tool's write to one
  is only ever **Allow once** or **Deny**.
- **Changes apply at once.** A grant added, removed or made read-only reaches the running tasks it covers from their
  next call, without restarting them. One exception: a domain a running task was already allowed to reach on a card
  stays reachable until its session restarts.
- **Nothing is written to your files.** Grants live in Glade's database, never in your project or `~/.claude`.
- **If the sandbox can't start,** nothing runs outside it instead: every command fails, the task stops on an error
  card that says why, and Retry starts a new session.
- **With the switch off,** agents can use any folder and reach any domain, as before the sandbox; the grants are
  kept for when it's back on.

The sandbox covers the agent's commands and file tools. The terminal tabs, Glade's own reading of your repository and
Glade's own tools run as you, as before. Your own Claude Code settings (`~/.claude/settings.json`) still apply to a
task's session, but an allow rule there can't let a call past the sandbox unasked, and a command they exclude from
the sandbox asks each time; a domain in their own sandbox lists, and their hooks and MCP servers, still apply. How it's built on the Claude
Agent SDK's sandbox is in `decisions.md` and `sdk-notes.md` §15; how to use it is in the user guide.

## Settings

Settings (⌘,) opens on Agent. Changes save as you make them.

- **General:** **Show Glade in the menu bar** (on by default): its icon, and the list under it (see Attention). Then
  the account the tasks run on and bill to, as Claude Code reports it when a task starts: the email (or "API key", a
  cloud provider, or "Not signed in"), organization, plan, and what it's signed in with. Claude Code owns the login;
  while it isn't signed in, or a lost login stops a task, a **Log in** row runs its login, as the logged-out card's
  does (see Logged out). How much of its usage limits is used shows in the usage meter at the foot of the sidebar (see
  Usage).
- **Agent:** the defaults for new tasks (model, effort and permissions: Ask first or Allow all; **Allow edits** is shown
  but disabled, as it isn't a mode yet), and two switches for what the agent keeps current: **Status summary**
  (`set_status` every turn) and **Task titles** (`set_title` from your first message). A session started with one off
  gets neither the tool nor the system prompt's ask for it. Then **Sandbox**: the **Run agents in a sandbox** switch
  and the Glade-wide Folders and Domains (see Permissions and the sandbox).
- **Notifications:** notifications on or off, and their sound.
- **Appearance:** nothing to set yet; Glade has one theme, dark.
- **Keyboard:** every shortcut, rebindable (`keymap.md`).
- **Plugins:** the plugins installed, each turned on or off, its own Reload button, and their folder (`plugin-api.md`).
  Reading the folder again (opening this section) reloads a running plugin whose files changed on disk since. A
  plugin that asks for a capability has a switch for it under its row, off until you turn it on: "Can see your Mac's
  CPU, GPU and Docker load" (`machine`). A plugin that declares settings of its own in its manifest has a row for
  each there too: its label and a select of its options, starting at the plugin's default. The choice is saved per
  plugin (SQLite), survives restarts and plugin updates, and reaches the running plugin at once, without reloading it.
- **Control:** whether other agents and scripts may drive Glade, and how to connect them (`control-api.md`).
- **Workspace** (under its own heading, by the workspace's name): its name and root folder, then its **Sandbox**:
  the folders its agents may use (the workspace root first, read-write and fixed) and the domains they may reach.

## Everything else

Every interaction is on the interaction map:

![Interaction map](design/screens/interaction-map.png)

Screens for each workflow are indexed in `design/README.md`.
