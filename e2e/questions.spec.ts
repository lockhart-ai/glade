// The agent's `ask` tool, end to end with the scripted agent: its questions open on a card and the task needs you, and
// they're answered with the card (by keyboard alone), through the bridge (`questions.answer`), or in words from the
// input bar. Questions in a task you aren't viewing notify and mark it unread.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { RELEASE_NOTES_PREAMBLE, RELEASE_NOTES_QUESTIONS } from '../src/main/agent/scripts'
import { BridgeErrorCode, CommandName } from '../src/shared/bridge'
import { QuestionSetState, TaskActivity, type QuestionSet, type Task } from '../src/shared/domain'
import { expect, notifications, test, type Glade } from './fixtures'
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

/** Whether the keyboard focus is on the question card's Send answers button. */
function onSend(window: Page): Promise<boolean> {
  return window.evaluate(() => document.activeElement?.textContent === 'Send answers')
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

  expect(open).toMatchObject({
    state: QuestionSetState.Open,
    preamble: RELEASE_NOTES_PREAMBLE,
    questions: RELEASE_NOTES_QUESTIONS,
  })
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

test('ask: the card is answered by keyboard alone, then shows the answers, and the agent carries on', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'asks-a-question', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  const open = await askForReleaseNotes(glade)
  const { log, questionCard, closedQuestions, agentReplies } = chat(window)
  await expect(questionCard).toContainText('4 questions before I finish')
  // The agent's reply to your message leads the card, as Markdown; what it said just before asking stays in the tool log.
  await expect(questionCard).toContainText(
    /^I read the 41 PRs .* upgrade guide too\.\s*A few choices are yours before I draft them\.4 questions before I finish/,
  )
  await expect(questionCard.locator('code').first()).toHaveText('v2.3.0')
  await expect(questionCard.locator('strong')).toHaveText('upgrade guide')
  await expect(log).not.toContainText('9 features, 17 fixes and 15 internal changes')
  await expect(questionCard).toContainText('0 of 4 answered')
  await expect(inputBar(window).field).toBeFocused()

  // Back from the input bar to the card: its last stop is Send answers, and before that, one stop per question.
  for (let step = 0; step < 12 && !(await onSend(window)); step += 1) await window.keyboard.press('Shift+Tab')
  expect(await onSend(window)).toBe(true)
  for (let step = 0; step < 4; step += 1) await window.keyboard.press('Shift+Tab')
  const layout = questionCard.getByRole('radiogroup', { name: 'How should the notes be laid out?' })
  await expect(layout.getByRole('radio', { name: 'By type' })).toBeFocused()

  // 2 picks the second layout and ← goes back to the first; Tab and ↓ move on through the pills, whose digits pick.
  await window.keyboard.press('2')
  await expect(layout.getByRole('radio', { name: 'By area' })).toHaveAttribute('aria-checked', 'true')
  await window.keyboard.press('ArrowLeft')
  await expect(layout.getByRole('radio', { name: 'By type' })).toHaveAttribute('aria-checked', 'true')
  await window.keyboard.press('Tab')
  await window.keyboard.press('2')
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('1')
  await expect(questionCard.getByRole('radio', { name: 'Internal changes' })).toHaveAttribute('aria-checked', 'true')
  await expect(questionCard.getByRole('radio', { name: 'GitHub handles' })).toHaveAttribute('aria-checked', 'true')
  await expect(questionCard).toContainText('3 of 4 answered')

  // Tab to the optional text question, type, and ↵ sends.
  await window.keyboard.press('Tab')
  await expect(questionCard.getByRole('textbox', { name: 'Anything to call out in the upgrade guide?' })).toBeFocused()
  await window.keyboard.type('Mention the new 429s on /search.')
  await expect(questionCard).toContainText('4 of 4 answered')
  await window.keyboard.press('Enter')

  await expect(questionCard).toHaveCount(0)
  await expect(closedQuestions).toContainText('4 questions · answered')
  await expect(closedQuestions).toContainText('A few choices are yours before I draft them.')
  await expect(closedQuestions.getByRole('definition')).toHaveText([
    'By type',
    'Internal changes',
    'GitHub handles',
    'Mention the new 429s on /search.',
  ])
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('The release notes for 2.4 are drafted')
  const [answered] = await questionSets(window)
  expect(answered).toMatchObject({
    id: open.id,
    state: QuestionSetState.Answered,
    reply: {
      kind: 'answers',
      answers: { 0: 'by-type', 1: 'Internal changes', 2: 'GitHub handles', 3: 'Mention the new 429s on /search.' },
    },
  })
})

test("ask: questions in a task you aren't viewing notify with the agent's reply and mark it unread", async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'asks-a-question', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  // Two new tasks. The first gets its message from outside the window (as a notification's reply would send it)
  // while you view the second.
  await list.newTask.click()
  await expect(chat(window).newTaskPrompt).toBeVisible()
  const first = await onlyTask(window)
  await list.newTask.click()
  await invoke(window, CommandName.TasksSend, { id: first?.id ?? '', text: 'Draft the release notes for 2.4.' })

  const row = list.taskRow('Draft release notes for 2.4')
  await expect(row.getByRole('img', { name: 'Unread' })).toBeVisible()
  await expect.poll(() => notifications(glade)).toHaveLength(1)
  const [shown] = await notifications(glade)
  // The first line of the agent's reply on the card, as plain text, cut short.
  expect(shown).toMatchObject({
    title: 'Draft release notes for 2.4',
    body: 'I read the 41 PRs merged since v2.3.0. The new rate limits on /search change what API clients see…',
  })
  await expect(list.filter('Needs you')).toHaveText('Needs you1')

  // Opening it shows its card, and makes it read.
  await row.click()
  await expect(chat(window).questionCard).toBeVisible()
  await expect(row.getByRole('img', { name: 'Unread' })).toHaveCount(0)
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
  // The card closes, saying you answered in your words, with no answers of its own.
  await expect(chat(window).questionCard).toHaveCount(0)
  await expect(chat(window).closedQuestions).toContainText('4 questions · answered in your words')
  await expect(chat(window).closedQuestions.getByRole('definition')).toHaveCount(0)
  await expect(chat(window).closedQuestions).toContainText('A few choices are yours before I draft them.')
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
  expect(open.preamble).toBe(RELEASE_NOTES_PREAMBLE)
  await expect(chat(window).questionCard).toContainText('A few choices are yours before I draft them.')

  await invoke(window, CommandName.QuestionsAnswer, {
    id: open.id,
    answers: { 0: 'by-area', 1: 'Leave it out', 2: 'No credits' },
  })

  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(chat(window).agentReplies.first()).toContainText('Got your answers after the restart.')
  await expect(chat(window).restarts).toHaveCount(1)
  await expect.poll(async () => (await onlyTask(window))?.activity).toBe(TaskActivity.Waiting)
})

test('ask: a card asked without a preamble leads with what the agent said just before asking', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await launch({ agentScript: 'asks-many-choices', chosenFolder: workspaceRoot(tempFolder) })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Add per-endpoint rate limits.')
  await bar.field.press('Enter')

  const { log, questionCard } = chat(window)
  await expect(questionCard).toBeVisible()
  expect((await questionSets(window))[0]?.preamble).toBeNull()
  await expect(log).toContainText(
    'The limiter is in. A few choices are yours before I go on.5 questions before I finish',
  )
  await expect(questionCard).not.toContainText('The limiter is in.')
})
