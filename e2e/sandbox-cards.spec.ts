// The agent sandbox's permission cards (#450), end to end with the scripted agent, in Allow all with the sandbox on: a
// command's connection and a `WebFetch` ask for their domain, a read and a write outside the workspace for their folder,
// each answered for the task or for the workspace; a command the sandbox blocks has the agent ask for the folder with
// `request_access`, and once it's allowed the same command runs; and a command that wants to run outside the sandbox is
// allowed once, or denied with a note. A grant for the workspace reaches the workspace's next task, a grant for the task
// doesn't, and nothing is written to the workspace's own files.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { ASKS_SANDBOX } from '../src/main/agent/scripts'
import type { SandboxFlagSettings } from '../src/main/agent/backend'
import { E2E_AGENT_GLOBAL, type E2eAgent } from '../src/main/e2e'
import { CommandName } from '../src/shared/bridge'
import {
  PermissionDecisionKind,
  PermissionRequestState,
  ToolCallState,
  ToolEventKind,
  type Task,
  type ToolCallEvent,
} from '../src/shared/domain'
import { expect, test, type Glade } from './fixtures'
import { chat, firstRun, inputBar, settings, taskHeader, taskList, taskPanel, workspaceSwitcher } from './selectors'
import { invoke } from './task-view'

/** The folders the script's agent reaches for, outside the workspace. */
const SHARED = '/Users/Shared/acme-shared'
const DOCS = '/Users/Shared/acme-docs'

/** The workspace's tasks, as main has them, newest first. */
async function tasks(window: Page): Promise<readonly Task[]> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  return (await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })).tasks
}

