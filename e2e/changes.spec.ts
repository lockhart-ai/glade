import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { MAKES_COMMITS } from '../src/main/agent/scripts'
import { SHELL_GIT_ENV } from '../src/main/agent/scripted-shell'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList, taskPanel, todoHub } from './selectors'

// The commits a task and its subagent made, newest first, each opening to its files and a file to Files, are covered
// end to end by `todo-hub-commits.spec.ts`. This file covers what's distinct: commits surviving a relaunch and the
// worktree's removal, read back from the repository, and a task taking none of another's.

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

/** The task's commit tiles' labels, as the todo hub shows them: the whole list, the task having no todos. */
async function commitLabels(window: Page): Promise<string[]> {
  await taskPanel(window)
    .tab(/^Todos/)
    .click()
  const hub = todoHub(window)
  const labels = await hub.tiles(hub.cards).evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('aria-label')))
  return labels.filter((label): label is string => label !== null)
}

const MADE = [MAKES_COMMITS.merge, MAKES_COMMITS.guide, MAKES_COMMITS.bump, MAKES_COMMITS.fix].map(
  (subject) => `Change: ${subject}`,
)

test('changes: still there after a relaunch and the worktree’s removal, read from the repository, and another task takes none of them', async ({
  launch,
  tempFolder,
}) => {
  const root = acmeApi(tempFolder)
  const first = await launch({ agentScriptsByFirstMessage: SCRIPTS, chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await newTask(first.window, MAKES_COMMITS.prompt, MAKES_COMMITS.reply)
  await expect.poll(() => commitLabels(first.window)).toEqual(MADE)
  await first.close()
  sh(`git worktree remove --force ${MAKES_COMMITS.worktree}`, root)

  // Reads back the same after the relaunch, with the subagent's worktree gone: nothing but git itself to read it from.
  const { window } = await launch({ agentScriptsByFirstMessage: SCRIPTS, chosenFolder: root })
  await taskList(window).taskRow(MAKES_COMMITS.title).click()
  await expect.poll(() => commitLabels(window)).toEqual(MADE)

  // Another task committing in the same repository has its own, and takes none of these.
  await newTask(window, MAKES_COMMITS.otherPrompt, MAKES_COMMITS.otherReply)
  await expect.poll(() => commitLabels(window)).toEqual([`Change: ${MAKES_COMMITS.other}`])
  await taskList(window).taskRow(MAKES_COMMITS.title).click()
  await expect.poll(() => commitLabels(window)).toEqual(MADE)
})
