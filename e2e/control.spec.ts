// Programmatic control, end to end with the scripted agent: with agents allowed to control Glade (seeded), a task's
// agent drives Glade through its in-process `glade-control` tools. It lists the tasks, creates one with a first
// message (which starts it), renames another and gives it a status, then marks it done, and the sidebar and header
// show each change. In the ask mode its reads go ahead, and each change waits on a permission card.
import type { Page } from '@playwright/test'
import { DRIVES_GLADE, REPLIES_BRIEFLY } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { TaskState, type Task } from '../src/shared/domain'
import { expect, seedPath, test } from './fixtures'
import { chat, inputBar, taskHeader, taskList } from './selectors'
import { invoke } from './task-view'

const SCRIPTS = { [DRIVES_GLADE.prompt]: 'drives-glade', [DRIVES_GLADE.created.message]: 'replies-briefly' } as const

const ASK = 'Ask before edits and commands'

/** The seeded workspace's tasks, as main has them. */
async function tasks(window: Page): Promise<readonly Task[]> {
  return (await invoke(window, CommandName.TasksList, { workspaceId: DRIVES_GLADE.workspaceId })).tasks
}

/** Sends the driving task, selected, the message that plays its script. */
async function askToSetUp(window: Page): Promise<void> {
  const bar = inputBar(window)
  await bar.field.fill(DRIVES_GLADE.prompt)
  await bar.field.press('Enter')
}

test("a task's agent creates, renames and marks done other tasks, and the sidebar and header show each change", async ({
  launch,
}) => {
  const { window } = await launch({ seed: seedPath('control.json'), agentScriptsByFirstMessage: SCRIPTS })
  const list = taskList(window)
  const header = taskHeader(window)
  await expect(header.title).toHaveText('Coordinate the release')
  await expect(list.row('Active', 'Tidy the changelog')).toBeVisible()

  await askToSetUp(window)

  // The agent replies once it's done; by then every change is in the sidebar.
  await expect(chat(window).agentReplies.last()).toContainText(DRIVES_GLADE.reply)
  await expect(list.row('Active', DRIVES_GLADE.created.title)).toBeVisible()
  await expect(list.row('Active', 'Tidy the changelog')).toHaveCount(0)
  await expect(list.sectionHeader('Done')).toHaveText('Done1')
  await list.sectionHeader('Done').click()
  await expect(list.row('Done', DRIVES_GLADE.target.title)).toBeVisible()
  // The driving task is still the one shown.
  await expect(header.title).toHaveText('Coordinate the release')

  // The renamed task: done, its status now its outcome.
  await list.row('Done', DRIVES_GLADE.target.title).click()
  await expect(header.title).toHaveText(DRIVES_GLADE.target.title)
  await expect(header.pill).toHaveText(/^Done/)
  await expect(header.field('Outcome')).toHaveText(DRIVES_GLADE.target.status)

  // The created task: its title as given, its first message sent, and its agent's reply.
  await list.row('Active', DRIVES_GLADE.created.title).click()
  await expect(header.title).toHaveText(DRIVES_GLADE.created.title)
  await expect(chat(window).userMessages.first()).toContainText(DRIVES_GLADE.created.message)
  await expect(chat(window).agentReplies.first()).toContainText(REPLIES_BRIEFLY.reply)

  const byTitle = new Map((await tasks(window)).map((task) => [task.title, task]))
  expect(byTitle.get(DRIVES_GLADE.target.title)).toMatchObject({
    id: DRIVES_GLADE.target.id,
    state: TaskState.Done,
    status: DRIVES_GLADE.target.status,
  })
  expect(byTitle.get(DRIVES_GLADE.created.title)).toMatchObject({ state: TaskState.Active })
})

test("in the ask mode, the agent's control reads go ahead and each change waits on a permission card", async ({
  launch,
}) => {
  const { window } = await launch({ seed: seedPath('control.json'), agentScriptsByFirstMessage: SCRIPTS })
  const bar = inputBar(window)
  await bar.setting('Permissions').click()
  await bar.option(ASK).click()
  await expect(bar.setting('Permissions')).toHaveAccessibleName(`Permissions: ${ASK}`)
  const conversation = chat(window)
  const list = taskList(window)

  await askToSetUp(window)

  // list_tasks ran without a card: the first card is create_task's, and nothing has been created yet.
  const create = conversation.permissionCards.first()
  await expect(create).toContainText('create_task')
  await expect(conversation.permissionCards).toHaveCount(1)
  await expect(conversation.closedPermissions).toHaveCount(0)
  await expect(list.row('Active', DRIVES_GLADE.created.title)).toHaveCount(0)
  expect((await tasks(window)).map(({ title }) => title).sort()).toEqual([
    'Coordinate the release',
    'Tidy the changelog',
  ])

  await create.getByRole('button', { name: 'Allow once' }).click()
  await expect(list.row('Active', DRIVES_GLADE.created.title)).toBeVisible()

  // update_task waits on its card, then mark_done on its own.
  const update = conversation.permissionCards.first()
  await expect(update).toContainText('update_task')
  await expect(list.row('Active', 'Tidy the changelog')).toBeVisible()
  await update.getByRole('button', { name: 'Allow once' }).click()
  await expect(list.row('Active', DRIVES_GLADE.target.title)).toBeVisible()

  const markDone = conversation.permissionCards.first()
  await expect(markDone).toContainText('mark_done')
  await markDone.getByRole('button', { name: 'Allow once' }).click()
  await expect(list.row('Active', DRIVES_GLADE.target.title)).toHaveCount(0)
  await expect(list.sectionHeader('Done')).toHaveText('Done1')

  await expect(conversation.agentReplies.last()).toContainText(DRIVES_GLADE.reply)
  await expect(conversation.closedPermissions).toHaveCount(3)
  await expect(conversation.permissionCards).toHaveCount(0)
})
