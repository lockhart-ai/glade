/**
 * Locators for the app's regions and controls, shared by the specs. Prefer roles and accessible names, as a user (and
 * a screen reader) would find them; fall back to test ids only for regions without one.
 */
import type { Locator, Page } from '@playwright/test'

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

/** A task list filter chip's name. */
export type TaskFilterName = 'All' | 'Needs you' | 'Unread'

/**
 * The sidebar's task list: the search field, the New task button, the filter chips and the Pinned, Active and Done
 * sections.
 */
export function taskList(page: Page) {
  const sidebar = regions(page).sidebar
  const section = (name: TaskSectionName) => sidebar.getByRole('region', { name })
  return {
    newTask: sidebar.getByRole('button', { name: 'New task', exact: true }),
    search: sidebar.getByRole('searchbox', { name: 'Search tasks' }),
    /** A filter chip, whose name is its label then its count (e.g. `Needs you1`); `aria-pressed` while it's chosen. */
    filter: (name: TaskFilterName) =>
      sidebar.getByRole('group', { name: 'Filter tasks' }).getByRole('button', { name: new RegExp(`^${name}`) }),
    /** A task's row, in whichever section it is, by its title. */
    taskRow: (title: string) => sidebar.getByRole('listitem').getByRole('button', { name: new RegExp(`^${title}`) }),
    section,
    /** A section's header, which collapses and expands it. */
    sectionHeader: (name: TaskSectionName) => section(name).getByRole('button').first(),
    /** A section's task rows, top to bottom. */
    rows: (name: TaskSectionName) => section(name).getByRole('listitem').getByRole('button'),
    /** A section's row for the task with this title. */
    row: (name: TaskSectionName, title: string) =>
      section(name).getByRole('listitem').getByRole('button').filter({ hasText: title }),
    /** A row's state dot, whose `data-state` is the task's indicator (working, waiting, done or error). */
    dot: (row: Locator) => row.locator('[data-state]'),
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
    /** Shows the right panel again; there only while it's collapsed. */
    showSidePanel: header.getByRole('button', { name: 'Show side panel' }),
    /** A row's value, e.g. the objective. */
    field: (name: TaskHeaderField) => header.getByRole('group', { name }).getByRole('paragraph'),
  }
}

/** The task card's right panel: its tabs, its resize handle and collapse button, and the Tool calls tab's log. */
export function taskPanel(page: Page) {
  const panel = regions(page).taskPanel
  const log = panel.getByRole('log', { name: 'Tool log' })
  return {
    panel,
    /** The drag handle on the panel's left edge, in the gap beside it. */
    resizeHandle: regions(page).task.getByRole('separator', { name: 'Resize panel' }),
    collapse: panel.getByRole('button', { name: 'Collapse side panel' }),
    tab: (name: string | RegExp) => panel.getByRole('tab', { name }),
    tabPanel: panel.getByRole('tabpanel'),
    log,
    /** A tool call's row, by its accessible name: its state, name, argument, time and result. */
    call: (name: string | RegExp) => log.getByRole('button', { name }),
    /** A subagent's calls, under the call that started it (by its name). */
    subagentCalls: (name: string) => log.getByRole('group', { name: `${name} subagent calls` }),
    dividers: log.getByRole('separator'),
    /** Each compaction's Compact row: its name, the tokens before and after, its time and how it went. */
    compactions: log.getByRole('group', { name: 'Compact' }),
  }
}

/** The right panel's Subagents tab: the tally by status and a row per subagent, which opens its log. */
export function subagentsTab(page: Page) {
  const panel = regions(page).taskPanel.getByRole('tabpanel')
  /** A subagent's row, by its name; `data-status` is running, done or error. */
  const row = (name: string) => panel.getByRole('group', { name, exact: true })
  return {
    /** "3 running 1 done". */
    tally: panel.getByRole('group', { name: 'Subagents by status' }),
    /** Every subagent's row, top to bottom. */
    rows: panel.locator('[data-status][role="group"]'),
    row,
    /** A row's header: its dot, name, status, latest line, elapsed time and tool call count. Click it to open its log. */
    header: (name: string) => row(name).getByRole('button').first(),
    /** A row's log, while it's open. */
    log: (name: string) => panel.getByRole('log', { name: `${name} log` }),
  }
}

