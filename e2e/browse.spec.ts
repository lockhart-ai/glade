import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TIDIES_DOCS } from '../src/main/agent/scripts'
import { SHELL_GIT_ENV } from '../src/main/agent/scripted-shell'
import { expect, test } from './fixtures'
import { chat, filesTab, firstRun, inputBar, taskList, taskPanel } from './selectors'

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
  await expect(files.tree.getByRole('treeitem')).toHaveText([
    'api',
    'docs',
    '.gitignore',
    'CLAUDE.md',
    'notes.txt',
    'README.md',
  ])

  // A folder opens in place; the keys walk the tree, and ↩ opens a file in a tab.
  await files.treeRow('api').click()
  await expect(files.tree.getByRole('treeitem')).toHaveText([
    'api',
    'tests',
    'throttles.py',
    'docs',
    '.gitignore',
    'CLAUDE.md',
    'notes.txt',
    'README.md',
  ])
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
  await expect(files.results).toHaveText(['limits.mddocs', 'rate-limits.mddocs'])
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
  await expect(again.tree.getByRole('treeitem')).toHaveText([
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
