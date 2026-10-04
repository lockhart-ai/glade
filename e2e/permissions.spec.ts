// Per-call permission review, end to end with the scripted agent: the input bar's Permissions picker switches a task
// between Allow all and Ask before edits and commands (saved across a relaunch, with Settings setting the default for
// new tasks), and in the ask mode the agent's edits and commands wait on permission cards in the chat, answered with
// Allow once, Allow for this task or Deny (with or without a note), by mouse or by keyboard alone. A card is in the chat
// only while it waits (#459): answered or withdrawn, it leaves, and its call's row in the Tool calls list says what was
// decided, a subagent's in the Subagents tab, across a relaunch. A rule granted with Allow for this task lets the calls
// it covers through in that task, across a relaunch. A card open when Glade quits is still there after the relaunch,
// and answering it carries the agent on.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { ALLOWS_FOR_TASK, ASKS_PERMISSION, PERMISSION_AT_QUIT, SUBAGENT_PERMISSION } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { PermissionMode, TaskActivity, ToolEventKind, type Task, type ToolCallEvent } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, settings, subagentsTab, taskHeader, taskList, taskPanel } from './selectors'
import { invoke } from './task-view'

const ASK = 'Ask before edits and commands'

function workspaceRoot(tempFolder: () => string): string {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  return root
}

/** The workspace's tasks, as main has them, newest first. */
async function tasks(window: Page): Promise<readonly Task[]> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  return (await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })).tasks
}

async function onlyTask(window: Page): Promise<Task | undefined> {
  return (await tasks(window))[0]
}

/**
 * A tool call in the newest task's log, by its name, as main has it: the first, or the one whose command or file is
 * `subject`.
 */
async function toolCall(window: Page, name: string, subject?: string): Promise<ToolCallEvent | undefined> {
  const task = await onlyTask(window)
  const { toolEvents } = await invoke(window, CommandName.TasksHistory, { id: task?.id ?? '' })
  return toolEvents.find(
    (event): event is ToolCallEvent =>
      event.kind === ToolEventKind.ToolCall &&
      event.name === name &&
      (subject === undefined || event.input.command === subject || event.input.file_path === subject),
  )
}

/** Chooses a permission mode from the input bar's picker. */
async function choosePermissions(window: Page, from: string, to: string): Promise<void> {
  const bar = inputBar(window)
  await expect(bar.setting('Permissions')).toHaveAccessibleName(`Permissions: ${from}`)
  await bar.setting('Permissions').click()
  await bar.option(to).click()
  await expect(bar.setting('Permissions')).toHaveAccessibleName(`Permissions: ${to}`)
}

test('the Permissions picker switches a task between the modes, a relaunch keeps it, and Settings sets the default', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)

  // Allow all is the default, and the picker offers the two modes, the task's checked.
  await bar.setting('Permissions').click()
  await expect(bar.option('Allow all')).toHaveAttribute('aria-checked', 'true')
  await expect(bar.option(ASK)).toHaveAttribute('aria-checked', 'false')
  await window.keyboard.press('Escape')

  await choosePermissions(window, 'Allow all', ASK)
  await expect.poll(async () => (await onlyTask(window))?.permissionMode).toBe(PermissionMode.AskBeforeEdits)

  await glade.close()
  const relaunched = await launch()
  const again = relaunched.window
  await expect(inputBar(again).setting('Permissions')).toHaveAccessibleName(`Permissions: ${ASK}`)

  // Settings › Agent › Permissions: Ask first makes new tasks start in the ask mode.
  const modal = settings(again)
  await chooseMenuItem(relaunched, 'Glade', 'Settings…')
  await expect(modal.choice('Permissions', 'Allow all')).toBeChecked()
  await expect(modal.choice('Permissions', 'Allow edits')).toBeDisabled()
  await modal.choice('Permissions', 'Ask first').click()
  await expect(modal.choice('Permissions', 'Ask first')).toBeChecked()
  await modal.close.click()

  await taskList(again).newTask.click()
  await expect(inputBar(again).setting('Permissions')).toHaveAccessibleName(`Permissions: ${ASK}`)
  await expect
    .poll(async () => (await tasks(again)).map((task) => task.permissionMode))
    .toEqual([PermissionMode.AskBeforeEdits, PermissionMode.AskBeforeEdits])
})

