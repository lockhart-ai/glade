// What runs outside the sandbox is a grant of its own (P15-11, #515), end to end with the scripted agent, in Allow all
// with the sandbox on: an MCP server Glade doesn't build asks once, whichever of its tools is called and whatever rule
// in the user's own settings would allow it; a message to another Claude session, and `RemoteTrigger`, ask once each;
// and a message to the task's own subagent never does. Each decision shows on its call's row. A grant for the
// workspace shows in Settings › Workspace, in the MCP servers list, where it's removed (the next call then asks
// again) and added back; and one made Glade-wide in Settings › Agent covers the workspace's next task.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { REACHES_OUTSIDE } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { agentFlagSettings, agentSessions, expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, settings, taskList, taskPanel, workspaceSwitcher } from './selectors'
import { invoke } from './task-view'

const CONNECTOR = REACHES_OUTSIDE.connector.name
const TRACKER = REACHES_OUTSIDE.tracker.name

/** Starts a task on the script, in Allow all with the sandbox on. */
async function startTask(window: Page): Promise<void> {
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Look up the retry policy.')
  await inputBar(window).field.press('Enter')
}

/** The one open card, once its title says what the agent wants. */
async function openCard(window: Page, wants: string): Promise<Locator> {
  const cards = chat(window).permissionCards
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText(wants)
  return cards.first()
}

