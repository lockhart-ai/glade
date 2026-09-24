import { describe, expect, it } from 'vitest'
import { EventType } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { applyEvent, idFromUiState } from './reducer'
import { INITIAL_DATA, type GladeData } from './state'
import { sampleTask, sampleWorkspace } from './test-bridge'

const state: GladeData = Object.freeze({
  ...INITIAL_DATA,
  workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
  tasks: { t1: sampleTask('t1', 'w1') },
})

describe('applyEvent', () => {
  it('records a uiState.changed entry and the workspace selection it holds', () => {
    const entry = { key: UiStateKey.ActiveWorkspaceId, value: 'w2' }

    const next = applyEvent(state, { type: EventType.UiStateChanged, entry })

    expect(next.uiState).toEqual({ [UiStateKey.ActiveWorkspaceId]: 'w2' })
    expect(next.selectedWorkspaceId).toBe('w2')
    expect(next.selectedTaskId).toBeNull()
    expect(state.uiState).toEqual({})
  })

  it('records a uiState.changed entry for the selected task, with the empty string as no selection', () => {
    const selected = applyEvent(state, {
      type: EventType.UiStateChanged,
      entry: { key: UiStateKey.SelectedTaskId, value: 't1' },
    })
    expect(selected.selectedTaskId).toBe('t1')

    const cleared = applyEvent(selected, {
      type: EventType.UiStateChanged,
      entry: { key: UiStateKey.SelectedTaskId, value: '' },
    })
    expect(cleared.selectedTaskId).toBeNull()
    expect(cleared.uiState).toEqual({ [UiStateKey.SelectedTaskId]: '' })
  })

  it('replaces an updated workspace in place', () => {
    const renamed = { ...sampleWorkspace('w1'), name: 'Acme Web' }

    const next = applyEvent(state, { type: EventType.WorkspaceUpdated, workspace: renamed })

    expect(next.workspaces).toEqual([renamed, sampleWorkspace('w2')])
    expect(state.workspaces[0]?.name).toBe('Acme API')
  })

  it('appends a new workspace', () => {
    const added = sampleWorkspace('w3')

    expect(applyEvent(state, { type: EventType.WorkspaceUpdated, workspace: added }).workspaces).toEqual([
      sampleWorkspace('w1'),
      sampleWorkspace('w2'),
      added,
    ])
  })

  it('adds or replaces an updated task by id', () => {
    const renamed = { ...sampleTask('t1', 'w1'), title: 'Add caching' }
    const added = sampleTask('t2', 'w2')

    const next = applyEvent(applyEvent(state, { type: EventType.TaskUpdated, task: renamed }), {
      type: EventType.TaskUpdated,
      task: added,
    })

    expect(next.tasks).toEqual({ t1: renamed, t2: added })
    expect(state.tasks).toEqual({ t1: sampleTask('t1', 'w1') })
  })
})

describe('idFromUiState', () => {
  it('reads the empty string as no selection', () => {
    expect(idFromUiState('')).toBeNull()
    expect(idFromUiState('t1')).toBe('t1')
  })
})
