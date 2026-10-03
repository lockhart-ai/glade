// A plugin opening a task (`openTask`, #466), end to end: the fixture plugin answers a click in its view with
// `openTask`, as Nekomata's cats and kittens do. Only a real click counts, which main hears as input the OS routed to
// the view (here sent as native input events, as a click would arrive): a message alone, or a click the page makes up,
// does nothing.
import { PluginEventType, type PluginEvent, type PluginSnapshotEvent } from '../src/shared/plugin-api'
import { inPlugin, installFixture } from './fixture-plugin'
import { expect, seedPath, test, type Glade } from './fixtures'
import { expectViewOverSlot, logged, pluginCard } from './plugin-view'
import { regions, subagentsTab, taskHeader, taskPanel } from './selectors'

/** The seed's tasks (e2e/seeds/plugin-open-task.json). */
const SHOWING = 'Fix the flaky date test'
const ELSEWHERE = 'Migrate the billing webhooks'
const KITTEN = 'Check the webhook retries'

/** The plugin's last snapshot. */
async function snapshot(glade: Glade): Promise<PluginSnapshotEvent> {
  const events = await inPlugin<{ event: PluginEvent }[]>(glade, 'window.received')
  const last = events
    .map(({ event }) => event)
    .findLast((event): event is PluginSnapshotEvent => event.type === PluginEventType.Snapshot)
  if (last === undefined) throw new Error('No snapshot')
  return last
}

/** Makes the plugin post `message` when you next click or press a key in its page. */
async function postOnInput(glade: Glade, message: unknown): Promise<void> {
  await inPlugin(glade, `window.postOnInput = ${JSON.stringify(message)}`)
}

/** Clicks in the plugin's view: a mouse button down and up, as native input, which is how a real click reaches it. */
async function clickInView({ app }: Glade): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('glade-plugin:'))
    if (page === undefined) throw new Error('No plugin page is running')
    page.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 })
    page.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 })
  })
}

/**
 * Presses a key in the plugin's view, as native input. (Not focusing its page first, which would focus the hidden
 * window too: main hears the key all the same.)
 */
async function pressInView({ app }: Glade): Promise<void> {
  await app.evaluate(({ webContents }) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('glade-plugin:'))
    if (page === undefined) throw new Error('No plugin page is running')
    page.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    page.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  })
}

test('clicking in a plugin opens the task it asks for, in another workspace, and on a subagent; a message alone does nothing', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch({ seed: seedPath('plugin-open-task.json') })
  const { window } = glade
  const header = taskHeader(window)
  const { workspace } = regions(window)
  await expect(pluginCard(glade).status).toHaveText(/said hello$/)
  await expectViewOverSlot(glade)
  await expect(workspace).toContainText('Acme API')
  await expect(header.title).toHaveText(SHOWING)

  // The plugin sees the two active tasks, the billing one with its kittens; not the done one.
  const seen = await snapshot(glade)
  expect(seen.tasks.map(({ title }) => title).sort()).toEqual([SHOWING, ELSEWHERE].sort())
  const billing = seen.tasks.find(({ title }) => title === ELSEWHERE)?.id ?? ''
  expect(seen.subagents.map(({ id, taskId }) => [id, taskId]).sort()).toEqual([
    ['kitten-endpoints', billing],
    ['kitten-retries', billing],
  ])

  // Without a click: posted outright, and in answer to a click and a key press the page makes up itself. All dropped.
  const open = { type: 'openTask', taskId: billing }
  await inPlugin(glade, `window.glade.post(${JSON.stringify(open)})`)
  await postOnInput(glade, open)
  await inPlugin(glade, "document.body.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))")
  await expect.poll(() => logged(glade, 'plugin openTask dropped').length).toBe(3)
  expect(logged(glade, 'plugin openTask dropped').map(({ reason }) => reason)).toEqual([
    'no_gesture',
    'no_gesture',
    'no_gesture',
  ])
  expect(logged(glade, 'plugin opened a task')).toEqual([])
  await expect(workspace).toContainText('Acme API')
  await expect(header.title).toHaveText(SHOWING)

  // A real click: Glade switches to the billing workspace and selects the task, as clicking its row would, and the
  // plugin's view stays where it is.
  await clickInView(glade)
  await expect(workspace).toContainText('Billing')
  await expect(header.title).toHaveText(ELSEWHERE)
  expect(logged(glade, 'plugin opened a task')).toEqual([
    expect.objectContaining({ id: 'fixture-plugin', taskId: billing, subagentId: null }),
  ])
  await expectViewOverSlot(glade)
  // #426: the input bar has the focus, as after any task switch.
  await expect(window.getByRole('textbox', { name: 'Message the agent' })).toBeFocused()

  // A click on a kitten: the Subagents tab opens on it, its log open.
  const panel = taskPanel(window)
  const subagents = subagentsTab(window)
  await panel.tab(/^Tool calls/).click()
  await postOnInput(glade, { ...open, subagentId: 'kitten-retries' })
  await clickInView(glade)
  await expect(panel.tab(/^Subagents/)).toHaveAttribute('aria-selected', 'true')
  await expect(subagents.header(KITTEN)).toHaveAttribute('aria-expanded', 'true')
  await expect(subagents.header('List the endpoints')).toHaveAttribute('aria-expanded', 'false')

  // A subagent of another task, or a task the plugin was never told of, is dropped even after a click.
  const showing = seen.tasks.find(({ title }) => title === SHOWING)?.id ?? ''
  await postOnInput(glade, { type: 'openTask', taskId: showing, subagentId: 'kitten-retries' })
  await clickInView(glade)
  await postOnInput(glade, { type: 'openTask', taskId: 'no-such-task' })
  await clickInView(glade)
  await expect.poll(() => logged(glade, 'plugin openTask dropped').length).toBe(5)
  expect(
    logged(glade, 'plugin openTask dropped')
      .map(({ reason }) => reason)
      .slice(3),
  ).toEqual(['unknown_subagent', 'unknown_task'])
  await expect(workspace).toContainText('Billing')
  await expect(header.title).toHaveText(ELSEWHERE)

  // A key press in the view counts as a click does: back to the first task, in its own workspace. (The page posts it
  // itself, as its key handler would: without the focus, it may not see the key.)
  await postOnInput(glade, null)
  await pressInView(glade)
  await inPlugin(glade, `window.glade.post(${JSON.stringify({ type: 'openTask', taskId: showing })})`)
  await expect(workspace).toContainText('Acme API')
  await expect(header.title).toHaveText(SHOWING)
})