test('in the ask mode, an edit and a command wait on cards: Allow once by mouse, Deny with a note by keyboard alone', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await launch({ agentScript: 'asks-permission', chosenFolder: workspaceRoot(tempFolder) })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await choosePermissions(window, 'Allow all', ASK)
  const bar = inputBar(window)
  const conversation = chat(window)
  await bar.field.fill('Add the retry change to the changelog and run the tests.')
  await bar.field.press('Enter')

  // The edit waits on its card, and the task needs you meanwhile: purple dots in the row and header, and Needs you.
  const edit = conversation.permissionCards.first()
  await expect(edit).toContainText('Edit')
  await expect(edit).toContainText(ASKS_PERMISSION.edit.file_path)
  await expect(edit.getByLabel('Change')).toContainText('+ - Retries now back off exponentially.')
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(taskList(window).dot(taskList(window).taskRow('Note the retry change'))).toHaveAttribute(
    'data-state',
    'waiting',
  )
  expect(await onlyTask(window)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
  // Its row in the Tool calls list waits too: the purple dot, and the shield's line in place of a result.
  const panel = taskPanel(window)
  await expect(panel.call(/^Waiting\s*Edit/)).toContainText('Waiting on you')
  await expect(panel.permissionLines).toHaveText(['Waiting on you'])
  await expect(panel.permissionLines.first()).toHaveAttribute('data-permission', 'waiting')

  await edit.getByRole('button', { name: 'Allow once' }).click()
  // The answered card leaves the chat, and its row says what was decided, above the edit's result.
  await expect(panel.permissionLines.first()).toHaveText('Allowed once')
  await expect(panel.permissionLines.first()).toHaveAttribute('data-permission', 'allowed')
  await expect(panel.call(/^Done\s*Edit/)).toContainText('Allowed once')
  await expect(conversation.permissionCards).toHaveCount(1)
  await expect(conversation.permissionRequests).toHaveCount(1)

  // The command's card opens next, and takes the focus on Allow once: the keyboard answers it alone.
  const command = conversation.permissionCards.first()
  await expect(command.getByLabel('Command')).toHaveText(ASKS_PERMISSION.command)
  await expect(command).toContainText('Run the test suite')
  const allow = command.getByRole('button', { name: 'Allow once' })
  await expect(allow).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(command.getByRole('button', { name: `Allow ${ASKS_PERMISSION.command} for this task` })).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(command.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
  await window.keyboard.press('Enter')
  const note = command.getByRole('textbox', { name: 'Note for the agent' })
  await expect(note).toBeFocused()
  await window.keyboard.type('Run only the retry tests')
  await window.keyboard.press('Enter')

  // Denied, it leaves the chat too: the chat is your message and the agent's reply, and the note is on the row.
  await expect(panel.permissionLines).toHaveText(['Allowed once', 'Denied: “Run only the retry tests”'])
  await expect(panel.permissionLines.nth(1)).toHaveAttribute('data-permission', 'denied')
  await expect(conversation.permissionRequests).toHaveCount(0)
  // The agent got the note, and carried on to its reply.
  await expect(conversation.agentReplies).toHaveCount(1)
  await expect(conversation.agentReplies.first()).toContainText(ASKS_PERMISSION.reply)
  const bash = await toolCall(window, 'Bash')
  expect(bash?.output).toContain('Run only the retry tests')
  expect(await onlyTask(window)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: false })
  expect((await toolCall(window, 'Edit'))?.output).toBe('The file CHANGELOG.md has been updated.')
})

