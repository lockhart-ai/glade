import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, openedInEditor, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, filesTab, firstRun, inputBar, taskList, taskPanel } from './selectors'

/** Makes a workspace folder holding `files` (path → content), in a throwaway folder. */
function workspace(tempFolder: () => string, files: Readonly<Record<string, string>>): string {
  const root = join(tempFolder(), 'acme-api')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** The files `multi-tool-turn` reads and edits (its edit is scripted, so the file stays as it is). */
const DATE_FILES = {
  'src/date.ts': 'export function formatDate(d: Date) {\n  return d.toISOString().slice(0, 10)\n}\n',
  'test/date.test.ts': "it('formats', () => {\n  expect(formatDate(new Date(0))).toBe('1970-01-01')\n})\n",
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

\`\`\`http
HTTP/1.1 429 Too Many Requests
Retry-After: 17
\`\`\`
`

test('files: the list of changed and read files, open-file tabs, the viewer, Open in editor and ⌘W', async ({
  launch,
  tempFolder,
}) => {
  const root = workspace(tempFolder, DATE_FILES)
  const glade = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('The date test is flaky. Can you fix it?')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)

  // ⌘⌥2 shows Files: no file open yet, and the list of the files the turn touched.
  const panel = taskPanel(window)
  const files = filesTab(window)
  await window.keyboard.press('Meta+Alt+Digit2')
  await expect(panel.tab(/^Files/)).toHaveText('Files')
  await expect(panel.tabPanel).toContainText('No file open.')
  await expect(files.list).toHaveText('2')
  await files.list.click()
  await expect(files.menu).toHaveText(/^Changedsrc\/date\.tsReadtest\/date\.test\.ts$/)

  // Choosing a file opens it in a tab, with the blue dot of a file the agent changed, and counts it.
  await files.listed('src/date.ts').click()
  await expect(files.tab('date.ts')).toHaveAttribute('aria-pressed', 'true')
  await expect(files.changedDot('date.ts')).toBeVisible()
  await expect(panel.tab(/^Files/)).toHaveText('Files 1')
  await expect(panel.tabPanel).toContainText(/src\/date\.tsEdited by the agent · \d\d:\d\d/)

  // The source, with line numbers, coloured as the design colours code.
  await expect(files.line(1)).toHaveText('1export function formatDate(d: Date) {')
  await expect(files.line(3)).toHaveText('3}')
  await expect(files.line(1).getByText('export')).toHaveCSS('color', 'rgb(143, 178, 245)')

  // A read file opens beside it, without a dot; the tabs switch.
  await files.list.click()
  await files.listed('test/date.test.ts').click()
  await expect(files.tab('date.test.ts')).toHaveAttribute('aria-pressed', 'true')
  await expect(files.changedDot('date.test.ts')).toHaveCount(0)
  await expect(panel.tabPanel).toContainText('Read by the agent')
  await expect(panel.tab(/^Files/)).toHaveText('Files 2')
  await files.tab('date.ts').click()
  await expect(files.line(2)).toContainText('toISOString')

  // Open in editor opens the file showing, by its real path.
  await files.openInEditor.click()
  await expect.poll(() => openedInEditor(glade)).toEqual([realpathSync(join(root, 'src', 'date.ts'))])

  // The tabs are kept: a relaunch shows the same ones.
  await glade.close()
  const relaunched = await launch()
  const again = filesTab(relaunched.window)
  await expect(again.tab('date.ts')).toHaveAttribute('aria-pressed', 'true')
  await expect(again.tab('date.test.ts')).toBeVisible()
  await expect(again.line(1)).toContainText('export function formatDate')

  // File › Close (⌘W) with the focus in the panel closes the file showing, not the window; the next closes the other.
  await again.contents.focus()
  await chooseMenuItem(relaunched, 'File', 'Close')
  await expect(again.tab('date.ts')).toHaveCount(0)
  await expect(again.tab('date.test.ts')).toHaveAttribute('aria-pressed', 'true')
  await chooseMenuItem(relaunched, 'File', 'Close')
  await expect(taskPanel(relaunched.window).tabPanel).toContainText('No file open.')
  await expect(taskPanel(relaunched.window).tab(/^Files/)).toHaveText('Files')
})

test('files: show_file opens the collapsed panel at the file and line; Markdown shows as a preview', async ({
  launch,
  tempFolder,
}) => {
  const root = workspace(tempFolder, { 'docs/rate-limits.md': RATE_LIMITS })
  const glade = await launch({ agentScript: 'shows-a-file', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()

  // The panel starts collapsed, on Tool calls.
  const panel = taskPanel(window)
  await chooseMenuItem(glade, 'View', 'Toggle right panel')
  await expect(panel.panel).toBeHidden()

  await inputBar(window).field.fill('Document the rate limits for clients.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)

  // The agent's show_file opened the panel at Files, with the doc open and its line 8 marked and in view.
  const files = filesTab(window)
  await expect(panel.tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(files.tab('rate-limits.md')).toHaveAttribute('aria-pressed', 'true')
  await expect(files.changedDot('rate-limits.md')).toBeVisible()
  await expect(files.line(19)).toHaveText('19```')
  await expect(files.line(8)).toHaveAttribute('data-focused', 'true')
  await expect(files.line(8)).toBeInViewport()
  await expect(files.line(1).getByText('# Rate limits')).toHaveCSS('color', 'rgb(143, 178, 245)')

  // Preview renders the Markdown; Source goes back to it.
  await expect(files.mode('Source')).toHaveAttribute('aria-checked', 'true')
  await files.mode('Preview').click()
  await expect(panel.tabPanel.getByRole('heading', { level: 1, name: 'Rate limits' })).toBeVisible()
  await expect(panel.tabPanel.getByRole('table')).toContainText('60 per minute')
  await expect(files.source).toHaveCount(0)
  await files.mode('Source').click()
  await expect(files.line(8)).toContainText('/search')
})
