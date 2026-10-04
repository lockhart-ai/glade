import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  PermissionMarkKind,
  ToolCallState,
  ToolEventKind,
  type PermissionMark,
  type ToolCallEvent,
} from '../../../shared/domain'
import { NO_PERMISSION_LINES, PermissionLineState } from '../../permissions/permissionLineModel'
import { samplePermissionRequest, sampleTask, sampleWorkspace } from '../../store/test-bridge'
import { subagentsByToolUse } from '../../subagents/subagentsModel'
import { hubAgent } from '../test-hub'
import { permissionLinesOf, rootPathOfTask, sameShownSubagent, subagentIn, useSameSelector } from './subagentLog'

vi.mock('../../subagents/subagentsModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../subagents/subagentsModel')>()
  return { ...original, subagentsByToolUse: vi.fn(original.subagentsByToolUse) }
})

function did(id: string, parent: string, fields: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: 1,
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: { file_path: '/code/api/views.py' },
    output: 'ok',
    state: ToolCallState.Done,
    finishedAt: 2,
    toolUseId: `use-${id}`,
    parentToolUseId: parent,
    progressSummary: null,
    ...fields,
  }
}

describe('permissionLinesOf', () => {
  it('gives the same lines for the same requests and marks, and makes them anew when either list changes', () => {
    const request = { ...samplePermissionRequest('p1', 't1'), toolUseId: 'use-read' }
    const requests = [request]
    const lines = permissionLinesOf(requests)

    expect(lines.get('use-read')?.state).toBe(PermissionLineState.Waiting)
    expect(permissionLinesOf(requests)).toBe(lines)
    expect(permissionLinesOf([request])).not.toBe(lines)

    const marks: PermissionMark[] = [
      { taskId: 't1', toolUseId: 'use-edit', outcome: { kind: PermissionMarkKind.Blocked, ask: null }, createdAt: 1 },
    ]
    const marked = permissionLinesOf(requests, marks)
    expect(marked).not.toBe(lines)
    expect([...marked.keys()].sort()).toEqual(['use-edit', 'use-read'])
    expect(permissionLinesOf(requests, marks)).toBe(marked)
  })

  it('has no lines for a task with no requests and no marks', () => {
    expect(permissionLinesOf()).toBe(NO_PERMISSION_LINES)
    expect(permissionLinesOf(undefined, undefined)).toBe(NO_PERMISSION_LINES)
  })
})

describe('subagentIn', () => {
  const events = [hubAgent('a', 'first'), did('read', 'a'), hubAgent('b', 'second')]

  it('finds a subagent with its log, working a task’s subagents out once per log however many tiles ask', () => {
    vi.mocked(subagentsByToolUse).mockClear()

    const first = subagentIn(events, 'a', '/code/api', NO_PERMISSION_LINES)
    expect(first?.name).toBe('first')
    expect(first?.log).toHaveLength(1)
    expect(subagentIn(events, 'b', '/code/api', NO_PERMISSION_LINES)?.name).toBe('second')
    expect(subagentIn(events, 'a', '/code/api', NO_PERMISSION_LINES)).toBe(first)
    expect(subagentIn(events, 'gone', '/code/api', NO_PERMISSION_LINES)).toBeUndefined()
    expect(subagentsByToolUse).toHaveBeenCalledTimes(1)
  })

  it('works them out again for a new log, another workspace root or other permission lines', () => {
    const before = subagentIn(events, 'a', '/code/api', NO_PERMISSION_LINES)
    vi.mocked(subagentsByToolUse).mockClear()

    expect(subagentIn([...events], 'a', '/code/api', NO_PERMISSION_LINES)).not.toBe(before)
    expect(subagentIn(events, 'a', '/code', NO_PERMISSION_LINES)?.latest).toMatchObject({ argument: 'api/views.py' })
    const lines = new Map([['use-read', { state: PermissionLineState.Waiting as const, subject: null }]])
    expect(subagentIn(events, 'a', '/code', lines)?.log[0]).toMatchObject({ permission: { subject: null } })
    expect(subagentsByToolUse).toHaveBeenCalledTimes(3)
  })

  it('finds nothing in a task whose log isn’t loaded', () => {
    expect(subagentIn(undefined, 'a', undefined, NO_PERMISSION_LINES)).toBeUndefined()
  })
})

describe('rootPathOfTask', () => {
  it('is the root of the workspace the task is in, and nothing for a task that isn’t loaded', () => {
    const state = {
      tasks: { t1: sampleTask('t1', 'w2') },
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
    }
    expect(rootPathOfTask(state, 't1')).toBe('/code/w2')
    expect(rootPathOfTask(state, 't9')).toBeUndefined()
  })
})

describe('sameShownSubagent', () => {
  it('tells a subagent made anew from the same call and log from one whose log grew', () => {
    const events = [hubAgent('a', 'first'), did('read', 'a')]
    const shown = subagentIn(events, 'a', undefined, NO_PERMISSION_LINES)
    const anew = subagentIn([...events], 'a', undefined, NO_PERMISSION_LINES)
    const grown = subagentIn([...events, did('more', 'a')], 'a', undefined, NO_PERMISSION_LINES)

    expect(anew).not.toBe(shown)
    expect(sameShownSubagent(shown, anew)).toBe(true)
    expect(sameShownSubagent(shown, grown)).toBe(false)
    expect(sameShownSubagent(undefined, undefined)).toBe(true)
    expect(sameShownSubagent(shown, undefined)).toBe(false)
    expect(sameShownSubagent(undefined, shown)).toBe(false)
  })
})

describe('useSameSelector', () => {
  it('answers with the value it gave before while the new one shows the same', () => {
    const { result } = renderHook(() =>
      useSameSelector(
        (state: { readonly words: readonly string[] }) => state.words.map((word) => word.toUpperCase()),
        (a, b) => a.join() === b.join(),
      ),
    )
    const first = result.current({ words: ['a', 'b'] })

    expect(first).toEqual(['A', 'B'])
    expect(result.current({ words: ['a', 'b'] })).toBe(first)
    const changed = result.current({ words: ['a', 'c'] })
    expect(changed).toEqual(['A', 'C'])
    expect(result.current({ words: ['a', 'c'] })).toBe(changed)
  })
})
