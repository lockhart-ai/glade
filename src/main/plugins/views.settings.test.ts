// A plugin's own settings in the plugin views (#435): in its snapshot when its manifest declares any, and again as a
// `settings.changed` event when one changes while its page is running, without reloading it. A plugin that declares
// none gets neither, and no plugin is ever sent another's.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginEventType, type PluginEvent, type PluginSnapshotEvent } from '../../shared/plugin-api'
import { gladeMessageSchema } from '../../shared/plugin-api-schema'
import {
  PluginSettingType,
  PluginStatus,
  type PluginSetting,
  type PluginSettingValues,
  type ValidPlugin,
} from '../../shared/plugins'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { createFakePluginViews, type FakePluginViews } from './fake-view'
import type { PluginFeed } from './feed'
import { createPluginViews, type PluginViews } from './views'

const bounds = { x: 600, y: 520, width: 680, height: 255 }

function select(key: string, values: readonly string[]): PluginSetting {
  return {
    type: PluginSettingType.Select,
    key,
    label: key,
    options: values.map((value) => ({ value, label: value })),
    default: values[0] ?? '',
  }
}

const STYLE = select('style', ['ink', 'chalk', 'neon'])
const PACE = select('pace', ['fast', 'slow'])

interface PluginOptions {
  readonly declares?: readonly PluginSetting[]
  readonly settings?: PluginSettingValues
  readonly enabled?: boolean
}

function plugin(folder: string, { declares = [], settings = {}, enabled = true }: PluginOptions = {}): ValidPlugin {
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
      settings: declares,
    },
    iconUrl: null,
    enabled,
    granted: [],
    settings,
  }
}

/** A made-up plugin that declares two settings, at `settings`. */
function sketchpad(settings: PluginSettingValues = { style: 'ink', pace: 'fast' }): ValidPlugin {
  return plugin('sketchpad', { declares: [STYLE, PACE], settings })
}

const SNAPSHOT: PluginSnapshotEvent = {
  type: PluginEventType.Snapshot,
  tasks: [],
  subagents: [],
  questions: [],
  permissions: [],
}

const feed: Pick<PluginFeed, 'subscribe'> = {
  subscribe(sink) {
    sink(SNAPSHOT)
    return vi.fn()
  },
}

let fakes: FakePluginViews
let views: PluginViews
let log: MemoryLog

beforeEach(() => {
  fakes = createFakePluginViews()
  log = createMemoryLog()
  views = createPluginViews({
    emit: vi.fn(),
    feed,
    folder: '/data/plugins',
    appVersion: '0.20.0',
    createView: fakes.create,
    log: log.logger,
  })
})

/** Every event the last view's page was sent, each checked against the schema. */
function events(): PluginEvent[] {
  return fakes.last().sent.map((message) => gladeMessageSchema.parse(message).event)
}

/** Each `settings.changed` the last view's page was sent, as the settings it carried. */
function changes(): PluginSettingValues[] {
  return events().flatMap((event) => (event.type === PluginEventType.SettingsChanged ? [event.settings] : []))
}

function snapshots(): PluginSnapshotEvent[] {
  return events().filter((event): event is PluginSnapshotEvent => event.type === PluginEventType.Snapshot)
}

/** Shows `id` and has its page say `ready`. */
function showReady(id: string): void {
  views.place(id, bounds)
  fakes.last().post({ type: 'ready' })
}

describe('the snapshot', () => {
  it("has the plugin's settings, every declared one by key, at the values chosen", () => {
    views.update([sketchpad({ style: 'chalk', pace: 'fast' })])
    showReady('sketchpad')

    expect(snapshots()).toEqual([{ ...SNAPSHOT, settings: { style: 'chalk', pace: 'fast' } }])
  })

  it('has no settings field at all for a plugin that declares none', () => {
    views.update([plugin('pomodoro')])
    showReady('pomodoro')

    expect(snapshots()).toEqual([SNAPSHOT])
    expect('settings' in (snapshots()[0] ?? {})).toBe(false)
  })

  it('has the values as they are when it is sent: a change before ready is in it, not after it', () => {
    views.update([sketchpad()])
    views.place('sketchpad', bounds)
    views.update([sketchpad({ style: 'neon', pace: 'fast' })])

    fakes.last().post({ type: 'ready' })

    expect(snapshots()).toEqual([{ ...SNAPSHOT, settings: { style: 'neon', pace: 'fast' } }])
    expect(changes()).toEqual([])
  })

  it('has them again, as they now are, each time the page says ready', () => {
    views.update([sketchpad()])
    showReady('sketchpad')
    views.update([sketchpad({ style: 'ink', pace: 'slow' })])

    fakes.last().post({ type: 'ready' })

    expect(snapshots().at(-1)?.settings).toEqual({ style: 'ink', pace: 'slow' })
  })
})

