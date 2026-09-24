// Type-level checks, enforced by `npm run typecheck` (this file is in tsconfig.node.json): the command map is the one
// source of truth, so a request or response that disagrees with it on either side of the bridge fails the typecheck.
// Each `@ts-expect-error` fails the typecheck if its line stops being an error.
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  CommandName,
  EventType,
  type CommandRequest,
  type CommandResponse,
  type GladeBridge,
  type GladeEvent,
} from '../../shared/bridge'
import { UiStateKey, type Task, type UiStateEntry, type Workspace } from '../../shared/domain'
import type { Handlers } from './handlers'
import { REQUEST_SCHEMAS, type RequestSchemas } from './requests'

const noop = (...values: unknown[]): unknown[] => values
/** A stand-in: these tests are about types, so what it answers doesn't matter. */
const glade: GladeBridge = { invoke: () => Promise.resolve({} as never), subscribe: () => noop }

describe('the command map', () => {
  it('types invoke from the map: its request and its response', () => {
    expectTypeOf(glade.invoke(CommandName.WorkspacesList, {})).resolves.toEqualTypeOf<{
      readonly workspaces: readonly Workspace[]
    }>()
    expectTypeOf(glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })).resolves.toEqualTypeOf<{
      readonly value: string | null
    }>()
    expectTypeOf(glade.invoke(CommandName.TasksList, { workspaceId: 'w' })).resolves.toEqualTypeOf<{
      readonly tasks: readonly Task[]
    }>()
    expectTypeOf(glade.invoke(CommandName.UiStateGetAll, {})).resolves.toEqualTypeOf<{
      readonly entries: readonly UiStateEntry[]
    }>()
    expectTypeOf<CommandRequest<CommandName.UiStateSet>>().toEqualTypeOf<UiStateEntry>()
    expectTypeOf(
      glade.invoke(CommandName.UiStateSet, { key: UiStateKey.ActiveWorkspaceId, value: '' }),
    ).resolves.toBeNull()
  })

  it('refuses a renderer call whose request disagrees with the map', () => {
    // @ts-expect-error: the key must be a UiStateKey.
    void glade.invoke(CommandName.UiStateGet, { key: 'theme' })
    // @ts-expect-error: uiState.set needs a value.
    void glade.invoke(CommandName.UiStateSet, { key: UiStateKey.ActiveWorkspaceId })
    // @ts-expect-error: tasks.list needs a workspace id.
    void glade.invoke(CommandName.TasksList, {})
    // @ts-expect-error: uiState.getAll takes no arguments.
    void glade.invoke(CommandName.UiStateGetAll, { key: UiStateKey.ActiveWorkspaceId })
    // @ts-expect-error: workspaces.list takes no arguments.
    void glade.invoke(CommandName.WorkspacesList, { all: true })
    // @ts-expect-error: not a command.
    void glade.invoke('tasks.explode', {})
  })

  it('refuses a renderer that reads a response field the map does not have', async () => {
    const { value } = await glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })
    expectTypeOf(value).toEqualTypeOf<string | null>()
    // @ts-expect-error: uiState.get answers with `value`, not `workspaces`.
    const { workspaces } = await glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })
    noop(workspaces)
  })

  it('refuses a schema registry missing a command, or a schema that disagrees with the map', () => {
    // @ts-expect-error: uiState.set has no schema.
    const missing: RequestSchemas = {
      [CommandName.WorkspacesList]: z.strictObject({}),
      [CommandName.TasksList]: z.strictObject({ workspaceId: z.string() }),
      [CommandName.UiStateGet]: z.strictObject({ key: z.enum(UiStateKey) }),
      [CommandName.UiStateGetAll]: z.strictObject({}),
    }
    const wrong: RequestSchemas = {
      [CommandName.WorkspacesList]: z.strictObject({}),
      [CommandName.TasksList]: z.strictObject({ workspaceId: z.string() }),
      [CommandName.UiStateGetAll]: z.strictObject({}),
      // @ts-expect-error: uiState.get's key is a UiStateKey, not any string.
      [CommandName.UiStateGet]: z.strictObject({ key: z.string() }),
      [CommandName.UiStateSet]: z.strictObject({ key: z.enum(UiStateKey), value: z.string() }),
    }
    noop(missing, wrong)
  })

  it('refuses a handler registry missing a command', () => {
    // @ts-expect-error: uiState.set has no handler.
    const handlers: Handlers = {
      [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
      [CommandName.TasksList]: () => ({ tasks: [] }),
      [CommandName.UiStateGet]: () => ({ value: null }),
      [CommandName.UiStateGetAll]: () => ({ entries: [] }),
    }
    noop(handlers)
  })

  it('refuses a handler whose response disagrees with the map', () => {
    const handlers: Handlers = {
      [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
      [CommandName.TasksList]: () => ({ tasks: [] }),
      [CommandName.UiStateGetAll]: () => ({ entries: [] }),
      // @ts-expect-error: uiState.get answers `{ value }`, not a bare string.
      [CommandName.UiStateGet]: () => 'workspace-1',
      [CommandName.UiStateSet]: () => null,
    }
    noop(handlers)
  })

  it('refuses a handler that reads a request field the map does not have', () => {
    const handlers: Handlers = {
      [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
      [CommandName.TasksList]: () => ({ tasks: [] }),
      [CommandName.UiStateGetAll]: () => ({ entries: [] }),
      // @ts-expect-error: uiState.get's request has `key`, not `name`.
      [CommandName.UiStateGet]: ({ name }) => ({ value: String(name) }),
      [CommandName.UiStateSet]: () => null,
    }
    noop(handlers)
  })

  it('has a request schema for every command that parses to exactly its request interface', () => {
    // Each schema's output and its request interface are assignable both ways: no field missing, none extra.
    type Matches<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    type SchemaMatches = {
      [C in CommandName]: Matches<z.output<(typeof REQUEST_SCHEMAS)[C]>, CommandRequest<C>>
    }
    expectTypeOf<SchemaMatches[CommandName]>().toEqualTypeOf<true>()
    expectTypeOf<keyof typeof REQUEST_SCHEMAS>().toEqualTypeOf<CommandName>()
    expectTypeOf<keyof Handlers>().toEqualTypeOf<CommandName>()
    expectTypeOf<Awaited<ReturnType<Handlers[CommandName.UiStateGet]>>>().toEqualTypeOf<
      CommandResponse<CommandName.UiStateGet>
    >()
  })
})

describe('events', () => {
  it('narrows an event by its type', () => {
    glade.subscribe((event) => {
      expectTypeOf(event).toEqualTypeOf<GladeEvent>()
      switch (event.type) {
        case EventType.UiStateChanged:
          expectTypeOf(event.entry).toEqualTypeOf<UiStateEntry>()
          break
        case EventType.WorkspaceUpdated:
          expectTypeOf(event.workspace).toEqualTypeOf<Workspace>()
          break
        case EventType.TaskUpdated:
          expectTypeOf(event.task).toEqualTypeOf<Task>()
          break
      }
    })
  })
})
