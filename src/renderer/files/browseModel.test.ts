import { describe, expect, it } from 'vitest'
import { FolderEntryKind, type FolderEntry } from '../../shared/browse'
import {
  formatSize,
  isOnSelectedPath,
  isTreeKey,
  MAX_EXTENSION_LENGTH,
  nameParts,
  NAME_TAIL_LENGTH,
  resultParts,
  rowGuides,
  shownFolders,
  treeKeyAction,
  TreeActionKind,
  TreeKey,
  unloadedFolders,
  visibleRows,
  type BrowseTree,
} from './browseModel'

function folder(path: string): FolderEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: FolderEntryKind.Folder }
}

function file(path: string): FolderEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: FolderEntryKind.File }
}

const FOLDERS = new Map<string, readonly FolderEntry[]>([
  ['', [folder('api'), folder('docs'), file('README.md')]],
  ['api', [folder('api/tests'), file('api/throttles.py')]],
  ['api/tests', [file('api/tests/test_throttles.py')]],
  ['docs', []],
])

function tree(expanded: readonly string[], folders = FOLDERS): BrowseTree {
  return { expanded: new Set(expanded), folders }
}

/** The rows as `depth path` with `+` for an open folder. */
function shown(browse: BrowseTree): string[] {
  return visibleRows(browse).map(
    ({ entry, depth, expanded }) => `${String(depth)} ${entry.path}${expanded ? ' +' : ''}`,
  )
}

describe('visibleRows', () => {
  it('shows the root’s entries, and each open folder’s under it once loaded', () => {
    expect(shown(tree([]))).toEqual(['0 api', '0 docs', '0 README.md'])
    expect(shown(tree(['api', 'api/tests', 'docs']))).toEqual([
      '0 api +',
      '1 api/tests +',
      '2 api/tests/test_throttles.py',
      '1 api/throttles.py',
      '0 docs +',
      '0 README.md',
    ])
    // A folder open under a closed one doesn't show; nor one whose entries haven't loaded.
    expect(shown(tree(['api/tests']))).toEqual(['0 api', '0 docs', '0 README.md'])
    expect(shown(tree(['api', 'api/tests'], new Map([...FOLDERS].filter(([path]) => path !== 'api/tests'))))).toEqual([
      '0 api +',
      '1 api/tests +',
      '1 api/throttles.py',
      '0 docs',
      '0 README.md',
    ])
    expect(shown(tree(['api'], new Map()))).toEqual([])
  })
})

describe('shownFolders and unloadedFolders', () => {
  it('name the root and every open folder that shows, and those of them not loaded yet', () => {
    const partly = tree(
      ['api', 'api/tests', 'docs', 'config'],
      new Map([...FOLDERS].filter(([path]) => path !== 'docs')),
    )
    const rows = visibleRows(partly)
    expect(shownFolders(rows)).toEqual(['', 'api', 'api/tests', 'docs'])
    expect(unloadedFolders(partly, rows)).toEqual(['docs'])
    expect(unloadedFolders(tree([], new Map()), [])).toEqual([''])
  })
})

describe('treeKeyAction', () => {
  const rows = visibleRows(tree(['api', 'api/tests', 'docs']))
  const act = (focused: string | null, key: TreeKey) => treeKeyAction(rows, focused, key)

  it('moves the focus up and down, to the ends, and up into the search from the top row', () => {
    expect(act(null, TreeKey.Down)).toEqual({ kind: TreeActionKind.Focus, path: 'api' })
    expect(act('api', TreeKey.Down)).toEqual({ kind: TreeActionKind.Focus, path: 'api/tests' })
    expect(act('README.md', TreeKey.Down)).toBeNull()
    expect(act('api/tests', TreeKey.Up)).toEqual({ kind: TreeActionKind.Focus, path: 'api' })
    expect(act('api', TreeKey.Up)).toEqual({ kind: TreeActionKind.FocusSearch })
    expect(act('gone', TreeKey.Up)).toEqual({ kind: TreeActionKind.FocusSearch })
    expect(act('docs', TreeKey.Home)).toEqual({ kind: TreeActionKind.Focus, path: 'api' })
    expect(act('api', TreeKey.End)).toEqual({ kind: TreeActionKind.Focus, path: 'README.md' })
  })

  it('opens a closed folder with →, goes into an open one, and does nothing on a file or an empty open folder', () => {
    const closed = visibleRows(tree([]))
    expect(treeKeyAction(closed, 'api', TreeKey.Right)).toEqual({ kind: TreeActionKind.Toggle, path: 'api' })
    expect(act('api', TreeKey.Right)).toEqual({ kind: TreeActionKind.Focus, path: 'api/tests' })
    expect(act('docs', TreeKey.Right)).toBeNull()
    expect(act('api/throttles.py', TreeKey.Right)).toBeNull()
  })

  it('closes an open folder with ←, or goes up to the folder a row is in', () => {
    expect(act('api/tests', TreeKey.Left)).toEqual({ kind: TreeActionKind.Toggle, path: 'api/tests' })
    expect(act('api/tests/test_throttles.py', TreeKey.Left)).toEqual({ kind: TreeActionKind.Focus, path: 'api/tests' })
    expect(act('README.md', TreeKey.Left)).toBeNull()
  })

  it('opens a file with ↩, and opens or closes a folder', () => {
    expect(act('api/throttles.py', TreeKey.Enter)).toEqual({ kind: TreeActionKind.Open, path: 'api/throttles.py' })
    expect(act('docs', TreeKey.Enter)).toEqual({ kind: TreeActionKind.Toggle, path: 'docs' })
  })

  it('does nothing in an empty tree', () => {
    expect(treeKeyAction([], null, TreeKey.Down)).toBeNull()
  })

  it('knows the keys it answers', () => {
    expect(isTreeKey('ArrowLeft')).toBe(true)
    expect(isTreeKey('Enter')).toBe(true)
    expect(isTreeKey('a')).toBe(false)
    expect(isTreeKey('Escape')).toBe(false)
  })
})

