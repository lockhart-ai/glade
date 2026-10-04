# Doc images

The 26 screenshots in [README.md](../README.md) and [the user guide](user-guide.md) (everything under
`docs/images/`, `docs/images/glade-icon.png` aside) are each captured from the current app, on made-up data, from a
recorded recipe: a seed fixture in `scripts/fixtures/` (`src/main/capture-seed.ts` has the format) and
`npm run screenshot` (`scripts/screenshot.mjs`), or, for three of them, a small script that needs more than that.
None of it talks to the real Claude API: capture mode always uses the scripted test backend.

## Regenerating

```sh
node scripts/fixtures/doc-images.mjs            # every image
node scripts/fixtures/doc-images.mjs hero control   # only these
```

Each image is captured in a window that's never shown, then saved with a 256-colour palette (`ffmpeg-static`), as
every image here already is. Regenerating overwrites the file in `docs/images/` in place; look it over (and check it's
under about 150 KB, and shows no `/var/folders` or `/Users/` path) before committing.

**Nekomata** (`nekomata.png`) needs its built Glade plugin, from its own repo
(github.com/lockhart-ai/nekomata, `./build.sh glade`), which isn't in this one: pass its folder as an extra argument
after `--`, or set `NEKOMATA_PLUGIN`:

```sh
node scripts/fixtures/doc-images.mjs nekomata -- <nekomata>/dist/glade/nekomata
NEKOMATA_PLUGIN=<nekomata>/dist/glade/nekomata node scripts/fixtures/doc-images.mjs
```

