# Kitten SOP

Kittens are the worker agents that do the work on Glade. A supervisor agent dispatches each one with an issue, reviews
its PR, sends back fixes, and approves and merges it. This SOP starts simple and grows as the codebase does.

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
4. **Push up a PR.** Every `gh` call goes through `node scripts/gh-team.mjs <gh args>`. Title `<id>: <issue title>`.
   The body is brief and ends at `Closes #N`, with no "Generated with Claude Code" footer or other attribution lines
   (commit messages keep their Co-Authored-By trailer):

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
   green on the PR (`node scripts/gh-team.mjs pr checks <N> --watch`). If it goes red, fix it with new commits.
6. **Report back** briefly: the PR URL, how you checked each acceptance criterion, the docs you updated, media paths,
   and decisions or open questions.

Review fixes go on the same branch as new commits. If you conflict with `main`, merge `origin/main` in; never rebase or
force-push.

### Tests

- **Bug fixes recreate the bug.** A bug-fix PR adds a test that fails without the fix and passes with it, and the PR
  description names that test.
- **Features get stressed, not just covered.** A feature PR adds tests that push on it: edge cases, failure paths and
  interactions with the rest of the app. 100% line coverage alone isn't enough.
- **No real Claude API.** Unit and integration tests use the fake backend; e2e uses the scripted fake agent
  (`launch({ agentScript })`, scripts in `src/main/agent/scripts.ts`).
- **UI changes need an e2e spec.** A PR that changes the UI adds or extends a Playwright spec in `e2e/` that drives the
  real app through the workflow. Use the fixtures in `e2e/fixtures.ts` (`launch`, `tempFolder`, `chooseFolder`) and the
  locators in `e2e/selectors.ts`, and wait on locators, never on timers.
- **No visible windows or OS capture.** The app runs with a throwaway database in a window that is never shown. Never
  use `npm run dev` for checks, or `screencapture`, `osascript` or System Events: they pop windows and permission
  dialogs up on Jared's screen.

### Screenshots and recordings

- **Any visual change needs media.** If your PR changes anything the user can see, however small, capture it and list
  the files in your report. A visual PR with no media isn't done.
- **Screenshots:** `npm run screenshot -- --out <dir> [--size 1920x1200 ...] [--route #gallery] [--name <name>]`, with
  `--seed` fixtures from `scripts/fixtures/` or `--agent-script`. Compare them with the design screens.
- **`--press` can't reach menu accelerators** in capture mode (⌘, for Settings, ⌘J or ⌘B for panels). Collapse panels
  with the seed's `collapsed` field, and open Settings by clicks (`scripts/screenshot.mjs` has the path).
- **`--classic-scrollbars`** captures macOS's always-on scroll bars, as a Mac with a mouse or "Show scroll bars:
  Always" draws them; e2e specs get the same with `launch({ classicScrollbars: true })`.
- **Interactive changes need a recording:** `npm run record -- --out <dir> [-g <test title>]` writes a `.webm`, `.mp4`
  and `.gif` per e2e test, over the DevTools protocol.
- Save every PNG, GIF and MP4 to `out/pr-media/pr-<N>/` in your worktree (gitignored) and list their absolute paths in
  your report. Never commit them, and never write the `Screenshots:` or `Recordings:` sections of the PR body: the
  supervisor publishes them. When you edit a PR body yourself, fetch it first and change only `Because`/`This commit`.

## Supervisor

- **Review for real** against the issue, the designs and the media before approving. Send fixes back to the kitten.
  A bug fix without a test that recreates the bug, or a feature whose tests only cover its lines, goes back too. So
  does a PR missing the doc updates or screenshot updates it needs, or a visual change whose report lists no media.
- **Publish media before approving.** Every PR with a visual change gets its media published first: no visual PR
  merges with an empty Screenshots or Recordings section. Publish with `node scripts/publish-media.mjs <N> <folder>`
  (`--dry-run` first to check the new body). It pushes to the orphan `screenshots` branch and rewrites the PR's
  Screenshots and Recordings sections.
- **Merge** by approving, then queueing with `node scripts/gh-team.mjs pr merge <N>`. Don't use `--auto`: it doesn't
  enqueue a PR that's already mergeable.
- **After every merge**, check the open PRs and the merge queue: others may now conflict or need re-queueing.
- **Migration numbers** clash between parallel PRs. The second to land renumbers its migration.

### Phase release

1. **Verify** the phase's done-when criteria on `main`: all checks, coverage and the e2e suite.
2. **Record the handback:** record the phase's workflows into a folder with an `index.txt` of
   `name<TAB>caption<TAB>done-when` lines (one per recording) plus `compare-<screen>.png` app-vs-design images, then
   `node scripts/publish-media.mjs --handback p<N>-handback <folder>`, which prints the comment markdown.
3. **Bump the version** in a PR, per `docs/releasing.md`. Its release notes include a "Calls made without Jared (please
   review)": every call made where the docs were silent.
4. **Tag** the merged commit and push the tag.
5. **Close the meta issue** with a comment: the release link, what was verified, and the handback markdown.
