# Conventions

How work on Glade is named and organised: Glade tasks, issues, branches, commits, pull requests, todos, artifacts,
design screens, migrations and releases. One form for each, so that work started in any task reads the same in the
repository and in Glade. It records what the repository already does where practice had settled, and picks one form
where it hadn't (#601). `CLAUDE.md` has the working rules and code conventions; `docs/kitten-sop.md` has the steps
from ticket to merged PR.

## At a glance

| Thing        | Form                                                    | Example                                                 |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| Glade task   | Title Case, the area it owns                            | `OpenRouter Support`                                    |
| Issue title  | `Area: what is wrong or wanted`                         | `Todos: old todos stay after a session restart`         |
| Branch       | `<issue>-<short-slug>`                                  | `593-stable-todo-list`                                  |
| Commit       | `<issue>: Imperative summary`                           | `593: Keep one todo list per task across restarts`      |
| PR title     | the same as its squash commit                           | `593: Keep one todo list per task across restarts`      |
| Todo         | `#<issue>: Issue title (PR #<n>)`                       | `#593: Todos: old todos stay after a restart (PR #594)` |
| Todo's note  | where it stands now and the next step, kept current     | `Waiting on Jared: review of PR #602`                   |
| Link         | `Issue #<n>: short title`, `PR #<n>: short title`       | `PR #594: one todo list per task`                       |
| Design       | `<nn>-<kebab-name>.html` and `.png`, next free number   | `46-todo-hub.html`                                      |
| Migration    | `<nnnn>-<kebab-purpose>.ts`, next free number           | `0072-retired-todos.ts`                                 |
| Release      | tag `vX.Y.Z`, branch `release-vX.Y.Z`, notes in `docs/` | `v0.28.0`, `docs/releases/v0.28.0.md`                   |

## Glade tasks

A task is one long-running piece of ownership, not one ticket.

- **Title:** Title Case, two to four words, naming the area the task owns: `Glade Development`, `OpenRouter Support`,
  `Agent Sandboxing`. No verbs, no issue numbers, no "catch-up" or "follow-ups".
- **Goal:** one or two sentences on what the task owns and how it works, written to stay true for the task's life.
- **Status** (the "Now" line): one line on what is in flight, naming issues and PRs by number: `#598 in CI; the tab's
  Stranded group is next`. When nothing is in flight, say so.
- **Who owns what:** one task leads (`Glade Development`): general bug fixes, dependency updates and every release.
  Each other task owns one feature area and its issues. A task works only on issues and PRs it owns.
- **Before touching an existing issue, PR or branch,** call `list_other_tasks` and check that no other task has it
  among its links or in its goal or status. If one does, stop and ask.

## Issues

- **Title:** `Area: what is wrong or wanted`, in sentence case, with no full stop. The area is the part of the app a
  user would name: `Todos`, `Agents tab`, `Chat`, `Task list`, `Input bar`, `Settings`, `Models`, `Usage meter`,
  `Menu bar`, `Files`, `Terminal`, `Plugins`, `Sandbox`, `OpenRouter`; or `Docs`, `Tests`, `CI`, `Release` for work
  on the project itself. A bug says what happens (`Todos: old todos stay after a session restart`); a feature says
  what it gives (`Agents tab: a dispatched child's token totals on its line`).
- **No phase ids in titles.** `P15-14:` and the like are retired: an issue's number is its id. A larger effort has
  one umbrella issue, titled `Area: the effort (meta)` and labelled `meta`, whose body lists its child issues as a
  task list and states what is true when the effort is done.
- **Body,** in this order, leaving out a section that has nothing in it:
  1. What was seen or asked, quoting the owner's words where there are any.
  2. `## Decided`: who decided what, and when. Calls made without the owner say so.
  3. `## Behaviour`: what the app does once this is done.
  4. `## Acceptance criteria`: statements that are true when it is done, not a list of work.
- **Labels:** exactly one kind: `bug`, `feature`, `documentation`, `design`, `infra` (tests, CI, tooling), `spike`
  or `dependencies`. Add `meta` to an umbrella issue. Nothing else is needed: the title's area does the rest.
- **One issue, one piece of behaviour.** Something found on the way gets its own issue, filed at once, not a
  paragraph in a PR.

## Branches

- `<issue>-<short-slug>`: the issue number, then two to four lowercase words joined by hyphens:
  `593-stable-todo-list`. No tool or agent prefix (`codex/…`), no phase id.
