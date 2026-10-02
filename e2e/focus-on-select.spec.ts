// #415: every switch to a task — by any route — puts the focus on its message field, once no modal holds it instead.
// Each route the issue lists gets its own check here, rather than trusting the specs that happen to cover a route
// already (most didn't check the focus at all; task-switching.spec.ts only covered ⌥↓ / ⌥↑ from the input bar, which
// was the one route that already worked).
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from '../src/shared/test-images'
import {
  chooseFolder,
  clickMenuBarIcon,
  clickNotification,
  expect,
  notifications,
  sendAndOpenNewTask,
  test,
} from './fixtures'
import { chooseMenuItem } from './menu'
import { paste, screenshot } from './paste'
import {
  artifactsTab,
  chat,
  deleteTaskDialog,
  firstRun,
  imageViewer,
  inputBar,
  menuBarPopover,
  regions,
  searchResults,
  settings,
  taskList,
} from './selectors'

/** Task A's first message: it plays `multi-tool-turn`, which titles the task and replies after a dozen tool calls. */
const FIX_DATE = 'The date test is flaky. Can you fix it?'
/** Task B's first message: it plays `simple-reply`. */
const ASK_RETRIES = 'How does the client retry?'
const A_TITLE = 'Fix the flaky date test'
const B_TITLE = 'Explain the retry policy'

test('clicking a row, ↩ on a focused one, ⌥↓ outside the field, ⌘⌥↓ and ⌘N / + all focus the task’s input', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({
    agentScriptsByFirstMessage: { [FIX_DATE]: 'multi-tool-turn', [ASK_RETRIES]: 'simple-reply' },
    chosenFolder: root,
  })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const bar = inputBar(window)

  // Two tasks that have both run and had their reply, so both need you; a third, blank one, selected last. Each
  // waits for its own reply (not just its title, which an early tool call sets) before the next starts, so the list
  // settles in a stable order: oldest (A) first, then B, then the blank one, newest.
  await list.newTask.click()
  await bar.field.fill(FIX_DATE)
  await bar.field.press('Enter')
  await expect(list.dot(list.taskRow(A_TITLE))).toHaveAttribute('data-state', 'waiting')
  await list.newTask.click()
  await bar.field.fill(ASK_RETRIES)
  await bar.field.press('Enter')
  await expect(list.dot(list.taskRow(B_TITLE))).toHaveAttribute('data-state', 'waiting')
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(3)

  // Clicking another row selects it and focuses its input (it starts not focused: a new task's bar already has it).
  await bar.field.blur()
  await list.taskRow(A_TITLE).click()
  await expect(bar.field).toBeFocused()

  // ↩ on a row the keyboard has moved to (⇧F10, say, or Tab) activates it, same as a click: its own input focuses.
  await bar.field.blur()
  await list.taskRow(B_TITLE).focus()
  await window.keyboard.press('Enter')
  await expect(list.taskRow(B_TITLE)).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toBeFocused()

  // ⌥↓ moves the selection on to the next task and focuses its input even when the list, not the field, has the
  // focus: before #415 the focus stayed on the row.
  await bar.field.blur()
  await list.taskRow(B_TITLE).focus()
  await window.keyboard.press('Alt+ArrowDown')
  await expect(list.taskRow(A_TITLE)).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toBeFocused()

  // ⌘⌥↓ (next task that needs you) steps from the blank task to one of the two that do, focusing its input.
  await list.taskRow('New task').click()
  await bar.field.blur()
  await window.keyboard.press('Meta+Alt+ArrowDown')
  await expect(bar.field).toBeFocused()
  await expect(list.taskRow('New task')).not.toHaveAttribute('aria-current', 'true')

  // File › New task (⌘N, a menu bar key a spec can't press, so this chooses the item) and + both focus the new
  // task's input.
  await bar.field.blur()
  await chooseMenuItem(glade, 'File', 'New task')
  await expect(list.rows('Active')).toHaveCount(4)
  await expect(bar.field).toBeFocused()
  await bar.field.blur()
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(5)
  await expect(bar.field).toBeFocused()
})

test('opening a task from a notification, the menu bar popover, search results, or switching workspace focuses its input', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const rootA = join(parent, 'acme-api')
  const rootB = join(parent, 'acme-web')
  mkdirSync(rootA)
  mkdirSync(rootB)
  const glade = await launch({
    agentScriptsByFirstMessage: { [FIX_DATE]: 'multi-tool-turn', [ASK_RETRIES]: 'simple-reply' },
    chosenFolder: rootA,
  })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const bar = inputBar(window)

  // Task A: ask it something, then move to a new task B before its agent replies, so A's reply arrives as a
  // notification while B, not A, is selected.
  await list.newTask.click()
  await sendAndOpenNewTask(glade, FIX_DATE)
  await expect.poll(() => notifications(glade)).toHaveLength(1)

  // Clicking the notification opens A, focused.
  await bar.field.blur()
  await clickNotification(glade, 0)
  await expect(list.taskRow(A_TITLE)).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toBeFocused()

  // B: ask it something too, so both need you, each in the menu bar popover (A under Working while its own turn
  // runs would also do, but by now both have answered).
  await list.taskRow('New task').click()
  await bar.field.fill(ASK_RETRIES)
  await bar.field.press('Enter')
  await expect(list.taskRow(B_TITLE)).toBeVisible()

  // Opening Glade on A from the menu bar popover selects it and focuses its input.
  await bar.field.blur()
  const popoverPage = await clickMenuBarIcon(glade)
  const popover = menuBarPopover(popoverPage)
  await popover.row('Needs you', A_TITLE).click()
  await expect(list.taskRow(A_TITLE)).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toBeFocused()

  // Opening a search result for B selects it and focuses its input.
  await bar.field.blur()
  await window.keyboard.press('Meta+F')
  await window.keyboard.type('retry')
  const results = searchResults(window)
  await expect(results.row(B_TITLE)).toBeVisible()
  await results.row(B_TITLE).click()
  await expect(list.taskRow(B_TITLE)).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toBeFocused()
  await list.search.press('Escape')

  // A second workspace, with its own task C: Workspace › Switch workspace (⌘1 – ⌘9, which a spec can't press either)
  // switches into it, and its own selected task's input is the one that focuses.
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(regions(window).workspace).toContainText('acme-web')
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(1)

  await bar.field.blur()
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(list.taskRow(B_TITLE)).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toBeFocused()

  await bar.field.blur()
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-web')
  await expect(list.taskRow('New task')).toHaveAttribute('aria-current', 'true')
  await expect(bar.field).toBeFocused()

  // The window, and the menu bar popover, stay hidden throughout: an e2e run never shows either.
  const visible = await glade.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.isVisible()),
  )
  expect(visible).toEqual([false, false])
})

