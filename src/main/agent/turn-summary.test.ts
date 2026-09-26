import { describe, expect, it } from 'vitest'
import { DividerKind, ToolCallState, ToolEventKind, type ToolEvent, type ToolInput } from '../../shared/domain'
import { lineChanges, summarizeTurn } from './turn-summary'

let nextId = 0

function call(name: string, input: ToolInput, state = ToolCallState.Done, parentToolUseId: string | null = null) {
  nextId += 1
  const id = `call-${String(nextId)}`
  return {
    kind: ToolEventKind.ToolCall,
    id,
    taskId: 't1',
    turn: 1,
    createdAt: 1_000,
    name,
    input,
    output: state === ToolCallState.Running ? null : 'ok',
    state,
    finishedAt: null,
    toolUseId: id,
    parentToolUseId,
    progressSummary: null,
  } satisfies ToolEvent
}

describe('lineChanges', () => {
  it('counts the lines a diff adds and removes', () => {
    expect(lineChanges('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
    expect(lineChanges('one line', 'one line\ntwo\nthree')).toEqual({ added: 2, removed: 0 })
    expect(lineChanges('x\ny', 'x')).toEqual({ added: 0, removed: 1 })
    expect(lineChanges('a\nb\nc\n', 'a\n')).toEqual({ added: 0, removed: 2 })
    expect(lineChanges('same', 'same')).toEqual({ added: 0, removed: 0 })
  })

  it('counts every line of new text as added', () => {
    expect(lineChanges('', 'x\ny\nz\n')).toEqual({ added: 3, removed: 0 })
    expect(lineChanges('', 'x\ny')).toEqual({ added: 2, removed: 0 })
    expect(lineChanges('', '')).toEqual({ added: 0, removed: 0 })
  })
})

describe('summarizeTurn', () => {
  it('is the duration and no changes for a turn without edits', () => {
    const events: ToolEvent[] = [
      { kind: ToolEventKind.Divider, id: 'd', taskId: 't1', turn: 1, createdAt: 1, dividerKind: DividerKind.Turn },
      {
        kind: ToolEventKind.Narration,
        id: 'n',
        taskId: 't1',
        turn: 1,
        createdAt: 1,
        text: 'Reading.',
        parentToolUseId: null,
      },
      call('Read', { file_path: 'src/date.ts' }),
      call('Bash', { command: 'npm test' }),
    ]
    expect(summarizeTurn({ startedAt: 2_000, finishedAt: 10_000 }, events)).toEqual({
      durationMs: 8_000,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    })
  })

  it('is wall-clock time from the start to the finish, unknown without a start, and never negative', () => {
    // Say the app quit mid-turn and resumed it an hour later: the whole span counts.
    expect(summarizeTurn({ startedAt: 1_000, finishedAt: 3_601_000 }, []).durationMs).toBe(3_600_000)
    expect(summarizeTurn({ startedAt: null, finishedAt: 5_000 }, [])).toEqual({
      durationMs: null,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    })
    expect(summarizeTurn({ startedAt: 5_000, finishedAt: 4_000 }, []).durationMs).toBe(0)
  })

  it('counts each editing tool, and distinct paths', () => {
    const events = [
      call('Edit', { file_path: 'src/date.ts', old_string: 'a', new_string: 'b\nc' }),
      call('Edit', { file_path: 'src/date.ts', old_string: 'x\ny', new_string: 'x', replace_all: true }),
      call('MultiEdit', {
        file_path: 'src/report.ts',
        edits: [
          { old_string: 'one', new_string: 'uno' },
          { old_string: 'two', new_string: 'two\ndos' },
        ],
      }),
      call('MultiEdit', { file_path: 'src/empty.ts', edits: [] }),
      call('Write', { file_path: 'test/date.test.ts', content: 'l1\nl2\nl3\n' }),
      call('NotebookEdit', { notebook_path: 'notes.ipynb', cell_id: 'c1', new_source: 'print(1)\nprint(2)' }),
      call('NotebookEdit', { notebook_path: 'notes.ipynb', cell_id: 'c2', edit_mode: 'delete' }),
    ]
    // Edit: +2 −1, +0 −1. MultiEdit: +1 −1, +1 −0. Write: +3. NotebookEdit: +2.
    expect(summarizeTurn({ startedAt: 0, finishedAt: 1_000 }, events)).toEqual({
      durationMs: 1_000,
      filesChanged: 5,
      linesAdded: 9,
      linesRemoved: 3,
    })
  })

  it("counts subagents' edits, but not edits that failed, never finished or aren't well formed", () => {
    const events = [
      call('Write', { file_path: 'a.ts', content: 'a\n' }, ToolCallState.Done, 'agent-1'),
      call('Write', { file_path: 'b.ts', content: 'b\n' }, ToolCallState.Error),
      call('Write', { file_path: 'c.ts', content: 'c\n' }, ToolCallState.Running),
      call('Edit', { file_path: 'd.ts' }),
      call('MultiEdit', { file_path: 'e.ts', edits: 'nope' }),
      call('constructor', { file_path: 'f.ts' }),
    ]
    expect(summarizeTurn({ startedAt: 0, finishedAt: 1_000 }, events)).toEqual({
      durationMs: 1_000,
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 0,
    })
  })
})
