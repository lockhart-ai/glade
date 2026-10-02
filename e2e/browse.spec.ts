import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TIDIES_DOCS } from '../src/main/agent/scripts'
import { SHELL_GIT_ENV } from '../src/main/agent/scripted-shell'
import { expect, test } from './fixtures'
import { chat, filesTab, firstRun, inputBar, taskList, taskPanel } from './selectors'
import { boxOf } from './window-layout'

/**
 * A made-up project in a throwaway folder, as a git repository: what git ignores (its dependencies and logs), and Glade's
 * own folder, are there on disk but never in the tree.
 */
function acmeApi(tempFolder: () => string): string {
  const root = join(realpathSync(tempFolder()), 'acme-api')
  const files: Readonly<Record<string, string>> = {
    '.gitignore': 'node_modules/\n*.log\n',
    'README.md': '# Acme API\n',
    'notes.txt': 'Rate limits: 120 a minute, 60 for /search.\n',
    'api/throttles.py': 'class KeyRateThrottle:\n    rate = "120/min"\n',
    'api/tests/test_throttles.py': 'def test_limit():\n    assert True\n',
    'docs/rate-limits.md': '# Rate limits\n',
    'node_modules/left-pad/index.js': 'module.exports = {}\n',
    'server.log': 'GET /api/items 200\n',
    '.glade/state.json': '{}\n',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  execFileSync('/bin/sh', ['-c', 'git init -q -b main && git add -A && git commit -q -m "Start the Acme API"'], {
    cwd: root,
    env: { ...process.env, ...SHELL_GIT_ENV },
  })
  return root
}

/** The tree's rows, top to bottom, by name: a file's row also shows its size, which is no part of its name. */
function rowNames(files: ReturnType<typeof filesTab>): Promise<(string | null)[]> {
  return files.tree.getByRole('treeitem').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))
}

test('browse: the workspace’s tree and search in the Files tab, opening files, live as the agent works, kept after a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = acmeApi(tempFolder)
  const glade = await launch({ agentScript: 'tidies-docs', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Tidy the docs.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.last()).toContainText(TIDIES_DOCS.firstReply)

  // Files opens on the Browse tab: the root's entries, folders first, without what git ignores or Glade's own folder.
  const files = filesTab(window)
  await window.keyboard.press('Meta+Alt+Digit2')
  await expect(files.browse).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => rowNames(files)).toEqual(['api', 'docs', '.gitignore', 'CLAUDE.md', 'notes.txt', 'README.md'])

  // A folder opens in place; the keys walk the tree, and ↩ opens a file in a tab.
  await files.treeRow('api').click()
  await expect
    .poll(() => rowNames(files))
    .toEqual(['api', 'tests', 'throttles.py', 'docs', '.gitignore', 'CLAUDE.md', 'notes.txt', 'README.md'])
  await window.keyboard.press('ArrowDown')
  await expect(files.treeRow('tests')).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(files.treeRow('test_throttles.py')).toBeVisible()
  await window.keyboard.press('ArrowRight')
  await expect(files.treeRow('test_throttles.py')).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(files.tab('test_throttles.py')).toHaveAttribute('aria-pressed', 'true')
  await expect(files.browse).toHaveAttribute('aria-pressed', 'false')
  await expect(files.editorLine(1)).toHaveText('def test_limit():')

  // Back on Browse, the tree is as it was. The agent moves the notes into docs: the tree shows it at once.
  await files.browse.click()
  await files.treeRow('docs').click()
  await expect(files.treeRow('rate-limits.md')).toBeVisible()
  await inputBar(window).field.fill('Go ahead.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.last()).toContainText(TIDIES_DOCS.reply)
  await expect(files.treeRow('limits.md')).toBeVisible()
  await expect(files.treeRow('notes.txt')).toHaveCount(0)

  // ⌘F, with the focus in the tree, puts it in the search, which finds files anywhere; ↩ opens the first.
  await files.treeRow('limits.md').focus()
  await window.keyboard.press('Meta+f')
  await expect(files.search).toBeFocused()
  await window.keyboard.type('LIMITS')
  await expect(files.results).toHaveText(['limits.mddocs14 B', 'rate-limits.mddocs14 B'])
  await expect(files.results.first().locator('mark')).toHaveText('limits')
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('Enter')
  await expect(files.tab('rate-limits.md')).toHaveAttribute('aria-pressed', 'true')

  // Esc clears the search, back to the tree.
  await files.browse.click()
  await files.search.focus()
  await window.keyboard.press('Escape')
  await expect(files.search).toHaveValue('')
  await expect(files.treeRow('limits.md')).toBeVisible()

  // A relaunch keeps the folders open.
  await glade.close()
  const relaunched = await launch()
  const again = filesTab(relaunched.window)
  await expect(taskPanel(relaunched.window).tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(again.browse).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => rowNames(again))
    .toEqual([
      'api',
      'tests',
      'test_throttles.py',
      'throttles.py',
      'docs',
      'limits.md',
      'rate-limits.md',
      '.gitignore',
      'CLAUDE.md',
      'README.md',
    ])
})

