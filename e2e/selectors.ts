/**
 * Locators for the app's regions and controls, shared by the specs. Prefer roles and accessible names, as a user (and
 * a screen reader) would find them; fall back to test ids only for regions without one.
 */
import type { Page } from '@playwright/test'

/** The window's regions (see src/renderer/layout and src/renderer/App.tsx). */
export function regions(page: Page) {
  return {
    sidebar: page.getByRole('navigation', { name: 'Tasks' }),
    /** The top of the sidebar: the workspace's name and root folder. */
    workspace: page.getByRole('region', { name: 'Workspace' }),
    /** The task card's content before there is any workspace. */
    welcome: page.getByRole('main', { name: 'Welcome' }),
    task: page.getByRole('main', { name: 'Task' }),
    taskHeader: page.getByRole('region', { name: 'Task header' }),
    chat: page.getByRole('region', { name: 'Chat' }),
    inputBar: page.getByTestId('input-bar'),
    taskPanel: page.getByRole('complementary', { name: 'Task panel' }),
    terminal: page.getByRole('region', { name: 'Terminal' }),
  }
}

/** The first-run welcome's controls. */
export function firstRun(page: Page) {
  const welcome = regions(page).welcome
  return {
    openFolder: welcome.getByRole('button', { name: 'Open folder…' }),
    createFolder: welcome.getByRole('button', { name: 'Create a new folder…' }),
  }
}

/** A task list section's name. */
export type TaskSectionName = 'Pinned' | 'Active' | 'Done'

/** The sidebar's task list: the search field, the New task button and the Pinned, Active and Done sections. */
export function taskList(page: Page) {
  const sidebar = regions(page).sidebar
  const section = (name: TaskSectionName) => sidebar.getByRole('region', { name })
  return {
    newTask: sidebar.getByRole('button', { name: 'New task', exact: true }),
    search: sidebar.getByRole('searchbox', { name: 'Search tasks' }),
    section,
    /** A section's header, which collapses and expands it. */
    sectionHeader: (name: TaskSectionName) => section(name).getByRole('button').first(),
    /** A section's task rows, top to bottom. */
    rows: (name: TaskSectionName) => section(name).getByRole('listitem').getByRole('button'),
  }
}

/** The chat view: the user's messages and the agent's replies, oldest first. */
export function chat(page: Page) {
  const log = regions(page).chat.getByRole('log', { name: 'Conversation' })
  return {
    log,
    userMessages: log.getByRole('article', { name: 'You' }),
    agentReplies: log.getByRole('article', { name: 'Agent' }),
  }
}

/** The component gallery (`#gallery`, dev and e2e builds only). */
export function gallery(page: Page) {
  return {
    title: page.getByRole('heading', { level: 1, name: 'Components' }),
    section: (name: string) => page.getByRole('region', { name }),
  }
}

/** A setting in the input bar. */
export type InputBarSetting = 'Model' | 'Effort' | 'Permissions'

/** The selected task's input bar: its settings, the message field, and Send and Stop. */
export function inputBar(page: Page) {
  const bar = regions(page).inputBar
  return {
    /** A setting's button, e.g. `setting('Model')`. */
    setting: (name: InputBarSetting) => bar.getByRole('button', { name: new RegExp(`^${name}: `) }),
    /** An option in the open setting's menu. */
    option: (name: string) => page.getByRole('menuitemradio', { name, exact: true }),
    field: bar.getByRole('textbox', { name: 'Message the agent' }),
    send: bar.getByRole('button', { name: 'Send', exact: true }),
    stop: bar.getByRole('button', { name: 'Stop', exact: true }),
  }
}

/** The toasts at the bottom of the window. */
export function notifications(page: Page) {
  return page.getByRole('region', { name: 'Notifications' })
}