/** A task's tool calls, as main has them. */
async function toolCalls(window: Page, taskId: string): Promise<ToolCallEvent[]> {
  const { toolEvents } = await invoke(window, CommandName.TasksHistory, { id: taskId })
  return toolEvents.filter((event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall)
}

/** Every change to a session's sandbox the app has asked for, oldest first. */
async function overlays({ app }: Glade): Promise<SandboxFlagSettings[]> {
  return app.evaluate((_, name) => [...(Reflect.get(globalThis, name) as E2eAgent).flagSettings], E2E_AGENT_GLOBAL)
}

/** Starts a task on the script, in Allow all with the sandbox on. */
async function startTask(window: Page): Promise<void> {
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Set things up.')
  await inputBar(window).field.press('Enter')
}

/** The one open card, once its title says what the agent wants. */
async function openCard(window: Page, wants: string): Promise<Locator> {
  const cards = chat(window).permissionCards
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText(wants)
  return cards.first()
}

test('the sandbox’s cards: a domain, a folder, a blocked command’s request_access and running outside the sandbox', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'asks-sandbox', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  // The sandbox is off by default until P15's last PR: turned on here, before the task's session starts.
  await invoke(window, CommandName.SettingsUpdate, { patch: { sandboxEnabled: true } })
  await startTask(window)
  const conversation = chat(window)
  const answers = (card: Locator) => card.getByRole('group', { name: 'Answer' }).getByRole('button')

  // A command's connection: the domain, with the command that waits on it, and no Allow once.
  const install = await openCard(window, `The agent wants to reach${ASKS_SANDBOX.host}`)
  await expect(install.getByLabel('Command')).toHaveText(ASKS_SANDBOX.install)
  await expect(answers(install)).toHaveText(['Allow for this task', 'Allow for this workspace', 'Deny'])
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · waiting on you')
  await install.getByRole('button', { name: 'Allow for this task' }).click()

  // WebFetch: its URL's domain.
  const fetch = await openCard(window, 'The agent wants to reachdocs.acme.dev')
  await expect(fetch).toContainText(ASKS_SANDBOX.docs)
  await fetch.getByRole('button', { name: 'Allow for this task' }).click()

  // A read outside the workspace: the folder, with the file under it, granted to the workspace.
  const read = await openCard(window, `The agent wants to read${SHARED}`)
  await expect(read).toContainText(ASKS_SANDBOX.notes)
  await read.getByRole('button', { name: 'Allow for this workspace' }).click()

  // A write: its folder, read-write, for this task only.
  const write = await openCard(window, `The agent wants to write to${DOCS}`)
  await expect(write).toContainText(ASKS_SANDBOX.changelog)
  await write.getByRole('button', { name: 'Allow for this task' }).click()

  // The sandbox blocks a command: it fails, and the agent asks for the folder itself, saying why.
  const access = await openCard(window, `The agent wants to read${ASKS_SANDBOX.configFolder}`)
  await expect(access).toContainText('cat needs to read the shared config.')
  await expect(answers(access)).toHaveText(['Allow for this task', 'Allow for this workspace', 'Deny'])
  await expect(taskPanel(window).call(/^Failed\s*Bash/)).toHaveCount(1)
  await expect(taskPanel(window).call(/^Waiting\s*request_access/)).toContainText(
    `Waiting on you: read ${ASKS_SANDBOX.configFolder}`,
  )
  await access.getByRole('button', { name: 'Allow for this task' }).click()

  // Running outside the sandbox: the command, what that means, and only Allow once and Deny.
  const compose = await openCard(window, 'The agent wants to run a command outside the sandbox')
  await expect(compose).toContainText('Outside the sandbox, it can use any folder and reach any domain you can.')
  await expect(compose.getByLabel('Command')).toHaveText(ASKS_SANDBOX.compose)
  await expect(answers(compose)).toHaveText(['Allow once', 'Deny'])
  await compose.getByRole('button', { name: 'Allow once' }).click()

  // It asks again the next time; this one is denied, with a note.
  const push = await openCard(window, 'The agent wants to run a command outside the sandbox')
  await expect(push.getByLabel('Command')).toHaveText(ASKS_SANDBOX.push)
  await push.getByRole('button', { name: 'Deny' }).click()
  await push.getByRole('textbox', { name: 'Note for the agent' }).fill('I’ll push it myself.')
  await push.getByRole('textbox', { name: 'Note for the agent' }).press('Enter')

  await expect(conversation.agentReplies.last()).toContainText(ASKS_SANDBOX.reply)
  await expect(conversation.permissionCards).toHaveCount(0)
  // The answered cards are on their calls' rows, status first: the connection's on its command's row, the blocked
  // command saying what it was blocked from once the agent's request named it, and its retry let through by the grant.
  await expect(conversation.permissionRequests).toHaveCount(0)
  await expect(taskPanel(window).permissionLines).toHaveText([
    `Allowed for this task: reach ${ASKS_SANDBOX.host}`,
    'Allowed for this task: reach docs.acme.dev',
    `Allowed for this workspace: read ${SHARED}`,
    `Allowed for this task: write to ${DOCS}`,
    `Blocked by the sandbox: read ${ASKS_SANDBOX.configFolder}`,
    `Allowed for this task: read ${ASKS_SANDBOX.configFolder}`,
    'Allowed once: run outside the sandbox',
    'Denied: run outside the sandbox · “I’ll push it myself.”',
  ])
  await expect(taskPanel(window).permissionLines.nth(4)).toHaveAttribute('data-permission', 'blocked')

  // What the agent got: the blocked command, the grant, then the same command running; and the denial's note.
  const [task] = await tasks(window)
  const calls = await toolCalls(window, task?.id ?? '')
  const config = calls.filter(({ input }) => input.command === `cat ${ASKS_SANDBOX.config}`)
  expect(config.map(({ state, output }) => [state, output])).toEqual([
    [ToolCallState.Error, expect.stringContaining('Operation not permitted')],
    [ToolCallState.Done, '{ "db": "staging" }'],
  ])
  const asked = calls.find(({ name }) => name === 'mcp__glade__request_access')
  expect(asked?.output).toBe(
    `Allowed for this task: you can now read ${ASKS_SANDBOX.configFolder}. Run the command that was blocked again.`,
  )
  expect(calls.find(({ input }) => input.command === ASKS_SANDBOX.push)?.output).toContain('I’ll push it myself.')
  expect(calls.find(({ input }) => input.command === ASKS_SANDBOX.compose)?.state).toBe(ToolCallState.Done)

  // The session's sandbox as it ended up: every grant, the read-only folders readable, the write's folder writable.
  const last = (await overlays(glade)).at(-1)
  expect(last?.sandbox?.filesystem?.allowRead).toEqual([root, SHARED, DOCS, ASKS_SANDBOX.configFolder])
  expect(last?.sandbox?.filesystem?.allowWrite).toEqual([root, DOCS])
  expect(last?.permissions?.allow).toEqual([
    `Read(/${SHARED}/**)`,
    `Read(/${ASKS_SANDBOX.configFolder}/**)`,
    `WebFetch(domain:${ASKS_SANDBOX.host})`,
    'WebFetch(domain:docs.acme.dev)',
  ])
  // Nothing was written to the workspace's own files.
  expect(existsSync(join(root, '.claude'))).toBe(false)

  // The workspace's next task has the workspace's grant, and none of the first task's: it asks for both domains
  // again, then goes straight past the read to the write.
  await startTask(window)
  const again = await openCard(window, `The agent wants to reach${ASKS_SANDBOX.host}`)
  await again.getByRole('button', { name: 'Allow for this task' }).click()
  const docs = await openCard(window, 'The agent wants to reachdocs.acme.dev')
  await docs.getByRole('button', { name: 'Allow for this task' }).click()
  await openCard(window, `The agent wants to write to${DOCS}`)
  const [second] = await tasks(window)
  const reads = (await toolCalls(window, second?.id ?? '')).filter(({ name }) => name === 'Read')
  expect(reads.map(({ state }) => state)).toEqual([ToolCallState.Done])
  // Its read's row says which rule let it through; the sidebar says what the task waits on now, led by the shield.
  await expect(taskPanel(window).permissionLines.nth(2)).toHaveText(`Allowed by workspace grant: read ${SHARED}`)
  const row = taskList(window).rows('Active').first()
  await expect(row).toContainText(`Waiting on you: write to ${DOCS}`)
  await expect(row.getByRole('img', { name: 'Permission' })).toBeVisible()
})

