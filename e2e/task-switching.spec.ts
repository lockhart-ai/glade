// Next / previous task (⌥↓ / ⌥↑) from the input bar, where the focus usually is: it switches tasks, the focus goes on to
// the new task's input bar, and each task keeps its draft. Other text fields and the terminal keep the keys.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { firstRun, inputBar, settings, taskList, terminal } from './selectors'

test('task switching: ⌥↓ / ⌥↑ from the input bar switch tasks and keep drafts; search and the terminal keep the keys', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const { field } = inputBar(window)
  const rows = list.rows('Active')
  const selected = (index: number) => expect(rows.nth(index)).toHaveAttribute('aria-current', 'true')

  // Three tasks; the newest is at the top, selected, with the focus in its input bar.
  for (let made = 1; made <= 3; made += 1) {
    await list.newTask.click()
    await expect(rows).toHaveCount(made)
  }
  await selected(0)
  await expect(field).toBeFocused()

  // ⌥↓ with a draft in the input bar goes to the next task, focus and all, whose input bar is empty.
  await field.fill('Check the rate limits first')
  await window.keyboard.press('Alt+ArrowDown')
  await selected(1)
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('')
  await window.keyboard.press('Alt+ArrowDown')
  await selected(2)
  await expect(field).toBeFocused()

  // At the bottom of the list, ⌥↓ stays put, and the focus with it.
  await window.keyboard.press('Alt+ArrowDown')
  await selected(2)
  await expect(field).toBeFocused()

  // ⌥↑ back up to the top task: its draft is still there.
  await window.keyboard.press('Alt+ArrowUp')
  await selected(1)
  await window.keyboard.press('Alt+ArrowUp')
  await selected(0)
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('Check the rate limits first')

  // In the search field, ⌥↓ is the field's: the selection stays.
  await list.search.focus()
  await window.keyboard.press('Alt+ArrowDown')
  await expect(list.search).toBeFocused()
  await selected(0)

  // In the terminal, ⌥↓ goes to the shell (the profile-less bash echoes the tail of its escape sequence, ESC[1;3B, at
  // the prompt), and the selection stays.
  const term = terminal(window)
  await term.newTab.click()
  await expect(term.rows.filter({ hasText: 'acme-api $' })).toHaveCount(1)
  await window.keyboard.press('Alt+ArrowDown')
  await expect(term.rows.filter({ hasText: /^acme-api \$ ;3B\s*$/ })).toHaveCount(1)
  await selected(0)

  // Rebound in Settings › Keyboard, Next task follows its new keys from the input bar, and ⌥↓ is the field's again.
  const modal = settings(window)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('Keyboard').click()
  await modal.keycap('Next task: ⌥↓').click()
  await window.keyboard.press('Control+Alt+KeyJ')
  await expect(modal.keycap('Next task: ⌃⌥J')).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(modal.dialog).toBeHidden()
  await field.focus()
  await window.keyboard.press('Alt+ArrowDown')
  await selected(0)
  await window.keyboard.press('Control+Alt+KeyJ')
  await selected(1)
  await expect(field).toBeFocused()
})
