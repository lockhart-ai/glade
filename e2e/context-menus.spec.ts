// The context menus (docs/context-menus.md), end to end with the scripted agent: an agent reply's, a tool call's, a
// file tab's, a subagent's, a queued message's, a todo's and an artifact's. The task row's menu is in task-actions.spec.ts. Nothing
// reaches the real clipboard or Finder: e2e mode records what the menus copy and reveal (`desktop`).
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import { desktop, expect, test, type Glade } from './fixtures'
import {
  artifactsTab,
  chat,
  contextMenu,
  filesTab,
  firstRun,
  inputBar,
  subagentsTab,
  taskList,
  taskPanel,
} from './selectors'

/** Opens the workspace at `root`, starts a task and sends it `message`. */
async function startTask(window: Page, message: string): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(message)
  await bar.field.press('Enter')
}

/** The text the menus have copied, the latest last. */
async function copied(glade: Glade): Promise<string[]> {
  return (await desktop(glade)).copied
}

const REPLY =
  'The failing test was a timezone bug: formatDate used the local date. It now formats in UTC, and all 148 tests pass.'

test('context menus: copy and quote an agent reply, act on tool calls, file tabs and subagents', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'date.ts'), 'export function formatDate(d: Date) {}\n')
  const glade = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  const { window } = glade
  await startTask(window, 'The date test is flaky. Can you fix it?')
  const { agentReplies } = chat(window)
  await expect(agentReplies).toHaveCount(1)

  // An agent reply's menu: Copy takes its text as it reads, Copy as Markdown its source.
  const replyMenu = contextMenu(window, 'Reply actions')
  await agentReplies.first().click({ button: 'right' })
  await expect(replyMenu.items).toHaveText([
    'Copy⌘C',
    'Copy as Markdown',
    'Quote in reply',
    "Show this turn's tool calls",
  ])
  await replyMenu.item('Copy as Markdown').click()
  await expect.poll(() => copied(glade)).toEqual([expect.stringContaining('`formatDate` used the local date')])
  await agentReplies.first().click({ button: 'right' })
  await replyMenu.item('Copy').click()
  await expect.poll(async () => (await copied(glade)).at(-1)).toBe(REPLY)

  // Quote in reply puts the reply, quoted, in the message field, ready to write under.
  const bar = inputBar(window)
  await agentReplies.first().click({ button: 'right' })
  await replyMenu.item('Quote in reply').click()
  await expect(bar.field).toHaveValue(`> ${REPLY.replace('formatDate', '`formatDate`')}\n\n`)
  await expect(bar.field).toBeFocused()
  await bar.field.fill('')

  // Show this turn's tool calls opens the Tool calls tab, from any other.
  const panel = taskPanel(window)
  await panel.tab('Todos').click()
  await agentReplies.first().focus()
  await window.keyboard.press('Shift+F10')
  await replyMenu.item("Show this turn's tool calls").click()
  await expect(panel.tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')

  // A Bash call's menu copies its command and its output; a Read call's opens its file in the Files tab.
  const callMenu = contextMenu(window, 'Tool call actions')
  await panel.call(/^Done\s*Bash\s*npm test/).click({ button: 'right' })
  await expect(callMenu.items).toHaveText(['Copy command', 'Copy output'])
  await callMenu.item('Copy command').click()
  await expect.poll(async () => (await copied(glade)).at(-1)).toBe('npm test')
  await panel.call(/^Done\s*Read\s*src\/date\.ts/).click({ button: 'right' })
  await expect(callMenu.items).toHaveText(['Copy output', 'Open file'])
  await callMenu.item('Open file').click()
  await expect(panel.tab(/^Files/)).toHaveAttribute('aria-selected', 'true')

  // A file tab's menu: its path, relative or whole, Finder, and closing it.
  const files = filesTab(window)
  const fileMenu = contextMenu(window, 'File actions')
  await files.tab('date.ts').click({ button: 'right' })
  await expect(fileMenu.items).toHaveText([
    'Close⌘W',
    'Close others',
    'Close all',
    'Open in editor⌘⇧E',
    'Reveal in Finder',
    'Copy path',
    'Copy relative path',
  ])
  await fileMenu.item('Copy relative path').click()
  await expect.poll(async () => (await copied(glade)).at(-1)).toBe('src/date.ts')
  await files.tab('date.ts').click({ button: 'right' })
  await fileMenu.item('Reveal in Finder').click()
  await expect.poll(async () => (await desktop(glade)).revealed).toEqual([expect.stringMatching(/\/src\/date\.ts$/)])
  await files.tab('date.ts').click({ button: 'right' })
  await fileMenu.item('Close all').click()
  await expect(files.tab('date.ts')).toHaveCount(0)

  // A subagent's menu opens its log and copies it.
  const subagents = subagentsTab(window)
  const subagentMenu = contextMenu(window, 'Subagent actions')
  await panel.tab(/^Subagents/).click()
  await subagents.header('Find flaky tests').click({ button: 'right' })
  await expect(subagentMenu.items).toHaveText(['Expand log↵', 'Copy log'])
  await subagentMenu.item('Copy log').click()
  await expect.poll(async () => (await copied(glade)).at(-1)).toMatch(/^Find flaky tests\nGrep new Date/)
  await subagents.header('Find flaky tests').click({ button: 'right' })
  await subagentMenu.item('Expand log').click()
  await expect(subagents.log('Find flaky tests')).toBeVisible()
})

