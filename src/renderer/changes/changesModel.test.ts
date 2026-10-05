import { describe, expect, it } from 'vitest'
import { CommitFileStatus } from '../../shared/domain'
import {
  additionsLabel,
  branchLabel,
  deletionsLabel,
  filePathLabel,
  madeByTitle,
  moreFilesLabel,
  shortHash,
  statusLetter,
  statusName,
  UNKNOWN_SUBAGENT,
} from './changesModel'

describe('a commit’s tile', () => {
  it('shows its hash short, and its lines added and removed', () => {
    expect(shortHash('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678')).toBe('a1b2c3d')
    expect(additionsLabel(12)).toBe('+12')
    expect(additionsLabel(1204)).toBe('+1,204')
    expect(deletionsLabel(3)).toBe('−3')
  })

  it('names its branch, or says it was made on a detached HEAD', () => {
    expect(branchLabel({ branch: 'fix/date-test' })).toBe('fix/date-test')
    expect(branchLabel({ branch: null })).toBe('detached')
  })

  it('says which subagent made it, in its tag’s tooltip', () => {
    expect(madeByTitle('fix-501')).toBe('Made by the subagent “fix-501”')
    expect(UNKNOWN_SUBAGENT).toBe('Subagent')
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
