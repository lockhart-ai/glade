// A commit's tile in the todo hub (P16-08, #499), end to end with the scripted agent: the commits a task and its
// subagent really made, each a tile that opens in place to its branch, the subagent that made it and its files, and
// a file that opens in the Files tab.
//
// The task keeps no todos, and nothing files its commits (#495), so they're under no todo: the placeholder group, which
// is then the whole list.
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { MAKES_COMMITS } from '../src/main/agent/scripts'
import { SHELL_GIT_ENV } from '../src/main/agent/scripted-shell'
import { CommandName } from '../src/shared/bridge'
import { expect, test } from './fixtures'
import { agentsTab, chat, filesTab, firstRun, inputBar, taskList, taskPanel, todoHub } from './selectors'
import { invoke } from './task-view'

const MADE = [MAKES_COMMITS.merge, MAKES_COMMITS.guide, MAKES_COMMITS.bump, MAKES_COMMITS.fix]

/** The only task's commits, as main has them: newest first. */
async function commitsOf(window: Page) {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return (await invoke(window, CommandName.TasksHistory, { id: tasks[0]?.id ?? '' })).commits
}

test('the todo hub: a commit’s tile opens to its branch, the subagent that made it and its files, and a file opens in Files', async ({
  launch,
  tempFolder,
}) => {
  // Someone's repository, with a first commit of theirs and a release script: the workspace.
  const root = join(realpathSync(tempFolder()), 'acme-api')
  mkdirSync(root)
  execFileSync('/bin/sh', ['-c', MAKES_COMMITS.setup], { cwd: root, env: { ...process.env, ...SHELL_GIT_ENV } })
  const { window } = await launch({ agentScript: 'makes-commits', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill(MAKES_COMMITS.prompt)
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.last()).toContainText(MAKES_COMMITS.reply)

  await taskPanel(window)
    .tab(/^Todos/)
    .click()
  const hub = todoHub(window)
  const panel = taskPanel(window).tabPanel
  const tile = (subject: string) => panel.getByRole('group', { name: `Change: ${subject}`, exact: true })
  const files = (hash: string) => panel.getByRole('list', { name: `Files in ${hash}` })
  const short = new Map((await commitsOf(window)).map(({ subject, hash }) => [subject, hash.slice(0, 7)]))
  const fix = short.get(MAKES_COMMITS.fix) ?? ''
  const guide = short.get(MAKES_COMMITS.guide) ?? ''

  // Every commit the task made is a tile, newest first: its short hash, subject, lines and age, `merge` on the merge.
  await expect(hub.noTodos).toBeVisible()
  await hub.kind(hub.cards, '4 changes').click()
  await expect(hub.kind(hub.cards, '4 changes')).toHaveAttribute('aria-pressed', 'true')
  await expect(hub.tiles(hub.cards)).toHaveCount(4)
  expect(
    await hub.tiles(hub.cards).evaluateAll((tiles) => tiles.map((each) => each.getAttribute('aria-label'))),
  ).toEqual(MADE.map((subject) => `Change: ${subject}`))
  await expect(tile(MAKES_COMMITS.fix)).toHaveText(new RegExp(`^${fix}${MAKES_COMMITS.fix}\\+1 −1 · now$`))
  await expect(tile(MAKES_COMMITS.merge)).toContainText(`${MAKES_COMMITS.merge}merge`)
  await expect(tile(MAKES_COMMITS.fix)).not.toContainText('merge')
  await expect(files(fix)).toHaveCount(0)

  // The fix opens in place to its branch and its file, which is still in the workspace: it opens in Files as it is now.
  await tile(MAKES_COMMITS.fix).click()
  await expect(files(fix).getByRole('listitem')).toHaveText(['Msrc/date.ts+1−1'])
  await expect(tile(MAKES_COMMITS.fix)).toContainText('main')
  await expect(tile(MAKES_COMMITS.fix)).not.toContainText(MAKES_COMMITS.subagent)
  // The other tiles stay shut.
  await expect(panel.getByRole('list', { name: /^Files in / })).toHaveCount(1)
  await files(fix).getByRole('button', { name: 'src/date.ts' }).click()
  await expect(taskPanel(window).tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(filesTab(window).contents).toContainText('toISOString')
  await expect(filesTab(window).openInEditor).toBeVisible()

  // The subagent's rename and logo, made in its worktree: its tile says its branch and who made it, a renamed file
  // from and to, and a binary one with no lines. The file is only in git, so it opens as the commit left it, read-only.
  await taskPanel(window)
    .tab(/^Todos/)
    .click()
  await tile(MAKES_COMMITS.guide).click()
  await expect(files(guide).getByRole('listitem')).toHaveText([
    'Adocs/logo.pngbinary',
    'Rdocs/upgrade.md → docs/upgrading.md+2−0',
  ])
  await expect(tile(MAKES_COMMITS.guide)).toContainText(MAKES_COMMITS.worktreeBranch)
  await expect(tile(MAKES_COMMITS.guide).getByTitle(`Made by the subagent “${MAKES_COMMITS.subagent}”`)).toHaveText(
    MAKES_COMMITS.subagent,
  )
  await files(guide)
    .getByRole('button', { name: /docs\/upgrading\.md/ })
    .click()
  await expect(taskPanel(window).panel.getByText(`As of ${guide} · read-only`)).toBeVisible()
  await expect(filesTab(window).contents).toContainText('Run the migrations before you start the server.')
  await expect(filesTab(window).source).toBeVisible()
  await expect(filesTab(window).editor).toHaveCount(0)
  await expect(filesTab(window).openInEditor).toHaveCount(0)

  // The keyboard alone: ↵ on a tile opens it, Tab reaches its file, and ↵ on the tile closes it again.
  await taskPanel(window)
    .tab(/^Todos/)
    .click()
  await tile(MAKES_COMMITS.fix).focus()
  await expect(tile(MAKES_COMMITS.fix)).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(files(fix).getByRole('listitem')).toHaveCount(1)
  await window.keyboard.press('Tab')
  await expect(files(fix).getByRole('button', { name: 'src/date.ts' })).toBeFocused()
  await tile(MAKES_COMMITS.fix).focus()
  await expect(tile(MAKES_COMMITS.fix)).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(files(fix)).toHaveCount(0)

  // The subagent's name on its commit goes to that subagent's tab in the Agents tab (#537).
  await tile(MAKES_COMMITS.guide).click()
  await tile(MAKES_COMMITS.guide).getByRole('button', { name: MAKES_COMMITS.subagent, exact: true }).click()
  await expect(taskPanel(window).tab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
  await expect(agentsTab(window).tab(MAKES_COMMITS.subagent)).toHaveAttribute('aria-selected', 'true')
  await expect(agentsTab(window).list).toContainText('git')
})