- A second PR for the same issue takes a different slug: `593-close-stranded-todos`.
- Releases use `release-vX.Y.Z`.
- Anyone who edits files works in their own git worktree. The main checkout stays on `main`, clean.

## Commits

- `<issue>: Imperative summary`, in sentence case, with no full stop: `593: Keep one todo list per task across
  session restarts`.
- A merge of main into a branch says what it brings: `593: Merge main (the Agents tab's token totals)`.
- A release commit is `Release vX.Y.Z`; a later change to its notes is `Release vX.Y.Z: what changed`.
- Commits keep their `Co-Authored-By` trailer.

## Pull requests

- **Title:** the same form as a commit, since it becomes the squash commit on `main`.
- **One issue per PR.** An issue may take several PRs; a PR never covers two issues.
- **Body,** in this shape, with no attribution footer:

  ```
  Because:
  - why this change is needed

  This commit:
  - what it changes

  Not in this change:
  - what was left for a later PR, if anything

  Calls made without Jared:
  - each decision the issue didn't settle

  Closes #123
  ```

  Use `Refs #123` in place of `Closes` when the issue stays open for a later PR. Leave out a section that would be
  empty. A PR with nothing visible says "No UI changes, so there are no screenshots."

- **Screenshots and recordings** are published to the PR (`scripts/publish-media.mjs`), never committed. A PR that
  changes what a user sees stays a draft until its media is published.
- **Design screens** land in the code PR that builds them. A mockup under review is a Glade artifact, not an issue
  or a PR of its own.
- The PR's author doesn't approve or merge it. It merges through the merge queue once reviewed.

## Todos in a Glade task

- **One todo per issue:** `#<issue>: Issue title (PR #<n>)`, adding each PR number as it opens:
  `#593: Todos: old todos stay after a session restart (PR #594, PR #598)`.
- **A release** is its own todo: `Release v0.29.0`.
- **Note:** the one line under the todo's title, on where it stands now and the next step: `PR #598 in CI; the tab's
  group is next` (#609).
- **Keep every todo current.** The list is how Jared follows the work, so a todo's state and its line change in the
  same turn as the work does: a kitten started, its plan came back, a push, CI red or green, approved, queued,
  merged. A todo is in progress only while someone is on it or something it started is still running, and completed
  only once its PR is merged or the work is dropped (`Merged Oct 12`, `Dropped: not needed after #594`).
- **Waiting on Jared comes first.** When a todo can't move until he reviews or decides something, its line starts
  with that and says what he is to look at: `Waiting on Jared: review of PR #602`,
  `Waiting on Jared: pick a mockup (A or B)`. Change it as soon as he answers.
- Work that has no issue yet gets an issue first, then a todo.
- A kitten's description starts with its todo in square brackets, `[todo 95] Fix the coverage gap`, so what it makes
  is filed under that todo.

## Artifacts

Everything a task produces is filed under the todo it belongs to.

- **Links:** `Issue #<n>: short title`, `PR #<n>: short title`, `Release vX.Y.Z`, `Review of PR #<n>`.
- **Files:** say what the file is and what it shows: `Mockup: Stranded group in the Todos tab`,
  `As built: the Broadcast modal (PR #507)`, `Brief: OpenRouter backend`.
- Mockups and working files live in the workspace's `.glade/` folder, which git ignores.

## Design screens

- `docs/design/html/<nn>-<kebab-name>.html` with its PNG in `docs/design/screens/`, taking the next free number.
  Variants of one screen share the number: `45-broadcast.html`, `45-broadcast-empty.html`.
- Sample data is the invented Acme workspaces, never real names or paths.
- `docs/design/README.md` gains the screen's entry in the same PR.

## Migrations

- `src/main/db/migrations/<nnnn>-<kebab-purpose>.ts`, taking the next free number, with a test beside it.
- Check the number again just before merging: another task may have taken it. The later PR renumbers.
- Migrations only go forward. A release that adds one says so in its notes.

## Releases

- The lead task cuts every release, after checking with `list_other_tasks` what the feature tasks still have in
  flight.
- Version `X.Y.Z`: a minor release for a batch of changes; a patch release only for one urgent fix with nothing else
  in flight.
- Branch `release-vX.Y.Z`, PR and commit `Release vX.Y.Z`, tag `vX.Y.Z` on the merged commit.
- Notes in `docs/releases/vX.Y.Z.md`, in this order: an opening paragraph; what a user notices, each item ending with
  its PR number; `## Under the hood`; `## Running it`; `## Calls made without Jared (please review)`;
  `**For Jared to check:**`; `**Known:**`.
- `docs/releasing.md` has the steps.
