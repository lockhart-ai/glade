import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { PluginEventType, type GladeMessage } from '../../shared/plugin-api'
import { PluginStatus, type InstalledPlugin, type ValidPlugin } from '../../shared/plugins'
import { LogLevel } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { createFakePluginViews, type FakePluginViews } from './fake-view'
import { createPluginViews, type PluginViews } from './views'

function valid(folder: string, enabled = true): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder,
    manifest: { id: folder, name: folder, version: '1.0.0', entry: 'index.html', icon: null },
    iconUrl: null,
    enabled,
  }
}

const invalid: InstalledPlugin = { status: PluginStatus.Invalid, folder: 'broken', reason: 'manifest.json is missing' }
const bounds = { x: 600, y: 520, width: 680, height: 255 }

let emit: Mock<(event: GladeEvent) => void>
let fakes: FakePluginViews
let log: MemoryLog
let time: number
let views: PluginViews

beforeEach(() => {
  emit = vi.fn()
  fakes = createFakePluginViews()
  log = createMemoryLog()
  time = 0
  views = createPluginViews({
    emit,
    folder: '/data/plugins',
    appVersion: '0.12.0',
    createView: fakes.create,
    now: () => time,
    log: log.logger,
  })
  views.update([invalid, valid('nekomata'), valid('pomodoro')])
})

function hello(seq = 1): GladeMessage {
  return {
    source: 'glade',
    apiVersion: 1,
    seq,
    event: { type: PluginEventType.Hello, app: { name: 'Glade', version: '0.12.0' } },
  }
}

function statuses(): GladeEvent[] {
  return emit.mock.calls.map(([event]) => event).filter((event) => event.type === EventType.PluginStatusChanged)
}

describe('place', () => {
  it("makes the plugin's view the first time it's shown, from its folder, and puts it over the card", () => {
    expect(views.place('nekomata', bounds)).toEqual({ status: '' })

    expect(fakes.views).toHaveLength(1)
    expect(fakes.last().spec).toMatchObject({ plugin: valid('nekomata'), folder: '/data/plugins/nekomata' })
    expect(fakes.last().bounds).toEqual(bounds)
  })

  it('moves the same view as the card moves, and hides it without ending it', () => {
    views.place('nekomata', bounds)
    views.place('nekomata', { ...bounds, width: 500 })
    views.place('nekomata', null)

    expect(fakes.views).toHaveLength(1)
    expect(fakes.last()).toMatchObject({ bounds: null, destroyed: false })

    views.place('nekomata', bounds)
    expect(fakes.last().bounds).toEqual(bounds)
  })

  it("doesn't make a view to hide", () => {
    expect(views.place('nekomata', null)).toEqual({ status: '' })

    expect(fakes.views).toEqual([])
  })

  it.each([
    ['a plugin that is off', 'off'],
    ['an invalid plugin', 'broken'],
    ['a plugin not in the folder', 'nope'],
  ])('refuses %s', (_name, id) => {
    views.update([invalid, valid('nekomata'), valid('off', false)])

    expect(() => views.place(id, bounds)).toThrow(expect.objectContaining({ code: BridgeErrorCode.NotFound }))
    expect(fakes.views).toEqual([])
  })

  it("destroys one plugin's view to show another's", () => {
    views.place('nekomata', bounds)
    const first = fakes.last()
    views.place('pomodoro', bounds)

    expect(first.destroyed).toBe(true)
    expect(fakes.views).toHaveLength(2)
    expect(fakes.last()).toMatchObject({ bounds, destroyed: false })
  })

  it("answers with nothing when the view can't be made, and tries again next time", () => {
    fakes.refuseNext()

    expect(views.place('nekomata', bounds)).toEqual({ status: '' })
    expect(fakes.views).toEqual([])

    views.place('nekomata', bounds)
    expect(fakes.views).toHaveLength(1)
  })

  it('checks the plugin but makes nothing without a way to make views', () => {
    const bare = createPluginViews({ emit, folder: '/data/plugins', appVersion: '0.12.0' })
    bare.update([valid('nekomata')])

    expect(bare.place('nekomata', bounds)).toEqual({ status: '' })
    expect(() => bare.place('other', bounds)).toThrow()
  })
})

