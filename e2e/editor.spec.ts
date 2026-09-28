import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { UiStateKey } from '../src/shared/domain'
import { expect, test, type Glade } from './fixtures'
import { chat, filesTab, firstRun, inputBar, taskList, taskPanel, toasts, unsavedDialog } from './selectors'
import { chooseMenuItem } from './menu'
import { invoke } from './task-view'

/** Makes a workspace folder holding `files` (path → content), in a throwaway folder. */
function workspace(tempFolder: () => string, files: Readonly<Record<string, string>>): string {
  const root = join(tempFolder(), 'acme-api')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const RATE_LIMITS = `# Rate limits

Every request to the public API counts against the key that made it.
Requests without a key are counted per IP address.

| Endpoint        | Limit          |
|-----------------|----------------|
| /search         | 60 per minute  |
| Everything else | 120 per minute |

## When you hit the limit

The API responds with \`429 Too Many Requests\` and a
\`Retry-After\` header: the number of seconds to wait.
`

const DOC = 'docs/rate-limits.md'

/** The right panel's narrowest, in px (`MIN_PANEL_WIDTH` in src/renderer/panels/panelSize.ts). */
const NARROWEST_PANEL = 320

/** Opens the workspace, and has a new task's agent show the doc (`show_file`): it opens in the Files tab's editor. */
async function showTheDoc(glade: Glade): Promise<void> {
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await say(window, 'Document the rate limits for clients.', 1)
  await expect(filesTab(window).editorLine(1)).toHaveText('# Rate limits')
}

/** Sends the task a message and waits for the agent's `replies`th reply. */
async function say(window: Page, message: string, replies: number): Promise<void> {
  await inputBar(window).field.fill(message)
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(replies)
}

/** Types at the end of a line of the editor. */
async function typeAtEndOf(window: Page, line: number, text: string): Promise<void> {
  await filesTab(window).editorLine(line).click()
  await window.keyboard.press('End')
  await window.keyboard.type(text)
}

test('editor: edit, save with ⌘S, and the agent changing the file', async ({ launch, tempFolder }) => {
  const root = workspace(tempFolder, { [DOC]: RATE_LIMITS })
  const onDisk = (): string => readFileSync(join(root, DOC), 'utf8')
  const glade = await launch({ agentScript: 'edits-a-shown-file', chosenFolder: root })
  const { window } = glade
  const files = filesTab(window)
  await showTheDoc(glade)

  // Typing edits the file in place: its tab's cross turns into a dot. Undo takes it back; redo puts it back.
  await typeAtEndOf(window, 4, ' Keys are case-sensitive.')
  await expect(files.editorLine(4)).toHaveText(
    'Requests without a key are counted per IP address. Keys are case-sensitive.',
  )
  await expect(files.unsaved('rate-limits.md')).toBeVisible()
  // A long line scrolls the editor sideways, and nothing else: one scroll bar, as the viewer has.
  await expect.poll(() => files.scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect
    .poll(() => taskPanel(window).tabPanel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBe(0)
  // At the panel's narrowest, the header keeps the file's name, Open in editor shrinks to its icon, and nothing is cut
  // off its right edge.
  await invoke(window, CommandName.UiStateSet, { key: UiStateKey.RightPanelWidth, value: String(NARROWEST_PANEL) })
  await expect(files.openInEditor.getByText('Open in editor')).toBeHidden()
  await expect(files.openInEditor).toHaveAttribute('title', 'Open in editor (⌘⇧E)')
  const header = files.openInEditor.locator('xpath=..')
  await expect
    .poll(async () => {
      const [button, box] = await Promise.all([files.openInEditor.boundingBox(), header.boundingBox()])
      return button !== null && box !== null && button.x + button.width <= box.x + box.width
    })
    .toBe(true)
  await expect.poll(() => header.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0)
  await expect(header.getByText('rate-limits.md', { exact: false })).toBeVisible()
  await invoke(window, CommandName.UiStateSet, { key: UiStateKey.RightPanelWidth, value: '' })
  await window.keyboard.press('Meta+z')
  await expect(files.unsaved('rate-limits.md')).toHaveCount(0)
  await window.keyboard.press('Meta+Shift+z')
  await expect(files.unsaved('rate-limits.md')).toBeVisible()

  // ⌘S writes it: the dot goes.
  await window.keyboard.press('Meta+s')
  await expect(files.unsaved('rate-limits.md')).toHaveCount(0)
  expect(onDisk()).toContain('per IP address. Keys are case-sensitive.\n')

  // The agent changes the file while you've no unsaved edits: the editor takes it quietly.
  writeFileSync(join(root, DOC), onDisk().replace('60 per minute', '30 per minute'))
  await say(window, 'Make /search 30 a minute.', 2)
  await expect(files.editorLine(8)).toHaveText('| /search         | 30 per minute  |')
  await expect(files.changedOnDisk).toHaveCount(0)
  await expect(files.unsaved('rate-limits.md')).toHaveCount(0)

  // With unsaved edits, a bar says it changed on disk. Keep mine keeps them, and saving writes them over the agent's.
  await typeAtEndOf(window, 1, ' for clients')
  writeFileSync(join(root, DOC), onDisk().replace('120 per minute', '100 per minute'))
  await say(window, 'Lower the default to 100.', 3)
  await expect(files.changedOnDisk).toBeVisible()
  await expect(files.editorLine(1)).toHaveText('# Rate limits for clients')
  await expect(files.editorLine(9)).toContainText('120 per minute')
  await files.keepMine.click()
  await expect(files.changedOnDisk).toHaveCount(0)
  await expect(files.unsaved('rate-limits.md')).toBeVisible()
  await files.editor.press('Meta+s')
  await expect(files.unsaved('rate-limits.md')).toHaveCount(0)
  expect(onDisk()).toContain('# Rate limits for clients\n')
  expect(onDisk()).toContain('120 per minute')

  // Reload drops your edits for the file on disk.
  await typeAtEndOf(window, 1, ' and partners')
  writeFileSync(join(root, DOC), onDisk().replace('120 per minute', '90 per minute'))
  await say(window, 'Lower the default to 90.', 4)
  await expect(files.changedOnDisk).toBeVisible()
  await files.reload.click()
  await expect(files.changedOnDisk).toHaveCount(0)
  await expect(files.editorLine(1)).toHaveText('# Rate limits for clients')
  await expect(files.editorLine(9)).toContainText('90 per minute')
  await expect(files.unsaved('rate-limits.md')).toHaveCount(0)
})

test('editor: unsaved edits ask before the tab closes, the task switches, or Glade quits', async ({
  launch,
  tempFolder,
}) => {
  const root = workspace(tempFolder, { [DOC]: RATE_LIMITS })
  const onDisk = (): string => readFileSync(join(root, DOC), 'utf8')
  const glade = await launch({ agentScript: 'edits-a-shown-file', chosenFolder: root })
  const { window } = glade
  const files = filesTab(window)
  const prompt = unsavedDialog(window)
  await showTheDoc(glade)

  // Closing the tab asks. Cancel keeps it, edits and all.
  await typeAtEndOf(window, 1, ' (draft)')
  await files.unsaved('rate-limits.md').click()
  await expect(prompt.dialog).toContainText('Save your edits to rate-limits.md?')
  await expect(prompt.dialog).toContainText('rate-limits.md has unsaved edits.')
  await prompt.cancel.click()
  await expect(prompt.dialog).toHaveCount(0)
  await expect(files.editorLine(1)).toHaveText('# Rate limits (draft)')

  // File › Close (⌘W) in the editor asks too. Discard closes it, and the file on disk stays as it was.
  await files.editor.focus()
  await chooseMenuItem(glade, 'File', 'Close')
  await expect(prompt.dialog).toContainText('Save your edits to rate-limits.md?')
  await prompt.discard.click()
  await expect(files.tab('rate-limits.md')).toHaveCount(0)
  expect(onDisk()).toBe(RATE_LIMITS)

  // Switching task asks. Save writes the edits, then the new task shows.
  await files.list.click()
  await files.listed(DOC).click()
  await typeAtEndOf(window, 1, ' (saved on the way out)')
  await taskList(window).newTask.click()
  await expect(prompt.dialog).toContainText('Save your edits before switching task?')
  await prompt.save.click()
  await expect(inputBar(window).field).toBeEmpty()
  expect(onDisk()).toContain('# Rate limits (saved on the way out)\n')

  // Quitting asks. Cancel keeps Glade open; Discard quits.
  await taskList(window).taskRow('Document the rate limits').click()
  await typeAtEndOf(window, 1, '!')
  await glade.app.evaluate(({ app }) => {
    app.quit()
  })
  await expect(prompt.dialog).toContainText('Save your edits before quitting?')
  await prompt.cancel.click()
  await expect(files.editorLine(1)).toHaveText('# Rate limits (saved on the way out)!')
  const quit = glade.app.waitForEvent('close')
  await glade.app.evaluate(({ app }) => {
    app.quit()
  })
  await prompt.discard.click()
  await quit
  expect(onDisk()).toContain('# Rate limits (saved on the way out)\n')
})

test('editor: a failed save says why and keeps the edits; ⌘F finds in the file', async ({ launch, tempFolder }) => {
  const root = workspace(tempFolder, { [DOC]: RATE_LIMITS })
  const glade = await launch({ agentScript: 'edits-a-shown-file', chosenFolder: root })
  const { window } = glade
  const files = filesTab(window)
  await showTheDoc(glade)

  // A file you can't write: saving shows a toast, and the edits stay unsaved.
  chmodSync(join(root, DOC), 0o444)
  await typeAtEndOf(window, 1, ' (read-only)')
  await window.keyboard.press('Meta+s')
  await expect(
    toasts(window).saying(
      `Couldn’t save rate-limits.md: files.write failed: you don't have permission to write ${DOC}`,
    ),
  ).toBeVisible()
  await expect(files.unsaved('rate-limits.md')).toBeVisible()
  expect(readFileSync(join(root, DOC), 'utf8')).toBe(RATE_LIMITS)

  // Once it can be written, saving again works.
  chmodSync(join(root, DOC), 0o644)
  await window.keyboard.press('Meta+s')
  await expect(files.unsaved('rate-limits.md')).toHaveCount(0)
  expect(readFileSync(join(root, DOC), 'utf8')).toContain('# Rate limits (read-only)\n')

  // ⌘F in the editor finds in the file, not the tasks: ↵ goes to the next match, Esc closes the bar.
  await files.editorLine(3).click()
  await window.keyboard.press('Meta+f')
  await expect(files.findField).toBeFocused()
  await window.keyboard.type('limit')
  await expect(taskPanel(window).panel.locator('.cm-searchMatch')).toHaveCount(3)
  await window.keyboard.press('Enter')
  await expect(taskPanel(window).panel.locator('.cm-searchMatch-selected')).toHaveCount(1)
  await expect(taskList(window).search).not.toBeFocused()
  await window.keyboard.press('Escape')
  await expect(files.findField).toHaveCount(0)
  await expect(files.editor).toBeFocused()
})

test('editor: files too large to show whole, or not text, stay read-only', async ({ launch, tempFolder }) => {
  const long = Array.from({ length: 6000 }, (_, index) => `line ${String(index + 1)}`).join('\n')
  const root = workspace(tempFolder, { [DOC]: RATE_LIMITS, 'logs/big.log': long, 'docs/logo.png': 'PNG\0\0\0' })
  const glade = await launch({ agentScript: 'edits-a-shown-file', chosenFolder: root })
  const { window } = glade
  const files = filesTab(window)
  await showTheDoc(glade)
  const { value: taskId } = await invoke(window, CommandName.UiStateGet, { key: UiStateKey.SelectedTaskId })

  await invoke(window, CommandName.FilesOpen, { taskId: taskId ?? '', path: 'logs/big.log' })
  await expect(files.tab('big.log')).toHaveAttribute('aria-pressed', 'true')
  await expect(taskPanel(window).panel.getByRole('note')).toContainText('only its first 5,000 lines are shown')
  await expect(files.line(1)).toHaveText('1line 1')
  await expect(files.editor).toHaveCount(0)

  await invoke(window, CommandName.FilesOpen, { taskId: taskId ?? '', path: 'docs/logo.png' })
  await expect(files.tab('logo.png')).toHaveAttribute('aria-pressed', 'true')
  await expect(files.contents).toContainText('This file isn’t text')
  await expect(files.editor).toHaveCount(0)
})
