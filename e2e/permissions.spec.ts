// Per-call permission review, end to end with the scripted agent: the input bar's Permissions picker switches a task
// between Allow all and Ask before edits and commands (saved across a relaunch, with Settings setting the default for
// new tasks), and in the ask mode the agent's edits and commands wait on permission cards in the chat, answered with
// Allow once, Allow for this task or Deny (with or without a note), by mouse or by keyboard alone. A rule granted with
// Allow for this task lets the calls it covers through in that task, across a relaunch.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { ALLOWS_FOR_TASK, ASKS_PERMISSION, SUBAGENT_PERMISSION } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { PermissionMode, TaskActivity, ToolEventKind, type Task, type ToolCallEvent } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, settings, taskHeader, taskList } from './selectors'
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

  // The edit waits on its card, and the task needs you meanwhile: purple dot, pill and Needs you.
  const edit = conversation.permissionCards.first()
  await expect(edit).toContainText('Edit')
  await expect(edit).toContainText(ASKS_PERMISSION.edit.file_path)
  await expect(edit.getByLabel('Change')).toContainText('+ - Retries now back off exponentially.')
  await expect(taskList(window).filter('Needs you')).toHaveText('Needs you1')
  await expect(taskHeader(window).pill).toHaveText('Active · waiting on you')
  await expect(taskList(window).dot(taskList(window).taskRow('Note the retry change'))).toHaveAttribute(
    'data-state',
    'waiting',
  )
  expect(await onlyTask(window)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

  await edit.getByRole('button', { name: 'Allow once' }).click()
  await expect(conversation.closedPermissions.first()).toHaveText(
    `Edit: ${ASKS_PERMISSION.edit.file_path}·allowed once`,
  )

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

  await expect(conversation.closedPermissions.nth(1)).toHaveText(
    `Bash: ${ASKS_PERMISSION.command}·denied: “Run only the retry tests”`,
  )
  // The agent got the note, and carried on to its reply.
  await expect(conversation.agentReplies).toHaveCount(1)
  await expect(conversation.agentReplies.first()).toContainText(ASKS_PERMISSION.reply)
  const bash = await toolCall(window, 'Bash')
  expect(bash?.output).toContain('Run only the retry tests')
  expect(await onlyTask(window)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: false })
  await expect(taskList(window).filter('Needs you')).toHaveText('Needs you1')
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
  await expect(conversation.closedPermissions.first()).toHaveText(
    `Bash: ${ALLOWS_FOR_TASK.command}·allowed for this task`,
  )

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

  // The second edit didn't ask: the agent replied, with three lines for the three calls that asked.
  await expect(conversation.agentReplies.first()).toContainText(ALLOWS_FOR_TASK.reply)
  await expect(conversation.permissionCards).toHaveCount(0)
  await expect(conversation.closedPermissions).toHaveText([
    `Bash: ${ALLOWS_FOR_TASK.command}·allowed for this task`,
    `Bash: ${ALLOWS_FOR_TASK.compound}·allowed once`,
    `Edit: ${ALLOWS_FOR_TASK.edit.file_path}·allowed for this task`,
  ])
  expect((await toolCall(window, 'Edit', ALLOWS_FOR_TASK.editAgain.file_path))?.output).toBe(
    'The file README.md has been updated.',
  )

  // After a relaunch the task's session resumes with its rules: only the compound command asks.
  await glade.close()
  const relaunched = await launch({ agentScript: 'allows-for-task' })
  const again = relaunched.window
  const resumedChat = chat(again)
  await expect(resumedChat.closedPermissions).toHaveCount(3)
  await inputBar(again).field.fill('Run them once more.')
  await inputBar(again).field.press('Enter')
  const asked = resumedChat.permissionCards.first()
  await expect(asked.getByLabel('Command')).toHaveText(ALLOWS_FOR_TASK.compound)
  await asked.getByRole('button', { name: 'Allow once' }).click()
  await expect(resumedChat.agentReplies).toHaveCount(2)
  await expect(resumedChat.closedPermissions).toHaveCount(4)

  // Another task has none of them: its `npm test` asks.
  await taskList(again).newTask.click()
  await choosePermissions(again, 'Allow all', ASK)
  await inputBar(again).field.fill('Run the tests.')
  await inputBar(again).field.press('Enter')
  const theirs = chat(again).permissionCards.first()
  await expect(theirs.getByLabel('Command')).toHaveText(ALLOWS_FOR_TASK.command)
  await expect(theirs.getByRole('button', { name: 'Allow npm test commands for this task' })).toBeVisible()
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
  await expect(conversation.closedPermissions.first()).toHaveText(`Bash: ${SUBAGENT_PERMISSION.command}·denied`)

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

  await expect(conversation.closedPermissions.nth(1)).toHaveText(`Write: ${SUBAGENT_PERMISSION.file}·allowed once`)
  await expect(conversation.agentReplies.first()).toContainText(SUBAGENT_PERMISSION.reply)
  expect((await toolCall(window, 'Write'))?.output).toBe(`File created successfully at: ${SUBAGENT_PERMISSION.file}`)
})
