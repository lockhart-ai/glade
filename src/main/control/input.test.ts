// Each control tool's input schema, through a real MCP client: a bad input is refused with `invalid_input` naming the
// field, before anything runs.
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Task } from '../../shared/domain'
import { getTask } from '../db/repositories/tasks'
import { sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { ControlErrorCode } from './errors'
import { ControlToolName } from './names'
import {
  connect,
  errorCode,
  errorMessage,
  HTTP,
  startControlApp,
  type ControlApp,
  type ControlClient,
} from './test-control'

let app: ControlApp
let client: ControlClient
let task: Task
let workspaceId: string

beforeEach(async () => {
  app = startControlApp()
  workspaceId = sampleWorkspace(app.database.db).id
  task = sampleTask(app.database.db, workspaceId)
  client = await connect(app.bridge.control.server(HTTP))
})

afterEach(async () => {
  await client.close()
  await app.close()
})

/** A bad input, and what the refusal says of it: the field and why. */
type BadInput = readonly [tool: ControlToolName, input: () => Record<string, unknown>, message: string]

const BAD_INPUTS: readonly BadInput[] = [
  [ControlToolName.ListWorkspaces, () => ({ everything: true }), 'everything: unknown field'],
  [ControlToolName.ListTasks, () => ({ limit: 0 }), 'limit: Too small'],
  [ControlToolName.ListTasks, () => ({ limit: 101 }), 'limit: Too big'],
  [ControlToolName.ListTasks, () => ({ limit: 2.5 }), 'limit: Invalid input: expected int'],
  [ControlToolName.ListTasks, () => ({ state: 'archived' }), 'state: Invalid option'],
  [ControlToolName.ListTasks, () => ({ query: '   ' }), 'query: is empty'],
  [ControlToolName.ListTasks, () => ({ cursor: 'not-a-cursor' }), 'cursor: not a cursor this listing gave'],
  [ControlToolName.ListTasks, () => ({ cursor: '' }), 'cursor: Too small'],
  [ControlToolName.ListTasks, () => ({ workspaceId: 7 }), 'workspaceId: Invalid input: expected string'],
  [ControlToolName.GetTask, () => ({}), 'id: Invalid input: expected string, received undefined'],
  [ControlToolName.GetTask, () => ({ id: ' ' }), 'id: is empty'],
  [ControlToolName.GetTask, () => ({ id: task.id, verbose: true }), 'verbose: unknown field'],
  [ControlToolName.GetChat, () => ({ id: task.id, fromTurn: 0 }), 'fromTurn: Too small'],
  [ControlToolName.GetChat, () => ({ id: task.id, limit: 51 }), 'limit: Too big'],
  [ControlToolName.GetChat, () => ({ id: task.id, includeTools: 'yes' }), 'includeTools: Invalid input'],
  [ControlToolName.CreateTask, () => ({}), 'workspaceId: Invalid input: expected string'],
  [ControlToolName.CreateTask, () => ({ workspaceId, title: '  ' }), 'title: is empty'],
  [ControlToolName.CreateTask, () => ({ workspaceId, message: '' }), 'message: is empty'],
  [ControlToolName.CreateTask, () => ({ workspaceId, model: 'gpt-5' }), 'model: Invalid option'],
  [ControlToolName.CreateTask, () => ({ workspaceId, effort: 'extreme' }), 'effort: Invalid option'],
  [ControlToolName.CreateTask, () => ({ workspaceId, permissionMode: 'yolo' }), 'permissionMode: Invalid option'],
  [ControlToolName.CreateTask, () => ({ workspaceId, start: true }), 'start: unknown field'],
  [ControlToolName.UpdateTask, () => ({ patch: { title: 'x' } }), 'id: Invalid input'],
  [ControlToolName.UpdateTask, () => ({ id: task.id }), 'patch: Invalid input: expected object'],
  [ControlToolName.UpdateTask, () => ({ id: task.id, patch: {} }), 'patch: changes nothing'],
  [ControlToolName.UpdateTask, () => ({ id: task.id, patch: { title: ' ' } }), 'patch.title: is empty'],
  [ControlToolName.UpdateTask, () => ({ id: task.id, patch: { state: 'done' } }), 'patch.state: unknown field'],
  [ControlToolName.UpdateTask, () => ({ id: task.id, patch: { model: 'nope' } }), 'patch.model: Invalid option'],
  [ControlToolName.UpdateTask, () => ({ id: task.id, patch: { pinned: 'yes' } }), 'patch.pinned: Invalid input'],
  [ControlToolName.SendMessage, () => ({ id: task.id }), 'text: Invalid input: expected string'],
  [ControlToolName.SendMessage, () => ({ id: task.id, text: '\n ' }), 'text: is empty'],
  [ControlToolName.SendMessage, () => ({ id: task.id, text: 'Hi', images: [] }), 'images: unknown field'],
  [ControlToolName.StopTask, () => ({}), 'id: Invalid input'],
  [ControlToolName.MarkDone, () => ({ id: '' }), 'id: is empty'],
  [ControlToolName.ReopenTask, () => ({ id: task.id, force: true }), 'force: unknown field'],
  [ControlToolName.DeleteTask, () => ({ confirm: true }), 'id: Invalid input'],
  [ControlToolName.DeleteTask, () => ({ id: task.id, confirm: 'true' }), 'confirm: Invalid input'],
]

it.each(BAD_INPUTS)('%s refuses %j as invalid_input, naming the field', async (tool, input, message) => {
  const before = getTask(app.database.db, task.id)
  const events = app.events.length

  const reply = await client.call(tool, input())

  expect(errorCode(reply)).toBe(ControlErrorCode.InvalidInput)
  expect(errorMessage(reply)).toContain(message)
  // Nothing ran.
  expect(getTask(app.database.db, task.id)).toEqual(before)
  expect(app.events.length).toBe(events)
})

it('names every field that is wrong at once', async () => {
  const reply = await client.call(ControlToolName.ListTasks, { limit: 0, state: 'x', extra: 1, other: 2 })

  expect(errorMessage(reply)).toBe(
    'state: Invalid option: expected one of "active"|"done"|"all"; limit: Too small: expected number to be >=1; ' +
      'extra, other: unknown field',
  )
})

it('trims the text it is given', async () => {
  await client.call(ControlToolName.UpdateTask, { id: task.id, patch: { title: '  Renamed \n' } })

  expect(getTask(app.database.db, task.id)?.title).toBe('Renamed')
})

it('takes no arguments at all as an empty input', async () => {
  const reply = await client.client.callTool({ name: ControlToolName.ListWorkspaces })

  expect(reply.isError).toBeUndefined()
})
