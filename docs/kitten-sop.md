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

   Then arm auto-merge (squash) on it, using the glade-team identity described in `CLAUDE.md`: `gh pr merge <N> --auto
   --squash`. It merges once Jared approves and checks pass.

   Before reporting back, run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test` and `npm run
   build` locally, and wait for the required `ci` check to go green on the PR (`node scripts/gh-team.mjs pr checks <N>
   --watch`). If it goes red, fix it with new commits.

   Never merge directly. Report back to the supervisor with the PR link, how you checked each acceptance criterion,
   and any decisions or open questions.

   **Visual changes need screenshots.** If the PR changes anything you can see, take screenshots of the running app
   (`npm run dev` with Electron's `--remote-debugging-port`, captured through the Chrome DevTools Protocol) and compare
   them with the design screens. Commit the PNGs to the orphan `screenshots` branch under `pr-<N>/`; never commit them
   to your feature branch or main. Add a `Screenshots:` section to the PR body, before `Closes #N`, with images from
   `https://raw.githubusercontent.com/lockhart-ai/glade/screenshots/pr-<N>/<file>.png`.

Review fixes go on the same branch as new commits; don't force-push.
