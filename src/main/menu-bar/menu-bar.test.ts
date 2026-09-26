import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type Task, type Workspace } from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { recordNotification } from '../db/repositories/notifications'
import { updateSettings } from '../db/repositories/settings'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createMemoryLog } from '../logging/memory-sink'
import {
  createMenuBar,
  REFRESH_DELAY_MS,
  REOPEN_GRACE_MS,
  type MenuBar,
  type MenuBarOptions,
  type MenuBarPopover,
  type MenuBarTray,
  type PopoverHandlers,
  type TrayHandlers,
} from './menu-bar'
import type { Bounds } from './position'
import { PULSE_FRAME_MS, RESTING_FRAME } from './pulse'

const TRAY_BOUNDS: Bounds = { x: 1480, y: 0, width: 32, height: 24 }

/** A recorded icon: what it shows, and its click. */
interface FakeTray extends MenuBarTray {
  title: string
  frames: number[]
  destroyed: boolean
  readonly handlers: TrayHandlers
}

/** A recorded popover: what it was sent and asked to do. */
interface FakePopover extends MenuBarPopover {
  readonly handlers: PopoverHandlers
  shown: Bounds[]
  hides: number
  heights: number[]
  sent: GladeEvent[]
  destroyed: boolean
}

let test: TestDatabase
let workspace: Workspace
let trays: FakeTray[]
let popovers: FakePopover[]
let reduceMotion: boolean
let clock: number
let opened: string[]
let calls: string[]
let menuBar: MenuBar

function start(overrides: Partial<MenuBarOptions> = {}): MenuBar {
  menuBar = createMenuBar({
    db: test.db,
    createTray: (handlers) => {
      const tray: FakeTray = {
        title: '',
        frames: [],
        destroyed: false,
        handlers,
        setFrame: (frame) => {
          tray.frames.push(frame)
        },
        setTitle: (title) => {
          tray.title = title
        },
        bounds: () => TRAY_BOUNDS,
        destroy: () => {
          tray.destroyed = true
        },
      }
      trays.push(tray)
      return tray
    },
    createPopover: (handlers) => {
      const popover: FakePopover = {
        handlers,
        shown: [],
        hides: 0,
        heights: [],
        sent: [],
        destroyed: false,
        show: (anchor) => {
          popover.shown.push(anchor)
        },
        hide: () => {
          popover.hides += 1
        },
        send: (event) => {
          popover.sent.push(event)
        },
        fit: (height) => {
          popover.heights.push(height)
        },
        destroy: () => {
          popover.destroyed = true
        },
      }
      popovers.push(popover)
      return popover
    },
    reduceMotion: () => reduceMotion,
    openTask: (taskId) => {
      opened.push(taskId)
    },
    openGlade: () => {
      calls.push('openGlade')
    },
    quit: () => {
      calls.push('quit')
    },
    now: () => clock,
    ...overrides,
  })
  menuBar.sync()
  return menuBar
}

function tray(): FakeTray {
  const last = trays.at(-1)
  if (last === undefined || last.destroyed) throw new Error('no menu bar icon')
  return last
}

function popover(): FakePopover {
  const last = popovers.at(-1)
  if (last === undefined) throw new Error('no popover')
  return last
}

/** A task that has run, as `patch` has it. */
function ranTask(patch: Parameters<typeof updateTask>[2] = {}): Task {
  const task = sampleTask(test.db, workspace.id)
  return updateTask(test.db, task.id, { title: 'Add rate limiting', sessionId: `session-${task.id}`, ...patch })
}

/** Changes a task and tells the menu bar, as the bridge does. */
function change(task: Task, patch: Parameters<typeof updateTask>[2]): void {
  const updated = updateTask(test.db, task.id, patch)
  menuBar.observe({ type: EventType.TaskUpdated, task: updated })
}

/** The last snapshot the popover's page was sent. */
function lastSent(): Extract<GladeEvent, { type: EventType.MenuBarChanged }>['snapshot'] {
  const event = popover().sent.at(-1)
  if (event?.type !== EventType.MenuBarChanged) throw new Error('nothing sent')
  return event.snapshot
}

beforeEach(() => {
  vi.useFakeTimers()
  test = openTestDatabase()
  workspace = sampleWorkspace(test.db)
  trays = []
  popovers = []
  reduceMotion = false
  clock = 100_000
  opened = []
  calls = []
})

afterEach(() => {
  menuBar.close()
  test.close()
  vi.useRealTimers()
})

