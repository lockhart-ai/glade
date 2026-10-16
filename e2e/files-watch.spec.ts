// The Files tab watching its open files (#646), end to end: a file rewritten on disk by something that isn't the
// agent — a script, another editor — shows its new contents in the viewer and the previews without any action, and
// under unsaved edits asks first, as the agent's own edits do.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test, type Glade } from './fixtures'
import { expectPreviewOverSlot, inHtmlPreview } from './html-preview'
import { filesTab, firstRun, taskList, taskPanel } from './selectors'

/** Makes a workspace folder holding `files` (path → content), in a throwaway folder. */
function workspace(tempFolder: () => string, files: Readonly<Record<string, string>>): string {
  const root = join(tempFolder(), 'acme-api')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const REPORT = `<!doctype html>
<html>
<head><style>h1 { color: #5b3df0; }</style></head>
<body>
  <h1>Acme API — Weekly Usage</h1>
  <p>Calls were counted for the week to Friday.</p>
</body>
</html>
`

const SUMMARY = `# Acme API

Calls were steady this week.
`

/** Opens the workspace and a new task, with nothing sent to the agent: these specs never need one. */
async function openTask(window: Glade['window']): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await window.keyboard.press('Meta+Alt+Digit2')
}

/** Types `text` at the end of a line of the editor showing. */
async function typeAtEndOf(window: Glade['window'], line: number, text: string): Promise<void> {
  const files = filesTab(window)
  await files.editorLine(line).click()
  await window.keyboard.press('End')
  await window.keyboard.type(text)
}

test('files watch: previews follow a file rewritten on disk, and unsaved edits ask first', async ({
  launch,
  tempFolder,
}) => {
  const root = workspace(tempFolder, { 'reports/report.html': REPORT, 'notes/summary.md': SUMMARY })
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await openTask(window)
  const files = filesTab(window)
  const media = process.env.GLADE_FILES_WATCH_MEDIA_DIR
  if (media !== undefined) mkdirSync(media, { recursive: true })

  // The report, in preview.
  await files.treeRow('reports').click()
  await files.treeRow('report.html').click()
  await window.keyboard.press('Enter')
  await files.mode('Preview').click()
  await expectPreviewOverSlot(glade)
  expect(await inHtmlPreview(glade, 'document.querySelector("h1").textContent')).toBe('Acme API — Weekly Usage')

  if (media !== undefined) {
    await window.screenshot({ path: join(media, 'before-outside-write.png') })
  }

  // A shell script rewrites the report straight to disk — not through the agent's tools — and its preview shows the
  // new contents without any action.
  writeFileSync(join(root, 'reports/report.html'), REPORT.replace('Weekly Usage', 'Monthly Usage'))
  await expect
    .poll(() => inHtmlPreview(glade, 'document.querySelector("h1").textContent'))
    .toBe('Acme API — Monthly Usage')

  if (media !== undefined) {
    await window.screenshot({ path: join(media, 'after-outside-write.png') })
  }

  // The summary, in preview beside it, follows a rewrite the same way.
  await files.browse.click()
  await files.treeRow('notes').click()
  await files.treeRow('summary.md').click()
  await window.keyboard.press('Enter')
  await files.mode('Preview').click()
  await expect(taskPanel(window).tabPanel.getByRole('heading', { level: 1, name: 'Acme API' })).toBeVisible()
  writeFileSync(join(root, 'notes/summary.md'), SUMMARY.replace('steady this week', 'doubled this month'))
  await expect(files.contents).toContainText('Calls were doubled this month.')

  // The same for the source: with no unsaved edits, the editor takes the change quietly.
  await files.mode('Source').click()
  await expect(files.editorLine(3)).toHaveText('Calls were doubled this month.')
  await expect(files.changedOnDisk).toHaveCount(0)

  // With unsaved edits, a bar says the file changed on disk; Reload drops the edits for what's on disk.
  await typeAtEndOf(window, 3, ' so far')
  writeFileSync(join(root, 'notes/summary.md'), SUMMARY.replace('steady this week', 'fallen this week'))
  await expect(files.changedOnDisk).toBeVisible()
  await expect(files.editorLine(3)).toHaveText('Calls were doubled this month. so far')
  await files.reload.click()
  await expect(files.changedOnDisk).toHaveCount(0)
  await expect(files.editorLine(3)).toHaveText('Calls were fallen this week.')
})
