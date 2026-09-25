import { expect, it, vi } from 'vitest'
import { BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { PermissionDecisionKind, TaskState, UiStateKey } from '../../shared/domain'
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