describe('settings.changed', () => {
  it('tells the running page all its settings when one changes, numbered on from its snapshot, without a reload', () => {
    views.update([sketchpad()])
    showReady('sketchpad')

    views.update([sketchpad({ style: 'chalk', pace: 'fast' })])
    views.update([sketchpad({ style: 'chalk', pace: 'slow' })])

    expect(fakes.views).toHaveLength(1)
    expect(fakes.last().destroyed).toBe(false)
    expect(events().slice(2)).toEqual([
      { type: PluginEventType.SettingsChanged, settings: { style: 'chalk', pace: 'fast' } },
      { type: PluginEventType.SettingsChanged, settings: { style: 'chalk', pace: 'slow' } },
    ])
    expect(fakes.last().sent.map(({ seq }) => seq)).toEqual([1, 2, 3, 4])
    expect(log.withMessage('plugin settings sent')).toHaveLength(2)
  })

  it('reaches the page while it is hidden behind Settings, where the change is made', () => {
    views.update([sketchpad()])
    showReady('sketchpad')
    views.place('sketchpad', null)

    views.update([sketchpad({ style: 'neon', pace: 'fast' })])

    expect(changes()).toEqual([{ style: 'neon', pace: 'fast' }])
  })

  it('says nothing when the plugins are read again with its settings as they were', () => {
    views.update([sketchpad()])
    showReady('sketchpad')

    views.update([sketchpad()])
    views.update([{ ...sketchpad(), iconUrl: 'data:image/png;base64,AAAA' }])

    expect(changes()).toEqual([])
  })

  it("says nothing when another plugin's setting changes, or to a plugin that declares none", () => {
    const easel = (style: string): ValidPlugin => plugin('easel', { declares: [STYLE], settings: { style } })
    views.update([easel('ink'), plugin('pomodoro'), sketchpad()])
    showReady('sketchpad')

    views.update([easel('neon'), plugin('pomodoro'), sketchpad()])
    expect(events()).toHaveLength(2)

    showReady('pomodoro')
    views.update([easel('chalk'), plugin('pomodoro'), sketchpad({ style: 'chalk', pace: 'slow' })])
    expect(events()).toEqual([expect.objectContaining({ type: PluginEventType.Hello }), SNAPSHOT])
  })

  it('tells a page of settings its plugin starts declaring while it runs', () => {
    views.update([plugin('sketchpad')])
    showReady('sketchpad')

    views.update([sketchpad()])

    expect(changes()).toEqual([{ style: 'ink', pace: 'fast' }])
  })

  it('says nothing to a plugin as it is turned off', () => {
    views.update([sketchpad()])
    showReady('sketchpad')
    const view = fakes.last()

    views.update([{ ...sketchpad({ style: 'neon', pace: 'fast' }), enabled: false }])

    expect(view.destroyed).toBe(true)
    expect(view.sent).toHaveLength(2)
  })
})

describe('what a plugin sees of settings', () => {
  it("is only its own: never another plugin's values, even under the same key", () => {
    const easel = plugin('easel', { declares: [STYLE, select('secret', ['hidden', 'shown'])] })
    const installed = [
      { ...easel, settings: { style: 'neon', secret: 'hidden' } },
      sketchpad({ style: 'chalk', pace: 'slow' }),
    ]
    views.update(installed)
    showReady('sketchpad')
    views.update([{ ...easel, settings: { style: 'ink', secret: 'shown' } }, sketchpad({ style: 'ink', pace: 'slow' })])

    const sent = JSON.stringify(fakes.last().sent)
    expect(snapshots()[0]?.settings).toEqual({ style: 'chalk', pace: 'slow' })
    expect(changes()).toEqual([{ style: 'ink', pace: 'slow' }])
    for (const other of ['neon', 'secret', 'hidden', 'shown', 'easel']) expect(sent).not.toContain(other)
  })

  it('is each plugin its own, as one is shown after the other', () => {
    views.update([
      plugin('easel', { declares: [STYLE], settings: { style: 'neon' } }),
      sketchpad({ style: 'chalk', pace: 'slow' }),
    ])

    showReady('easel')
    expect(snapshots()).toEqual([{ ...SNAPSHOT, settings: { style: 'neon' } }])

    showReady('sketchpad')
    expect(snapshots()).toEqual([{ ...SNAPSHOT, settings: { style: 'chalk', pace: 'slow' } }])
  })
})
