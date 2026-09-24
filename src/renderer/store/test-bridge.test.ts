import { expect, it, vi } from 'vitest'
import { BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { fakeBridge } from './test-bridge'

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