test('Allow for this task grants a command prefix or a whole tool: the calls it covers stop asking, across a relaunch, in that task only', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'allows-for-task', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await choosePermissions(window, 'Allow all', ASK)
  const bar = inputBar(window)
  const conversation = chat(window)
  await bar.field.fill('Run the tests and note the retry change.')
  await bar.field.press('Enter')

  // `npm test` asks; its card offers the prefix Claude Code suggested, between Allow once and Deny.
  const test = conversation.permissionCards.first()
  await expect(test.getByLabel('Command')).toHaveText(ALLOWS_FOR_TASK.command)
  await expect(test.getByRole('group', { name: 'Answer' }).getByRole('button')).toHaveText([
    'Allow once',
    'Allow npm test commands for this task',
    'Deny',
  ])
  await test.getByRole('button', { name: 'Allow npm test commands for this task' }).click()
  // Its row names the rule it granted.
  const panel = taskPanel(window)
  await expect(panel.permissionLines.first()).toHaveText('Allowed for this task: npm test commands')

  // `npm test -- --watch` ran without asking; `npm test && rm -rf build` still asks.
  const compound = conversation.permissionCards.first()
  await expect(compound.getByLabel('Command')).toHaveText(ALLOWS_FOR_TASK.compound)
  expect((await toolCall(window, 'Bash', ALLOWS_FOR_TASK.watch))?.output).toBe('Watching for changes')
  await compound.getByRole('button', { name: 'Allow once' }).click()

  // The edit's card offers the whole tool, by keyboard: → then ↵.
  const edit = conversation.permissionCards.first()
  await expect(edit).toContainText(ALLOWS_FOR_TASK.edit.file_path)
  await expect(edit.getByRole('button', { name: 'Allow once' })).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(edit.getByRole('button', { name: 'Allow Edit for this task' })).toBeFocused()
  await window.keyboard.press('Enter')

  // The second edit didn't ask: the agent replied. The three calls that asked have your answers on their rows, and
  // the two the task's new rules let through say which rule did (#450).
  await expect(conversation.agentReplies.first()).toContainText(ALLOWS_FOR_TASK.reply)
  await expect(conversation.permissionRequests).toHaveCount(0)
  await expect(panel.permissionLines).toHaveText([
    'Allowed for this task: npm test commands',
    'Allowed by task rule: npm test commands',
    'Allowed once',
    'Allowed for this task: Edit',
    'Allowed by task rule: Edit',
  ])
  expect((await toolCall(window, 'Edit', ALLOWS_FOR_TASK.editAgain.file_path))?.output).toBe(
    'The file README.md has been updated.',
  )

  // After a relaunch the task's session resumes with its rules: only the compound command asks.
  await glade.close()
  const relaunched = await launch({ agentScript: 'allows-for-task' })
  const again = relaunched.window
  const resumedChat = chat(again)
  // The decisions are still on their rows, and still out of the chat.
  await expect(taskPanel(again).permissionLines).toHaveText([
    'Allowed for this task: npm test commands',
    'Allowed by task rule: npm test commands',
    'Allowed once',
    'Allowed for this task: Edit',
    'Allowed by task rule: Edit',
  ])
  await expect(resumedChat.permissionRequests).toHaveCount(0)
  await inputBar(again).field.fill('Run them once more.')
  await inputBar(again).field.press('Enter')
  const asked = resumedChat.permissionCards.first()
  await expect(asked.getByLabel('Command')).toHaveText(ALLOWS_FOR_TASK.compound)
  await asked.getByRole('button', { name: 'Allow once' }).click()
  await expect(resumedChat.agentReplies).toHaveCount(2)
  // The turn's other calls are let through by the task's rules, and say so; the compound command has your answer.
  await expect(taskPanel(again).permissionLines).toHaveCount(10)
  await expect(taskPanel(again).permissionLines.filter({ hasText: 'Allowed by task rule' })).toHaveCount(6)
  await expect(taskPanel(again).permissionLines.filter({ hasText: 'Allowed once' })).toHaveCount(2)
  await expect(resumedChat.permissionRequests).toHaveCount(0)

  // Another task has none of them: its `npm test` asks.
  await taskList(again).newTask.click()
  await choosePermissions(again, 'Allow all', ASK)
  await inputBar(again).field.fill('Run the tests.')
  await inputBar(again).field.press('Enter')
  const theirs = chat(again).permissionCards.first()
  await expect(theirs.getByLabel('Command')).toHaveText(ALLOWS_FOR_TASK.command)
  await expect(theirs.getByRole('button', { name: 'Allow npm test commands for this task' })).toBeVisible()
})

