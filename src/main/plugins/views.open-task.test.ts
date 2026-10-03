// A plugin's `openTask` in the plugin views (#466): honoured only right after a click or key press in its own view, as
// main heard it (never anything the page says), one per gesture, and only for a task (and subagent) the plugin can see.
// Everything else is dropped and logged; the rate limit applies as to every message.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  PluginEventType,
  PluginSubagentState,
  PluginTaskActivity,
  PluginTaskState,
  type PluginChangeEvent,
  type PluginSnapshotEvent,
  type PluginSubagent,
  type PluginTask,
} from '../../shared/plugin-api'
import { PluginStatus, type ValidPlugin } from '../../shared/plugins'
import { LogLevel } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { createFakePluginViews, type FakePluginView, type FakePluginViews } from './fake-view'
import type { PluginFeed, PluginSink } from './feed'
import { PLUGIN_GESTURE_MS } from './gesture'
import { SightRefusal } from './sight'
import { createPluginViews, type PluginViews } from './views'

const bounds = { x: 600, y: 520, width: 680, height: 255 }

function plugin(folder: string): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder,
    manifest: {
      id: folder,
      name: folder,
      version: '1.0.0',
      entry: 'index.html',
      icon: null,
      capabilities: [],
      settings: [],
    },
    iconUrl: null,
    enabled: true,
    granted: [],
    settings: {},
  }
}

function task(id: string, workspaceId: string, state = PluginTaskState.Active): PluginTask {
  return {
    id,
    workspaceId,
    workspaceName: workspaceId === 'w1' ? 'Acme API' : 'Billing',
    title: 'Fix the date bug',
    status: '',
    state,
    activity: PluginTaskActivity.Working,
    needsYou: false,
    waitingOn: null,
    createdAt: 1,
    updatedAt: 1,
    doneAt: null,
  }
}

function subagent(id: string, taskId: string): PluginSubagent {
  return {
    id,
    taskId,
    name: 'Check links',
    state: PluginSubagentState.Running,
    latest: null,
    startedAt: 1,
    endedAt: null,
  }
}

/** Two active tasks in two workspaces, the second with a kitten. */
const SNAPSHOT: PluginSnapshotEvent = {
  type: PluginEventType.Snapshot,
  tasks: [task('cat-1', 'w1'), task('cat-2', 'w2')],
  subagents: [subagent('kitten-1', 'cat-2')],
  questions: [],
  permissions: [],
}

let emit: Mock<(event: GladeEvent) => void>
let fakes: FakePluginViews
let log: MemoryLog
let time: number
let views: PluginViews
let sinks: Set<PluginSink>

const feed: Pick<PluginFeed, 'subscribe'> = {
  subscribe(sink) {
    sink(SNAPSHOT)
    sinks.add(sink)
    return () => {
      sinks.delete(sink)
    }
  },
}

function push(event: PluginChangeEvent): void {
  for (const sink of sinks) sink(event)
}

beforeEach(() => {
  emit = vi.fn()
  fakes = createFakePluginViews()
  log = createMemoryLog()
  time = 0
  sinks = new Set()
  views = createPluginViews({
    emit,
    feed,
    folder: '/data/plugins',
    appVersion: '0.21.0',
    createView: fakes.create,
    now: () => time,
    log: log.logger,
  })
  views.update([plugin('nekomata'), plugin('sketchpad')])
})

/** The shown plugin's view, placed and past its handshake. */
function ready(id = 'nekomata'): FakePluginView {
  views.place(id, bounds)
  const view = fakes.last()
  view.post({ type: 'ready' })
  return view
}

function opened(): GladeEvent[] {
  return emit.mock.calls.map(([event]) => event).filter((event) => event.type === EventType.TaskOpenRequested)
}

function dropped(): unknown[] {
  return log.withMessage('plugin openTask dropped').map(({ fields }) => fields)
}

