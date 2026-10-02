import { describe, expect, it } from 'vitest'
import { FolderEntryKind, type FolderEntry } from '../../shared/browse'
import {
  isTreeKey,
  resultParts,
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
