// Backfilling past tasks, end to end with the scripted agent: with agents allowed to control Glade (seeded), a task's
// agent backfills two past tasks from their notes folders through its in-process `glade-control` tools, each done with
// its notes as artifacts and its start date, and no handoff note — the control API no longer takes one. Asked again,
// it finds them there and makes nothing new; asked to set a handoff note on another task through `update_task`, it is
// refused. A task seeded with a stored handoff note (the way `src/main/capture-seed.ts` seeds one, its `handoff`
// field) still shows the Backfilled card, open until its line closes it, and picking it up starts a session whose
// system prompt carries the note.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BACKFILLS_TASKS, REPLIES_BRIEFLY, type BackfilledTaskSample } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { TaskState } from '../src/shared/domain'
import { agentReceived, agentSessions, expect, test } from './fixtures'
import { chat, inputBar, taskHeader, taskList, taskPanel, todoHub } from './selectors'
import { invoke } from './task-view'

const PICK_UP = "Let's pick this up."

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

/** The handoff note the seed stores on the seeded task (`BACKFILLS_TASKS.seededTask`), Markdown. */
const NOTE = [
  '### Where it got to',
  '',
  'The `invoice.*` and `customer.*` handlers are on v2 and live. `subscription.*` still goes through v1.',
  '',
  '### Next',
  '',
  'Write the `subscription.*` mapping, then turn v1 off. Notes are in `notes/billing-webhooks/`.',
].join('\n')

