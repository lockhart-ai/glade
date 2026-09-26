// The task and agent events a plugin is fed (`docs/plugin-api.md`, "Events"), end to end: the fixture plugin records
// what Glade sends it while the scripted agent runs a task that works, asks a question and is marked done.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { PluginEventType, type GladeMessage, type PluginEvent } from '../src/shared/plugin-api'
import { gladeMessageSchema } from '../src/shared/plugin-api-schema'
import { inPlugin, installFixture } from './fixture-plugin'
import { expect, test, type Glade } from './fixtures'
import { firstRun, inputBar, taskHeader, taskList } from './selectors'
import { invoke } from './task-view'

const EMPTY_SNAPSHOT: PluginEvent = {
  type: PluginEventType.Snapshot,
  tasks: [],
  subagents: [],
  questions: [],
  permissions: [],
}

/** Everything the plugin was sent since its last hello, checked against the schema: in order, with no gaps. */
async function received(glade: Glade): Promise<PluginEvent[]> {
  const messages = await inPlugin<GladeMessage[]>(glade, 'window.received')
  const run = messages.slice(messages.findLastIndex(({ event }) => event.type === PluginEventType.Hello))
  for (const message of run) expect(gladeMessageSchema.parse(message)).toEqual(message)
  expect(run.map(({ seq }) => seq)).toEqual(run.map((_, index) => index + 1))
  return run.map(({ event }) => event)
}

/** The last event of a type the plugin was sent since its last hello. */
async function last<T extends PluginEventType>(
  glade: Glade,
  type: T,
): Promise<Extract<PluginEvent, { type: T }> | undefined> {
  return (await received(glade)).findLast((event): event is Extract<PluginEvent, { type: T }> => event.type === type)
}

/** Posts `ready` from the page, as a reload does, and waits for the new hello and snapshot. */
async function readyAgain(glade: Glade): Promise<PluginEvent> {
  await inPlugin(glade, "window.glade.post({ type: 'ready' })")
  await expect.poll(async () => (await received(glade)).map(({ type }) => type)).toEqual(['hello', 'snapshot'])
  const [, snapshot] = await received(glade)
  if (snapshot === undefined) throw new Error('No snapshot')
  return snapshot
}

test('a plugin sees a task created, working, asking a question and marked done, and never its chat', async ({
  launch,
  tempFolder,
  userData,
}) => {
  installFixture(userData)
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'asks-a-question', chosenFolder: root })
  const { window } = glade

  // With a workspace and no tasks yet: hello, then an empty snapshot.
  await firstRun(window).openFolder.click()
  await expect.poll(async () => (await received(glade).catch(() => [])).length).toBe(2)
  expect(await received(glade)).toEqual([
    { type: PluginEventType.Hello, app: { name: 'Glade', version: expect.any(String) as unknown } },
    EMPTY_SNAPSHOT,
  ])

  await taskList(window).newTask.click()
  await expect.poll(() => last(glade, PluginEventType.TaskCreated)).toBeDefined()
  const created = await last(glade, PluginEventType.TaskCreated)
  expect(created?.task).toMatchObject({ workspaceName: 'acme-api', state: 'active', activity: 'waiting', title: '' })
  const taskId = created?.task.id ?? ''

  const bar = inputBar(window)
  await bar.field.fill('Draft the release notes for 2.4.')
  await bar.field.press('Enter')

  // Working: its title and status, its notes and tool calls, then its questions, which the task waits on.
  await expect.poll(() => last(glade, PluginEventType.QuestionOpened)).toBeDefined()
  expect(await last(glade, PluginEventType.QuestionOpened)).toMatchObject({
    question: {
      taskId,
      prompts: [
        'How should the notes be laid out?',
        'Where does the Django 5.2 upgrade go?',
        'Credit contributors?',
        'Anything to call out in the upgrade guide?',
      ],
    },
  })
  const asking = await received(glade)
  expect(asking).toContainEqual({
    type: PluginEventType.TaskUpdated,
    task: expect.objectContaining({ id: taskId, activity: 'working' }) as unknown,
  })
  expect(asking).toContainEqual({
    type: PluginEventType.TaskUpdated,
    task: expect.objectContaining({ title: 'Draft release notes for 2.4' }) as unknown,
  })
  expect(asking).toContainEqual({
    type: PluginEventType.AgentNote,
    taskId,
    subagentId: null,
    text: '41 PRs since v2.3.0: 9 features, 17 fixes and 15 internal changes.',
    at: expect.any(Number) as unknown,
  })
  expect(asking).toContainEqual({
    type: PluginEventType.AgentToolCall,
    call: expect.objectContaining({ tool: 'set_title', summary: '', state: 'done' }) as unknown,
  })
  await expect
    .poll(() => last(glade, PluginEventType.TaskUpdated))
    .toMatchObject({ task: { needsYou: true, waitingOn: 'question' } })

  // A reload of the page (ready again) starts over: the snapshot has the task and its open questions.
  expect(await readyAgain(glade)).toMatchObject({
    tasks: [{ id: taskId, title: 'Draft release notes for 2.4', waitingOn: 'question' }],
    questions: [{ taskId }],
  })

  // Answered: the questions close, and the agent finishes its turn.
  const { questionSets } = await invoke(window, CommandName.TasksHistory, { id: taskId })
  await invoke(window, CommandName.QuestionsAnswer, {
    id: questionSets[0]?.id ?? '',
    answers: { 0: 'by-type', 1: 'Internal changes', 2: 'GitHub handles' },
  })
  await expect
    .poll(() => last(glade, PluginEventType.QuestionClosed))
    .toMatchObject({ taskId, questionSetId: questionSets[0]?.id, outcome: 'answered' })
  await expect
    .poll(() => last(glade, PluginEventType.TaskUpdated))
    .toMatchObject({ task: { status: 'Release notes drafted in docs/releases/2.4.md.', activity: 'waiting' } })

  // Marked done: the last word on it.
  await taskHeader(window).markDone.click()
  await expect
    .poll(() => last(glade, PluginEventType.TaskUpdated))
    .toMatchObject({ task: { id: taskId, state: 'done', needsYou: false } })

  // Nothing of the chat, the agent's reply on the card, the answers or the questions' options reached the plugin.
  const everything = JSON.stringify(await inPlugin(glade, 'window.received'))
  for (const text of [
    'Draft the release notes for 2.4.',
    'change what API clients see',
    'laid out the way you picked',
    'Matches the 2.3 notes',
    'GitHub handles',
    'e.g. the new 429s',
  ]) {
    expect(everything).not.toContain(text)
  }

  // A fresh snapshot leaves the done task out.
  expect(await readyAgain(glade)).toEqual(EMPTY_SNAPSHOT)
})