/** The right panel's Files tab: the list of the task's files, the open files' tabs, and the file showing. */
export function filesTab(page: Page) {
  const panel = regions(page).taskPanel
  const menu = page.getByRole('menu', { name: 'Files in this task' })
  const openFiles = panel.getByRole('group', { name: 'Open files' })
  const source = panel.getByTestId('source')
  // A tab's name is the file's, after its blue dot's ("Changed by the agent") when it has one.
  const tab = (name: string) =>
    openFiles.getByRole('button', {
      name: new RegExp(`^(Changed by the agent )?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    })
  return {
    /** The "☰ 6 ⌄" button, whose menu lists the files the agent changed and read. */
    list: panel.getByRole('button', { name: 'All files in this task' }),
    menu,
    /** A file in the list's menu, by its path. */
    listed: (path: string) => menu.getByRole('menuitem', { name: path, exact: true }),
    openFiles,
    /** An open file's tab, by its name; `pressed` while it shows. */
    tab,
    /** The blue dot on the tab of a file the agent changed. */
    changedDot: (name: string) => tab(name).getByRole('img', { name: 'Changed by the agent' }),
    close: (name: string) => openFiles.getByRole('button', { name: `Close ${name}`, exact: true }),
    /** The scrolling area the file shows in. */
    contents: panel.getByRole('region', { name: / contents$/ }),
    source,
    /** A line of the source, by its number from 1: its number, then its text. */
    line: (number: number) => source.locator(`[data-line="${String(number)}"]`),
    openInEditor: panel.getByRole('button', { name: 'Open in editor' }),
    /** Source or Preview, for a Markdown file. */
    mode: (name: 'Source' | 'Preview') => panel.getByRole('radio', { name }),
  }
}

/** The chat view: the user's messages and the agent's replies, oldest first, or a new task's prompt. */
export function chat(page: Page) {
  const log = regions(page).chat.getByRole('log', { name: 'Conversation' })
  return {
    log,
    userMessages: log.getByRole('article', { name: 'You' }),
    agentReplies: log.getByRole('article', { name: 'Agent' }),
    /** The summary under each finished turn's reply: "Finished in 24m 10s · 4 files +61 −3". */
    turnSummaries: log.getByRole('note', { name: 'Turn summary' }),
    /** Where Glade restarted and resumed a turn. */
    restarts: log.getByRole('separator', { name: 'Glade restarted' }),
    /** Where a done task was marked done, before the message that reopened it. */
    markedDone: log.getByRole('separator', { name: 'Marked done' }),
    /** Where your message reopened a done task. */
    reopened: log.getByRole('separator', { name: 'Reopened' }),
    /** Where the context was compacted: "Compacted · 198k → 41k". */
    compacted: log.getByRole('separator', { name: 'Compacted' }),
    /** The live line while the agent works. */
    working: log.getByRole('status'),
    /** What a task with no messages yet asks. */
    newTaskPrompt: log.getByRole('heading', { name: 'What should the agent do?' }),
    /** The live line while a turn runs: "Working · …", or "Retrying (2 of 3)…". */
    workingLine: log.getByRole('status'),
    /** The pink card when an error stopped the agent, and its buttons. */
    errorCard: log.getByRole('alert'),
    errorButton: (name: 'Retry' | 'Retry with another model' | 'Show details' | 'Hide details') =>
      log.getByRole('alert').getByRole('button', { name, exact: true }),
    errorDetails: log.getByRole('alert').getByLabel('Error details'),
    /** The line that ends the chat while the task's turn is paused: "Paused · resumes at 11:42". */
    pausedLine: log.getByRole('status', { name: 'Paused' }),
    /** The agent's open questions: the card you answer them on. */
    questionCard: log.getByRole('form', { name: 'Questions from the agent' }),
    /** The agent's questions once they're answered or withdrawn: the closed card. */
    closedQuestions: log.getByRole('region', { name: 'Questions from the agent' }),
  }
}

/** The app-wide banner across the top of the window while tasks are paused, and its controls. */
export function pauseBanner(page: Page) {
  const banner = page.getByRole('status', { name: 'Paused tasks' })
  return {
    banner,
    switchModel: banner.getByRole('button', { name: 'Switch model', exact: true }),
    details: banner.getByRole('button', { name: 'Details', exact: true }),
    /** Details' list of the paused tasks: each one's title, then why and until when. */
    pausedTasks: banner.getByRole('list', { name: 'Paused tasks' }).getByRole('listitem'),
    /** Details' raw error, as the SDK gave it. */
    said: banner.getByLabel('What the API said'),
  }
}

/** The toasts at the bottom of the window, e.g. Mark done's Undo. */
export function toasts(page: Page) {
  const region = page.getByRole('region', { name: 'Notifications' })
  return {
    region,
    undo: region.getByRole('button', { name: 'Undo' }),
  }
}

/** The notice after Glade quit unexpectedly with tasks mid-turn, in the window's top right corner. */
export function relaunchNotice(page: Page) {
  const notice = page.getByRole('status', { name: 'Glade quit unexpectedly' })
  return {
    notice,
    showThem: notice.getByRole('button', { name: 'Show them' }),
    dismiss: notice.getByRole('button', { name: 'Dismiss' }),
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
    /** What Send becomes while the agent works. */
    queue: bar.getByRole('button', { name: 'Queue message', exact: true }),
    /** The message queue above the settings, while it has messages. */
    queued: bar.getByRole('region', { name: 'Queued messages' }),
    /** The queued messages' rows, in order: each one's number and text. */
    queuedRows: bar.getByRole('region', { name: 'Queued messages' }).getByRole('listitem'),
    /** A queued message's Edit, Remove or Save button, by its number. */
    queuedButton: (position: number, name: 'Edit' | 'Remove' | 'Save') =>
      bar
        .getByRole('region', { name: 'Queued messages' })
        .getByRole('listitem')
        .nth(position - 1)
        .getByRole('button', { name: `${name} queued message` }),
    /** The field of the queued message being edited in place. */
    queuedEditor: bar.getByRole('textbox', { name: 'Queued message' }),
    /** The context meter, at the right of the settings row. */
    contextMeter: bar.getByTestId('context-meter-slot').getByRole('meter', { name: 'Context used' }),
    /** The button the context meter is, which opens its popover. */
    contextButton: bar.getByTestId('context-meter-slot').getByRole('button', { name: 'Context' }),
  }
}

/** The context meter's popover: how full the context is, where it compacts automatically, and Compact now. */
export function contextPopover(page: Page) {
  const popover = page.getByRole('dialog', { name: 'Context' })
  return {
    popover,
    usage: popover.getByTestId('context-usage'),
    compactNow: popover.getByRole('button', { name: 'Compact now' }),
  }
}