/**
 * Makes the workspace folder, with each backfilled task's notes in it, and a seed that opens it with agents allowed to
 * control Glade, one task, selected, to do the backfill in, and one done task that already has a stored handoff note.
 * Answers with the seed's path.
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
      tasks: [
        { title: 'Backfill my notes', minutesAgo: 5, selected: true },
        {
          id: BACKFILLS_TASKS.seededTask.id,
          title: BACKFILLS_TASKS.seededTask.title,
          objective: 'Turn the v1 billing API off once every client is on v2.',
          state: TaskState.Done,
          minutesAgo: 30,
          handoff: { body: NOTE, minutesAgo: 30 },
        },
      ],
    }),
  )
  return seed
}

test('an agent backfills past tasks; a stored handoff note shows its card, and a new handoff note is refused', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({
    seed: seedWorkspace(tempFolder()),
    // The pick-up message plays the default script: the seeded task's session began before its note was set, so the
    // note goes ahead of the message as a block, and no first-message key matches it exactly.
    agentScript: 'replies-briefly',
    agentScriptsByFirstMessage: { [BACKFILLS_TASKS.prompt]: 'backfills-tasks' },
  })
  const { window } = glade
  const list = taskList(window)
  const conversation = chat(window)
  const header = taskHeader(window)
  const bar = inputBar(window)
  const panel = taskPanel(window)

  await bar.field.fill(BACKFILLS_TASKS.prompt)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(BACKFILLS_TASKS.reply)
  await expect(list.sectionHeader('Done')).toHaveText('Done3')

  // Asked again, it finds both there: nothing new.
  await bar.field.fill(BACKFILLS_TASKS.prompt)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies).toHaveCount(2)
  await expect(conversation.agentReplies.last()).toContainText(BACKFILLS_TASKS.again)
  await expect(list.sectionHeader('Done')).toHaveText('Done3')
  const tasks = (await invoke(window, CommandName.TasksList, { workspaceId: BACKFILLS_TASKS.workspaceId })).tasks
  expect(tasks.map(({ title }) => title).sort()).toEqual(
    ['Backfill my notes', BILLING.title, PDFS.title, BACKFILLS_TASKS.seededTask.title].sort(),
  )

  // Asked to set a handoff note through update_task, it is refused: the call fails naming the field.
  await bar.field.fill(BACKFILLS_TASKS.tryHandoff)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(BACKFILLS_TASKS.refused)
  await expect(panel.call(/update_task/)).toHaveAccessibleName(/patch\.handoff: unknown field/)

  // Done, the seeded task most recently updated, then the April task above the March one.
  await list.sectionHeader('Done').click()
  await expect(list.rows('Done')).toHaveText([
    new RegExp(`^${BACKFILLS_TASKS.seededTask.title}`),
    new RegExp(`^${PDFS.title}`),
    new RegExp(`^${BILLING.title}`),
  ])
  await list.row('Done', BILLING.title).click()
  await expect(header.title).toHaveText(BILLING.title)
  await expect(header.stateDot).toHaveAccessibleName(/^Done · Mar \d+$/)
  await expect(header.stateDot).toHaveAttribute('data-state', 'done')
  // Backfilled done, it has no span of its own: only the day it started, with the full date as its tooltip.
  await expect(header.age).toHaveText(/^· started Mar \d+$/)
  await expect(header.age).toHaveAttribute('title', /^Started Mar \d+, \d{4}, \d{1,2}:\d{2} [AP]M$/)
  await expect(header.markDone).toHaveCount(0)
  await expect(header.field('Outcome')).toBeVisible()
  // Backfilled without a handoff note, it has no Backfilled card: what to write is the new task's prompt again.
  await expect(conversation.handoffCard).toHaveCount(0)
  await expect(conversation.newTaskPrompt).toBeVisible()

  // Its notes are its artifacts; the task has no todos, so the placeholder group is the whole list, always open.
  const hub = todoHub(window)
  await panel.tab(/^Todos/).click()
  await expect(hub.cards).toHaveCount(1)
  const notes = hub.tile(hub.cards, 'File: Migration notes')
  const decisions = hub.tile(hub.cards, 'File: Decisions')
  await expect(notes.getByText('Markdown')).toHaveAttribute('title', 'notes/billing-webhooks/notes.md')
  await expect(decisions.getByText('Markdown')).toHaveAttribute('title', 'notes/billing-webhooks/decisions.md')

  // The seeded task's stored handoff note is the Backfilled card, rendered, open until its line closes it,
  // in place of what to write.
  await list.row('Done', BACKFILLS_TASKS.seededTask.title).click()
  await expect(conversation.newTaskPrompt).toHaveCount(0)
  const card = conversation.handoffCard
  await expect(conversation.handoffToggle).toHaveText(/^Backfilled·handoff from earlier notes, added \w{3} \d+$/)
  await expect(card.getByRole('heading', { name: 'Where it got to' })).toBeVisible()
  await expect(card.getByText('invoice.*')).toBeVisible()
  await conversation.handoffToggle.click()
  await expect(conversation.handoffToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(card.getByRole('heading', { name: 'Where it got to' })).toHaveCount(0)
  await conversation.handoffToggle.click()
  await expect(card.getByRole('heading', { name: 'Where it got to' })).toBeVisible()

  // Picking it up reopens it, and the session that starts has the stored handoff note; the backfilling task's had none.
  await bar.field.fill(PICK_UP)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(REPLIES_BRIEFLY.reply)
  await expect(header.stateDot).toHaveAccessibleName(/^Active/)
  await expect(conversation.markedDone).toHaveCount(1)
  await expect(conversation.reopened).toHaveCount(1)
  await expect(conversation.handoffCard).toBeVisible()
  const seeded = tasks.find(({ title }) => title === BACKFILLS_TASKS.seededTask.title)
  expect(
    (await invoke(window, CommandName.TasksList, { workspaceId: BACKFILLS_TASKS.workspaceId })).tasks,
  ).toContainEqual(expect.objectContaining({ id: seeded?.id, state: TaskState.Active }))
  const prompts = (await agentSessions(glade)).map(({ systemPromptAppend }) => systemPromptAppend)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).not.toContain(HANDOFF_HEADING)
  expect(prompts[1]).toContain(HANDOFF_HEADING)
  expect(prompts[1]).toContain(NOTE)
  // The seeded task's session began before the note was set, so the note goes ahead of the message once, as a block.
  expect((await agentReceived(glade)).at(-1)).toContain(PICK_UP)
})
