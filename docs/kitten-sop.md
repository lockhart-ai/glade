# Kitten SOP

Kittens are the worker agents that do the work on Glade. A supervisor agent dispatches each one with an issue, reviews
its PR, and sends back fixes. Jared approves and merges. This SOP starts simple and grows as the codebase does.

1. **Review your ticket.** Read `CLAUDE.md`, the issue, its phase's meta issue, and any docs and design screens it
   links. If something is unclear or contradicts the docs, stop and report the question instead of guessing.
2. **Implement.** Work on a branch named after the issue (e.g. `p0-01-scaffold`), cut from the latest `main`. Meet
   every acceptance criterion. Commit messages are imperative and reference the ticket (`P0-01: …`).
3. **Push up a PR.** Title `<id>: <issue title>`. The body is brief and ends with `Closes #N`:

   ```
   Because:
   - reason

   This commit:
   - change

   Screenshots: (when visual)

   Closes #N
   ```

   The body ends at `Closes #N`: no "Generated with Claude Code" footer or other attribution lines. (Commit messages
   keep their Co-Authored-By trailer.)

   Then arm auto-merge (squash) on it, using the glade-team identity described in `CLAUDE.md`: `gh pr merge <N> --auto
   --squash`. It merges once Jared approves and checks pass.

   Before reporting back, run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run
   build` and `npm run test:e2e` locally, and wait for the required `ci` check to go green on the PR (`node scripts/gh-team.mjs pr checks <N>
   --watch`). If it goes red, fix it with new commits.

   Never merge directly. Report back to the supervisor with the PR link, how you checked each acceptance criterion,
   and any decisions or open questions.

   **Visual changes need screenshots.** If the PR changes anything you can see, take screenshots with `npm run
   screenshot -- --out <dir> [--size 1920x1200 ...] [--route #gallery] [--name <name>]`, not `npm run dev` and remote
   debugging. It captures from inside Electron, in a window that is never shown, with a throwaway database. Never use
   OS-level capture or automation (`screencapture`, `osascript`, System Events): they pop windows and permission
   dialogs up on Jared's screen. Compare the PNGs with the design screens. Save them to
   `/private/tmp/claude-501/-Users-decker-Documents-glade/22a56592-db4d-4483-a6f8-3de038868265/scratchpad/pr-<N>/`
   and list them in your report; the supervisor pushes them to the orphan `screenshots` branch under `pr-<N>/`. Never
   commit them to your feature branch or main. Add a `Screenshots:` section to the PR body, before `Closes #N`, with
   images from `https://raw.githubusercontent.com/lockhart-ai/glade/screenshots/pr-<N>/<file>.png`.

   **UI changes need an e2e spec.** A PR that changes the UI adds or extends a Playwright spec in `e2e/` that drives
   the real app through the workflow (`npm run test:e2e`; CI runs it too). Use the fixtures in `e2e/fixtures.ts`
   (`launch`, `tempFolder`, `chooseFolder`) and the locators in `e2e/selectors.ts`, and wait on locators, never on
   timers. The app runs with a throwaway database, in a window that is never shown.

   **Interactive changes need a recording.** If the PR changes how something behaves, record the specs with `npm run
   record -- --out <dir> [-g <test title>]`. It writes a `<spec>--<test>.webm`, `.mp4` and `.gif` per test, recorded
   over the DevTools protocol, not OS capture. Save them to the same `pr-<N>/` folder as the screenshots and list them
   in your report; the supervisor publishes them. Link the MP4s in a `Recordings:` section of the PR body, before
   `Closes #N`.

Review fixes go on the same branch as new commits; don't force-push.