describe('openTask', () => {
  it('opens a task the plugin can see right after a click in its view, giving the window back the keyboard', () => {
    const view = ready()
    view.click()
    time += 200
    view.post({ type: 'openTask', taskId: 'cat-2' })

    expect(opened()).toEqual([{ type: EventType.TaskOpenRequested, taskId: 'cat-2', subagentId: null }])
    expect(view.focusYielded).toBe(1)
    expect(log.withMessage('plugin opened a task')).toEqual([
      expect.objectContaining({
        level: LogLevel.Info,
        fields: { id: 'nekomata', taskId: 'cat-2', subagentId: null },
      }),
    ])
  })

  it('opens it on a subagent of that task', () => {
    const view = ready()
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-2', subagentId: 'kitten-1' })

    expect(opened()).toEqual([{ type: EventType.TaskOpenRequested, taskId: 'cat-2', subagentId: 'kitten-1' }])
  })

  it('takes a null subagent as none', () => {
    const view = ready()
    view.press()
    view.post({ type: 'openTask', taskId: 'cat-1', subagentId: null })

    expect(opened()).toEqual([{ type: EventType.TaskOpenRequested, taskId: 'cat-1', subagentId: null }])
  })

  it('counts a key press in the view as much as a click', () => {
    const view = ready()
    view.press()
    time += PLUGIN_GESTURE_MS
    view.post({ type: 'openTask', taskId: 'cat-1' })

    expect(opened()).toHaveLength(1)
  })

  it('drops it with no click or key press in the view, and logs why', () => {
    const view = ready()
    view.post({ type: 'openTask', taskId: 'cat-2' })

    expect(opened()).toEqual([])
    expect(view.focusYielded).toBe(0)
    expect(log.withMessage('plugin openTask dropped')).toEqual([
      expect.objectContaining({
        level: LogLevel.Warn,
        fields: { id: 'nekomata', taskId: 'cat-2', subagentId: null, reason: 'no_gesture' },
      }),
    ])
  })

  it('drops it more than a second after the click', () => {
    const view = ready()
    view.click()
    time += PLUGIN_GESTURE_MS + 1
    view.post({ type: 'openTask', taskId: 'cat-2' })

    expect(opened()).toEqual([])
    expect(dropped()).toEqual([expect.objectContaining({ reason: 'no_gesture' })])
  })

  it('honours one openTask per click: a second right after it is dropped', () => {
    const view = ready()
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-1' })
    view.post({ type: 'openTask', taskId: 'cat-2' })

    expect(opened()).toEqual([{ type: EventType.TaskOpenRequested, taskId: 'cat-1', subagentId: null }])
    expect(dropped()).toEqual([expect.objectContaining({ taskId: 'cat-2', reason: 'no_gesture' })])

    // The next click allows the next one.
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-2' })
    expect(opened()).toHaveLength(2)
  })

  it("doesn't take anything the page says for a click: only input main heard counts", () => {
    const view = ready()
    for (const fake of [
      { type: 'click' },
      { type: 'gesture' },
      { type: 'input', kind: 'press' },
      { type: 'openTask', taskId: 'cat-2', gesture: true },
      { type: 'openTask', taskId: 'cat-2', clickedAt: time },
    ]) {
      view.post(fake)
    }
    view.post({ type: 'openTask', taskId: 'cat-2' })

    expect(opened()).toEqual([])
    // The made-up messages fail the schema; the real one has no gesture behind it.
    expect(log.withMessage('plugin message dropped')).toHaveLength(5)
    expect(dropped()).toEqual([expect.objectContaining({ reason: 'no_gesture' })])
  })

  it('uses up the click even on a task it may not open', () => {
    const view = ready()
    view.click()
    view.post({ type: 'openTask', taskId: 'stray' })
    view.post({ type: 'openTask', taskId: 'cat-1' })

    expect(opened()).toEqual([])
    expect(dropped()).toEqual([
      expect.objectContaining({ taskId: 'stray', reason: SightRefusal.UnknownTask }),
      expect.objectContaining({ taskId: 'cat-1', reason: 'no_gesture' }),
    ])
  })

  it('drops a task it was never told of', () => {
    const view = ready()
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-9' })

    expect(opened()).toEqual([])
    expect(view.focusYielded).toBe(0)
    expect(dropped()).toEqual([expect.objectContaining({ taskId: 'cat-9', reason: SightRefusal.UnknownTask })])
  })

  it('drops a task once it is done', () => {
    const view = ready()
    push({ type: PluginEventType.TaskUpdated, task: task('cat-2', 'w2', PluginTaskState.Done) })
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-2' })

    expect(opened()).toEqual([])
    expect(dropped()).toEqual([expect.objectContaining({ taskId: 'cat-2', reason: SightRefusal.DoneTask })])
  })

  it('drops a task once it is deleted', () => {
    const view = ready()
    push({ type: PluginEventType.TaskDeleted, taskId: 'cat-2' })
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-2', subagentId: 'kitten-1' })

    expect(opened()).toEqual([])
    expect(dropped()).toEqual([expect.objectContaining({ taskId: 'cat-2', reason: SightRefusal.UnknownTask })])
  })

  it("opens a task created after the snapshot, and a subagent started since, once it's told of them", () => {
    const view = ready()
    push({ type: PluginEventType.TaskCreated, task: task('cat-3', 'w1') })
    push({ type: PluginEventType.SubagentStarted, subagent: subagent('kitten-3', 'cat-3') })
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-3', subagentId: 'kitten-3' })

    expect(opened()).toEqual([{ type: EventType.TaskOpenRequested, taskId: 'cat-3', subagentId: 'kitten-3' }])
  })

  it("drops a subagent of another task, or one it wasn't told of", () => {
    const view = ready()
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-1', subagentId: 'kitten-1' })
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-2', subagentId: 'kitten-9' })

    expect(opened()).toEqual([])
    expect(dropped()).toEqual([
      expect.objectContaining({ taskId: 'cat-1', subagentId: 'kitten-1', reason: SightRefusal.UnknownSubagent }),
      expect.objectContaining({ taskId: 'cat-2', subagentId: 'kitten-9', reason: SightRefusal.UnknownSubagent }),
    ])
  })

  it("drops it before the plugin's ready: it has been told of nothing yet", () => {
    views.place('nekomata', bounds)
    const view = fakes.last()
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-1' })

    expect(opened()).toEqual([])
    expect(dropped()).toEqual([expect.objectContaining({ reason: SightRefusal.UnknownTask })])
  })

  it("keeps each view's clicks its own: one in another plugin's view, or the page before a reload, doesn't count", () => {
    const first = ready('nekomata')
    first.click()
    const second = ready('sketchpad')
    second.post({ type: 'openTask', taskId: 'cat-1' })
    expect(opened()).toEqual([])

    second.click()
    views.reload(['sketchpad'])
    const reloaded = fakes.last()
    reloaded.post({ type: 'ready' })
    reloaded.post({ type: 'openTask', taskId: 'cat-1' })
    expect(opened()).toEqual([])
    expect(dropped()).toEqual([
      expect.objectContaining({ id: 'sketchpad', reason: 'no_gesture' }),
      expect.objectContaining({ id: 'sketchpad', reason: 'no_gesture' }),
    ])
  })

  it('still counts against the rate limit: a flood is cut off, openTask with it', () => {
    const view = ready()
    for (let i = 0; i < 100; i += 1) view.post({ type: 'status', text: String(i) })
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-1' })

    expect(opened()).toEqual([])
    expect(dropped()).toEqual([])

    // Once it slows, the next click works.
    time += 1000
    view.click()
    view.post({ type: 'openTask', taskId: 'cat-1' })
    expect(opened()).toHaveLength(1)
  })

  it('drops a malformed openTask as any other malformed message', () => {
    const view = ready()
    view.click()
    view.post({ type: 'openTask' })
    view.post({ type: 'openTask', taskId: '' })
    view.post({ type: 'openTask', taskId: 42 })
    view.post({ type: 'openTask', taskId: 'cat-1', subagentId: 7 })

    expect(opened()).toEqual([])
    expect(log.withMessage('plugin message dropped')).toHaveLength(4)
    // None of them used the click.
    view.post({ type: 'openTask', taskId: 'cat-1' })
    expect(opened()).toHaveLength(1)
  })
})
