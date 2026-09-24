import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

test('input bar: ⌘L focuses it, ⇧↵ adds a line, the pickers persist, and ↵ sends to the agent', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)

  await expect(bar.setting('Model')).toHaveText('ModelOpus 5.5')
  await expect(bar.setting('Effort')).toHaveText('EffortHigh')
  await expect(bar.setting('Permissions')).toHaveText('PermissionsAllow all')
  await expect(bar.field).toHaveAttribute('placeholder', 'Reply…')
  await expect(bar.send).toBeEnabled()
  await expect(bar.stop).toHaveCount(0)

  // ⌘L focuses the field from anywhere.
  await taskList(glade.window).search.focus()
  await glade.window.keyboard.press('Meta+L')
  await expect(bar.field).toBeFocused()

  // ⇧↵ adds a line, and the field grows with what you type, up to a limit.
  const startHeight = (await bar.field.boundingBox())?.height ?? 0
  await glade.window.keyboard.type('Add a Retry-After header.')
  await glade.window.keyboard.press('Shift+Enter')
  await glade.window.keyboard.type('Keep the 429 body short.')
  await expect(bar.field).toHaveValue('Add a Retry-After header.\nKeep the 429 body short.')
  for (let line = 0; line < 3; line += 1) await glade.window.keyboard.press('Shift+Enter')
  await expect.poll(async () => (await bar.field.boundingBox())?.height ?? 0).toBeGreaterThan(startHeight)
  for (let line = 0; line < 20; line += 1) await glade.window.keyboard.press('Shift+Enter')
  await expect.poll(async () => (await bar.field.boundingBox())?.height).toBe(240)
  await bar.field.fill('Add a Retry-After header.')

  // The pickers change the task's model and effort, which it keeps.
  await bar.setting('Model').click()
  await bar.option('Sonnet 5').click()
  await expect(bar.setting('Model')).toHaveText('ModelSonnet 5')
  await bar.setting('Effort').click()
  await expect(bar.option('High')).toHaveAttribute('aria-checked', 'true')
  await bar.option('Low').click()
  await expect(bar.setting('Effort')).toHaveText('EffortLow')

  // ↵ sends: the message shows in the chat, the field empties, and the scripted agent's reply arrives.
  await bar.field.focus()
  await glade.window.keyboard.press('Enter')
  const conversation = chat(glade.window)
  await expect(conversation.userMessages).toHaveCount(1)
  await expect(conversation.userMessages.first()).toContainText('Add a Retry-After header.')
  await expect(bar.field).toHaveValue('')
  await expect(conversation.agentReplies.first()).toContainText('The client retries idempotent requests')
  await expect(bar.send).toBeEnabled()
  await expect(bar.stop).toHaveCount(0)

  await glade.close()
  const relaunched = inputBar((await launch()).window)
  await expect(relaunched.setting('Model')).toHaveText('ModelSonnet 5')
  await expect(relaunched.setting('Effort')).toHaveText('EffortLow')
})

test('input bar: while the agent works, Send waits and the Stop button stops it', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)

  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')

  // The agent works until it's stopped: Stop shows, Send waits, and you can keep typing.
  await expect(bar.stop).toBeVisible()
  await expect(bar.send).toBeDisabled()
  await bar.field.fill('Only run the unit tests.')
  await bar.field.press('Enter')
  await expect(chat(glade.window).userMessages).toHaveCount(1)
  await expect(bar.field).toHaveValue('Only run the unit tests.')

  await bar.stop.click()
  await expect(bar.stop).toHaveCount(0)
  await expect(bar.send).toBeEnabled()
  await bar.send.click()
  await expect(chat(glade.window).userMessages).toHaveCount(2)
  await expect(chat(glade.window).agentReplies.first()).toContainText('I stopped the suite')
})
