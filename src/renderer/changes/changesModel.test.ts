import { describe, expect, it } from 'vitest'
import { CommitFileStatus, ToolCallState, ToolEventKind, type ToolCallEvent } from '../../shared/domain'
import { sampleCommit } from '../store/test-bridge'
import {
  additionsLabel,
  commitMeta,
  deletionsLabel,
  filePathLabel,
  madeBy,
  moreFilesLabel,
  shortHash,
  statusLetter,
  statusName,
} from './changesModel'

const NOW = new Date(2026, 8, 25, 13, 14).getTime()

function agentCall(toolUseId: string, input: Record<string, unknown>): ToolCallEvent {
  return {
    id: `e-${toolUseId}`,
    taskId: 't1',
    turn: 1,
    createdAt: 1,
    kind: ToolEventKind.ToolCall,
    name: 'Agent',
    input,
    output: null,
    state: ToolCallState.Done,
    finishedAt: null,
    toolUseId,
    parentToolUseId: null,
  }
}

describe('a commit’s row', () => {
  it('shows its hash short, and its lines added and removed', () => {
    expect(shortHash('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe('a1b2c3d')
    expect(additionsLabel(12)).toBe('+12')
    expect(additionsLabel(1204)).toBe('+1,204')
    expect(deletionsLabel(3)).toBe('−3')
  })

  it('says its branch, when, and that it’s a merge', () => {
    expect(commitMeta(sampleCommit('c1', 't1'), NOW)).toBe('fix/date-test · 12m ago')
    expect(commitMeta(sampleCommit('c1', 't1', { branch: null, merge: true, committedAt: NOW }), NOW)).toBe(
      'detached · just now · merge',
    )
  })

  it('names the subagent that made it, from its call in the tool log, and none for the task’s own agent', () => {
    const events = [agentCall('toolu_docs', { description: 'Update the upgrade guide' })]
    expect(madeBy(sampleCommit('c1', 't1'), events)).toBeNull()
    expect(madeBy(sampleCommit('c1', 't1', { subagentToolUseId: 'toolu_docs' }), events)).toBe(
      'Update the upgrade guide',
    )
    expect(madeBy(sampleCommit('c1', 't1', { subagentToolUseId: 'toolu_gone' }), events)).toBe('Subagent')
  })
})

describe('a commit’s files', () => {
  it('show each status as its letter, and in words', () => {
    expect(Object.values(CommitFileStatus).map((status) => [statusLetter(status), statusName(status)])).toEqual([
      ['A', 'Added'],
      ['M', 'Modified'],
      ['D', 'Deleted'],
      ['R', 'Renamed'],
    ])
  })

  it('show a renamed file’s path from and to', () => {
    const file = {
      path: 'docs/upgrading.md',
      oldPath: null,
      status: CommitFileStatus.Modified,
      additions: 1,
      deletions: 0,
    }
    expect(filePathLabel(file)).toBe('docs/upgrading.md')
    expect(filePathLabel({ ...file, oldPath: 'docs/upgrade.md', status: CommitFileStatus.Renamed })).toBe(
      'docs/upgrade.md → docs/upgrading.md',
    )
  })

  it('end a capped list with how many more there are', () => {
    expect(moreFilesLabel(100, 100)).toBeNull()
    expect(moreFilesLabel(100, 101)).toBe('and 1 more file')
    expect(moreFilesLabel(100, 1512)).toBe('and 1,412 more files')
  })
})
