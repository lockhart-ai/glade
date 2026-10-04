# Kitten SOP

Kittens are the worker agents that do the work on Glade. A supervisor agent dispatches each one with an issue, reviews
its PR, sends back fixes, and approves and merges it. This SOP starts simple and grows as the codebase does.

**Kittens never contact Jared.** He only ever talks to a task's main agent; a kitten working inside a Glade task is a
subagent of it, so Glade itself refuses its calls to `ask`, `set_status`, `set_title`, `set_objective`, `show_file` and
the whole of `glade-control` (`docs/model-surface.md`, "Main agent only", #366) — there's no card or status change for
a kitten to raise even if it tried. A question or an update for Jared goes in the report back to the supervisor
instead (step 6, below), never through Glade's own tools.

## Kittens

1. **Review your ticket.** Read `CLAUDE.md`, the issue, its phase's meta issue, and any docs and design screens it
   links. If something is unclear or contradicts the docs, stop and report the question instead of guessing.
2. **Implement.** Work on a branch named after the issue (e.g. `p0-01-scaffold`), cut from the latest `main`. Meet
   every acceptance criterion. Commit messages are imperative and reference the ticket (`P0-01: …`).

   Build what the designs show: `docs/design/screens/*.png`, with the exact CSS in `docs/design/html/*.html`. Where
   they're silent, make the conservative call and list it under "Decisions" in your report.
3. **Update the docs.** Every change carries the doc updates it needs, in the same PR: the user guide, the reference
   docs (`docs/keymap.md`, `docs/context-menus.md`, `docs/model-surface.md`, `docs/control-api.md`,
   `docs/plugin-api.md`), the README and the docs index. If it changes how anything looks, update the screenshots that
   show it too: the design screens in `docs/design/` and the images in the README and user guide.
4. **Push up a PR.** Every `gh` call goes through `node scripts/gh-team.mjs <gh args>`. Open it as a draft
   (`pr create --draft`) and don't mark it ready: the supervisor does that once its media is published. Title
   `<id>: <issue title>`. The body is brief and ends at `Closes #N`, with no "Generated with Claude Code" footer or
   other attribution lines (commit messages keep their Co-Authored-By trailer):

   ```
   Because:
   - reason

   This commit:
   - change

   Closes #N
   ```

   Don't arm auto-merge, queue the PR or poll it for merging: the supervisor approves, queues and merges it.
5. **Check it.** Before reporting back, run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`
   (100% line coverage), `npm run build` and `npm run test:e2e` locally, and wait for the required `ci` check to go
   green on the PR (`node scripts/gh-team.mjs pr checks <N> --watch`). If it goes red, fix it with new commits. If the
   change touches a hot path, follow CLAUDE.md's Performance section and run its two tests.
   CI itself (`.github/workflows/ci.yml`) splits that work into parallel jobs, balanced to land around the same
   wall-clock time: `static` (typecheck, lint, format, build) and `unit` (`npm test`) on `ubuntu-latest`, and
   `check-design` and `e2e` (three `playwright test --shard` jobs, each building its own `out/testing`) on
   `macos-latest`, since pixel comparisons and the real app's behaviour need macOS. The sandbox's escape battery is
   one of the e2e specs, so an attack that gets out fails its shard, and `ci` with it. A final `ci` job needs all of them
   and fails if any failed or was cancelled, so branch protection and the merge queue still gate on one check.
   `unit` runs the perf tests (`*.perf.test.ts`) apart from the rest, with `npm run test:perf`: one file at a time
   with nothing alongside, since their timings swing too far among the other test files on a runner. `npm test` on
   your Mac still runs them with the rest. A budget counted in references differs by platform (a Mac's for your
   machine, the Linux runners' for CI), and each perf file says where its budgets were measured; a new one needs
   measuring on both.
6. **Report back** briefly: the PR URL, how you checked each acceptance criterion, the docs you updated, media paths,
   and decisions or open questions.

Review fixes go on the same branch as new commits. If you conflict with `main`, merge `origin/main` in; never rebase or
force-push.

Stay inside the repo. Only read and search inside your worktree, `/tmp` and paths your brief names; never run `find`,
`grep -r`, `ls`, `du` or `mdfind` over the home folder (`~`) or other folders outside those. Walking `~` touches
Desktop, Documents, Downloads and Photos and pops macOS privacy prompts on Jared's screen. If you need something from
outside, ask the supervisor.

### Tests

- **Bug fixes recreate the bug.** A bug-fix PR adds a test that fails without the fix and passes with it, and the PR
  description names that test.
- **Features get stressed, not just covered.** A feature PR adds tests that push on it: edge cases, failure paths and
  interactions with the rest of the app. 100% line coverage alone isn't enough.
- **No real Claude API.** Unit and integration tests use the fake backend; e2e uses the scripted fake agent
  (`launch({ agentScript })`, scripts in `src/main/agent/scripts.ts`). One spec is the exception, and still makes no
  real API call: the sandbox's escape battery (`e2e/escape-battery.spec.ts`, `docs/escape-battery.md`) runs the real
  backend and the bundled Claude Code against a stand-in for the model on the same Mac
  (`launch({ standInModel })`), with a dummy home folder. Don't use the stand-in for anything else.
- **A sandbox finding gets a battery entry.** A PR that fixes a way past the agent sandbox adds the attack to the
  escape battery, and says in its description that the entry is reported `ESCAPED` with the fix reverted
  (`docs/escape-battery.md`, "Adding an entry").
- **UI changes need an e2e spec.** A PR that changes the UI adds or extends a Playwright spec in `e2e/` that drives the
  real app through the workflow. Use the fixtures in `e2e/fixtures.ts` (`launch`, `tempFolder`, `chooseFolder`) and the
  locators in `e2e/selectors.ts`, and wait on locators, never on timers.
- **A spec runs a function in the main process with `inMain`** (`e2e/in-main.ts`, #486), never Playwright's
  `app.evaluate`: that runs it inside whatever main is doing, even in the middle of one of its queries, where a read
  throws "This database connection is busy executing a query". `inMain` has main run it on a turn of its own, and the
  lint fails a spec that calls `app.evaluate`.
- **A failed e2e test keeps its evidence** (#483, `e2e/evidence.ts`). Read it before guessing at a cause, and before
  running the test again: a rare failure may not come back. It's in the test's folder under `out/e2e-results/`, and
  the list reporter prints each path under the failure:
  - `attachments/main-log-….log`: the app's main log for the test, every launch (`docs/logs.md`). Follow one task with
    `grep '"taskId":"<id>"'`: the commands main got (`ipc`), its turns (`runner`), its messages (`chat`) and each
    change sent to the window (`task`; a `task updated` line names the fields that changed, `unread` among them).
  - `attachments/tasks-json-….json`: the tasks as main had them when the test failed (id, workspace, title, state,
    activity, unread, asking, awaiting permission, background work, and whether it needed you), with the workspace
    main had as shown and the task it counted as viewed, which a reply is judged against. If the test had closed its
    app, it says so instead.
  - `error-context.md`: Playwright's own snapshot of the page, which is the window's side of the same moment.

  On CI, a failed e2e shard uploads the folder as the run's `e2e-results-<shard>` artefact:
  `node scripts/gh-team.mjs run download <run id> -n e2e-results-<shard> -D /tmp/e2e-results`. A test that passes keeps
  nothing. The log's lines about the environment are left out and the home folder is written `~`, so nothing kept
  names whose Mac it ran on; `e2e/evidence.spec.ts` checks all of this on tests that fail on purpose.
- **Stress specs** (`e2e/stress/`) hunt for a rare failure over hundreds of runs on a loaded machine. They're no part
  of `npm run test:e2e` or CI (`playwright.config.ts` ignores the folder unless `GLADE_E2E_STRESS` is set); each says
  at its top how to run it and what it writes down.
- **Tools that launch Electron run outside the command sandbox, in the background.** `npm run render-design`,
  `npm run check-design`, `npm run screenshot`, `npm run record` and `npm run test:e2e` (and long test runs) go
  outside the sandbox and in the background, then you wait for them to finish: never as a long, silent foreground
  command. Hidden Electron windows don't paint inside the sandbox or while the Mac sleeps. `render-design` stops by
  itself when no screen finishes for 60 s, and names the step it was stuck on. If a render still passes 2 minutes,
  kill only your own Electron, with your worktree's absolute path, and retry once:
  `pkill -9 -f "<your worktree>/node_modules/electron"` (the script exits once its Electron is gone). Never a bare
  `pkill -f render-design`: it kills every kitten's renders, and any shell whose command mentions render-design.
- **No visible windows or OS capture.** The app runs with a throwaway database in a window that is never shown. Never
  use `npm run dev` for checks, or `screencapture`, `osascript` or System Events: they pop windows and permission
  dialogs up on Jared's screen.

### Screenshots and recordings

- **Any visual change needs media.** If your PR changes anything the user can see, however small, capture it and list
  the files in your report. A visual PR with no media isn't done.
- **Screenshots:** `npm run screenshot -- --out <dir> [--size 1920x1200 ...] [--route #gallery] [--name <name>]`, with
  `--seed` fixtures from `scripts/fixtures/` or `--agent-script`. Compare them with the design screens.
- **`--press` can't reach menu accelerators** in capture mode (⌘, for Settings, ⌘J or ⌘B for panels). Collapse panels
  with the seed's `collapsed` field, and open Settings by clicks (`scripts/screenshot.mjs` has the path). An app
  command with no button to click runs with `--command <id>` instead, as choosing its menu bar item would:
  `--command app.broadcast` opens the Broadcast modal.
- **`--classic-scrollbars`** captures macOS's always-on scroll bars, as a Mac with a mouse or "Show scroll bars:
  Always" draws them; e2e specs get the same with `launch({ classicScrollbars: true })`.
- **Interactive changes need a recording:** `npm run record -- --out <dir> [-g <test title>]` writes a `.webm`, `.mp4`
  and `.gif` per e2e test, over the DevTools protocol.
- Save every PNG, GIF and MP4 to `out/pr-media/pr-<N>/` in your worktree (gitignored) and list their absolute paths in
  your report. Never commit them, and never write the `Screenshots:` or `Recordings:` sections of the PR body: the
  supervisor publishes them. When you edit a PR body yourself, fetch it first and change only `Because`/`This commit`.
- **Name a before/after pair `before-<what>.png` / `after-<what>.png`**, with the same `<what>` for both (e.g.
  `before-empty-state.png` / `after-empty-state.png`); the publish step tables them side by side under Before | After.
  Name every other screenshot and recording descriptively (`empty-state.png`, not `screenshot-1.png`): the publish
  step captions it with that name.

## Supervisor

- **Review for real** against the issue, the designs and the media before approving. Send fixes back to the kitten.
  A bug fix without a test that recreates the bug, or a feature whose tests only cover its lines, goes back too. So
  does a PR missing the doc updates or screenshot updates it needs, or a visual change whose report lists no media.
- **Publish media before approving.** Every PR with a visual change gets its media published first: no visual PR
  merges with an empty Screenshots or Recordings section. Publish with `node scripts/publish-media.mjs <N> <folder>`
  (`--dry-run` first to check the new body). It pushes to the orphan `screenshots` branch and rewrites the PR's
  Screenshots and Recordings sections.
- **Mark it ready last.** Kittens open PRs as drafts, so a draft is still in progress and a non-draft PR always has its
  media. Publish the media, review, then mark it ready with `node scripts/gh-team.mjs pr ready <N>` before approving.
- **Merge** by approving, then queueing with `node scripts/gh-team.mjs pr merge <N>`. Don't use `--auto`: it doesn't
  enqueue a PR that's already mergeable.
- **After every merge**, check the open PRs and the merge queue: others may now conflict or need re-queueing.
- **Migration numbers:** give each parallel PR its own, so none clash. Gaps are fine: the runner applies every
  migration a database hasn't recorded, in version order, whichever PR lands first.

### Phase release

1. **Verify** the phase's done-when criteria on `main`: all checks, coverage and the e2e suite.
2. **Record the handback:** record the phase's workflows into a folder with an `index.txt` of
   `name<TAB>caption<TAB>done-when` lines (one per recording) plus `compare-<screen>.png` app-vs-design images, then
   `node scripts/publish-media.mjs --handback p<N>-handback <folder>`, which prints the comment markdown.
3. **Bump the version** in a PR, per `docs/releasing.md`. Its release notes include a "Calls made without Jared (please
   review)": every call made where the docs were silent.
4. **Tag** the merged commit and push the tag.
5. **Close the meta issue** with a comment: the release link, what was verified, and the handback markdown.

## Dependabot PRs

Dependabot (`.github/dependabot.yml`) checks for updates every week and opens three kinds of PR, labelled
`dependencies`:

- **The Claude Agent SDK** (`deps: bump the claude-agent-sdk group …`): `@anthropic-ai/claude-agent-sdk` and its
  platform packages, which carry the Claude Code binary Glade ships. One PR per bump, whatever its size, keeping the
  exact pin.
- **Everything else on npm:** every minor and patch update in one grouped PR, and each major update as its own PR.
- **GitHub Actions** (`ci: bump …`): one PR per action.

**Held majors.** Dependabot skips these major updates (the `ignore` list in `dependabot.yml`); we raise them by hand
once the reason goes away:

- **`@types/node`:** the main process runs on Electron's Node (Node 24 in Electron 44), so the Node types stay on that
  major. Raise them with the Electron major that moves Node.
- **`typescript`:** TypeScript 7, the native port, waits until typescript-eslint and vitest support it.
- **`eslint` and `@eslint/js`:** eslint-plugin-react 7.37.5 doesn't support ESLint 10
  ([jsx-eslint/eslint-plugin-react#3977](https://github.com/jsx-eslint/eslint-plugin-react/issues/3977)). Revisit
  when it ships a release that does.
- **`vite` and `@vitejs/plugin-react`:** electron-vite 5 accepts only vite 5 to 7 (vite 8 support is only in its 6.0.0
  betas), and plugin-react 6 needs vite 8. Revisit when electron-vite 6.0.0 is stable.

### SDK bumps

The supervisor dispatches a kitten to each SDK bump. It works on the Dependabot branch (merging `origin/main` in if it
falls behind, like any other PR) and:

1. **Reads the changelog** between the old and new versions (`npm view @anthropic-ai/claude-agent-sdk` and the
   package's `CHANGELOG.md`), and diffs the SDK's `sdk.d.ts` between them.
2. **Re-checks `docs/sdk-notes.md`** against the new types and behaviour: the event shapes Glade parses, the rate limit
   event, the experimental usage call, compaction, `supportedModels`, `accountInfo`, and anything else the notes flag.
   It fixes whatever breaks on the same branch, and records anything that changed in the notes.
3. **Updates the notes' pinned version** (the "Tested" line at the top).
4. **Runs every check** in "Check it" above, e2e included.
5. **Packages the app and probes it** as `docs/releasing.md` describes: `check-packaged-claude` on the build, then one
   real probe of the packaged app, which must return a result. That probe is the only real Claude call.
6. **Reports back** with the changes it found and what it did about each, and the probe's output.

### Other npm and Actions bumps

- **The grouped minor and patch PR** merges once CI passes, unless it includes Electron or electron-builder: then a
  kitten packages the app and runs `check-packaged-claude` on it first.
- **A major update** gets a kitten: it reads the release notes for breaking changes, fixes what breaks on the same
  branch, and runs every check. Electron and electron-builder majors also get the packaged-app check.
- **An Actions bump** merges once CI passes. If it touches an action that only `release.yml` uses, dry-run the release
  workflow on the branch first (`docs/releasing.md`).

The supervisor reviews and merges Dependabot PRs like any other: approve, then queue.