describe('update', () => {
  it('destroys the view when its plugin is turned off, and clears its status', () => {
    views.place('nekomata', bounds)
    fakes.last().post({ type: 'status', text: '5 cats' })

    views.update([valid('nekomata', false), valid('pomodoro')])

    expect(fakes.last().destroyed).toBe(true)
    expect(statuses()).toEqual([
      { type: EventType.PluginStatusChanged, id: 'nekomata', text: '5 cats' },
      { type: EventType.PluginStatusChanged, id: 'nekomata', text: '' },
    ])
    expect(log.records).toContainEqual(
      expect.objectContaining({
        message: 'plugin view destroyed',
        fields: { id: 'nekomata', reason: 'the plugin is off' },
      }),
    )
  })

  it('destroys the view when its folder is removed or its manifest breaks', () => {
    views.place('nekomata', bounds)
    views.update([{ status: PluginStatus.Invalid, folder: 'nekomata', reason: 'bad manifest' }])
    expect(fakes.last().destroyed).toBe(true)

    views.update([valid('nekomata')])
    views.place('nekomata', bounds)
    views.update([])
    expect(fakes.last().destroyed).toBe(true)
  })

  it('keeps the view while its plugin stays on, and makes a new one when it comes back on', () => {
    views.place('nekomata', bounds)
    views.update([valid('nekomata'), valid('pomodoro', false)])
    expect(fakes.last().destroyed).toBe(false)

    views.update([valid('nekomata', false)])
    views.update([valid('nekomata')])
    views.place('nekomata', bounds)

    expect(fakes.views).toHaveLength(2)
    expect(fakes.last().destroyed).toBe(false)
  })
})

describe("the page's messages", () => {
  beforeEach(() => {
    views.place('nekomata', bounds)
  })

  it('answers ready with hello, and starts seq over each time', () => {
    const view = fakes.last()
    view.post({ type: 'ready' })
    expect(view.sent).toEqual([hello(1)])

    view.post({ type: 'ready' })
    expect(view.sent).toEqual([hello(1), hello(1)])
  })

  it('sets the status, cut to 40 characters, and broadcasts it once per change', () => {
    const view = fakes.last()
    view.post({ type: 'status', text: '5 cats · 4 kittens' })
    view.post({ type: 'status', text: '5 cats · 4 kittens' })
    view.post({ type: 'status', text: 'x'.repeat(100) })
    view.post({ type: 'status', text: '' })

    expect(statuses()).toEqual([
      { type: EventType.PluginStatusChanged, id: 'nekomata', text: '5 cats · 4 kittens' },
      { type: EventType.PluginStatusChanged, id: 'nekomata', text: 'x'.repeat(40) },
      { type: EventType.PluginStatusChanged, id: 'nekomata', text: '' },
    ])
    view.post({ type: 'status', text: 'on' })
    expect(views.place('nekomata', bounds)).toEqual({ status: 'on' })
  })

  it('drops a malformed message, logs why, and carries on', () => {
    const view = fakes.last()
    view.post({ type: 'status', text: 42 })
    view.post('ready')
    view.post({ type: 'task.create', title: 'x' })
    view.post({ type: 'ready' })

    expect(statuses()).toEqual([])
    expect(view.sent).toEqual([hello(1)])
    expect(log.records.filter(({ message }) => message === 'plugin message dropped')).toHaveLength(3)
    expect(log.records).toContainEqual(
      expect.objectContaining({ level: LogLevel.Warn, fields: expect.objectContaining({ id: 'nekomata' }) as unknown }),
    )
  })

  it('drops a flood beyond the rate limit, logging it once, and takes messages again once it slows', () => {
    const view = fakes.last()
    for (let i = 0; i < 10_000; i += 1) view.post({ type: 'ready' })

    // The burst of 50 is answered; the rest are dropped.
    expect(view.sent).toHaveLength(50)
    expect(log.records.filter(({ message }) => message === 'plugin messages dropped: too many')).toHaveLength(1)

    time += 1000
    view.post({ type: 'status', text: 'calm again' })
    expect(statuses()).toEqual([{ type: EventType.PluginStatusChanged, id: 'nekomata', text: 'calm again' }])

    for (let i = 0; i < 100; i += 1) view.post({ type: 'status', text: String(i) })
    expect(log.records.filter(({ message }) => message === 'plugin messages dropped: too many')).toHaveLength(2)
  })

  it('counts malformed messages against the limit too', () => {
    const view = fakes.last()
    for (let i = 0; i < 1000; i += 1) view.post({ junk: i })

    expect(log.records.filter(({ message }) => message === 'plugin message dropped')).toHaveLength(50)
  })

  it("ignores a destroyed view's page", () => {
    const view = fakes.last()
    views.place('pomodoro', bounds)

    view.post({ type: 'ready' })
    view.post({ type: 'status', text: 'ghost' })

    expect(view.sent).toEqual([])
    expect(statuses()).toEqual([])
  })

  it('forgets a view whose page is gone, and makes a new one next time', () => {
    const view = fakes.last()
    view.post({ type: 'status', text: '5 cats' })
    view.crash()

    expect(view.destroyed).toBe(true)
    expect(statuses().at(-1)).toEqual({ type: EventType.PluginStatusChanged, id: 'nekomata', text: '' })

    views.place('nekomata', bounds)
    expect(fakes.views).toHaveLength(2)
    // The old page going again does nothing to the new one.
    view.crash()
    expect(fakes.last().destroyed).toBe(false)
  })
})

describe('close', () => {
  it('destroys the view, and does nothing without one', () => {
    views.close()
    views.place('nekomata', bounds)

    views.close()

    expect(fakes.last().destroyed).toBe(true)
  })
})
