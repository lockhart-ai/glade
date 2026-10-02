import { describe, expect, it } from 'vitest'
import {
  childPath,
  compareNames,
  FolderEntryKind,
  isHiddenPath,
  matchPath,
  MatchRank,
  normalizeQuery,
  parentPath,
  rankMatches,
  sortEntries,
} from './browse'

describe('compareNames', () => {
  it('orders names without regard to case or accents, numbers by their value, and keeps a fixed order for ties', () => {
    const names = ['file10.md', 'README.md', 'file2.md', 'éclair.md', 'readme.md', 'apple.md', 'Zeta.md']
    expect([...names].sort(compareNames)).toEqual([
      'apple.md',
      'éclair.md',
      'file2.md',
      'file10.md',
      'README.md',
      'readme.md',
      'Zeta.md',
    ])
    expect(compareNames('a', 'a')).toBe(0)
  })
})

describe('sortEntries', () => {
  it('puts folders first, then files, each by name', () => {
    const entry = (name: string, kind: FolderEntryKind) => ({ name, path: name, kind })
    expect(
      sortEntries([
        entry('b.md', FolderEntryKind.File),
        entry('src', FolderEntryKind.Folder),
        entry('A.md', FolderEntryKind.File),
        entry('docs', FolderEntryKind.Folder),
      ]).map(({ name }) => name),
    ).toEqual(['docs', 'src', 'A.md', 'b.md'])
  })
})

describe('paths', () => {
  it('joins and splits a folder and a name, with the root as an empty path', () => {
    expect(childPath('', 'api')).toBe('api')
    expect(childPath('api/tests', 'test_views.py')).toBe('api/tests/test_views.py')
    expect(parentPath('api')).toBe('')
    expect(parentPath('api/tests/test_views.py')).toBe('api/tests')
  })

  it('knows a path through .git or .glade is hidden, and nothing else', () => {
    expect(isHiddenPath('.git')).toBe(true)
    expect(isHiddenPath('vendor/.git/config')).toBe(true)
    expect(isHiddenPath('.glade/state.json')).toBe(true)
    expect(isHiddenPath('.github/workflows/ci.yml')).toBe(false)
    expect(isHiddenPath('docs/.gitignore')).toBe(false)
  })
})

describe('matchPath', () => {
  it('matches without regard to case, in the file name first, then anywhere in the path', () => {
    const query = normalizeQuery('  Throttle ')
    expect(query).toBe('throttle')
    expect(matchPath('api/throttles.py', query)).toEqual({ start: 4, end: 12, rank: MatchRank.NameStart })
    expect(matchPath('api/tests/test_THROTTLES.py', query)).toEqual({ start: 15, end: 23, rank: MatchRank.Name })
    // The name's match counts, not an earlier one in the folders.
    expect(matchPath('throttle/old_throttle.py', query)).toEqual({ start: 13, end: 21, rank: MatchRank.Name })
    expect(matchPath('throttle/README.md', query)).toEqual({ start: 0, end: 8, rank: MatchRank.Path })
    expect(matchPath('api/tests/', 'api/te')).toEqual({ start: 0, end: 6, rank: MatchRank.Path })
    expect(matchPath('docs/upgrading.md', query)).toBeNull()
    expect(matchPath('docs/upgrading.md', '')).toBeNull()
  })
})

describe('rankMatches', () => {
  it('lists what matches best first: names that start with it, then names that hold it, then paths; each by path', () => {
    expect(
      rankMatches(
        [
          'throttle/README.md',
          'scripts/throttle_report.sh',
          'api/tests/test_throttles.py',
          'api/throttles.py',
          'docs/upgrading.md',
          'api/migrations/0004_throttle_scopes.py',
        ],
        'throttle',
      ),
    ).toEqual([
      'api/throttles.py',
      'scripts/throttle_report.sh',
      'api/migrations/0004_throttle_scopes.py',
      'api/tests/test_throttles.py',
      'throttle/README.md',
    ])
  })
})
