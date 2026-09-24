// The agent's `ask` tool, end to end with the scripted agent: its questions open and the task needs you, and they're
// answered through the bridge (`questions.answer`; the question card is P4-02) or in words from the input bar.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { RELEASE_NOTES_QUESTIONS } from '../src/main/agent/scripts'
import { BridgeErrorCode, CommandName } from '../src/shared/bridge'
import { QuestionSetState, TaskActivity, type QuestionSet, type Task } from '../src/shared/domain'
import { expect, test, type Glade } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'
import { invoke, refusal } from './task-view'

/** The only task in the only workspace, as main has it. */
async function onlyTask(window: Page): Promise<Task | undefined> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]
}

/** The only task's question sets, as main has them. */
async function questionSets(window: Page): Promise<readonly QuestionSet[]> {
  const task = await onlyTask(window)
  return (await invoke(window, CommandName.TasksHistory, { id: task?.id ?? '' })).questionSets
}

/** Opens a workspace, starts a task and asks for the release notes; resolves once the agent's questions are open. */
async function askForReleaseNotes(glade: Glade): Promise<QuestionSet> {
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Draft the release notes for 2.4.')
  await bar.field.press('Enter')
  await expect.poll(async () => (await onlyTask(window))?.asking).toBe(true)
  const [open] = await questionSets(window)
  if (open === undefined) throw new Error('No question set opened')
  return open
}

function workspaceRoot(tempFolder: () => string): string {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  return root
}

test('ask: the task needs you while its questions are open, and the answers carry its turn on', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'asks-a-question', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const open = await askForReleaseNotes(glade)

  expect(open).toMatchObject({ state: QuestionSetState.Open, questions: RELEASE_NOTES_QUESTIONS })
  expect(await onlyTask(window)).toMatchObject({ activity: TaskActivity.Waiting, asking: true })
  await expect(taskList(window).filter('Needs you')).toHaveText('Needs you1')
  await expect(chat(window).agentReplies).toHaveCount(0)

  // Answers that don't fit are refused, and the questions stay open.
  const refused = await refusal(window, CommandName.QuestionsAnswer, { id: open.id, answers: { 0: 'by-date' } })
  expect(refused).toMatchObject({ code: BridgeErrorCode.InvalidRequest })
  expect(refused?.message).toContain('has no option "by-date"')
  expect((await onlyTask(window))?.asking).toBe(true)

  const { questionSet } = await invoke(window, CommandName.QuestionsAnswer, {
    id: open.id,
    answers: { 0: 'by-type', 1: 'Internal changes', 2: 'GitHub handles' },
  })

  expect(questionSet).toMatchObject({ state: QuestionSetState.Answered })
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(chat(window).agentReplies.first()).toContainText('The release notes for 2.4 are drafted')
  await expect.poll(async () => (await onlyTask(window))?.activity).toBe(TaskActivity.Waiting)
  expect((await onlyTask(window))?.asking).toBe(false)
  await expect(taskList(window).rows('Active').first()).toContainText('Release notes drafted in docs/releases/2.4.md.')
})

test('ask: a reply in words from the input bar answers the questions, and shows as your message', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'asks-a-question', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await askForReleaseNotes(glade)

  const bar = inputBar(window)
  await bar.field.fill('By type, put Django under internal changes, and credit GitHub handles.')
  await bar.field.press('Enter')

  const { userMessages, agentReplies } = chat(window)
  await expect(userMessages).toHaveCount(2)
  await expect(userMessages.last()).toContainText('credit GitHub handles')
  await expect(agentReplies).toHaveCount(1)
  const [answered] = await questionSets(window)
  expect(answered?.reply).toEqual({
    kind: 'free_text',
    text: 'By type, put Django under internal changes, and credit GitHub handles.',
  })
})

test('ask: questions open when the app is force-quit are still open after a relaunch, and answering carries on', async ({
  launch,
  tempFolder,
}) => {
  const first = await launch({ agentScript: 'asks-a-question', chosenFolder: workspaceRoot(tempFolder) })
  const open = await askForReleaseNotes(first)
  await first.kill()

  const { window } = await launch({ agentScript: 'asks-a-question' })
  expect(await onlyTask(window)).toMatchObject({ activity: TaskActivity.Waiting, asking: true })
  expect(await questionSets(window)).toEqual([open])

  await invoke(window, CommandName.QuestionsAnswer, {
    id: open.id,
    answers: { 0: 'by-area', 1: 'Leave it out', 2: 'No credits' },
  })

  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(chat(window).agentReplies.first()).toContainText('Got your answers after the restart.')
  await expect(chat(window).restarts).toHaveCount(1)
  await expect.poll(async () => (await onlyTask(window))?.activity).toBe(TaskActivity.Waiting)
})
