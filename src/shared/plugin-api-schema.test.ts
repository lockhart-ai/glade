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
  type PluginMessage,
  type PluginTask,
} from './plugin-api'
import { gladeMessageSchema, pluginEventSchema, pluginMessageSchema, pluginTaskSchema } from './plugin-api-schema'

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
    const hello = { type: PluginEventType.Hello, app: { name: 'Glade', version: '0.12.0' } }
    expect(gladeMessageSchema.safeParse({ source: 'glade', apiVersion: 2, seq: 1, event: hello }).success).toBe(false)
    expect(gladeMessageSchema.safeParse({ source: 'glade', apiVersion: 1, seq: 0, event: hello }).success).toBe(false)
    expect(pluginEventSchema.safeParse({ type: 'chat.message', body: 'hi' }).success).toBe(false)
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