test('a card open when Glade quits is still there after a relaunch, and Allow once carries the agent on', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'permission-at-quit', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await choosePermissions(window, 'Allow all', ASK)
  await inputBar(window).field.fill('Run the pending migrations.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).permissionCards.first().getByLabel('Command')).toHaveText(PERMISSION_AT_QUIT.command)

  // Quit with the card open.
  await glade.close()
  const { window: again } = await launch({ agentScript: 'permission-at-quit' })
  const conversation = chat(again)

  // The card is still there, and the task still needs you; the call itself ended when Glade quit.
  const card = conversation.permissionCards.first()
  await expect(card.getByLabel('Command')).toHaveText(PERMISSION_AT_QUIT.command)
  await expect(taskHeader(again).stateDot).toHaveAccessibleName('Active · waiting on you')
  expect(await onlyTask(again)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
  await expect(taskPanel(again).call(/^Interrupted\s*Bash/)).toContainText('Waiting on you')
  await expect(taskPanel(again).permissionLines).toHaveText(['Waiting on you'])

  await card.getByRole('button', { name: 'Allow once' }).click()

  // The card leaves the chat, and the call it was about says it was allowed. The agent is told, and carries on: it
  // runs the command again, without a second card or a line of its own, and replies.
  await expect(taskPanel(again).call(/^Interrupted\s*Bash/)).toContainText('Allowed once')
  await expect(taskPanel(again).permissionLines).toHaveText(['Allowed once'])
  await expect(conversation.permissionRequests).toHaveCount(0)
  await expect(conversation.restarts).toHaveCount(1)
  await expect(conversation.agentReplies).toHaveCount(1)
  await expect(conversation.agentReplies.first()).toContainText(PERMISSION_AT_QUIT.reply)
  await expect(conversation.permissionCards).toHaveCount(0)
  await expect(taskPanel(again).call(/^Done\s*Bash/)).toBeVisible()
  await expect(taskPanel(again).log).toContainText(PERMISSION_AT_QUIT.resumed)
  await expect.poll(async () => (await onlyTask(again))?.activity).toBe(TaskActivity.Waiting)
  expect((await onlyTask(again))?.awaitingPermission).toBe(false)
})

test("a subagent's card says which subagent, opens on Deny when a stray key mustn't approve, and a mode switch leaves an open card open", async ({
  launch,
  tempFolder,
}) => {
  const { window } = await launch({
    agentScript: 'asks-permission-from-a-subagent',
    chosenFolder: workspaceRoot(tempFolder),
  })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await choosePermissions(window, 'Allow all', ASK)
  const bar = inputBar(window)
  const conversation = chat(window)
  await bar.field.fill('Write the 2.4 upgrade guide.')
  await bar.field.press('Enter')

  // The agent's own command waits; switching the mode meanwhile leaves its card open.
  const clean = conversation.permissionCards.first()
  await expect(clean.getByLabel('Command')).toHaveText(SUBAGENT_PERMISSION.command)
  await choosePermissions(window, ASK, 'Allow all')
  await choosePermissions(window, 'Allow all', ASK)
  await expect(conversation.permissionCards).toHaveCount(1)
  expect((await onlyTask(window))?.awaitingPermission).toBe(true)

  // Deny with no note, by mouse.
  await clean.getByRole('button', { name: 'Deny', exact: true }).click()
  await clean.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(taskPanel(window).permissionLines).toHaveText(['Denied'])

  // The subagent's write: its card names the subagent and titles itself, and opens on Deny.
  const write = conversation.permissionCards.first()
  await expect(write).toContainText(SUBAGENT_PERMISSION.title)
  await expect(write).toContainText(`subagent · ${SUBAGENT_PERMISSION.subagent}`)
  await expect(write).toContainText(SUBAGENT_PERMISSION.file)
  const deny = write.getByRole('button', { name: 'Deny', exact: true })
  await expect(deny).toBeFocused()

  // ↵ opens the note rather than approving; Esc goes back to Deny; ← then ↵ allows it once.
  await window.keyboard.press('Enter')
  await expect(write.getByRole('textbox', { name: 'Note for the agent' })).toBeFocused()
  await window.keyboard.press('Escape')
  await expect(deny).toBeFocused()
  await window.keyboard.press('ArrowLeft')
  await expect(write.getByRole('button', { name: 'Allow Write for this task' })).toBeFocused()
  await window.keyboard.press('ArrowLeft')
  await expect(write.getByRole('button', { name: 'Allow once' })).toBeFocused()
  await window.keyboard.press('Enter')

  await expect(conversation.agentReplies.first()).toContainText(SUBAGENT_PERMISSION.reply)
  expect((await toolCall(window, 'Write'))?.output).toBe(`File created successfully at: ${SUBAGENT_PERMISSION.file}`)
  // Both cards left the chat. The subagent's decision isn't in the Tool calls list, whose rows are the agent's own:
  // it's on the row its Write already has, in the subagent's log.
  await expect(conversation.permissionRequests).toHaveCount(0)
  await expect(taskPanel(window).permissionLines).toHaveText(['Denied'])
  await taskPanel(window)
    .tab(/^Subagents/)
    .click()
  const subagents = subagentsTab(window)
  await subagents.header(SUBAGENT_PERMISSION.subagent).click()
  await expect(subagents.log(SUBAGENT_PERMISSION.subagent)).toContainText(SUBAGENT_PERMISSION.file)
  await expect(subagents.permissionLines(SUBAGENT_PERMISSION.subagent)).toHaveText(['Allowed once'])
})

test('stopping the task withdraws an open card: it leaves the chat, and its row says Withdrawn, across a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const glade = await launch({ agentScript: 'asks-permission', chosenFolder: workspaceRoot(tempFolder) })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await choosePermissions(window, 'Allow all', ASK)
  await inputBar(window).field.fill('Add the retry change to the changelog and run the tests.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).permissionCards.first()).toContainText(ASKS_PERMISSION.edit.file_path)
  await expect(taskPanel(window).permissionLines).toHaveText(['Waiting on you'])

  // The input bar's Stop shows only while the agent works, and here it waits on you: stopped as `stop_task` stops it.
  await invoke(window, CommandName.TasksStop, { id: (await onlyTask(window))?.id ?? '' })

  await expect(chat(window).permissionRequests).toHaveCount(0)
  await expect(taskPanel(window).permissionLines).toHaveText(['Withdrawn'])
  await expect(taskPanel(window).permissionLines.first()).toHaveAttribute('data-permission', 'withdrawn')
  await expect.poll(async () => (await onlyTask(window))?.awaitingPermission).toBe(false)
  // The edit never ran.
  expect((await toolCall(window, 'Edit'))?.output).not.toBe('The file CHANGELOG.md has been updated.')

  await glade.close()
  const { window: again } = await launch({ agentScript: 'asks-permission' })
  await expect(taskPanel(again).permissionLines).toHaveText(['Withdrawn'])
  await expect(chat(again).permissionRequests).toHaveCount(0)
})
