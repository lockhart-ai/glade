// Broadcast (#489, #675): one message to the active tasks you've ticked, in every workspace, from the modal
// File › Broadcast… opens (⌘⇧B). Everything is ticked when it opens, and you untick what to leave out. Scripted agents
// only: an idle task starts a turn with it, a busy one and one asking a question get it in their queue, a done one and
// one never given anything get nothing, and one whose session can't start fails as any send does, alone.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CommandName } from '../src/shared/bridge'
import { AppCommandId } from '../src/shared/commands'
import { TaskState } from '../src/shared/domain'
import { chooseFolder, expect, test } from './fixtures'
import { chooseMenuItem, menuItem } from './menu'
import { broadcastDialog, chat, firstRun, inputBar, regions, taskHeader, taskList } from './selectors'
import { invoke } from './task-view'

const BROADCAST = "Is anyone restarting Docker? If it's you, stop and tell me why."
/** Plays `copy-in-batches`: its command runs until it's stopped, then its next turn answers what was queued. */
const COPY = 'Move image uploads to S3.'
/** Plays `asks-a-question`: its turn waits on the question card. */
const NOTES = 'Draft the release notes.'
/** Plays `simple-reply`: one reply, and the same again for the next message. */
const RETRIES = 'How does it retry?'
/** Plays `fails-to-start`: its session can't start, for this message or any after it. */
const DEPLOY = 'Check the deploy.'

const COPY_TITLE = 'Move image uploads to S3'
const NOTES_TITLE = 'Draft release notes for 2.4'
const RETRIES_TITLE = 'Explain the retry policy'

