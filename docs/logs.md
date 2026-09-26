# Logs

Glade keeps a thorough log of what the main process does, so that after a session you can read what happened and find
what worked and what didn't. The logs stay on your Mac: nothing is sent anywhere.

## Where they are

- **The app:** `~/Library/Logs/glade/main.log` (Electron's logs folder). Open it in Console.app, or
  `tail -f ~/Library/Logs/glade/main.log`. The folder is named after the package, `glade`, in lower case, as the app's
  data folder is (`~/Library/Application Support/glade/`): the packaged app has no `productName` of its own.
- **Rotation:** once `main.log` passes 5 MB it becomes `main.1.log`, the old `main.1.log` becomes `main.2.log`, and so
  on. Five old files are kept (`main.1.log` is the newest); older ones are deleted.
- **Development** (`npm run dev`): the same file, and every line on the terminal too.
- **Tests:** unit tests log to memory (`src/main/logging/memory-sink.ts`) or a temp folder. The e2e and screenshot runs
  write to `logs/main.log` in their throwaway data folder, never to yours.

## What a line looks like

One JSON object per line:

```json
{"time":"2026-09-24T10:15:03.412Z","level":"info","scope":"runner","taskId":"6431e16e-…","msg":"turn started","turn":1,"messages":1,"queued":0,"reopening":false}
```

- `time`: when, in UTC.
- `level`: `debug`, `info`, `warn` or `error`. Debug is on, while we dogfood.
- `scope`: which part of the app (below).
- `taskId`: the task it's about, on every line that has one.
- `msg`: what happened, a short fixed phrase you can grep for.
- the rest: the fields that say more, which differ by message.

## Scopes

| Scope           | What it logs                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `app`           | Start (version, platform, packaged or not, which agent backend, where the log is) and quit; windows opening, a page failing to load, the window's process dying; workspaces and settings changing; uncaught exceptions and unhandled rejections in main. |
| `env`           | The environment the agents run in: from the login shell or Glade's own (and why), its `PATH`, and at debug every variable, with secrets redacted. |
| `db`            | The database opening: its file, and the schema version before and after migrating.                        |
| `ipc`           | Every command from the window: its name, task, how long it took, and whether it failed (with the error). Never its request. |
| `agent`         | Each agent session starting, resuming and closing (model, effort, folder, the SDK session id, the Claude Code executable and `PATH`); every message the SDK sends, by type and subtype, with tool names and ids, and usage, cost and duration for results; the usage limit; messages it couldn't read; and what the Claude Code process prints to its error output, a warning per line (`agent stderr`, below). |
| `runner`        | Turns starting and ending, and each result; stops, retries, API errors and their retries; pauses resuming; subagents starting and being stopped; compaction; the queue delivered mid-turn; turns resumed after a relaunch; tool calls allowed without asking (debug), and permission requests made, answered and withdrawn. |
| `task`          | A task created, deleted, and each change of its state, activity, error, pause, retry, question, permission request waiting, title, model, effort, permission mode and session id. |
| `chat`          | Each message added (who, which turn, how long) and the queue. The text itself at debug.                   |
| `tools`         | Each tool call starting and finishing (name, id, the subagent call it belongs to, how long it took, and whether it failed), narration, dividers, compactions, todos, artifacts and files shown. Tool input and output at debug. |
| `questions`     | Questions asked, answered (with the card or in words) and withdrawn. The questions and answers at debug.  |
| `permissions`   | Permission requests opened (tool, call id, subagent), allowed, denied and withdrawn. The call's input and a deny note at debug. |
| `notifications` | Each notification sent, opened and replied to, and ones not sent because notifications are off.          |
| `terminal`      | Terminal tabs opening and closing, shells starting and exiting (with their exit code or signal).          |
| `plugins`       | The plugins found each time the plugins folder is read (how many, and each invalid one with its reason), plugins turned on and off, and the folder failing to be read. The shown plugin's view made and destroyed (and why), the status it sets (debug), its event feed starting after each `ready` (debug: how many tasks the snapshot held), and what its sandbox refuses: requests, files outside its folder, navigation, new windows, permissions, downloads, and messages that are malformed or too many. |
| `control`       | Each call to the `glade-control` tools ([`control-api.md`](control-api.md)): the tool, the caller (the calling task's id, or `http`, over MCP or `/v1`), the task it acts on, how long it took, and `ok` or the error code. The text of a message it sends at debug, cut short. The HTTP endpoint starting (host, port, and the chosen port when it fell back), stopping and failing to start; the token regenerated; each request refused before a tool saw it (why: bad host, origin or token, no token, no such path or tool, wrong method, too large, not JSON, rate limited; the status, method and path); and a request failing inside Glade. Never a token. |
| `renderer`      | Errors in the window: uncaught errors, unhandled rejections, and errors React caught (with its component stack). |
| `test-mode`     | The screenshot and e2e runs.                                                                              |

## Text and secrets

- **Text is cut short.** Your messages, the agent's, tool input and output, and questions and answers are logged at
  debug level, cut to 500 characters, saying how many more there were. No string in the log is ever longer than 4,000
  characters.
- **Secrets are redacted.** Any field or environment variable whose name looks like a secret's (`*_KEY`, `*_TOKEN`,
  `*_SECRET`, `*PASSWORD*`, `authorization`, `cookie`, …) is logged as `[redacted]`, however deep it is. Glade never
  handles your Claude credentials itself, so they never reach the log.
- **Never logged:** what you type into a terminal tab, its output, and the requests the window sends main.

## The agent's error output

What each task's Claude Code process prints to its error output (stderr) goes to the log, a warning per non-blank line,
in the `agent` scope with the task's id: `{"msg":"agent stderr","line":"…"}`. It's limited, so a process that floods
it can't flood the log:

- A line is cut to 1,000 characters, saying how many more there were.
- At most 20 lines are logged every 10 seconds, per task. The first line past that logs `agent stderr limited` (with the
  limits); the rest are counted, and the next line logged after the 10 seconds logs `agent stderr lines dropped` with
  how many weren't. A line split across two writes is logged as two.

```sh
grep '"msg":"agent stderr' ~/Library/Logs/glade/main.log
```

## Reading it

Everything about one task:

```sh
grep '"taskId":"6431e16e' ~/Library/Logs/glade/main.log
```

What went wrong:

```sh
grep -E '"level":"(warn|error)"' ~/Library/Logs/glade/main.log
```

With `jq`, a task's turns and tool calls:

```sh
jq -c 'select(.taskId == "6431e16e-…" and (.scope == "runner" or .scope == "tools")) | [.time, .msg, .name, .state]' ~/Library/Logs/glade/main.log
```

## How it's built

`src/main/logging/`: a small `Logger` (`logger.ts`) that every part of main is handed, never imports, so a test can hand
it one that keeps what it logs. Each record is formatted as a JSON line (`format.ts`) and written with
[electron-log](https://github.com/megahertz/electron-log) (`file-sink.ts`), which appends it to the file, rotates by
size and prints to the terminal in development. What main tells the window (task changes, messages, tool calls,
questions) is logged on its way out (`event-log.ts`); the runner logs its sessions and turns, and each SDK message
(`../agent/sdk-message-log.ts`). The window sends its errors over the bridge (`log.rendererError`,
`src/renderer/errors/reportErrors.ts`).