test('a request_access card open when Glade quits is still there after a relaunch, and allowing it carries the agent on', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'asks-sandbox', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await invoke(window, CommandName.SettingsUpdate, { patch: { sandboxEnabled: true } })
  await startTask(window)
  for (const wants of [
    `The agent wants to reach${ASKS_SANDBOX.host}`,
    'The agent wants to reachdocs.acme.dev',
    `The agent wants to read${SHARED}`,
    `The agent wants to write to${DOCS}`,
  ]) {
    const card = await openCard(window, wants)
    await card.getByRole('button', { name: 'Allow for this workspace' }).click()
  }
  await openCard(window, `The agent wants to read${ASKS_SANDBOX.configFolder}`)

  // Quit with the card open.
  await glade.close()
  const relaunched = await launch({ agentScript: 'asks-sandbox' })
  const again = relaunched.window

  const card = await openCard(again, `The agent wants to read${ASKS_SANDBOX.configFolder}`)
  await expect(card).toContainText('cat needs to read the shared config.')
  await expect(taskHeader(again).stateDot).toHaveAccessibleName('Active · waiting on you')
  expect((await tasks(again))[0]).toMatchObject({ awaitingPermission: true })
  await expect(taskPanel(again).call(/^Interrupted\s*request_access/)).toBeVisible()

  await card.getByRole('button', { name: 'Allow for this workspace' }).click()

  // The grant is saved, the session resumes with it, and the agent is told.
  await expect(taskPanel(again).call(/^Interrupted\s*request_access/)).toContainText(
    `Allowed for this workspace: read ${ASKS_SANDBOX.configFolder}`,
  )
  await expect(chat(again).restarts).toHaveCount(1)
  const [first] = await overlays(relaunched)
  expect(first?.sandbox?.filesystem?.allowRead).toEqual([root, SHARED, DOCS, ASKS_SANDBOX.configFolder])
  expect(first?.permissions?.allow).toContain(`WebFetch(domain:${ASKS_SANDBOX.host})`)
})

test('Allow for this workspace on a card adds to Settings › Workspace while it’s open', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'asks-sandbox', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await invoke(window, CommandName.SettingsUpdate, { patch: { sandboxEnabled: true } })
  await startTask(window)
  await openCard(window, `The agent wants to reach${ASKS_SANDBOX.host}`)

  // Settings › Workspace, open over the chat: nothing granted yet but the root.
  const modal = settings(window)
  const switcher = workspaceSwitcher(window)
  await switcher.trigger.click()
  await switcher.action('Workspace settings…').click()
  await expect(modal.grantRows('Folders')).toHaveCount(1)
  await expect(modal.grantList('Domains')).toContainText('No domains yet.')

  // The cards are behind the modal: each is answered as its button would, for the workspace.
  const allowForWorkspace = async (): Promise<void> => {
    const [task] = await tasks(window)
    const { permissionRequests } = await invoke(window, CommandName.TasksHistory, { id: task?.id ?? '' })
    const open = permissionRequests.find(({ state }) => state === PermissionRequestState.Open)
    await invoke(window, CommandName.PermissionsAnswer, {
      id: open?.id ?? '',
      decision: { kind: PermissionDecisionKind.AllowForWorkspace },
    })
  }
  await allowForWorkspace()
  await expect(modal.grantRow('Domains', ASKS_SANDBOX.host)).toBeVisible()

  // Then WebFetch's domain, and the read's folder, read-only, each as its card is answered.
  await expect.poll(async () => (await tasks(window))[0]?.permissionAsk).toMatchObject({ domain: 'docs.acme.dev' })
  await allowForWorkspace()
  await expect(modal.grantRows('Domains')).toHaveCount(2)
  await expect.poll(async () => (await tasks(window))[0]?.permissionAsk).toMatchObject({ path: SHARED })
  await allowForWorkspace()
  const shared = modal.grantRow('Folders', SHARED)
  await expect(shared).toBeVisible()
  await expect(shared).toContainText('Read-only')
  await expect(modal.grantRows('Folders')).toHaveCount(2)
})