test('a broadcast reaches every active task with an agent, in every workspace, once: started, queued, or failed alone', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const rootA = join(parent, 'acme-api')
  const rootB = join(parent, 'storefront')
  mkdirSync(rootA)
  mkdirSync(rootB)
  const scripts = {
    [COPY]: 'copy-in-batches',
    [NOTES]: 'asks-a-question',
    [RETRIES]: 'simple-reply',
    [DEPLOY]: 'fails-to-start',
  } as const
  const glade = await launch({ agentScriptsByFirstMessage: scripts, chosenFolder: rootA })
  const { window } = glade
  const list = taskList(window)
  const bar = inputBar(window)
  const conversation = chat(window)
  const header = taskHeader(window)
  const workspace = regions(window).workspace

  // Acme API: one task mid-turn, one waiting on a question card.
  await firstRun(window).openFolder.click()
  await expect(workspace).toContainText('acme-api')
  await list.newTask.click()
  await bar.field.fill(COPY)
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()
  await expect(header.title).toHaveText(COPY_TITLE)
  await list.newTask.click()
  await bar.field.fill(NOTES)
  await bar.field.press('Enter')
  await expect(conversation.questionCard).toBeVisible()

  // Storefront: one done, one idle with a reply already read, one that has never been sent anything, and one whose
  // session can't start, stopped on its error.
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('storefront')
  await list.newTask.click()
  await bar.field.fill(RETRIES)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies).toHaveCount(1)
  await header.markDone.click()
  await expect(list.rows('Done')).toHaveCount(1)
  await list.newTask.click()
  await bar.field.fill(RETRIES)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies).toHaveCount(1)
  await expect(header.stateDot).toHaveAccessibleName('Active · idle')
  await list.newTask.click()
  await expect(conversation.newTaskPrompt).toBeVisible()
  await list.newTask.click()
  await bar.field.fill(DEPLOY)
  await bar.field.press('Enter')
  await expect(conversation.errorCard).toBeVisible()
  await expect(conversation.userMessages).toHaveCount(1)

  // File › Broadcast… (⌘⇧B) opens the modal over whatever the window shows.
  expect((await menuItem(glade, 'File', 'Broadcast…')).accelerator).toBe('CmdOrCtrl+Shift+B')
  await chooseMenuItem(glade, 'File', 'Broadcast…')
  const modal = broadcastDialog(window)
  await expect(modal.dialog).toBeVisible()
  await expect(modal.field).toBeFocused()
  await expect(modal.reach).toHaveText(
    'Goes to 4 of 4 active tasks in 2 workspaces. Busy agents get it when their turn ends.',
  )
  // The four it lists, by workspace, each with where it stands. The done one isn't among them, and neither is the
  // task that has never been sent anything: it has no agent to ask.
  await expect(modal.tasks).toHaveCount(4)
  await expect(modal.tasksIn('acme-api')).toHaveCount(2)
  await expect(modal.tasksIn('acme-api').filter({ hasText: NOTES_TITLE })).toHaveText(`${NOTES_TITLE}needs you`)
  await expect(modal.tasksIn('acme-api').filter({ hasText: COPY_TITLE })).toHaveText(`${COPY_TITLE}working`)
  await expect(modal.tasksIn('storefront')).toHaveCount(2)
  await expect(modal.tasksIn('storefront').filter({ hasText: RETRIES_TITLE })).toHaveText(`${RETRIES_TITLE}idle`)
  await expect(modal.tasksIn('storefront').filter({ hasText: 'New task' })).toHaveText('New taskneeds you')
  // Everything is ticked when it opens: each workspace's box, and each task's.
  await expect(modal.workspace('acme-api')).toBeChecked()
  await expect(modal.workspace('storefront')).toBeChecked()
  for (const title of [NOTES_TITLE, COPY_TITLE, RETRIES_TITLE, 'New task']) {
    await expect(modal.task(title)).toBeChecked()
  }

  // ⇧↵ adds a line, ↵ sends: one command, and the modal closes.
  await modal.field.fill('Is anyone restarting Docker?')
  await modal.field.press('Shift+Enter')
  await expect(modal.dialog).toBeVisible()
  await modal.field.fill(BROADCAST)
  await modal.field.press('Enter')
  await expect(modal.dialog).toHaveCount(0)

  // The task whose session can't start got it, tagged, and failed again: its error shows in its own chat, as any
  // failed send does, and stops no other task.
  await expect(conversation.userMessages).toHaveCount(2)
  await expect(conversation.userMessages.nth(1)).toContainText(BROADCAST)
  await expect(conversation.broadcasts).toHaveCount(1)
  await expect(conversation.errorCard).toBeVisible()

  // The idle task started a turn with it, and its agent answered in its own chat.
  await list.row('Active', RETRIES_TITLE).click()
  await expect(conversation.userMessages).toHaveCount(2)
  await expect(conversation.userMessages.nth(1)).toContainText(BROADCAST)
  await expect(conversation.broadcasts).toHaveCount(1)
  await expect(conversation.agentReplies).toHaveCount(2)
  await expect(bar.queued).toHaveCount(0)

  // The done task got nothing, and stays done.
  await list.row('Done', RETRIES_TITLE).click()
  await expect(conversation.userMessages).toHaveCount(1)
  await expect(conversation.broadcasts).toHaveCount(0)
  await expect(list.rows('Done')).toHaveCount(1)

  // Acme API. The task asking a question got it in its queue, tagged, and its question is still open: a broadcast
  // never answers one.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(workspace).toContainText('acme-api')
  await list.taskRow(NOTES_TITLE).click()
  await expect(conversation.questionCard).toBeVisible()
  await expect(bar.queuedRows).toHaveText([`1Broadcast${BROADCAST}`])
  await expect(conversation.userMessages).toHaveCount(1)

  // The task mid-turn got it in its queue too, and reads it once its turn is stopped: the queue starts the next one.
  await list.taskRow(COPY_TITLE).click()
  await expect(bar.queuedRows).toHaveText([`1Broadcast${BROADCAST}`])
  await expect(conversation.userMessages).toHaveCount(1)
  await bar.stop.click()
  await expect(conversation.userMessages).toHaveCount(2)
  await expect(conversation.broadcasts).toHaveCount(1)
  await expect(bar.queued).toHaveCount(0)
  await expect(conversation.agentReplies).toHaveCount(1)

  // Each of the four got it exactly once, and no one else, as the modal's count said: the done task and the one
  // never sent anything have nothing, and that one is as it was, with no session started for it.
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const tasks = (
    await Promise.all(workspaces.map(({ id }) => invoke(window, CommandName.TasksList, { workspaceId: id })))
  ).flatMap((answer) => answer.tasks)
  expect(tasks).toHaveLength(6)
  const received = await Promise.all(
    tasks.map(async (task) => {
      const { messages, queuedMessages } = await invoke(window, CommandName.TasksHistory, { id: task.id })
      const count = [...messages, ...queuedMessages].filter((message) => message.broadcast).length
      return { state: task.state, untouched: messages.length + queuedMessages.length === 0, count }
    }),
  )
  const counts = (which: (task: (typeof received)[number]) => boolean): number[] =>
    received.filter(which).map(({ count }) => count)
  expect(counts(({ state, untouched }) => state === TaskState.Active && !untouched)).toEqual([1, 1, 1, 1])
  expect(counts(({ state }) => state === TaskState.Done)).toEqual([0])
  expect(received.filter(({ untouched }) => untouched)).toEqual([
    { state: TaskState.Active, untouched: true, count: 0 },
  ])

  // It's stored with each task: after a relaunch it's still tagged in the chat, and in the queue it still waits in,
  // behind the question the app quit on.
  await glade.close()
  const relaunched = await launch({ agentScriptsByFirstMessage: scripts })
  const reopened = chat(relaunched.window)
  const reopenedBar = inputBar(relaunched.window)
  await expect(regions(relaunched.window).workspace).toContainText('acme-api')
  await expect(reopened.userMessages).toHaveCount(2)
  await expect(reopened.broadcasts).toHaveCount(1)
  await taskList(relaunched.window).taskRow(NOTES_TITLE).click()
  await expect(reopened.questionCard).toBeVisible()
  await expect(reopenedBar.queuedRows).toHaveText([`1Broadcast${BROADCAST}`])
  await expect(reopened.userMessages).toHaveCount(1)

  // Answering the question carries on the turn that asked; when it ends, the queued broadcast is delivered: it isn't
  // left waiting for another message.
  await reopened.questionCard.getByRole('button', { name: 'Skip questions' }).click()
  await expect(reopened.userMessages).toHaveCount(2)
  await expect(reopened.userMessages.nth(1)).toContainText(BROADCAST)
  await expect(reopened.broadcasts).toHaveCount(1)
  await expect(reopenedBar.queued).toHaveCount(0)
})

