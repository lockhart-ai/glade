// Porting a Claude Code session in, end to end with the scripted agent: with agents allowed to control Glade (seeded)
// and Claude Code's config folder a temporary one holding an invented transcript, a task's agent lists the sessions
// and imports one. The imported task is under Done in the workspace added for its folder, with its title, its chat at
// its original times, and its tool log with turn dividers; sending it a message reopens it and resumes its session.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { PORTS_SESSIONS, REPLIES_BRIEFLY } from '../src/main/agent/scripts'
import { projectSlug, TranscriptBuilder } from '../src/main/control/claude-code/test-transcripts'
import { CommandName } from '../src/shared/bridge'
import { TaskState } from '../src/shared/domain'
import { expect, seedPath, test } from './fixtures'
import { chat, inputBar, taskHeader, taskList, taskPanel, workspaceSwitcher } from './selectors'
import { invoke } from './task-view'

const TITLE = 'Fix the rate limit tests'
const FIRST_PROMPT = 'Why do the rate limit tests fail on CI?'
const FIRST_REPLY = 'They assumed UTC. I pinned the zone in the test setup, and they pass.'
const SECOND_PROMPT = 'Thanks. Does the README say anything about it?'
const SECOND_REPLY = 'No; it only covers local setup.'
const FOLLOW_UP = 'Also pin the zone in CI.'

// A resumed session plays the script of its task's first message: for the imported task, the transcript's first prompt.
const SCRIPTS = { [PORTS_SESSIONS.prompt]: 'ports-sessions', [FIRST_PROMPT]: 'replies-briefly' } as const

/** An invented session in `cwd`, which started `start` ms since the epoch. */
function transcript(cwd: string, start: number): string {
  return new TranscriptBuilder(cwd, start)
    .noise(0)
    .prompt(0, FIRST_PROMPT)
    .say(5, "I'll run them first.")
    .toolUse(6, 'toolu_1', 'Bash', { command: 'npm test -- rate' })
    .toolResult(9, 'toolu_1', '2 failed', true)
    .toolUse(10, 'toolu_2', 'Edit', {
      file_path: join(cwd, 'test/setup.ts'),
      old_string: "process.env.TZ = ''",
      new_string: "process.env.TZ = 'UTC'",
    })
    .toolResult(11, 'toolu_2', 'Edited.')
    .toolUse(12, 'toolu_3', 'Bash', { command: 'npm test -- rate' })
    .toolResult(15, 'toolu_3', '14 passed')
    .say(16, FIRST_REPLY)
    .aiTitle(TITLE)
    .prompt(600, SECOND_PROMPT)
    .say(610, SECOND_REPLY)
    .toJsonl()
}

/** A time as the chat and tool log show it: the window's 24-hour local time. */
function clock(window: Page, at: number): Promise<string> {
  return window.evaluate((ms) => {
    const date = new Date(ms)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }, at)
}

test('a task imports a Claude Code session: it is under Done with its chat, tool log and dividers, and a message resumes it', async ({
  launch,
  tempFolder,
}) => {
  const config = realpathSync(tempFolder('glade-e2e-claude-'))
  const cwd = realpathSync(tempFolder('acme-api-'))
  const start = Date.now() - 2 * 60 * 60 * 1000
  const folder = join(config, 'projects', projectSlug(cwd))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${PORTS_SESSIONS.sessionId}.jsonl`), transcript(cwd, start))

  const { window } = await launch({
    seed: seedPath('import-sessions.json'),
    agentScriptsByFirstMessage: SCRIPTS,
    env: { CLAUDE_CONFIG_DIR: config },
  })
  const bar = inputBar(window)
  const conversation = chat(window)
  const list = taskList(window)
  const header = taskHeader(window)
  const panel = taskPanel(window)

  await bar.field.fill(PORTS_SESSIONS.prompt)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(PORTS_SESSIONS.reply)
  await expect(panel.call(/^Done .*list_claude_code_sessions/)).toBeVisible()
  await expect(panel.call(/^Done .*import_claude_code_session/)).toBeVisible()

  // Its folder is now a workspace, and the task is under its Done section.
  const switcher = workspaceSwitcher(window)
  await switcher.trigger.click()
  const name = cwd.split('/').pop() ?? ''
  await switcher.row(name).click()
  await expect(list.sectionHeader('Done')).toHaveText('Done1')
  await list.sectionHeader('Done').click()
  await list.row('Done', TITLE).click()
  await expect(header.title).toHaveText(TITLE)
  await expect(header.pill).toHaveText(/^Done/)
  await expect(header.field('Objective')).toHaveText(FIRST_PROMPT)

  // The chat: your prompts and the agent's final replies, at their original times.
  await expect(conversation.userMessages).toHaveCount(2)
  await expect(conversation.userMessages.nth(0)).toContainText(FIRST_PROMPT)
  await expect(conversation.userMessages.nth(0)).toContainText(`you · ${await clock(window, start)}`)
  await expect(conversation.agentReplies.nth(0)).toContainText(FIRST_REPLY)
  await expect(conversation.agentReplies.nth(0)).toContainText(`agent · ${await clock(window, start + 16_000)}`)
  await expect(conversation.userMessages.nth(1)).toContainText(`you · ${await clock(window, start + 600_000)}`)
  await expect(conversation.agentReplies.nth(1)).toContainText(SECOND_REPLY)

  // The tool log: the calls with their outcomes, the narration, and turn 2's divider at its time.
  await expect(panel.tab(/^Tool calls/)).toHaveText('Tool calls 3')
  await expect(panel.call(/^Failed Bash npm test -- rate/)).toContainText('2 failed')
  await expect(panel.call(/^Done Edit test\/setup\.ts/)).toBeVisible()
  await expect(panel.call(/^Done Bash npm test -- rate/)).toContainText('14 passed')
  await expect(panel.log).toContainText("I'll run them first.")
  await expect(panel.dividers).toHaveCount(1)
  await expect(panel.dividers.first()).toHaveAccessibleName(`turn 2 · ${await clock(window, start + 600_000)}`)

  // A message reopens it and resumes its Claude Code session, as turn 3.
  await bar.field.fill(FOLLOW_UP)
  await bar.field.press('Enter')
  await expect(conversation.reopened).toBeVisible()
  await expect(conversation.agentReplies.last()).toContainText(REPLIES_BRIEFLY.reply)
  await expect(header.pill).not.toHaveText(/^Done/)
  await expect(panel.log.getByRole('separator', { name: /^turn 3 · / })).toHaveCount(1)

  const workspaces = (await invoke(window, CommandName.WorkspacesList, {})).workspaces
  const added = workspaces.find((workspace) => workspace.rootPath === cwd)
  const tasks = (await invoke(window, CommandName.TasksList, { workspaceId: added?.id ?? '' })).tasks
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ title: TITLE, state: TaskState.Active, sessionId: PORTS_SESSIONS.sessionId })
})
