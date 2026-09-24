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

/** A labelled row of the task header. */
export type TaskHeaderField = 'Objective' | 'Status' | 'Outcome'

/** The selected task's header: its title, pin toggle, status pill, Mark done, and objective and status rows. */
export function taskHeader(page: Page) {
  const header = regions(page).taskHeader
  return {
    header,
    title: header.getByRole('heading', { level: 1 }),
    pill: header.getByRole('status'),
    pin: header.getByRole('button', { name: 'Pin task' }),
    unpin: header.getByRole('button', { name: 'Unpin task' }),
    markDone: header.getByRole('button', { name: 'Mark done' }),
    /** A row's value, e.g. the objective. */
    field: (name: TaskHeaderField) => header.getByRole('group', { name }).getByRole('paragraph'),
  }
}

/** The task card's right panel: its tabs, and the Tool calls tab's log. */
export function taskPanel(page: Page) {
  const panel = regions(page).taskPanel
  const log = panel.getByRole('log', { name: 'Tool log' })
  return {
    tab: (name: string | RegExp) => panel.getByRole('tab', { name }),
    tabPanel: panel.getByRole('tabpanel'),
    log,
    /** A tool call's row, by its accessible name: its state, name, argument, time and result. */
    call: (name: string | RegExp) => log.getByRole('button', { name }),
    /** A subagent's calls, under the call that started it (by its name). */
    subagentCalls: (name: string) => log.getByRole('group', { name: `${name} subagent calls` }),
    dividers: log.getByRole('separator'),
  }
}

/** The chat view: the user's messages and the agent's replies, oldest first, or a new task's prompt. */
export function chat(page: Page) {
  const log = regions(page).chat.getByRole('log', { name: 'Conversation' })
  return {
    log,
    userMessages: log.getByRole('article', { name: 'You' }),
    agentReplies: log.getByRole('article', { name: 'Agent' }),
    /** Where Glade restarted and resumed a turn. */
    restarts: log.getByRole('separator', { name: 'Glade restarted' }),
    /** What a task with no messages yet asks. */
    newTaskPrompt: log.getByRole('heading', { name: 'What should the agent do?' }),
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
    /** The context meter, at the right of the settings row. */
    contextMeter: bar.getByTestId('context-meter-slot').getByRole('meter', { name: 'Context used' }),
  }
}