test('with no active task, the Broadcast modal says so and can’t send; its key follows Settings › Keyboard', async ({
  launch,
}) => {
  const glade = await launch()
  const { window } = glade

  // The first-run window, with no workspace at all: Broadcast is there all the same.
  await chooseMenuItem(glade, 'File', 'Broadcast…')
  const modal = broadcastDialog(window)
  await expect(modal.dialog).toBeVisible()
  await expect(modal.reach).toHaveText('No active tasks to send to.')
  await expect(modal.field).toBeDisabled()
  await expect(modal.send).toBeDisabled()
  await expect(modal.recipients).toHaveCount(0)

  // Esc closes it.
  await window.keyboard.press('Escape')
  await expect(modal.dialog).toHaveCount(0)

  // Rebound like any shortcut, the menu bar's item answers the new key.
  await invoke(window, CommandName.SettingsUpdate, {
    patch: { keyBindings: { [AppCommandId.Broadcast]: 'Meta+Alt+M' } },
  })
  await expect.poll(async () => (await menuItem(glade, 'File', 'Broadcast…')).accelerator).toBe('CmdOrCtrl+Alt+M')
})

test('a broadcast goes only to the tasks still ticked, and with nothing ticked it can’t send', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const rootA = join(parent, 'acme-api')
  const rootB = join(parent, 'storefront')
  mkdirSync(rootA)
  mkdirSync(rootB)
  const scripts = {
    [COPY]: 'copy-in-batches',
    [NOTES]: 'asks-a-question',
    [RETRIES]: 'simple-reply',
  } as const
  const glade = await launch({ agentScriptsByFirstMessage: scripts, chosenFolder: rootA })
  const { window } = glade
  const list = taskList(window)
  const bar = inputBar(window)
  const conversation = chat(window)
  const workspace = regions(window).workspace

  // Acme API: one task mid-turn and one waiting on a question card. Storefront: one idle with a reply already read.
  await firstRun(window).openFolder.click()
  await expect(workspace).toContainText('acme-api')
  await list.newTask.click()
  await bar.field.fill(COPY)
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()
  await list.newTask.click()
  await bar.field.fill(NOTES)
  await bar.field.press('Enter')
  await expect(conversation.questionCard).toBeVisible()
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('storefront')
  await list.newTask.click()
  await bar.field.fill(RETRIES)
  await bar.field.press('Enter')
  await expect(conversation.agentReplies).toHaveCount(1)

  await chooseMenuItem(glade, 'File', 'Broadcast…')
  const modal = broadcastDialog(window)
  await expect(modal.dialog).toBeVisible()
  await expect(modal.reach).toHaveText(
    'Goes to 3 of 3 active tasks in 2 workspaces. Busy agents get it when their turn ends.',
  )

  // Unticking a task from its row leaves it out: the line counts two of three, and its workspace's box shows a dash.
  await modal.task(NOTES_TITLE).click()
  await expect(modal.reach).toHaveText(
    'Goes to 2 of 3 active tasks in 2 workspaces. Busy agents get it when their turn ends.',
  )
  await expect(modal.workspace('acme-api')).toHaveAttribute('aria-checked', 'mixed')

  // A box half-ticked ticks its workspace's tasks all back.
  await modal.workspace('acme-api').click()
  await expect(modal.task(NOTES_TITLE)).toBeChecked()
  await expect(modal.reach).toHaveText(
    'Goes to 3 of 3 active tasks in 2 workspaces. Busy agents get it when their turn ends.',
  )

  // Space toggles the focused row: the idle task is left out again, and its workspace with it.
  await modal.task(RETRIES_TITLE).press(' ')
  await expect(modal.task(RETRIES_TITLE)).not.toBeChecked()
  await expect(modal.reach).toHaveText(
    'Goes to 2 of 3 active tasks in 1 workspace. Busy agents get it when their turn ends.',
  )

  // Unticking the last ticked workspace's box leaves nothing ticked: the line says so, and Send won't send.
  await modal.workspace('acme-api').click()
  await expect(modal.reach).toHaveText('Nothing ticked. Tick a task to send to it.')
  await expect(modal.send).toBeDisabled()
  await modal.field.fill('Is anyone restarting Docker?')
  await modal.field.press('Enter')
  await expect(modal.dialog).toBeVisible()

  // Ticking the idle task's workspace back ticks it, and ↵ sends to it alone.
  await modal.workspace('storefront').click()
  await expect(modal.task(RETRIES_TITLE)).toBeChecked()
  await expect(modal.task(COPY_TITLE)).not.toBeChecked()
  await expect(modal.reach).toHaveText(
    'Goes to 1 of 3 active tasks in 1 workspace. Busy agents get it when their turn ends.',
  )
  await modal.field.press('Enter')
  await expect(modal.dialog).toHaveCount(0)

  // The idle task got it, tagged: it started a turn with it, as an idle one does.
  await expect(conversation.userMessages).toHaveCount(2)
  await expect(conversation.userMessages.nth(1)).toContainText('Is anyone restarting Docker?')
  await expect(conversation.broadcasts).toHaveCount(1)
  await expect(conversation.agentReplies).toHaveCount(2)
  await expect(bar.queued).toHaveCount(0)

  // The tasks left out got nothing: the busy one has no broadcast in its queue, and the one asking a question keeps
  // it open with nothing queued.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(workspace).toContainText('acme-api')
  await list.taskRow(COPY_TITLE).click()
  await expect(conversation.userMessages).toHaveCount(1)
  await expect(conversation.broadcasts).toHaveCount(0)
  await expect(bar.queued).toHaveCount(0)
  await list.taskRow(NOTES_TITLE).click()
  await expect(conversation.questionCard).toBeVisible()
  await expect(conversation.userMessages).toHaveCount(1)
  await expect(bar.queued).toHaveCount(0)
})
