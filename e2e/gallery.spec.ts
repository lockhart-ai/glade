import { expect, test } from './fixtures'
import { gallery } from './selectors'

test('renders the component gallery, and its components respond', async ({ launch }) => {
  const { window } = await launch({ route: '#gallery' })
  const page = gallery(window)

  await expect(page.title).toBeVisible()
  for (const name of ['Button', 'Toggle', 'Tabs', 'Menu', 'Popover · Toast']) {
    await expect(page.section(name)).toBeVisible()
  }

  const buttons = page.section('Button')
  await buttons.getByRole('button', { name: 'Pin task' }).click()
  await expect(buttons.getByRole('button', { name: 'Unpin task' })).toHaveAttribute('aria-pressed', 'true')

  const menus = page.section('Menu')
  await menus.getByRole('button', { name: 'Task actions' }).click()
  await window.getByRole('menuitem', { name: /^Mark done/ }).click()
  await expect(window.getByRole('menu')).toHaveCount(0)
  await expect(menus.getByText('Mark done')).toBeVisible()
})