describe('resultParts', () => {
  it('marks the match in the name, or in the folder, or across the two', () => {
    expect(resultParts('api/tests/test_throttles.py', 'throttle')).toEqual({
      name: [
        { text: 'test_', match: false },
        { text: 'throttle', match: true },
        { text: 's.py', match: false },
      ],
      folder: [{ text: 'api/tests', match: false }],
    })
    expect(resultParts('throttle/README.md', 'throttle')).toEqual({
      name: [{ text: 'README.md', match: false }],
      folder: [{ text: 'throttle', match: true }],
    })
    expect(resultParts('api/tests/test_views.py', 'tests/test')).toEqual({
      name: [
        { text: 'test', match: true },
        { text: '_views.py', match: false },
      ],
      folder: [
        { text: 'api/', match: false },
        { text: 'tests', match: true },
      ],
    })
    expect(resultParts('README.md', 'read')).toEqual({
      name: [
        { text: 'READ', match: true },
        { text: 'ME.md', match: false },
      ],
      folder: [],
    })
    expect(resultParts('README.md', 'nothing')).toEqual({ name: [{ text: 'README.md', match: false }], folder: [] })
  })
})

/** A size as its row reads: the number, a space, the unit. */
function size(bytes: number): string {
  const { value, unit } = formatSize(bytes)
  return `${value} ${unit}`
}

describe('formatSize', () => {
  it('shows whole bytes under 1,000', () => {
    expect(size(0)).toBe('0 B')
    expect(size(1)).toBe('1 B')
    expect(size(348)).toBe('348 B')
    expect(size(872)).toBe('872 B')
    expect(size(999)).toBe('999 B')
  })

  it('shows KB, MB and GB with one decimal under 100, and none from there', () => {
    expect(size(1_000)).toBe('1.0 KB')
    expect(size(1_049)).toBe('1.0 KB')
    expect(size(1_050)).toBe('1.1 KB')
    expect(size(6_800)).toBe('6.8 KB')
    expect(size(18_300)).toBe('18.3 KB')
    expect(size(99_900)).toBe('99.9 KB')
    expect(size(100_000)).toBe('100 KB')
    expect(size(212_000)).toBe('212 KB')
    expect(size(212_499)).toBe('212 KB')
    expect(size(212_500)).toBe('213 KB')
    expect(size(1_400_000)).toBe('1.4 MB')
    expect(size(52_340_000)).toBe('52.3 MB')
    expect(size(640_000_000)).toBe('640 MB')
    expect(size(3_250_000_000)).toBe('3.3 GB')
  })

  it('never shows 100.0, nor 1,000 of a unit: what rounds up moves on', () => {
    // Just under 100 KB rounds to 100, without a decimal.
    expect(size(99_949)).toBe('99.9 KB')
    expect(size(99_950)).toBe('100 KB')
    // Just under 1,000 of a unit rounds into the next.
    expect(size(999_499)).toBe('999 KB')
    expect(size(999_500)).toBe('1.0 MB')
    expect(size(999_999)).toBe('1.0 MB')
    expect(size(1_000_000)).toBe('1.0 MB')
    expect(size(999_500_000)).toBe('1.0 GB')
    expect(size(1_000_000_000)).toBe('1.0 GB')
  })

  it('stays in GB past it', () => {
    expect(size(999_600_000_000)).toBe('1000 GB')
    expect(size(4_200_000_000_000)).toBe('4200 GB')
  })
})

