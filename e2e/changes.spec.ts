import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { MAKES_COMMITS, REPLIES_BRIEFLY } from '../src/main/agent/scripts'
import { SHELL_GIT_ENV } from '../src/main/agent/scripted-shell'
import { expect, test, type Glade, type LaunchOptions } from './fixtures'
import { changesTab, chat, filesTab, firstRun, inputBar, taskList, taskPanel } from './selectors'

/** The scripts the tasks play, by their first message: one makes the design's commits, the other one more. */
const SCRIPTS = {
  [MAKES_COMMITS.prompt]: 'makes-commits',
  [MAKES_COMMITS.otherPrompt]: 'makes-another-commit',
} as const

/** Runs a shell command as a person would at their terminal, with none of the machine's git config. */
function sh(command: string, cwd: string): string {
  return execFileSync('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...SHELL_GIT_ENV }, encoding: 'utf8' })
}

/**
 * A folder holding the Acme API's repository, with a first commit of a person's and a release script, as someone's
 * existing project is: the workspace. The subagent's worktree goes beside it.
 */
function acmeApi(tempFolder: () => string): string {
  const root = join(realpathSync(tempFolder()), 'acme-api')
  mkdirSync(root)
  sh(MAKES_COMMITS.setup, root)
  return root
}

/** Sends a task its first message, in a new task, and waits for the agent's reply. */
async function newTask(window: Page, prompt: string, reply: string): Promise<void> {
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(prompt)
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies.last()).toContainText(reply)
}

/** The short hash of a commit's row. */
async function shortHash(window: Page, subject: string): Promise<string> {
  const hash = await changesTab(window).row(subject).getAttribute('data-hash')
  return (hash ?? '').slice(0, 7)
}

/** Opens the Changes tab (⌘⌥7). */
async function showChanges(window: Page): Promise<void> {
  await window.keyboard.press('Meta+Alt+Digit7')
  await expect(taskPanel(window).tab(/^Changes/)).toHaveAttribute('aria-selected', 'true')
}

/** Launches the app on the workspace, and has the first task make its commits. */
async function makeCommits(launch: (options: LaunchOptions) => Promise<Glade>, root: string): Promise<Glade> {
  const glade = await launch({ agentScriptsByFirstMessage: SCRIPTS, chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await newTask(glade.window, MAKES_COMMITS.prompt, MAKES_COMMITS.reply)
  await showChanges(glade.window)
  return glade
}

const MADE = [MAKES_COMMITS.merge, MAKES_COMMITS.guide, MAKES_COMMITS.bump, MAKES_COMMITS.fix]

test('changes: the commits a task and its subagent made, newest first, each opening to its files, and a file to Files', async ({
  launch,
  tempFolder,
}) => {
  const root = acmeApi(tempFolder)
  const { window } = await makeCommits(launch, root)
  const changes = changesTab(window)

  // Every commit the agent made, however it made it: printed, by the release script, amended, by the subagent in its
  // worktree, and the merge. Not the person's first commit.
  await expect(taskPanel(window).tab(/^Changes/)).toHaveText('Changes 4')
  expect(await changes.rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).toEqual(MADE)
  await expect(changes.panel).not.toContainText('Start the Acme API')
  await expect(changes.panel).not.toContainText('Bump the version+')
  await expect(changes.row(MAKES_COMMITS.merge)).toContainText('main · just now · merge')
  await expect(changes.row(MAKES_COMMITS.guide)).toContainText(`${MAKES_COMMITS.worktreeBranch} · just now`)
  await expect(changes.row(MAKES_COMMITS.guide)).toContainText(MAKES_COMMITS.subagent)
  await expect(changes.row(MAKES_COMMITS.fix)).toContainText('+1−1main · just now')
  await expect(changes.row(MAKES_COMMITS.fix)).not.toContainText(MAKES_COMMITS.subagent)

  // The fix's file is still in the workspace: it opens in Files as it is now.
  const fix = await shortHash(window, MAKES_COMMITS.fix)
  await changes.header(MAKES_COMMITS.fix).click()
  await expect(changes.files(fix).getByRole('listitem')).toHaveText(['Msrc/date.ts+1−1'])
  await changes.file(MAKES_COMMITS.fix, 'src/date.ts').click()
  await expect(taskPanel(window).tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(filesTab(window).contents).toContainText('toISOString')
  await expect(filesTab(window).openInEditor).toBeVisible()

  // The subagent's rename and logo, in its worktree beside the workspace: the file opens as its commit left it.
  await showChanges(window)
  const guide = await shortHash(window, MAKES_COMMITS.guide)
  await changes.header(MAKES_COMMITS.guide).click()
  await expect(changes.files(guide).getByRole('listitem')).toHaveText([
    'Adocs/logo.pngbinary',
    'Rdocs/upgrade.md → docs/upgrading.md+2−0',
  ])
  await changes.file(MAKES_COMMITS.guide, /docs\/upgrading\.md/).click()
  await expect(taskPanel(window).panel.getByText(`As of ${guide} · read-only`)).toBeVisible()
  await expect(filesTab(window).contents).toContainText('Run the migrations before you start the server.')
  await expect(filesTab(window).openInEditor).toHaveCount(0)

  // Another task committing in the same repository has its own, and takes none of these.
  await newTask(window, MAKES_COMMITS.otherPrompt, MAKES_COMMITS.otherReply)
  await showChanges(window)
  await expect(taskPanel(window).tab(/^Changes/)).toHaveText('Changes 1')
  await expect(changes.rows).toHaveCount(1)
  await expect(changes.row(MAKES_COMMITS.other)).toBeVisible()
  await taskList(window).taskRow(MAKES_COMMITS.title).click()
  await expect(taskPanel(window).tab(/^Changes/)).toHaveText('Changes 4')
  await expect(changes.panel).not.toContainText(MAKES_COMMITS.other)
})

test('changes: still there after a relaunch and the worktree’s removal, its files read from the repository', async ({
  launch,
  tempFolder,
}) => {
  const root = acmeApi(tempFolder)
  const first = await makeCommits(launch, root)
  // The last commit is linked just after the reply: quit once it is.
  await expect(taskPanel(first.window).tab(/^Changes/)).toHaveText('Changes 4')
  const guide = await shortHash(first.window, MAKES_COMMITS.guide)
  await first.close()
  sh(`git worktree remove --force ${MAKES_COMMITS.worktree}`, root)

  const { window } = await launch({ agentScriptsByFirstMessage: SCRIPTS, chosenFolder: root })
  const changes = changesTab(window)
  await taskList(window).taskRow(MAKES_COMMITS.title).click()
  await showChanges(window)
  await expect(taskPanel(window).tab(/^Changes/)).toHaveText('Changes 4')
  expect(await changes.rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).toEqual(MADE)

  await changes.header(MAKES_COMMITS.guide).click()
  await expect(changes.files(guide).getByRole('listitem')).toHaveCount(2)
  await changes.file(MAKES_COMMITS.guide, /docs\/upgrading\.md/).click()
  await expect(taskPanel(window).panel.getByText(`As of ${guide} · read-only`)).toBeVisible()
  await expect(filesTab(window).contents).toContainText('Run the migrations before you start the server.')
})

test('changes: a workspace that isn’t a git repository says so', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'notes')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'replies-briefly', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await newTask(window, 'Draft the release notes.', REPLIES_BRIEFLY.reply)
  await showChanges(window)
  await expect(taskPanel(window).tab(/^Changes/)).toHaveText('Changes')
  await expect(changesTab(window).panel).toContainText('This workspace isn’t a git repository.')
})