describe('the icon', () => {
  it('is in the menu bar by default, still and saying nothing while nothing is in flight', () => {
    start()
    expect(menuBar.shown).toBe(true)
    expect(tray().title).toBe('')
    expect(menuBar.pulsing).toBe(false)
    vi.advanceTimersByTime(PULSE_FRAME_MS * 4)
    expect(tray().frames).toEqual([])
  })

  it('counts the tasks that need you from launch, and keeps counting as they change', () => {
    const first = ranTask()
    start()
    expect(tray().title).toBe('1')

    const second = ranTask({ activity: TaskActivity.Working })
    menuBar.observe({ type: EventType.TaskUpdated, task: second })
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(tray().title).toBe('1')

    change(second, { activity: TaskActivity.Error })
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(tray().title).toBe('2')

    change(first, { activity: TaskActivity.Working })
    change(second, { activity: TaskActivity.Working })
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(tray().title).toBe('')
  })

  it('pulses while an agent works, and rests the glyph once none does', () => {
    const task = ranTask({ activity: TaskActivity.Working })
    start()
    expect(menuBar.pulsing).toBe(true)
    vi.advanceTimersByTime(PULSE_FRAME_MS * 4)
    expect(tray().frames).toEqual([1, 2, 1, 0])

    change(task, { activity: TaskActivity.Waiting })
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(menuBar.pulsing).toBe(false)
    expect(tray().frames.at(-1)).toBe(RESTING_FRAME)
    const drawn = tray().frames.length
    vi.advanceTimersByTime(PULSE_FRAME_MS * 4)
    expect(tray().frames).toHaveLength(drawn)
  })

  it('holds still with Reduce motion on, and follows it being turned off and on again', () => {
    ranTask({ activity: TaskActivity.Working })
    reduceMotion = true
    start()
    expect(menuBar.pulsing).toBe(false)
    vi.advanceTimersByTime(PULSE_FRAME_MS * 4)
    expect(tray().frames).toEqual([])

    reduceMotion = false
    menuBar.motionChanged()
    expect(menuBar.pulsing).toBe(true)

    reduceMotion = true
    menuBar.motionChanged()
    expect(menuBar.pulsing).toBe(false)
    expect(tray().frames.at(-1)).toBe(RESTING_FRAME)
  })

  it('catches up once for a burst of changes, a moment after the last one starts it', () => {
    const task = ranTask({ activity: TaskActivity.Working })
    start()
    const reads = vi.spyOn(tray(), 'setTitle')
    for (let index = 0; index < 20; index += 1) {
      menuBar.observe({ type: EventType.TaskUpdated, task: { ...task, status: `Step ${String(index)}` } })
    }
    expect(reads).not.toHaveBeenCalled()
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(reads).toHaveBeenCalledTimes(1)
  })

  it('catches up on questions, permission cards, todos and workspaces, and ignores what never changes it', () => {
    const task = ranTask({ activity: TaskActivity.Working })
    start()
    const setTitle = vi.spyOn(tray(), 'setTitle')
    const ignored: GladeEvent[] = [
      { type: EventType.TerminalOutput, tabId: 'term-1', offset: 0, data: 'ls\n' },
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.SelectedTaskId, value: task.id } },
      { type: EventType.SettingsChanged, settings: DEFAULT_SETTINGS },
      { type: EventType.MenuBarChanged, snapshot: { needsYou: [], working: [], recent: [] } },
    ]
    for (const event of ignored) menuBar.observe(event)
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(setTitle).not.toHaveBeenCalled()

    const relevant: GladeEvent[] = [
      { type: EventType.TaskDeleted, taskId: task.id },
      { type: EventType.TodosChanged, taskId: task.id, todos: null },
      { type: EventType.WorkspaceUpdated, workspace },
      { type: EventType.WorkspaceRemoved, workspaceId: workspace.id },
    ]
    for (const event of relevant) {
      menuBar.observe(event)
      vi.advanceTimersByTime(REFRESH_DELAY_MS)
    }
    expect(setTitle).toHaveBeenCalledTimes(relevant.length)
  })

  it('catches up soon after a notification is sent', () => {
    const task = ranTask()
    start()
    menuBar.toggle()
    recordNotification(test.db, { taskId: task.id, title: 'Add rate limiting', body: 'Which limit?' })
    menuBar.changed()
    menuBar.changed()
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(lastSent().recent.map(({ body }) => body)).toEqual(['Which limit?'])
  })
})

