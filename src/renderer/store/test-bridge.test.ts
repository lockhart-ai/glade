import { expect, it, vi } from 'vitest'
import { BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { BroadcastDelivery } from '../../shared/broadcast'
import { PermissionDecisionKind, TaskActivity, TaskState, UiStateKey } from '../../shared/domain'
import { fakeBridge, samplePermissionRequest, sampleTask } from './test-bridge'

it('answers uiState.get from its data, and stops delivering events once unsubscribed', async () => {
  const entry = { key: UiStateKey.ActiveWorkspaceId, value: 'w1' }
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [entry] })
  const listener = vi.fn()
  const unsubscribe = fake.bridge.subscribe(listener)

  await expect(fake.bridge.invoke(CommandName.UiStateGet, { key: entry.key })).resolves.toEqual({ value: 'w1' })
  await expect(fake.bridge.invoke(CommandName.UiStateGet, { key: UiStateKey.SelectedTaskId })).resolves.toEqual({
    value: null,
  })
  unsubscribe()
  fake.emit({ type: EventType.UiStateChanged, entry })

  expect(listener).not.toHaveBeenCalled()
  expect(fake.listenerCount()).toBe(0)
})

it('sends a batch whole to a subscriber with a batch listener, and event by event to one without', () => {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] })
  const whole = { listener: vi.fn(), batchListener: vi.fn() }
  const each = vi.fn()
  fake.bridge.subscribe(whole.listener, whole.batchListener)
  fake.bridge.subscribe(each)
  const first = { type: EventType.TaskUpdated, task: sampleTask('t1', 'w1') } as const
  const second = { type: EventType.TaskUpdated, task: sampleTask('t2', 'w1') } as const

  fake.emitBatch([first, second])

  expect(whole.batchListener.mock.calls).toEqual([[[first, second]]])
  expect(whole.listener).not.toHaveBeenCalled()
  expect(each.mock.calls).toEqual([[first], [second]])
})

it('broadcasts to every active task as one batch: to an idle one’s chat, to a busy one’s queue', async () => {
  const idle = { ...sampleTask('t1', 'w1'), sessionId: 's1' }
  const working = { ...sampleTask('t2', 'w1'), activity: TaskActivity.Working }
  const asking = { ...sampleTask('t3', 'w2'), sessionId: 's3', asking: true }
  const awaiting = { ...sampleTask('t4', 'w2'), sessionId: 's4', awaitingPermission: true }
  const done = { ...sampleTask('t5', 'w2'), sessionId: 's5', state: TaskState.Done }
  // Never given anything: it has no agent, so it gets nothing.
  const untouched = sampleTask('t6', 'w2')
  const tasks = [idle, working, asking, awaiting, done, untouched]
  const fake = fakeBridge({ workspaces: [], tasks, uiState: [], messages: [] })
  const listener = vi.fn()
  const batchListener = vi.fn()
  fake.bridge.subscribe(listener, batchListener)

  const { recipients } = await fake.bridge.invoke(CommandName.TasksBroadcast, { text: 'Is anyone restarting Docker?' })

  expect(recipients).toEqual([
    { taskId: 't1', delivery: BroadcastDelivery.Sent },
    { taskId: 't2', delivery: BroadcastDelivery.Queued },
    { taskId: 't3', delivery: BroadcastDelivery.Queued },
    { taskId: 't4', delivery: BroadcastDelivery.Queued },
  ])
  expect(listener).not.toHaveBeenCalled()
  expect(batchListener).toHaveBeenCalledOnce()
  expect(batchListener.mock.calls[0]?.[0]).toMatchObject([
    { type: EventType.MessageAppended, message: { taskId: 't1', broadcast: true } },
    { type: EventType.QueueChanged, taskId: 't2', queuedMessages: [{ broadcast: true }] },
    { type: EventType.QueueChanged, taskId: 't3', queuedMessages: [{ broadcast: true }] },
    { type: EventType.QueueChanged, taskId: 't4', queuedMessages: [{ broadcast: true }] },
  ])
})

it('refuses to delete a task it does not have', async () => {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] })

  await expect(fake.bridge.invoke(CommandName.TasksDelete, { id: 'missing' })).rejects.toMatchObject({
    code: BridgeErrorCode.NotFound,
  })
})

it('refuses to answer a permission request, since it has none', async () => {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] })
  const decision = { kind: PermissionDecisionKind.AllowOnce } as const

  await expect(fake.bridge.invoke(CommandName.PermissionsAnswer, { id: 'p1', decision })).rejects.toMatchObject({
    code: BridgeErrorCode.NotFound,
  })
})

it('refuses Allow for this task on a request it isn’t offered for, as main does, and grants it on one it is', async () => {
  const bare = { ...samplePermissionRequest('p1', 't1'), suggestions: [] }
  const fake = fakeBridge({
    workspaces: [],
    tasks: [],
    uiState: [],
    permissionRequests: [bare, samplePermissionRequest('p2', 't1')],
  })
  const decision = { kind: PermissionDecisionKind.AllowForTask } as const

  await expect(fake.bridge.invoke(CommandName.PermissionsAnswer, { id: 'p1', decision })).rejects.toMatchObject({
    code: BridgeErrorCode.InvalidRequest,
  })
  await expect(fake.bridge.invoke(CommandName.PermissionsAnswer, { id: 'p2', decision })).resolves.toMatchObject({
    permissionRequest: { grantedRule: { toolName: 'Bash', ruleContent: 'npm test *' } },
  })
})

it('refuses to reveal a workspace it does not have', async () => {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] })

  await expect(fake.bridge.invoke(CommandName.WorkspacesReveal, { id: 'missing' })).rejects.toMatchObject({
    code: BridgeErrorCode.NotFound,
  })
})

it('answers dialog.chooseFolder as if cancelled', async () => {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] })

  await expect(fake.bridge.invoke(CommandName.DialogChooseFolder, {})).resolves.toEqual({ path: null })
})

it("answers tasks.list with every one of the workspace's tasks, done ones too", async () => {
  const done = { ...sampleTask('d', 'w1'), state: TaskState.Done }
  const fake = fakeBridge({ workspaces: [], tasks: [sampleTask('a', 'w1'), done, sampleTask('x', 'w2')], uiState: [] })

  const { tasks } = await fake.bridge.invoke(CommandName.TasksList, { workspaceId: 'w1' })

  expect(tasks.map(({ id }) => id)).toEqual(['a', 'd'])
})
