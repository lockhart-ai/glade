// Switching a task's model mid-task, with the SDK's models: the effort falls back to the new model's default when it
// doesn't support the task's, and the session runs on both from the next turn.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Effort, PermissionMode, TaskActivity, type Task } from '../../shared/domain'
import { SDK_MODELS } from '../../shared/test-models'
import { setSdkModels } from '../db/repositories/sdk-models'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { changeTask } from '../tasks/service'
import { FakeAgentBackend, settle } from './fake-backend'
import { createAgentRunner, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let runner: AgentRunner

beforeEach(() => {
  database = openTestDatabase()
  setSdkModels(database.db, SDK_MODELS)
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  task = updateTask(database.db, task.id, { model: 'default', effort: Effort.Max })
  backend = new FakeAgentBackend()
  runner = createAgentRunner({ db: database.db, emit: () => undefined, backend })
})

afterEach(() => {
  runner.close()
  database.close()
})

function change(patch: Parameters<typeof changeTask>[2]): Task {
  return changeTask({ db: database.db, emit: () => undefined, runner }, task.id, patch)
}

it('switches model while the agent works: the next turn runs on it, at its default effort', async () => {
  runner.send(task.id, 'Find out why the login test is flaky.')
  backend.session.emit(sdk.init())
  await settle()
  expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)

  expect(change({ model: 'sonnet' })).toMatchObject({ model: 'sonnet', effort: Effort.High })
  // Mid-turn, the session keeps what it has.
  expect(backend.session.configured).toEqual([])

  backend.session.emit(sdk.result('Two tests are flaky.'))
  await settle()
  runner.send(task.id, 'Fix them.')

  expect(backend.sessions).toHaveLength(1)
  expect(backend.session.sent.map(({ settings }) => settings)).toEqual([
    { model: 'default', effort: Effort.Max, permissionMode: PermissionMode.AllowAll },
    { model: 'sonnet', effort: Effort.High, permissionMode: PermissionMode.AllowAll },
  ])
})

it('keeps the effort on a model that takes none, and runs the next model that does at it', async () => {
  runner.send(task.id, 'Hi')
  backend.session.emit(sdk.init(), sdk.result('Hello.'))
  await settle()

  change({ model: 'haiku' })
  runner.send(task.id, 'Quick one.')
  backend.session.emit(sdk.result('Done.'))
  await settle()
  change({ model: 'opus[1m]' })
  runner.send(task.id, 'Now a hard one.')

  expect(backend.session.sent.map(({ settings }) => [settings.model, settings.effort])).toEqual([
    ['default', Effort.Max],
    ['haiku', Effort.Max],
    ['opus[1m]', Effort.Max],
  ])
})

it('retries on another model at its default effort when it doesn’t support the task’s', async () => {
  runner.send(task.id, 'Find out why the login test is flaky.')
  backend.session.emit(sdk.init(), sdk.result('Hmm.'))
  await settle()
  updateTask(database.db, task.id, { activity: TaskActivity.Error })

  const retried = runner.retry(task.id, 'lite')

  expect(retried).toMatchObject({ model: 'lite', effort: Effort.Low })
  expect(backend.session.sent.at(-1)?.settings).toEqual({
    model: 'lite',
    effort: Effort.Low,
    permissionMode: PermissionMode.AllowAll,
  })
})
