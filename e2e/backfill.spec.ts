// Backfilling past tasks, end to end with the scripted agent: with agents allowed to control Glade (seeded), a task's
// agent backfills two past tasks from their notes folders through its in-process `glade-control` tools, each done with
// a handoff note, its notes as artifacts and its start date. Asked again, it finds them there and makes nothing new.
// The user opens one, sees the Backfilled card and the artifacts, and picks it up; the session that starts has the
// handoff note in its system prompt.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BACKFILLS_TASKS, REPLIES_BRIEFLY, type BackfilledTaskSample } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { TaskState } from '../src/shared/domain'
import { agentReceived, agentSessions, expect, test } from './fixtures'
import { artifactsTab, chat, inputBar, taskHeader, taskList, taskPanel } from './selectors'
import { invoke } from './task-view'

const PICK_UP = "Let's pick this up."
const SCRIPTS = { [BACKFILLS_TASKS.prompt]: 'backfills-tasks', [PICK_UP]: 'replies-briefly' } as const

/** One of the tasks the script backfills. */
function backfilled(index: number): BackfilledTaskSample {
  const sample = BACKFILLS_TASKS.tasks[index]
  if (sample === undefined) throw new Error(`The script backfills no task ${String(index)}`)
  return sample
}

const BILLING = backfilled(0)
const PDFS = backfilled(1)

/** The heading the handoff note goes under in the system prompt (`HANDOFF_HEADING`). */
const HANDOFF_HEADING = 'Handoff for this task (backfilled from earlier notes)'

/**
 * Makes the workspace folder, with each backfilled task's notes in it, and a seed that opens it with agents allowed to
 * control Glade and one task, selected, to do the backfill in. Answers with the seed's path.
 */
function seedWorkspace(folder: string): string {
  const root = join(folder, 'acme-api')
  for (const { artifacts } of BACKFILLS_TASKS.tasks) {
    for (const { path, title } of artifacts) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), `# ${title}\n`)
    }
  }
  const seed = join(folder, 'backfill.json')
  writeFileSync(
    seed,
    JSON.stringify({
      settings: { controlEnabled: true },
      workspace: { id: BACKFILLS_TASKS.workspaceId, name: 'Acme API', rootPath: realpathSync(root) },
      tasks: [{ title: 'Backfill my notes', minutesAgo: 5, selected: true }],
    }),
  )
  return seed
}

test('an agent backfills past tasks; the user opens one, sees its handoff and artifacts, and picks it up', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ seed: seedWorkspace(tempFolder()), agentScriptsByFirstMessage: SCRIPTS })
  const { window } = glade
  const list = taskList(window)
  const conversation = chat(window)
  const header = taskHeader(window)
  const bar = inputBar(window)

  await bar.field.fill(BACKFILLS_TASKS.prompt)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(BACKFILLS_TASKS.reply)
  await expect(list.sectionHeader('Done')).toHaveText('Done2')

  // Asked again, it finds both there: nothing new.
  await bar.field.fill(BACKFILLS_TASKS.prompt)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies).toHaveCount(2)
  await expect(conversation.agentReplies.last()).toContainText(BACKFILLS_TASKS.again)
  await expect(list.sectionHeader('Done')).toHaveText('Done2')
  const tasks = (await invoke(window, CommandName.TasksList, { workspaceId: BACKFILLS_TASKS.workspaceId })).tasks
  expect(tasks.map(({ title }) => title).sort()).toEqual(['Backfill my notes', BILLING.title, PDFS.title].sort())

  // Done, newest first by the day each started: the April task above the March one.
  await list.sectionHeader('Done').click()
  await expect(list.rows('Done')).toHaveText([new RegExp(`^${PDFS.title}`), new RegExp(`^${BILLING.title}`)])
  await list.row('Done', BILLING.title).click()
  await expect(header.title).toHaveText(BILLING.title)
  await expect(header.stateDot).toHaveAccessibleName(/^Done · Mar \d+$/)
  await expect(header.stateDot).toHaveAttribute('data-state', 'done')
  // Backfilled done, it has no span of its own: only the day it started, with the full date as its tooltip.
  await expect(header.age).toHaveText(/^· started Mar \d+$/)
  await expect(header.age).toHaveAttribute('title', /^Started Mar \d+, \d{4}, \d{1,2}:\d{2} [AP]M$/)
  await expect(header.markDone).toHaveCount(0)
  await expect(header.field('Outcome')).toBeVisible()
  await expect(conversation.newTaskPrompt).toHaveCount(0)

  // The Backfilled card: the handoff note, rendered, open until its line closes it.
  const card = conversation.handoffCard
  await expect(conversation.handoffToggle).toHaveText(/^Backfilled·handoff from earlier notes, added \w{3} \d+$/)
  await expect(card.getByRole('heading', { name: 'Where it got to' })).toBeVisible()
  await expect(card.getByText('invoice.*')).toBeVisible()
  await conversation.handoffToggle.click()
  await expect(conversation.handoffToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(card.getByRole('heading', { name: 'Where it got to' })).toHaveCount(0)
  await conversation.handoffToggle.click()
  await expect(card.getByRole('heading', { name: 'Where it got to' })).toBeVisible()

  // Its notes are its artifacts.
  const panel = taskPanel(window)
  await panel.tab(/^Artifacts/).click()
  await expect(panel.tab(/^Artifacts/)).toHaveText('Artifacts 2')
  await expect(artifactsTab(window).rows).toHaveCount(2)
  await expect(artifactsTab(window).open('Migration notes')).toHaveAttribute('title', 'notes/billing-webhooks/notes.md')
  await expect(artifactsTab(window).open('Decisions')).toHaveAttribute('title', 'notes/billing-webhooks/decisions.md')

  // Picking it up reopens it, and the session that starts has the handoff note; the backfilling task's had none.
  await bar.field.fill(PICK_UP)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(REPLIES_BRIEFLY.reply)
  await expect(header.stateDot).toHaveAccessibleName(/^Active/)
  await expect(conversation.markedDone).toHaveCount(1)
  await expect(conversation.reopened).toHaveCount(1)
  await expect(conversation.handoffCard).toBeVisible()
  const billing = tasks.find(({ title }) => title === BILLING.title)
  expect(
    (await invoke(window, CommandName.TasksList, { workspaceId: BACKFILLS_TASKS.workspaceId })).tasks,
  ).toContainEqual(expect.objectContaining({ id: billing?.id, state: TaskState.Active }))
  const prompts = (await agentSessions(glade)).map(({ systemPromptAppend }) => systemPromptAppend)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).not.toContain(HANDOFF_HEADING)
  expect(prompts[1]).toContain(HANDOFF_HEADING)
  expect(prompts[1]).toContain(BILLING.handoff)
  // A session that starts with the note needs no block ahead of the message: it gets it as written.
  expect((await agentReceived(glade)).at(-1)).toBe(PICK_UP)
})
