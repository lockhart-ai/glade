// Nekomata as a Glade plugin (docs/plugin-api.md, "Nekomata"), end to end: its built plugin folder, installed in a
// temp data folder, shows the cat cafe beside the terminal while the scripted agent asks questions and the task is
// marked done. Nekomata is built in its own repo (github.com/lockhart-ai/nekomata), so this runs only when
// NEKOMATA_PLUGIN names its built folder: `./build.sh glade` there, then
// `NEKOMATA_PLUGIN=<nekomata>/dist/glade/nekomata npm run test:e2e -- nekomata`.
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inPlugin } from './fixture-plugin'
import { expect, pluginsFolder, test, type Glade } from './fixtures'
import { firstRun, inputBar, taskHeader, taskList } from './selectors'

const NEKOMATA_PLUGIN = process.env.NEKOMATA_PLUGIN

test.skip(NEKOMATA_PLUGIN === undefined, 'NEKOMATA_PLUGIN names no built Nekomata plugin folder')

/** A console message from the plugin's page. */
interface ConsoleLine {
  readonly level: string
  readonly message: string
}

/** Reloads the plugin's page (it posts `ready` again) with its console recorded, and resolves once it's loaded. */
async function reloadWatchingConsole({ app }: Glade): Promise<void> {
  await app.evaluate(async ({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('glade-plugin:'))
    if (page === undefined) throw new Error('No plugin page is running')
    const lines: ConsoleLine[] = []
    Reflect.set(globalThis, 'nekomataConsole', lines)
    page.on('console-message', ({ level, message }) => lines.push({ level, message }))
    const loaded = new Promise<void>((resolve) => {
      page.once('did-finish-load', () => {
        resolve()
      })
    })
    page.reload()
    await loaded
  })
}

async function consoleLines({ app }: Glade): Promise<ConsoleLine[]> {
  return app.evaluate(() => Reflect.get(globalThis, 'nekomataConsole') as ConsoleLine[])
}

/** What the cafe's overlay says: its speech bubbles and name tags. */
async function overlayText(glade: Glade, selector: string): Promise<string[]> {
  return inPlugin<string[]>(
    glade,
    `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`,
  )
}

test('Nekomata keeps a cat per task, raises its paw for questions and carries it out when done', async ({
  launch,
  tempFolder,
  userData,
}) => {
  const plugin = NEKOMATA_PLUGIN ?? ''
  expect(existsSync(join(plugin, 'manifest.json'))).toBe(true)
  cpSync(plugin, join(pluginsFolder(userData), 'nekomata'), { recursive: true })
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'asks-a-question', chosenFolder: root })
  const { window } = glade
  const status = window.getByRole('region', { name: 'Nekomata' }).getByTestId('plugin-status')

  // An empty cafe, then a cat for the new task.
  await firstRun(window).openFolder.click()
  await expect(status).toHaveText('0 cats')
  await taskList(window).newTask.click()
  await expect(status).toHaveText('1 cat')

  // The agent works, names the task and asks: the cat raises its paw, asking the first question.
  const bar = inputBar(window)
  await bar.field.fill('Draft the release notes for 2.4.')
  await bar.field.press('Enter')
  await expect.poll(() => overlayText(glade, '.nametag')).toEqual(['Draft release notes for 2.4'])
  await expect
    .poll(() => overlayText(glade, '.bubble'))
    .toEqual([expect.stringContaining('How should the notes be laid out?')])

  // Reloaded, it posts ready again and draws the same cafe from the fresh snapshot, with nothing blocked or fetched.
  await reloadWatchingConsole(glade)
  await expect
    .poll(() => overlayText(glade, '.bubble'))
    .toEqual([expect.stringContaining('How should the notes be laid out?')])
  await expect(status).toHaveText('1 cat')
  expect(await inPlugin<number>(glade, "performance.getEntriesByType('resource').length")).toBe(0)
  expect(await consoleLines(glade)).toEqual([])
  const log = existsSync(glade.logFile) ? readFileSync(glade.logFile, 'utf8') : ''
  expect(log).not.toContain('plugin request blocked')
  expect(log).not.toContain('plugin navigation refused')

  // Marked done: the adoption man carries the cat out.
  await taskHeader(window).markDone.click()
  await expect(status).toHaveText('0 cats')
  await expect.poll(() => overlayText(glade, '.nametag')).toEqual([])
})