test('an MCP server asks once, other agents once each, the task’s own subagent never, and Settings lists what’s granted', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'reaches-outside', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  // The sandbox is off by default until P15's last PR: turned on here, before the task's session starts.
  await invoke(window, CommandName.SettingsUpdate, { patch: { sandboxEnabled: true } })
  await startTask(window)
  const conversation = chat(window)
  const answers = (card: Locator) => card.getByRole('group', { name: 'Answer' }).getByRole('button')

  // The connector: its name as Claude Code reports it, what allowing it means, the tool and its input. A rule in the
  // user's own settings allows this call, and it asks all the same.
  const docs = await openCard(window, `The agent wants to use the${CONNECTOR}MCP server`)
  await expect(docs).toContainText('It runs outside the sandbox, with whatever access it has.')
  await expect(docs).toContainText(REACHES_OUTSIDE.search)
  await expect(docs.getByLabel('Input')).toContainText(REACHES_OUTSIDE.query)
  await expect(answers(docs)).toHaveText(['Allow for this task', 'Allow for this workspace', 'Deny'])
  await expect(taskPanel(window).permissionLines).toHaveText([`Waiting on you: use the ${CONNECTOR} MCP server`])
  await docs.getByRole('button', { name: 'Allow for this workspace' }).click()

  // Its second tool ran unasked. The server from the workspace's `.mcp.json` is another card: denied, with a note.
  const tracker = await openCard(window, `The agent wants to use the${TRACKER}MCP server`)
  await expect(tracker).toContainText(REACHES_OUTSIDE.issue)
  await tracker.getByRole('button', { name: 'Deny' }).click()
  await tracker.getByRole('textbox', { name: 'Note for the agent' }).fill('No tickets from here.')
  await tracker.getByRole('textbox', { name: 'Note for the agent' }).press('Enter')

  // The message to its own subagent never asked; the one to another session does, with the message it would send.
  const peer = await openCard(window, 'The agent wants to message other Claude sessions')
  await expect(peer).toContainText('Messages to this task’s own subagents never ask.')
  await expect(peer.getByLabel('Input')).toContainText(REACHES_OUTSIDE.peer)
  await expect(answers(peer)).toHaveText(['Allow for this task', 'Allow for this workspace', 'Deny'])
  await peer.getByRole('button', { name: 'Allow for this task' }).click()

  // And cloud agents.
  const cloud = await openCard(window, 'The agent wants to manage cloud agents')
  await expect(cloud).toContainText('RemoteTrigger')
  await cloud.getByRole('button', { name: 'Allow for this task' }).click()

  await expect(conversation.agentReplies.last()).toContainText(REACHES_OUTSIDE.reply)
  await expect(conversation.permissionCards).toHaveCount(0)
  // Each decision is on its call's row, status first; the connector's second tool says whose grant let it through.
  await expect(taskPanel(window).permissionLines).toHaveText([
    `Allowed for this workspace: use the ${CONNECTOR} MCP server`,
    `Allowed by workspace grant: use the ${CONNECTOR} MCP server`,
    `Denied: use the ${TRACKER} MCP server · “No tickets from here.”`,
    'Allowed for this task: message other Claude sessions',
    'Allowed for this task: manage cloud agents',
  ])
  // Nothing of them is in the session's sandbox settings: Glade holds the session to them itself.
  const applied = JSON.stringify(await agentFlagSettings(glade))
  expect(applied).not.toContain(REACHES_OUTSIDE.connectorKey)
  expect(applied).not.toContain('SendMessage')

  // The next message calls the connector again: the workspace's grant covers it, with no card.
  await inputBar(window).field.fill('Check it again.')
  await inputBar(window).field.press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(REACHES_OUTSIDE.again)
  await expect(conversation.permissionCards).toHaveCount(0)

  // Settings › Workspace lists it, in the third list, by the name it was reported under.
  const modal = settings(window)
  const switcher = workspaceSwitcher(window)
  await switcher.trigger.click()
  await switcher.action('Workspace settings…').click()
  await expect(modal.heading).toHaveText('acme-api')
  await expect(modal.grantRows('MCP servers')).toHaveText([CONNECTOR])
  // The task's own grants (other sessions, cloud agents) aren't listed: they end with the task.
  // Removing it: the row goes, Add… takes the focus, and the list says it's empty.
  await modal.dialog.getByRole('button', { name: `Remove ${CONNECTOR}`, exact: true }).click()
  await expect(modal.grantList('MCP servers')).toContainText('No MCP servers yet.')
  await expect(modal.addGrant('Add an MCP server')).toBeFocused()
  await modal.close.click()

  // The running task's next call to the connector asks again, in the same session.
  await inputBar(window).field.fill('And once more.')
  await inputBar(window).field.press('Enter')
  const again = await openCard(window, `The agent wants to use the${CONNECTOR}MCP server`)
  expect(await agentSessions(glade)).toHaveLength(1)

  // Added back in Settings while the card waits: Add… offers the servers the workspace's sessions have reported, by
  // name, then the other agents; the first is chosen to start, and ↵ on Add adds it.
  await switcher.trigger.click()
  await switcher.action('Workspace settings…').click()
  await modal.addGrant('Add an MCP server').click()
  const pending = modal.grantRow('MCP servers', 'New MCP server')
  const choice = pending.getByRole('button', { name: /^MCP server to add: / })
  await expect(choice).toHaveText(TRACKER)
  await expect(pending.getByRole('button', { name: 'Add', exact: true })).toBeFocused()
  await choice.click()
  await expect(window.getByRole('menu', { name: 'MCP servers' }).getByRole('menuitemradio')).toHaveText([
    TRACKER,
    CONNECTOR,
    'Messaging other Claude sessions',
    'Cloud agents',
  ])
  await window.getByRole('menuitemradio', { name: 'Messaging other Claude sessions', exact: true }).click()
  await pending.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(modal.grantRows('MCP servers')).toHaveText(['Messaging other Claude sessions'])
  await expect(modal.addGrant('Add an MCP server')).toBeFocused()

  // The Glade-wide list, in Agent, starts empty and offers the same servers: the connector, granted there, covers
  // every workspace.
  await modal.section('Agent').click()
  await expect(modal.grantList('Glade-wide MCP servers')).toContainText('No MCP servers yet.')
  await modal.addGrant('Add a Glade-wide MCP server').click()
  const wide = modal.grantRow('Glade-wide MCP servers', 'New MCP server')
  await wide.getByRole('button', { name: /^MCP server to add: / }).click()
  await window.getByRole('menuitemradio', { name: CONNECTOR, exact: true }).click()
  await wide.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(modal.grantRows('Glade-wide MCP servers')).toHaveText([CONNECTOR])
  await modal.close.click()

  // The card that was waiting is still the task's to answer.
  await again.getByRole('button', { name: 'Deny' }).click()
  await again.getByRole('textbox', { name: 'Note for the agent' }).press('Enter')
  await expect(conversation.agentReplies.last()).toContainText(REACHES_OUTSIDE.again)

  // A relaunch keeps both lists, and the workspace's next task goes straight past the connector and the other
  // session to the server nobody granted.
  await glade.close()
  const relaunched = await launch({ agentScript: 'reaches-outside' })
  const next = relaunched.window
  await chooseMenuItem(relaunched, 'Glade', 'Settings…')
  const kept = settings(next)
  await expect(kept.grantRows('Glade-wide MCP servers')).toHaveText([CONNECTOR])
  await kept.close.click()
  await startTask(next)
  await openCard(next, `The agent wants to use the${TRACKER}MCP server`)
  await expect(taskPanel(next).permissionLines).toHaveText([
    `Allowed by Glade-wide grant: use the ${CONNECTOR} MCP server`,
    `Allowed by Glade-wide grant: use the ${CONNECTOR} MCP server`,
    `Waiting on you: use the ${TRACKER} MCP server`,
  ])
  const row = taskList(next).rows('Active').first()
  await expect(row).toContainText(`Waiting on you: use the ${TRACKER} MCP server`)
  await chat(next).permissionCards.first().getByRole('button', { name: 'Allow for this task' }).click()
  // Other sessions are the workspace's by now; only cloud agents are left to ask.
  await openCard(next, 'The agent wants to manage cloud agents')
  await expect(taskPanel(next).permissionLines.nth(3)).toHaveText(
    'Allowed by workspace grant: message other Claude sessions',
  )
})