Without one, `nekomata` is skipped (with a message saying why); the other 25 still regenerate. Its own page is much
bigger than the sample plugins in `scripts/fixtures/plugins/`, and draws its cat cafe onto a canvas it redraws from a
`resize` its page gets once Glade places it at its slot's real size, not from the window's: a single shot is still
mid-load when the app quits (logging a load failure that's really just that race), and even once it's loaded, a
capture's `settle()` only waits for its fonts, not for that redraw to finish, so the canvas can still be blank the
moment it's taken. `nekomata.mjs` asks for three shots, the real size last twice, settling the view again each time
(each one re-sends its size and re-waits) and giving its redraw the real time between them to finish before the one
it keeps.

**A capture that lands on a blank "Loading…" page** is a rare flake in the capture pipeline, not a bad seed: just
run the command again.

**A capture no longer lands mid-animation.** Before a shot, the page waits not just for its size but until nothing's
busy and every running animation (a question card's entrance) has finished (`waitForSize` in `src/main/capture.ts`,
sharing its settle script with `--click`'s). A seed can still avoid the entrance animation outright by dating what
opens it (a `questionSet`, a `permissionRequests` entry) more than two seconds before the capture — any `minutesAgo`
above 0 clears it (`APPEAR_WINDOW_MS` in `src/renderer/questions/QuestionCard.tsx`), which every fixture here does.

## The images

| File | Shows | Recipe |
| --- | --- | --- |
| `hero.png` | The app with a workspace open: the task list, a task's chat, its tool calls. | `--seed task-workspace.json --size 1600x1000` |
| `subagents.png` | A task working with three subagents running and one done. | `--seed subagents.json --size 1600x1000` |
| `question.png` | A question card: the agent's reply, four questions, Anything else. | `--seed question.json --size 1600x1100` |
| `permission.png` | A permission card for a Bash command, and another for a file edit's diff; in the Tool calls list, what was decided about the calls answered before them. | `--seed permission-card.json --size 1600x1000` |
| `nekomata.png` | The Nekomata plugin beside the terminal: a cat per task, a question bubble over the one waiting on you. | `nekomata.mjs` (needs the built plugin) |
| `control.png` | Settings › Control, turned on, with the endpoint and the connect command. | `--seed settings-control.json --size 1600x1000`, clicked to Control |
| `guide/window.png` | The whole window: task list, chat and header, right panel, terminal. | `--seed task-workspace.json --size 1440x960` |
| `guide/welcome.png` | The first-run welcome screen. | no seed, `--size 1280x800` |
| `guide/working.png` | A working task: the queue above the input bar, Stop beside Send. | `--seed agent-working.json --size 1280x800` |
| `guide/broadcast.png` | The Broadcast modal over the window: the message field, who it goes to, and the recipients by workspace. | `--seed broadcast.json --size 1280x800 --command app.broadcast` |
| `guide/menu-bar.png` | The menu bar popover: needs you, working, recent. | `menu-bar.mjs` (the popover's own 360px-wide box) |
| `guide/files-browse.png` | The Files tab's Browse tree, folders open, a file selected. | `files-browse.mjs` (builds a sample workspace under `/tmp`) |
| `guide/artifacts.png` | The Artifacts tab: files and links under Today and Yesterday, the All · Files · Links filter. | `--seed artifacts.json --size 1280x880` |
| `guide/permission-card.png` | A single open permission card, for a Bash command; in the Tool calls list, an allowed call, a denied one and the one waiting. | `--seed permission-card-bash.json --size 1280x800` |
| `guide/settings-general.png` | Settings › General, with the account. | `--seed settings-general.json --size 1280x800`, clicked to General |
| `guide/settings-control.png` | Settings › Control, turned on. | `--seed settings-control.json --size 1280x800`, clicked to Control |
| `guide/backfilled.png` | A backfilled task: its handoff note, its notes files as artifacts. | `--seed backfilled.json --size 1280x880` |
| `guide/sandbox-folder-card.png` | Two sandbox cards: a folder to read, and a subagent's folder to write; in the Tool calls list, a read a workspace grant let through and the one waiting. | `--seed sandbox-folder-card.json --size 1280x800`, clicked to settle |
| `guide/sandbox-file-card.png` | The card for one file (`~/.gitconfig`), raised by the agent after its commit was blocked; the blocked command in the Tool calls list. | `--seed sandbox-file-card.json --size 1280x800`, clicked to settle |
| `guide/sandbox-domain-card.png` | A domain card for a command's connection, and the folder card the agent raised with `request_access` after a blocked command, with its reason. | `--seed sandbox-domain-card.json --size 1280x980`, clicked to settle |
| `guide/sandbox-outside-card.png` | The card for running a command outside the sandbox: Allow once or Deny; the earlier decisions on their rows. | `--seed sandbox-outside-card.json --size 1280x800`, clicked to settle |
| `guide/sandbox-server-card.png` | The card for an MCP server (#515): its name, what allowing it means, the tool being called and its input; in the Tool calls list, a server allowed for the workspace, a call its grant let through, a message to another session allowed, and cloud agents denied. | `--seed sandbox-server-card.json --size 1280x860`, clicked to settle |
| `guide/sandbox-failed.png` | A task stopped on the error card because its sandbox couldn't start. | `--seed sandbox-failed.json --size 1280x800`, clicked to settle |
| `guide/settings-sandbox.png` | Settings › Agent: the Sandbox group's switch and the start of the Glade-wide folders. | `--seed settings-sandbox.json --size 1280x800`, clicked to Agent |
| `guide/settings-workspace-sandbox.png` | Settings › Workspace: the root, the granted folders and the domains. | `--seed settings-sandbox.json --size 1280x800`, clicked to the workspace's section |
| `guide/settings-mcp-servers.png` | Settings › Workspace scrolled to its MCP servers list (#515): a server and Messaging other Claude sessions granted, and the row Add… opens, with the first server there is to add chosen. | `--seed settings-sandbox.json --size 1280x800`, clicked to the workspace's section, then **Add…** on the list (its new row takes the focus, which scrolls the list into view) |

`--command <id>` runs an app command in the window as choosing its menu bar item would (`app.broadcast` opens the
Broadcast modal, which no button does), since capture mode can't send menu accelerators.

A "clicked to `<section>`" recipe opens Settings by clicking, not ⌘, (capture mode can't send menu accelerators,
`scripts/screenshot.mjs`'s header): the workspace switcher
(`button[aria-label="Switch workspace"]`), then **Workspace settings…** (the switcher menu's 4th button), landing on
the Workspace section; then the wanted section in the nav, General 1st, Agent 2nd and Control 7th
(`APP_SECTIONS` in `src/renderer/settings/sections.ts`). `scripts/fixtures/doc-images.mjs` has the exact selectors.

A "clicked to settle" recipe clicks the right panel's selected tab (`[role="tab"][aria-selected="true"]`), which
changes nothing: a click waits for its element, so the capture waits until the task is on screen. Without it, a
capture at the window's own starting size (1280×800) can be taken while the app still shows "Loading…", as it was
for two of the sandbox card seeds, every time. The Settings › Agent page is taller than its dialog, so its image
shows the Sandbox group's switch and the top of its lists; the workspace's image shows whole lists.

## Keeping a sample task's dot honest

Since #430/#433, a task's dot is purple only when it's genuinely blocked on you or has a reply you haven't read: an
open question, an open permission request, an error, or `unread: true` in its seed. A sidebar row whose status says
"Waiting on you: …" needs one of those, or it shows as idle (slate) instead, however its status reads
(`src/shared/attention.ts`) — true of the *selected* task too: being open (and so read) is no excuse. Most
background "Waiting on you" rows here get `unread: true` for this. `question.png` and `nekomata.png` instead give
their task an actual open question set, since the picture is about it; so does "Add rate limiting to public API",
the selected task in `task-workspace.json`, `files-browse.json`, `settings-general.json` and `settings-control.json`
(the one shared seeds that select it): its final reply used to end in a question typed as plain text ("Should it get
a tighter limit of 60 a minute, or share the default 120?"), which the dot rules don't see, so it was leading with
"Waiting on you" and showing idle. It now asks for real, with that first sentence as the question card's preamble and
the choice as its question.

## The seed format's open question set

A task showing an open question card (`QuestionSet`) is something the capture seed format couldn't express before
this: a seed could open a permission request, but not a question. `SeedQuestionSet` (`src/main/capture-seed.ts`) adds
a task-level `questionSet` (a preamble, questions, a turn and `minutesAgo`), applied with the same
`appendQuestionSet` the real `ask` tool uses, so the task's `asking` flag (and so its purple dot) comes out the same
way a real one would. Covered in `src/main/capture-seed.test.ts`.