describe('nameParts', () => {
  const file = (name: string): ReturnType<typeof nameParts> => nameParts(name, FolderEntryKind.File)

  it('keeps a long name’s last letters and its extension, so it truncates in the middle', () => {
    const long = 'test_burst_window_resets_after_a_sustained_rate_limit_for_anonymous_and_api_key_clients.py'
    const parts = file(long)

    expect(parts).toEqual({
      head: 'test_burst_window_resets_after_a_sustained_rate_limit_for_anonymous_and_api_key_c',
      tail: 'lients',
      extension: '.py',
    })
    expect(parts.tail).toHaveLength(NAME_TAIL_LENGTH)
    expect(parts.head + parts.tail + parts.extension).toBe(long)
  })

  it('leaves a short name whole before its extension', () => {
    expect(file('throttles.py')).toEqual({ head: 'throttles', tail: '', extension: '.py' })
    expect(file('README.md')).toEqual({ head: 'README', tail: '', extension: '.md' })
    // Exactly twice the tail is still short; one more letter and it splits.
    expect(file('abcdefghijkl.ts')).toEqual({ head: 'abcdefghijkl', tail: '', extension: '.ts' })
    expect(file('abcdefghijklm.ts')).toEqual({ head: 'abcdefg', tail: 'hijklm', extension: '.ts' })
  })

  it('takes what follows the last dot for the extension, but not a dot that starts or ends the name', () => {
    expect(file('archive.tar.gz')).toEqual({ head: 'archive.tar', tail: '', extension: '.gz' })
    expect(file('.gitignore')).toEqual({ head: '.gitignore', tail: '', extension: '' })
    expect(file('.env.local')).toEqual({ head: '.env', tail: '', extension: '.local' })
    expect(file('Dockerfile')).toEqual({ head: 'Dockerfile', tail: '', extension: '' })
    expect(file('trailing.')).toEqual({ head: 'trailing.', tail: '', extension: '' })
    expect(file('')).toEqual({ head: '', tail: '', extension: '' })
  })

  it('takes an ending too long to be an extension for part of the name', () => {
    const longest = `.${'x'.repeat(MAX_EXTENSION_LENGTH - 1)}`
    expect(file(`notes${longest}`)).toEqual({ head: 'notes', tail: '', extension: longest })
    expect(file(`notes${longest}x`)).toEqual({ head: 'notes.xxxxxx', tail: 'xxxxxx', extension: '' })
  })

  it('gives a folder no extension, and still keeps a long one’s end', () => {
    expect(nameParts('v1.2', FolderEntryKind.Folder)).toEqual({ head: 'v1.2', tail: '', extension: '' })
    expect(nameParts('very-long-folder.name', FolderEntryKind.Folder)).toEqual({
      head: 'very-long-folde',
      tail: 'r.name',
      extension: '',
    })
  })

  it('never cuts a character in two', () => {
    const parts = file('notes-📁📁📁📁📁📁📁📁.md')

    expect(parts).toEqual({ head: 'notes-📁📁', tail: '📁📁📁📁📁📁', extension: '.md' })
  })
})

describe('isOnSelectedPath and rowGuides', () => {
  it('counts only the folders the selected row is in', () => {
    expect(isOnSelectedPath('api', 'api/throttles.py')).toBe(true)
    expect(isOnSelectedPath('api', 'api/tests/test_throttles.py')).toBe(true)
    expect(isOnSelectedPath('api/tests', 'api/tests/test_throttles.py')).toBe(true)
    expect(isOnSelectedPath('api/tests', 'api/throttles.py')).toBe(false)
    // Not the selected folder itself, nor one whose name only starts the same.
    expect(isOnSelectedPath('api', 'api')).toBe(false)
    expect(isOnSelectedPath('api', 'api-v2/throttles.py')).toBe(false)
    expect(isOnSelectedPath('api', null)).toBe(false)
  })

  it('gives a row a guide for each folder it’s in, lit for those on the way to the selected row', () => {
    expect(rowGuides('README.md', 'api/throttles.py')).toEqual([])
    expect(rowGuides('api/views.py', 'api/throttles.py')).toEqual([true])
    expect(rowGuides('api/throttles.py', 'api/throttles.py')).toEqual([true])
    expect(rowGuides('api/tests/test_throttles.py', 'api/throttles.py')).toEqual([true, false])
    expect(rowGuides('api/tests/test_throttles.py', 'api/tests/test_throttles.py')).toEqual([true, true])
    expect(rowGuides('web/src/App.tsx', 'api/throttles.py')).toEqual([false, false])
    expect(rowGuides('web/src/App.tsx', null)).toEqual([false, false])
  })
})