describe('Show Glade in the menu bar', () => {
  it('keeps the icon out of the menu bar from launch while it is off', () => {
    updateSettings(test.db, { showInMenuBar: false })
    start()
    expect(menuBar.shown).toBe(false)
    expect(trays).toEqual([])
    menuBar.toggle()
    expect(popovers).toEqual([])
  })

  it('takes the icon away as it is turned off, closing the popover, and puts it back as it is turned on', () => {
    ranTask({ activity: TaskActivity.Working })
    const log = createMemoryLog()
    start({ log: log.logger })
    menuBar.toggle()
    const first = tray()

    const off = updateSettings(test.db, { showInMenuBar: false })
    menuBar.observe({ type: EventType.SettingsChanged, settings: off })
    expect(menuBar.shown).toBe(false)
    expect(first.destroyed).toBe(true)
    expect(popover().destroyed).toBe(true)
    expect(menuBar.open).toBe(false)
    expect(menuBar.pulsing).toBe(false)
    // Nothing is drawn on the icon that's gone.
    const drawn = first.frames.length
    vi.advanceTimersByTime(PULSE_FRAME_MS * 4)
    expect(first.frames).toHaveLength(drawn)

    const on = updateSettings(test.db, { showInMenuBar: true })
    menuBar.observe({ type: EventType.SettingsChanged, settings: on })
    expect(menuBar.shown).toBe(true)
    expect(tray()).not.toBe(first)
    expect(menuBar.pulsing).toBe(true)
    expect(log.records.map(({ message }) => message)).toEqual([
      'menu bar icon added',
      'menu bar icon removed',
      'menu bar icon added',
    ])
  })

  it('changes nothing when another setting changes', () => {
    start()
    const first = tray()
    menuBar.observe({ type: EventType.SettingsChanged, settings: updateSettings(test.db, { notifications: false }) })
    expect(tray()).toBe(first)
    expect(trays).toHaveLength(1)
  })

  it('drops a change that was on its way when the icon went', () => {
    const task = ranTask()
    start()
    menuBar.toggle()
    const sent = popover().sent.length
    change(task, { activity: TaskActivity.Working })
    menuBar.observe({ type: EventType.SettingsChanged, settings: updateSettings(test.db, { showInMenuBar: false }) })
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    menuBar.changed()
    menuBar.refresh()
    menuBar.motionChanged()
    expect(popover().sent).toHaveLength(sent)
  })
})

describe('the popover', () => {
  it('shows under the icon on a click, sent what is in flight as it shows', () => {
    const task = ranTask()
    start()
    expect(popovers).toEqual([])
    menuBar.toggle()
    expect(menuBar.open).toBe(true)
    expect(popover().shown).toEqual([TRAY_BOUNDS])
    expect(lastSent().needsYou.map(({ taskId }) => taskId)).toEqual([task.id])
  })

  it('stays up to date while it is open', () => {
    const task = ranTask()
    start()
    menuBar.toggle()
    change(task, { activity: TaskActivity.Working, status: 'Running the tests' })
    vi.advanceTimersByTime(REFRESH_DELAY_MS)
    expect(lastSent().needsYou).toEqual([])
    expect(lastSent().working.map(({ status }) => status)).toEqual(['Running the tests'])
  })

  it('hides on a second click, and shows again, the same window, on a third', () => {
    start()
    menuBar.toggle()
    menuBar.toggle()
    expect(menuBar.open).toBe(false)
    expect(popover().hides).toBe(1)
    clock += REOPEN_GRACE_MS
    menuBar.toggle()
    expect(menuBar.open).toBe(true)
    expect(popovers).toHaveLength(1)
    expect(popover().shown).toHaveLength(2)
  })

  it('stays hidden when the click that took its focus away, and so hid it, arrives', () => {
    start()
    menuBar.toggle()
    popover().handlers.onHidden()
    expect(menuBar.open).toBe(false)
    clock += REOPEN_GRACE_MS - 1
    menuBar.toggle()
    expect(menuBar.open).toBe(false)
    expect(popover().shown).toHaveLength(1)

    clock += 1
    menuBar.toggle()
    expect(menuBar.open).toBe(true)
  })

  it('takes its hiding itself once only', () => {
    start()
    menuBar.toggle()
    menuBar.hide()
    const hiddenAt = clock
    clock += REOPEN_GRACE_MS
    // Hiding the window takes its focus, which says it hid again: that isn't a new hiding.
    popover().handlers.onHidden()
    menuBar.toggle()
    expect(menuBar.open).toBe(true)
    expect(clock - hiddenAt).toBe(REOPEN_GRACE_MS)
  })

  it('hides on Esc, and does nothing when it is already hidden', () => {
    start()
    menuBar.hide()
    menuBar.toggle()
    menuBar.hide()
    menuBar.hide()
    expect(popover().hides).toBe(1)
  })

  it('opens a task, hiding first', () => {
    const task = ranTask()
    start()
    menuBar.toggle()
    menuBar.openTask(task.id)
    expect(menuBar.open).toBe(false)
    expect(opened).toEqual([task.id])
    expect(getTask(test.db, task.id)).toBeDefined()
  })

  it('opens Glade and quits, hiding first', () => {
    start()
    menuBar.toggle()
    menuBar.openGlade()
    expect(menuBar.open).toBe(false)
    clock += REOPEN_GRACE_MS
    menuBar.toggle()
    menuBar.quit()
    expect(menuBar.open).toBe(false)
    expect(calls).toEqual(['openGlade', 'quit'])
  })

  it('sizes itself to its page, once it has been made', () => {
    start()
    menuBar.fit(200)
    menuBar.toggle()
    menuBar.fit(320)
    expect(popover().heights).toEqual([320])
  })

  it('goes with the icon when the app quits, and quitting twice is harmless', () => {
    ranTask({ activity: TaskActivity.Working })
    start()
    menuBar.toggle()
    menuBar.close()
    expect(trays[0]?.destroyed).toBe(true)
    expect(popover().destroyed).toBe(true)
    expect(menuBar.shown).toBe(false)
    expect(menuBar.pulsing).toBe(false)
    menuBar.close()
  })
})
