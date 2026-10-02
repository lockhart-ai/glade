// The plugin API's schemas against its types, both ways (`npm run typecheck` checks the type-level half), and what the
// schemas take and refuse.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  MAX_PLUGIN_TEXT,
  PluginEventType,
  PluginMessageType,
  PluginTaskActivity,
  PluginTaskState,
  type GladeMessage,
  type PluginEvent,
  type PluginMachineReading,
  type PluginMessage,
  type PluginTask,
} from './plugin-api'
import {
  gladeMessageSchema,
  pluginEventSchema,
  pluginMachineReadingSchema,
  pluginMessageSchema,
  pluginSettingsSchema,
  pluginTaskSchema,
} from './plugin-api-schema'

describe('the types', () => {
  it('match the schemas both ways', () => {
    expectTypeOf<z.output<typeof gladeMessageSchema>>().toExtend<GladeMessage>()
    expectTypeOf<GladeMessage>().toExtend<z.output<typeof gladeMessageSchema>>()
    expectTypeOf<z.output<typeof pluginEventSchema>>().toExtend<PluginEvent>()
    expectTypeOf<PluginEvent>().toExtend<z.output<typeof pluginEventSchema>>()
    expectTypeOf<z.output<typeof pluginMessageSchema>>().toExtend<PluginMessage>()
    expectTypeOf<PluginMessage>().toExtend<z.output<typeof pluginMessageSchema>>()
  })
})

const TASK: PluginTask = {
  id: 't1',
  workspaceId: 'w1',
  workspaceName: 'Acme API',
  title: 'Fix the date bug',
  status: '',
  state: PluginTaskState.Active,
  activity: PluginTaskActivity.Working,
  needsYou: false,
  waitingOn: null,
  createdAt: 1,
  updatedAt: 2,
  doneAt: null,
}

describe('gladeMessageSchema', () => {
  it('takes a message in the envelope', () => {
    const message: GladeMessage = {
      source: 'glade',
      apiVersion: 1,
      seq: 3,
      event: { type: PluginEventType.TaskUpdated, task: TASK },
    }

    expect(gladeMessageSchema.parse(message)).toEqual(message)
  })

  it.each([
    ['a field the schema has no place for', { ...TASK, objective: 'Something private' }],
    ['text longer than 200 characters', { ...TASK, title: 'x'.repeat(MAX_PLUGIN_TEXT + 1) }],
    ['a state that is not one', { ...TASK, state: 'archived' }],
  ])('refuses a task with %s', (_name, task) => {
    expect(pluginTaskSchema.safeParse(task).success).toBe(false)
    expect(
      gladeMessageSchema.safeParse({ source: 'glade', apiVersion: 1, seq: 1, event: { type: 'task.created', task } })
        .success,
    ).toBe(false)
  })

  it('refuses another version, a seq below 1, and an event type it does not know', () => {
    const hello = { type: PluginEventType.Hello, app: { name: 'Glade', version: '0.11.0' } }
    expect(gladeMessageSchema.safeParse({ source: 'glade', apiVersion: 2, seq: 1, event: hello }).success).toBe(false)
    expect(gladeMessageSchema.safeParse({ source: 'glade', apiVersion: 1, seq: 0, event: hello }).success).toBe(false)
    expect(pluginEventSchema.safeParse({ type: 'chat.message', body: 'hi' }).success).toBe(false)
  })
})