test('context menus: edit and remove a queued message', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'copy-in-batches', chosenFolder: root })
  await startTask(window, 'Move image uploads to S3.')
  const bar = inputBar(window)
  await expect(bar.stop).toBeVisible()
  await bar.field.fill('Keep the filenames.')
  await bar.field.press('Enter')
  await expect(bar.queuedRows).toHaveText(['1Keep the filenames.'])

  const menu = contextMenu(window, 'Queued message actions')
  await bar.queuedRows.first().click({ button: 'right' })
  await expect(menu.items).toHaveText(['Edit', 'Remove'])
  await menu.item('Edit').click()
  await expect(bar.queuedEditor).toBeFocused()
  await bar.queuedEditor.press('Escape')

  await bar.queuedRows.first().click({ button: 'right' })
  await menu.item('Remove').click()
  await expect(bar.queued).toHaveCount(0)
})

test('context menus: copy a todo, and ask the agent about it', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'writes-todos', chosenFolder: root })
  const { window } = glade
  await startTask(window, 'The login test is flaky.')
  await expect(chat(window).agentReplies).toHaveCount(1)
  const panel = taskPanel(window)
  await panel.tab(/^Todos/).click()

  const menu = contextMenu(window, 'Todo actions')
  await panel.todos.first().click({ button: 'right' })
  await expect(menu.items).toHaveText(['Copy', 'Ask agent about this'])
  await menu.item('Copy').click()
  await expect.poll(() => copied(glade)).toEqual(['Reproduce the flake'])

  await panel.todos.first().focus()
  await window.keyboard.press('Shift+F10')
  await menu.item('Ask agent about this').click()
  const bar = inputBar(window)
  await expect(bar.field).toHaveValue('About the todo “Reproduce the flake”: ')
  await expect(bar.field).toBeFocused()
})

test('context menus: open, copy, reveal and remove an artifact', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  for (const path of ['docs/releases/2.4.md', 'docs/releases/2.4-upgrade.md']) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), `# ${path}\n`)
  }
  const glade = await launch({ agentScript: 'declares-artifacts', chosenFolder: root })
  const { window } = glade
  await startTask(window, 'Draft release notes for 2.4, with a short upgrade guide.')
  await expect(chat(window).agentReplies).toHaveCount(1)
  const panel = taskPanel(window)
  const artifacts = artifactsTab(window)
  await panel.tab(/^Artifacts/).click()
  await expect(artifacts.cards).toHaveCount(2)

  const menu = contextMenu(window, 'Artifact actions')
  await artifacts.card('Upgrade guide').click({ button: 'right' })
  await expect(menu.items).toHaveText([
    'Open↵',
    'Open in editor⌘⇧E',
    'Copy contents',
    'Copy path',
    'Reveal in Finder',
    'Remove from artifacts',
  ])
  await menu.item('Copy path').click()
  await expect.poll(async () => (await desktop(glade)).copied).toEqual([join(root, 'docs/releases/2.4-upgrade.md')])
  await artifacts.card('Upgrade guide').click({ button: 'right' })
  await menu.item('Reveal in Finder').click()
  await expect
    .poll(async () => (await desktop(glade)).revealed)
    .toEqual([realpathSync(join(root, 'docs', 'releases', '2.4-upgrade.md'))])

  // Remove from artifacts takes the card away; the file stays.
  await artifacts.card('Upgrade guide').click({ button: 'right' })
  await menu.item('Remove from artifacts').click()
  await expect(artifacts.cards).toHaveCount(1)
  await expect(panel.tab(/^Artifacts/)).toHaveText('Artifacts 1')

  // Open shows the other in the Files tab.
  await artifacts.card('Release notes 2.4').click({ button: 'right' })
  await menu.item('Open').click()
  await expect(panel.tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(filesTab(window).tab('2.4.md')).toHaveAttribute('aria-pressed', 'true')
})
