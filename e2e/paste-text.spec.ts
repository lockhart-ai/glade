// Marking pasted text for the agent (#363): a big paste becomes its own block, kept apart from what was typed, and
// the agent gets it wrapped in tags with a matching random id.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { agentReceived, expect, test } from './fixtures'
import { paste } from './paste'
import { chat, firstRun, inputBar, taskList } from './selectors'

const TRACE = 'Traceback (most recent call last):\n  File "api/views.py", line 42, in get_user\nKeyError: \'user_id\''

/** A message's text content, as the agent got it (no images in these tests). */
function textSent(content: unknown): string {
  return typeof content === 'string' ? content : ((content as { text?: string }[])[0]?.text ?? '')
}

test('pasting: a big paste becomes a chip, never landing in the field, and the agent gets it wrapped in tags', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)
  await bar.field.fill("Here's the error: ")
  await bar.field.focus()
  await bar.field.press('End')

  // A short line is left to the field, as always.
  expect(await paste(bar.field, { text: '/code/acme-api/src/main.ts' })).toBe(true)
  await expect(bar.pastedChips).toHaveCount(0)
  await bar.field.fill("Here's the error: ")
  await bar.field.press('End')

  // A big paste is marked: a chip shows above the field, and the field keeps only a short token, never the pasted
  // text itself.
  expect(await paste(bar.field, { text: TRACE })).toBe(false)
  await expect(bar.pastedChips).toHaveText(['Pasted text · 3 lines'])
  await expect(bar.field).toHaveValue(/^Here's the error: \[Pasted text · 3 lines\]$/)
  await expect(bar.field).not.toHaveValue(/KeyError/)

  await bar.field.fill(`${await bar.field.inputValue()} any ideas?`)
  await bar.field.press('Enter')

  const conversation = chat(glade.window)
  await expect(conversation.userMessages).toHaveCount(1)
  const sent = conversation.userMessages.first()
  await expect(sent).toContainText("Here's the error:")
  await expect(sent).toContainText('any ideas?')
  await expect(sent).not.toContainText('KeyError')
  await expect(bar.pastedChips).toHaveCount(0)
  await expect(bar.field).toHaveValue('')

  // The collapsed row expands in place to the pasted text, never shown as Markdown.
  const row = sent.getByRole('button', { name: 'Pasted text · 3 lines' })
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(sent).toContainText("KeyError: 'user_id'")

  // The agent gets it wrapped in tags, with a matching random id, at its place among the typed text.
  const [text] = (await agentReceived(glade)).map(textSent)
  expect(text).toMatch(/^Here's the error: <pasted_content id="[a-z0-9]+">\n/)
  expect(text).toContain(TRACE)
  expect(text).toMatch(/<\/pasted_content id="[a-z0-9]+"> any ideas\?$/)
  const opening = /id="([a-z0-9]+)"/.exec(text ?? '')?.[1] ?? ''
  expect(text?.match(new RegExp(`id="${opening}"`, 'g'))).toHaveLength(2)
  expect(text?.trim().endsWith('any ideas?')).toBe(true)

  // After a relaunch the chat still shows it, collapsed, with the same text once expanded.
  await glade.close()
  const relaunched = chat((await launch()).window)
  await expect(relaunched.userMessages).toHaveCount(1)
  const restoredRow = relaunched.userMessages.first().getByRole('button', { name: 'Pasted text · 3 lines' })
  await restoredRow.click()
  await expect(relaunched.userMessages.first()).toContainText("KeyError: 'user_id'")
})

test('pasting: removing a chip takes its token out of the field, and editing it updates the token', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)

  await bar.field.focus()
  expect(await paste(bar.field, { text: TRACE })).toBe(false)
  await expect(bar.pastedChips).toHaveCount(1)

  // Expand it, edit its text, and save: the chip's line count and the field's token both update.
  await bar.pastedChip(1).click()
  await expect(bar.pastedChipEditor).toHaveValue(TRACE)
  await bar.pastedChipEditor.fill(`${TRACE}\nmore context`)
  await bar.pastedChipButton('Save pasted text').click()
  await expect(bar.pastedChips).toHaveText(['Pasted text · 4 lines'])
  await expect(bar.field).toHaveValue('[Pasted text · 4 lines]')

  // Removing it clears the chip and the token.
  await bar.removePastedChip(1).click()
  await expect(bar.pastedChips).toHaveCount(0)
  await expect(bar.field).toHaveValue('')
})

test('pasting: a queued pasted block is delivered to the agent wrapped in tags', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)

  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()

  await bar.field.focus()
  expect(await paste(bar.field, { text: TRACE })).toBe(false)
  await bar.field.fill(`See this: ${await bar.field.inputValue()}`)
  await bar.queue.click()
  await expect(bar.queuedRows).toHaveText([`1See this: [Pasted text · 3 lines]`])

  await bar.stop.click()
  await expect(bar.stop).toHaveCount(0)
  await bar.field.fill('Go on.')
  await bar.field.press('Enter')

  await expect
    .poll(async () => (await agentReceived(glade)).map(textSent).at(-2))
    .toMatch(/^See this: <pasted_content id="[a-z0-9]+">\n/)
})