test('relaunch restores the selected task with the focus in its input', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  await taskList(first.window).newTask.click()
  await expect(taskList(first.window).rows('Active')).toHaveCount(2)
  await first.close()

  const { window } = await launch()
  await expect(taskList(window).current).toHaveCount(1)
  await expect(inputBar(window).field).toBeFocused()
})

test('closing Settings, a confirm dialog or the image viewer back onto a task focuses its input; typing in the sidebar search does not steal it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const bar = inputBar(window)
  await list.newTask.click()
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(2)
  await expect(bar.field).toBeFocused()

  // Closing Settings (⌘, is a menu bar key too) puts the focus back on the task's input, not wherever it was before
  // Settings opened.
  await bar.field.blur()
  const modal = settings(window)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  // The rest of the window, the input bar included, is hidden from accessibility while the modal is open: there's
  // nothing to assert its focus against until it closes.
  await expect(modal.dialog).toBeVisible()
  await modal.close.click()
  await expect(modal.dialog).toHaveCount(0)
  await expect(bar.field).toBeFocused()

  // Delete task… (a confirm dialog): Cancel keeps the task and puts the focus back on its input.
  await bar.field.blur()
  await list.taskRow('New task').first().click({ button: 'right' })
  const menu = window.getByRole('menu', { name: 'Task actions' })
  await menu.getByRole('menuitem', { name: 'Delete task…' }).click()
  const dialog = deleteTaskDialog(window)
  await expect(dialog.dialog).toBeVisible()
  await dialog.cancel.click()
  await expect(dialog.dialog).toHaveCount(0)
  await expect(bar.field).toBeFocused()

  // The image viewer: closing it puts the focus on the task's input too, not back on the thumbnail that opened it.
  await paste(bar.field, { files: [screenshot('note.png', '#7fd1c7')] })
  await expect(bar.attachedImages).toHaveCount(1)
  await bar.field.fill('Look at this.')
  await bar.field.press('Enter')
  await expect(chat(window).thumbnails).toHaveCount(1)
  await bar.field.blur()
  const viewer = imageViewer(window)
  await chat(window).thumbnails.first().click()
  await expect(viewer.viewer).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(viewer.viewer).toHaveCount(0)
  await expect(bar.field).toBeFocused()

  // Typing in the sidebar search doesn't steal the focus: it stays in the search field until you choose a result.
  await window.keyboard.press('Meta+F')
  await expect(list.search).toBeFocused()
  await window.keyboard.type('New')
  await expect(list.search).toBeFocused()
  await list.search.press('Escape')
  await expect(bar.field).not.toBeFocused()
})

test('closing the image viewer opened from the Artifacts tab keeps the focus on its row, not the task’s input', async ({
  launch,
  tempFolder,
}) => {
  const folder = tempFolder()
  const root = join(folder, 'acme-api')
  mkdirSync(join(root, 'screens'), { recursive: true })
  writeFileSync(join(root, 'screens', 'landing.png'), Buffer.from(PNG.data, 'base64'))
  const seed = join(folder, 'artifacts.json')
  writeFileSync(
    seed,
    JSON.stringify({
      workspace: { name: 'Acme API', rootPath: realpathSync(root) },
      panelTab: 'artifacts',
      tasks: [
        {
          title: 'Refresh the landing page',
          objective: 'Update the landing page screenshot.',
          status: 'The screenshot is in Artifacts.',
          minutesAgo: 4,
          selected: true,
          artifacts: [{ path: 'screens/landing.png', title: 'Landing page', minutesAgo: 4 }],
        },
      ],
    }),
  )
  const { window } = await launch({ seed })
  const artifacts = artifactsTab(window)
  const viewer = imageViewer(window)
  const trigger = artifacts.open('Landing page')

  await trigger.click()
  await expect(viewer.viewer).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(viewer.viewer).toHaveCount(0)
  // Unlike a chat image's viewer, this one isn't a "modal" the input bar's focus effect answers (#415): closing it
  // keeps a keyboard user's place in the Artifacts list instead of jumping to the task's input.
  await expect(trigger).toBeFocused()
  await expect(inputBar(window).field).not.toBeFocused()
})
