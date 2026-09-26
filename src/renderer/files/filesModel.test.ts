import { describe, expect, it } from 'vitest'
import { DividerKind, ToolCallState, ToolEventKind, type ToolCallEvent, type ToolEvent } from '../../shared/domain'
import { FileTouch, formatSize, isChanged, isMarkdown, touchedCount, touchedFiles, touchOfFile } from './filesModel'

const ROOT = '/code/acme-api'

function call(id: string, name: string, input: Record<string, unknown>, overrides: Partial<ToolCallEvent> = {}) {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: Number(id.replace(/\D/g, '')) * 1000,
    kind: ToolEventKind.ToolCall,
    name,
    input,
    output: 'ok',
    state: ToolCallState.Done,
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  } satisfies ToolCallEvent
}

const EVENTS: ToolEvent[] = [
  { id: 'd1', taskId: 't1', turn: 1, createdAt: 0, kind: ToolEventKind.Divider, dividerKind: DividerKind.Turn },
  call('c1', 'Read', { file_path: `${ROOT}/docs/rate-limits.md` }),
  call('c2', 'Read', { file_path: `${ROOT}/api/views.py` }),
  call('c3', 'Edit', { file_path: `${ROOT}/docs/rate-limits.md`, old_string: 'a', new_string: 'b' }),
  call('c4', 'Write', { file_path: 'api/throttles.py', content: 'x' }),
  call('c5', 'MultiEdit', { file_path: `${ROOT}/config/settings.py`, edits: [] }),
  call('c6', 'NotebookEdit', { notebook_path: `${ROOT}/analysis.ipynb` }, { parentToolUseId: 'use-agent' }),
  call('c7', 'Read', { file_path: `${ROOT}/api/views.py` }),
  // Not counted: other tools, calls still running or failed, files outside the workspace, and input without a path.
  call('c8', 'Grep', { pattern: 'throttle', path: `${ROOT}/api` }),
  call('c9', 'Edit', { file_path: `${ROOT}/api/urls.py` }, { state: ToolCallState.Running, output: null }),
  call('c10', 'Write', { file_path: `${ROOT}/api/models.py` }, { state: ToolCallState.Error }),
  call('c11', 'Read', { file_path: '/etc/hosts' }),
  call('c12', 'Read', { path: `${ROOT}/README.md` }),
  {
    id: 'n1',
    taskId: 't1',
    turn: 1,
    createdAt: 0,
    kind: ToolEventKind.Narration,
    text: 'Reading the views.',
    parentToolUseId: null,
  },
]

describe('touchedFiles', () => {
  it('lists the files the agent changed, then the ones it only read, by path relative to the root', () => {
    const touched = touchedFiles(EVENTS, ROOT)

    expect(touched.changed.map(({ path }) => path)).toEqual([
      'analysis.ipynb',
      'api/throttles.py',
      'config/settings.py',
      'docs/rate-limits.md',
    ])
    expect(touched.read.map(({ path }) => path)).toEqual(['api/views.py'])
    expect(touchedCount(touched)).toBe(5)
  })

  it('keeps when, and by which call, each file was last touched', () => {
    const touched = touchedFiles(EVENTS, ROOT)

    expect(touchOfFile(touched, 'docs/rate-limits.md')).toEqual({
      touch: FileTouch.Changed,
      file: { path: 'docs/rate-limits.md', at: 3000, eventId: 'c3' },
    })
    expect(touchOfFile(touched, 'api/views.py')).toEqual({
      touch: FileTouch.Read,
      file: { path: 'api/views.py', at: 7000, eventId: 'c7' },
    })
    expect(touchOfFile(touched, 'README.md')).toBeUndefined()
    expect(isChanged(touched, 'api/throttles.py')).toBe(true)
    expect(isChanged(touched, 'api/views.py')).toBe(false)
  })

  it('is empty for a task with no file tools', () => {
    expect(touchedFiles([], ROOT)).toEqual({ changed: [], read: [] })
  })
})

describe('isMarkdown', () => {
  it('knows Markdown by its extension', () => {
    expect(['README.md', 'docs/guide.MARKDOWN', 'page.mdx'].map(isMarkdown)).toEqual([true, true, true])
    expect(isMarkdown('md/notes.txt')).toBe(false)
  })
})

describe('formatSize', () => {
  it('says bytes, KB or MB', () => {
    expect(formatSize(1)).toBe('1 byte')
    expect(formatSize(812)).toBe('812 bytes')
    expect(formatSize(48 * 1024 + 100)).toBe('48 KB')
    expect(formatSize(2.4 * 1024 * 1024)).toBe('2.4 MB')
  })
})
