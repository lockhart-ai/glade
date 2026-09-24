import type { MenuItemConstructorOptions } from 'electron'
import { expect, it, vi } from 'vitest'
import { appCommand, AppCommandId, EMPTY_MENU_STATE, type MenuState } from '../../shared/commands'
import { installAppMenu, type MenuApi } from './app-menu'

interface FakeMenu {
  readonly template: MenuItemConstructorOptions[]
}

function fakeMenuApi() {
  const menus: FakeMenu[] = []
  const api: MenuApi<FakeMenu> = {
    buildFromTemplate: (template) => ({ template }),
    setApplicationMenu: vi.fn((menu: FakeMenu) => {
      menus.push(menu)
    }),
  }
  const current = (): FakeMenu => {
    const menu = menus.at(-1)
    if (menu === undefined) throw new Error('No menu bar set')
    return menu
  }
  return { api, menus, current }
}

function newTaskItem(menu: FakeMenu): MenuItemConstructorOptions {
  const [newTask] = menu.template.find((item) => item.label === 'File')?.submenu as MenuItemConstructorOptions[]
  if (newTask === undefined) throw new Error('No New task')
  return newTask
}

const SHOWING: MenuState = { ...EMPTY_MENU_STATE, workspaces: [{ id: 'w1', name: 'Acme API' }], shownWorkspaceId: 'w1' }

it('sets the menu bar at once, with nothing to act on, and rebuilds it only when what the window shows changes', () => {
  const { api, menus, current } = fakeMenuApi()
  const menu = installAppMenu({ menu: api, send: vi.fn(), appName: 'Glade', developer: false })

  expect(menus).toHaveLength(1)
  expect(newTaskItem(current()).enabled).toBe(false)

  menu.update(SHOWING)
  expect(menus).toHaveLength(2)
  expect(newTaskItem(current()).enabled).toBe(true)

  menu.update({ ...SHOWING, workspaces: [{ id: 'w1', name: 'Acme API' }] })
  expect(menus).toHaveLength(2)
})

it('sends a chosen item’s command to the window, and rebuilds the menu bar', () => {
  const { api, menus, current } = fakeMenuApi()
  const send = vi.fn()
  const menu = installAppMenu({ menu: api, send, appName: 'Glade', developer: false })
  menu.update(SHOWING)

  ;(newTaskItem(current()).click as () => void)()

  expect(send).toHaveBeenCalledWith(appCommand(AppCommandId.NewTask))
  expect(menus).toHaveLength(3)
  expect(newTaskItem(current()).enabled).toBe(true)
})
