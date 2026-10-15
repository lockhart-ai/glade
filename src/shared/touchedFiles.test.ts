import { describe, expect, it } from 'vitest'
import { ToolCallState, ToolEventKind, type ToolCallEvent } from './domain'
import { CHANGING_TOOLS } from './files'
import { fileOfCall, mergeTouched, NO_TOUCHED_FILES, touchedFiles, type TouchedFiles } from './touchedFiles'

const ROOT = '/code/acme-api'

function call(name: string, input: Record<string, unknown>, at: number, state = ToolCallState.Done): ToolCallEvent {
  return {
    kind: ToolEventKind.ToolCall,
    id: `e-${name}-${String(at)}`,
    taskId: 't1',
    turn: 1,
    createdAt: at,
    name,
    input,
    output: null,
    state,
    finishedAt: at,
    toolUseId: `u-${name}-${String(at)}`,
    parentToolUseId: null,
    progressSummary: null,
  }
}

describe('fileOfCall', () => {
  it('names the file a changing or reading call works on, relative to the workspace root, and nothing for others', () => {
    expect(fileOfCall({ name: 'Write', input: { file_path: `${ROOT}/src/api.py` } }, ROOT)).toBe('src/api.py')
    expect(fileOfCall({ name: 'Read', input: { file_path: `${ROOT}/src/api.py` } }, ROOT)).toBe('src/api.py')
    expect(fileOfCall({ name: 'Bash', input: { command: 'ls' } }, ROOT)).toBeNull()
    expect(fileOfCall({ name: 'Read', input: { file_path: '/elsewhere/api.py' } }, ROOT)).toBeNull()
  })
})

describe('touchedFiles', () => {
  it('says which files the agent changed and which it only read, from its finished calls, changed over read', () => {
    const events = [
      call('Read', { file_path: `${ROOT}/src/api.py` }, 1),
      call('Write', { file_path: `${ROOT}/src/api.py`, content: '' }, 2),
      call('Edit', { file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b' }, 3),
      call('Read', { file_path: '/elsewhere/other.py' }, 4),
      call('Read', { file_path: `${ROOT}/src/running.py` }, 5, ToolCallState.Running),
      call('Read', { file_path: `${ROOT}/src/failed.py` }, 6, ToolCallState.Error),
    ]

    expect(touchedFiles(events, ROOT)).toEqual({
      changed: [
        { path: 'README.md', at: 3, eventId: 'e-Edit-3' },
        { path: 'src/api.py', at: 2, eventId: 'e-Write-2' },
      ],
      read: [],
    })
    expect(touchedFiles([], ROOT)).toEqual(NO_TOUCHED_FILES)
  })
})

describe('mergeTouched', () => {
  const changed = (path: string, at: number): TouchedFiles => ({
    changed: [{ path, at, eventId: `e-${path}-${String(at)}` }],
    read: [],
  })
  const read = (path: string, at: number): TouchedFiles => ({
    changed: [],
    read: [{ path, at, eventId: `e-${path}-${String(at)}` }],
  })

  it('keeps a file changed by either summary changed, and takes the later touch where they agree', () => {
    // Changed in the whole-history summary, read later in the tail: still changed, as the whole log reads it.
    expect(mergeTouched(changed('src/api.py', 1), read('src/api.py', 2)).changed.map(({ path }) => path)).toEqual([
      'src/api.py',
    ])
    expect(mergeTouched(changed('src/api.py', 1), read('src/api.py', 2)).read).toEqual([])
    // Read in the summary, changed later in the tail: changed by the later call.
    expect(mergeTouched(read('src/api.py', 1), changed('src/api.py', 2)).changed).toEqual([
      { path: 'src/api.py', at: 2, eventId: 'e-src/api.py-2' },
    ])
    // Changed twice: the later change stands.
    expect(mergeTouched(changed('src/api.py', 1), changed('src/api.py', 3)).changed).toEqual([
      { path: 'src/api.py', at: 3, eventId: 'e-src/api.py-3' },
    ])
    // Read on both sides: the later read stands; the other file keeps its own side.
    expect(mergeTouched(read('src/a.py', 1), read('src/b.py', 2))).toEqual({
      changed: [],
      read: [
        { path: 'src/a.py', at: 1, eventId: 'e-src/a.py-1' },
        { path: 'src/b.py', at: 2, eventId: 'e-src/b.py-2' },
      ],
    })
    expect(mergeTouched(NO_TOUCHED_FILES, NO_TOUCHED_FILES)).toEqual(NO_TOUCHED_FILES)
  })
})

describe('CHANGING_TOOLS', () => {
  it('names every tool whose call changes the file it points at', () => {
    expect(Object.keys(CHANGING_TOOLS)).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  })
})