describe('the machine readings', () => {
  const READING: PluginMachineReading = {
    t: 1_700_000_000_000,
    cpuCount: 10,
    total: 7.3,
    claude: 4.6,
    docker: 1.24,
    gpu: 88,
    containers: [
      { name: 'acme-api-db-1', cpu: 78, memory: 440_401_920 },
      { name: 'acme-api-web-1', cpu: 46, memory: 188_743_680 },
    ],
  }
  const SNAPSHOT = { type: PluginEventType.Snapshot, tasks: [TASK], subagents: [], questions: [], permissions: [] }

  it('takes a reading, with a GPU or without one, and with no containers', () => {
    const event = { type: PluginEventType.MachineReading, reading: READING }
    expect(pluginEventSchema.parse(event)).toEqual(event)
    expect(pluginMachineReadingSchema.parse({ ...READING, gpu: null, containers: [] })).toMatchObject({ gpu: null })
  })

  it.each([
    ['a process name or command', { ...READING, processes: ['claude --print'] }],
    ['a container with its image', { ...READING, containers: [{ name: 'db', cpu: 1, memory: 1, image: 'pg:16' }] }],
    ['a negative load', { ...READING, total: -1 }],
    ['a GPU over 100%', { ...READING, gpu: 101 }],
    ['no cores', { ...READING, cpuCount: 0 }],
    ['fractional bytes', { ...READING, containers: [{ name: 'db', cpu: 1, memory: 1.5 }] }],
    [
      'a container name longer than 200 characters',
      { ...READING, containers: [{ name: 'x'.repeat(201), cpu: 1, memory: 1 }] },
    ],
  ])('refuses a reading with %s', (_name, reading) => {
    expect(pluginMachineReadingSchema.safeParse(reading).success).toBe(false)
  })

  it('takes a snapshot with the latest readings, up to 60, or without any machine at all', () => {
    expect(pluginEventSchema.parse(SNAPSHOT)).toEqual(SNAPSHOT)
    expect(pluginEventSchema.parse({ ...SNAPSHOT, machine: [] })).toEqual({ ...SNAPSHOT, machine: [] })
    const full = { ...SNAPSHOT, machine: Array.from({ length: 60 }, (_, i) => ({ ...READING, t: i })) }
    expect(pluginEventSchema.safeParse(full).success).toBe(true)
    expect(pluginEventSchema.safeParse({ ...full, machine: [...full.machine, READING] }).success).toBe(false)
  })
})

describe("a plugin's settings", () => {
  const SNAPSHOT = { type: PluginEventType.Snapshot, tasks: [TASK], subagents: [], questions: [], permissions: [] }

  it('takes a snapshot with settings, key to value, with none declared, or without the field at all', () => {
    const withSettings = { ...SNAPSHOT, settings: { style: '16bit', pace: 'slow' } }
    expect(pluginEventSchema.parse(withSettings)).toEqual(withSettings)
    expect(pluginEventSchema.parse({ ...SNAPSHOT, settings: {} })).toEqual({ ...SNAPSHOT, settings: {} })
    expect(pluginEventSchema.parse(SNAPSHOT)).not.toHaveProperty('settings')
  })

  it('takes settings.changed with the whole settings object', () => {
    const event = { type: PluginEventType.SettingsChanged, settings: { style: '32bit' } }
    expect(pluginEventSchema.parse(event)).toEqual(event)
    expect(gladeMessageSchema.parse({ source: 'glade', apiVersion: 1, seq: 3, event })).toMatchObject({ event })
  })

  it.each([
    ['a value that is not a string', { style: 16 }],
    ['a nested value', { style: { value: '16bit' } }],
    ['a list', ['16bit']],
    ['null', null],
  ])('refuses settings that are %s', (_name, settings) => {
    expect(pluginSettingsSchema.safeParse(settings).success).toBe(false)
    expect(pluginEventSchema.safeParse({ ...SNAPSHOT, settings }).success).toBe(false)
    expect(pluginEventSchema.safeParse({ type: PluginEventType.SettingsChanged, settings }).success).toBe(false)
  })

  it('refuses settings.changed without settings, or with anything more', () => {
    expect(pluginEventSchema.safeParse({ type: PluginEventType.SettingsChanged }).success).toBe(false)
    const more = { type: PluginEventType.SettingsChanged, settings: {}, plugin: 'easel' }
    expect(pluginEventSchema.safeParse(more).success).toBe(false)
  })
})

describe('pluginMessageSchema', () => {
  it('takes ready and status, and nothing more', () => {
    expect(pluginMessageSchema.parse({ type: PluginMessageType.Ready })).toEqual({ type: 'ready' })
    expect(pluginMessageSchema.parse({ type: PluginMessageType.Status, text: '5 cats' })).toEqual({
      type: 'status',
      text: '5 cats',
    })
    expect(pluginMessageSchema.safeParse({ type: 'ready', extra: true }).success).toBe(false)
    expect(pluginMessageSchema.safeParse({ type: 'task.create' }).success).toBe(false)
  })
})