const LONG_NAME = 'test_burst_window_resets_after_a_sustained_rate_limit_for_anonymous_and_api_key_clients.py'

/** A made-up project in a throwaway folder, each file of a size its row shows; not a repository, so nothing is hidden. */
function sizedAcmeApi(tempFolder: () => string): string {
  const root = join(realpathSync(tempFolder()), 'acme-api')
  const files: Readonly<Record<string, number>> = {
    [`api/tests/${LONG_NAME}`]: 6_800,
    'api/tests/test_throttles.py': 4_200,
    'api/schema.sql': 18_300,
    'api/throttles.py': 3_600,
    'web/logo.png': 1_400_000,
    'web/pnpm-lock.yaml': 212_000,
    'web/theme.css': 9_700,
    '.gitignore': 348,
    'docker-compose.yml': 1_100,
    Dockerfile: 872,
    'README.md': 7_500,
  }
  for (const [path, size] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), '#'.repeat(size))
  }
  return root
}

test('browse: each row’s icon and size, a long name cut in the middle, the hover and selection pills, and the keys', async ({
  launch,
  tempFolder,
}) => {
  const root = sizedAcmeApi(tempFolder)
  const { window } = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Hello.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.last()).toBeVisible()
  const files = filesTab(window)
  await window.keyboard.press('Meta+Alt+Digit2')
  await expect(files.browse).toHaveAttribute('aria-pressed', 'true')
  await files.treeRow('api').click()
  await files.treeRow('tests').click()
  await files.treeRow('web').click()
  await expect
    .poll(() => rowNames(files))
    .toEqual([
      'api',
      'tests',
      LONG_NAME,
      'test_throttles.py',
      'schema.sql',
      'throttles.py',
      'web',
      'logo.png',
      'pnpm-lock.yaml',
      'theme.css',
      '.gitignore',
      'CLAUDE.md',
      'docker-compose.yml',
      'Dockerfile',
      'README.md',
    ])

  // Each file's glyph, by its kind, in its family's tint; a folder has its own icon.
  const glyphs: Readonly<Record<string, readonly [string, string]>> = {
    'throttles.py': ['code', 'code'],
    'theme.css': ['stylesheet', 'code'],
    'schema.sql': ['database', 'data'],
    'logo.png': ['image', 'image'],
    'docker-compose.yml': ['config', 'config'],
    'pnpm-lock.yaml': ['lock', 'config'],
    Dockerfile: ['docker', 'config'],
    '.gitignore': ['dotfile', 'config'],
    'README.md': ['docs', 'docs'],
  }
  for (const [name, [glyph, family]] of Object.entries(glyphs)) {
    await expect(files.treeIcon(name), name).toHaveAttribute('data-glyph', glyph)
    await expect(files.treeIcon(name), name).toHaveAttribute('data-family', family)
    await expect(files.treeIcon(name).locator('svg'), name).toBeVisible()
  }
  await expect(files.treeIcon('api')).toHaveCount(0)
  const tint = (name: string): Promise<string> => files.treeIcon(name).evaluate((icon) => getComputedStyle(icon).color)
  expect(await tint('throttles.py')).toBe('rgb(143, 178, 245)')
  expect(await tint('logo.png')).toBe('rgb(127, 209, 199)')
  expect(await tint('schema.sql')).toBe('rgb(200, 178, 255)')
  expect(await tint('Dockerfile')).toBe('rgb(153, 157, 176)')
  expect(await tint('README.md')).toBe('rgb(174, 179, 195)')

  // Each file's size, from the disk, at the far edge; a folder shows none.
  const sizes: Readonly<Record<string, string>> = {
    [LONG_NAME]: '6.8 KB',
    'schema.sql': '18.3 KB',
    'throttles.py': '3.6 KB',
    'logo.png': '1.4 MB',
    'pnpm-lock.yaml': '212 KB',
    '.gitignore': '348 B',
    Dockerfile: '872 B',
  }
  for (const [name, size] of Object.entries(sizes)) await expect(files.treeRow(name), name).toContainText(size)
  await expect(files.treeRow('api')).toHaveText('api')
  // The numbers end on one line, whatever their unit, and the units start on one.
  const numberEnds = new Set<number>()
  const unitStarts = new Set<number>()
  for (const [name, size] of Object.entries(sizes)) {
    const [number = '', unit = ''] = size.split(' ')
    const numberBox = await boxOf(files.treeRow(name).getByText(number, { exact: true }))
    const unitBox = await boxOf(files.treeRow(name).getByText(unit, { exact: true }))
    numberEnds.add(Math.round(numberBox.x + numberBox.width))
    unitStarts.add(Math.round(unitBox.x))
  }
  expect([...numberEnds]).toHaveLength(1)
  expect([...unitStarts]).toHaveLength(1)

  // The long name gives way in the middle: its start is cut short, while its end and extension show, clear of the size.
  const long = files.treeRow(LONG_NAME)
  const head = long.getByText(/^test_burst_window/)
  expect(await head.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  const extension = await boxOf(long.getByText('.py', { exact: true }))
  const tail = await boxOf(long.getByText('lients.py', { exact: true }))
  const longSize = await boxOf(long.getByText('6.8', { exact: true }))
  const rowBox = await boxOf(long)
  expect(tail.width).toBeGreaterThan(extension.width)
  expect(extension.x + extension.width).toBeLessThanOrEqual(longSize.x)
  expect(longSize.x + longSize.width).toBeLessThan(rowBox.x + rowBox.width)
  // A short name isn't cut.
  const short = files.treeRow('throttles.py').getByText('throttles', { exact: true })
  expect(await short.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false)

  // Rows are 24px, flush; the pointer's row and the selected one each show a pill of their own shade.
  expect(rowBox.height).toBe(24)
  const pill = (name: string): Promise<string> =>
    files.treeRow(name).evaluate((row) => getComputedStyle(row, '::before').backgroundColor)
  await files.treeRow('theme.css').hover()
  await expect.poll(() => pill('theme.css')).toBe('rgb(40, 43, 57)')
  expect(await pill('logo.png')).toBe('rgba(0, 0, 0, 0)')

  // The keys still walk the tree: Home and End, ↑↓, ← to a row's folder and to close it, → to open it and go in.
  await files.treeRow('web').focus()
  await window.keyboard.press('Home')
  await expect(files.treeRow('api')).toBeFocused()
  await window.keyboard.press('End')
  await expect(files.treeRow('README.md')).toBeFocused()
  await window.keyboard.press('Home')
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('ArrowDown')
  await expect(long).toBeFocused()
  await expect(long).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => pill(LONG_NAME)).toBe('rgb(46, 50, 67)')
  // The folders on the way to the selected row are lit: both of this row's guides.
  await expect(long.locator('[data-guide="lit"]')).toHaveCount(2)
  await expect(files.treeRow('throttles.py').locator('[data-guide="lit"]')).toHaveCount(1)
  await expect(files.treeRow('theme.css').locator('[data-guide="dim"]')).toHaveCount(1)
  await window.keyboard.press('ArrowLeft')
  await expect(files.treeRow('tests')).toBeFocused()
  await window.keyboard.press('ArrowLeft')
  await expect(files.treeRow('tests')).toHaveAttribute('aria-expanded', 'false')
  await expect(long).toHaveCount(0)
  await window.keyboard.press('ArrowRight')
  await expect(files.treeRow('tests')).toHaveAttribute('aria-expanded', 'true')
  await expect(long).toBeVisible()
  await window.keyboard.press('ArrowRight')
  await expect(long).toBeFocused()
  await window.keyboard.press('ArrowUp')
  await window.keyboard.press('ArrowUp')
  await window.keyboard.press('ArrowUp')
  await expect(files.search).toBeFocused()

  // A search's results have the same icons and sizes; ↓ and ↩ open one.
  await window.keyboard.type('throttles')
  await expect(files.results).toHaveText(['throttles.pyapi3.6 KB', 'test_throttles.pyapi/tests4.2 KB'])
  await expect(files.results.first().locator('[data-glyph]')).toHaveAttribute('data-glyph', 'code')
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('Enter')
  await expect(files.tab('test_throttles.py')).toHaveAttribute('aria-pressed', 'true')
})
