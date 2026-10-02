import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faFileCode, faFileImage, faFileLines, faFolder, faFolderOpen } from '@fortawesome/free-regular-svg-icons'
import { faChevronDown, faChevronRight, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { normalizeQuery, type FileSearchResult, type FolderEntry } from '../../shared/browse'
import { fileTileKind, FileTileKind } from '../artifacts/artifactsModel'
import { Icon, IconSize, Input } from '../components'
import { classNames } from '../components/classNames'
import { Marked } from '../search/Highlight'
import { useGladeStoreApi } from '../store/react'
import {
  isFolder,
  isTreeKey,
  resultParts,
  shownFolders,
  treeKeyAction,
  TreeActionKind,
  unloadedFolders,
  visibleRows,
  type BrowseTree,
  type TreeRow,
} from './browseModel'
import styles from './BrowseTab.module.css'

/** How long typing in the search waits for more before it searches, in milliseconds. */
export const SEARCH_WAIT_MS = 120

const NUMBER = new Intl.NumberFormat('en-US')

export interface BrowseTabProps {
  readonly taskId: string
  /** The files the agent changed, by path: their rows have the blue dot. */
  readonly changed: ReadonlySet<string>
  /** The search field, which ⌘F (with the focus in the Files tab) puts the focus in. */
  readonly searchField: RefObject<HTMLInputElement | null>
}

/** A search's results, and the search they're for (as `normalizeQuery` has it). */
interface Results extends FileSearchResult {
  readonly query: string
}

function fileIcon(path: string): IconDefinition {
  switch (fileTileKind(path)) {
    case FileTileKind.Image:
      return faFileImage
    case FileTileKind.Code:
      return faFileCode
    case FileTileKind.Text:
      return faFileLines
  }
}

function entryIcon(entry: FolderEntry, expanded: boolean): IconDefinition {
  if (!isFolder(entry)) return fileIcon(entry.path)
  return expanded ? faFolderOpen : faFolder
}

/** The design's indent: 8px in from the panel, and 16px more for each folder down. */
function indentOf(depth: number): number {
  return 8 + depth * 16
}

/**
 * The Files tab's Browse tab (`docs/design/html/36-browse-files.html`): the workspace's tree, folders first, loaded a
 * folder at a time as you open them, with the folders you leave open kept for the task; and a search that finds
 * files by name or path anywhere in the workspace. Clicking a file, or ↩ on it, opens it in a tab. The folders it
 * shows are watched, so what the agent makes or deletes shows at once.
 */
export function BrowseTab({ taskId, changed, searchField }: BrowseTabProps): React.JSX.Element {
  const store = useGladeStoreApi()
  const listId = useId()
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null)
  const [folders, setFolders] = useState<ReadonlyMap<string, readonly FolderEntry[]>>(new Map())
  const [focused, setFocused] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [active, setActive] = useState(0)
  // The latest listing asked for, by folder: an older answer that arrives after it is dropped.
  const requests = useRef(new Map<string, number>())
  const rowElements = useRef(new Map<string, HTMLElement>())

  const tree: BrowseTree = useMemo(() => ({ expanded: expanded ?? new Set(), folders }), [expanded, folders])
  const rows = useMemo(() => (expanded === null ? [] : visibleRows(tree)), [expanded, tree])
  const searching = normalizeQuery(query)

  /** Lists a folder (again), keeping the answer only if it's the latest asked for. A folder that went shows empty. */
  const load = useCallback(
    (path: string): void => {
      const request = (requests.current.get(path) ?? 0) + 1
      requests.current.set(path, request)
      const keep = (entries: readonly FolderEntry[]): void => {
        if (requests.current.get(path) !== request) return
        setFolders((current) => new Map(current).set(path, entries))
      }
      store
        .getState()
        .listFolder(taskId, path)
        .then(
          (entries) => {
            keep(entries ?? [])
          },
          () => {
            keep([])
          },
        )
    },
    [store, taskId],
  )

  // The folders left open, as the task last had them.
  useEffect(() => {
    let current = true
    store
      .getState()
      .expandedFolders(taskId)
      .then(
        (paths) => {
          if (current) setExpanded(new Set(paths))
        },
        () => {
          if (current) setExpanded(new Set())
        },
      )
    return () => {
      current = false
    }
  }, [store, taskId])

  // Each folder that shows is loaded once it shows; one already asked for isn't asked for again here.
  const unloaded = unloadedFolders(tree, rows)
  const unloadedKey = expanded === null ? null : unloaded.join('\0')
  useEffect(() => {
    if (unloadedKey === null) return
    for (const path of unloadedKey.split('\0')) if (!requests.current.has(path)) load(path)
  }, [unloadedKey, load])

  // A folder that shows changed on disk: it's listed again.
  useEffect(
    () =>
      store.getState().subscribeFolderChanges((changedTask, path) => {
        if (changedTask === taskId && requests.current.has(path)) load(path)
      }),
    [store, taskId, load],
  )

  // The folders that show are watched while the tab is there.
  const watchedKey = expanded === null ? null : shownFolders(rows).join('\0')
  useEffect(() => {
    if (watchedKey === null) return
    void store
      .getState()
      .watchFolders(taskId, watchedKey.split('\0'))
      .catch(() => undefined)
  }, [store, taskId, watchedKey])
  useEffect(
    () => () => {
      void store
        .getState()
        .watchFolders(taskId, [])
        .catch(() => undefined)
    },
    [store, taskId],
  )

  // A search waits for a pause in typing; an answer for an older search is dropped.
  useEffect(() => {
    // No search: the tree shows, and results kept from before are for another search, so never show.
    if (searching === '') return
    let current = true
    const timer = setTimeout(() => {
      store
        .getState()
        .searchFiles(taskId, searching)
        .then(
          (found) => {
            if (!current) return
            setResults({ ...found, query: searching })
            setActive(0)
          },
          () => {
            if (current) setResults({ paths: [], more: 0, query: searching })
          },
        )
    }, SEARCH_WAIT_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [store, taskId, searching])

  const open = (path: string): void => {
    void store.getState().openFile(taskId, path)
  }

  const toggle = (path: string): void => {
    if (expanded === null) return
    const opening = !expanded.has(path)
    const next = new Set(expanded)
    if (opening) next.add(path)
    else next.delete(path)
    setExpanded(next)
    // Opened again, a folder is listed afresh: it wasn't watched while it was closed.
    if (opening) load(path)
    void store
      .getState()
      .setFolderExpanded(taskId, path, opening)
      .catch(() => undefined)
  }

  const focusRow = (path: string): void => {
    setFocused(path)
    rowElements.current.get(path)?.focus()
  }

  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !isTreeKey(event.key)) return
    const action = treeKeyAction(rows, focused, event.key)
    event.preventDefault()
    if (action === null) return
    switch (action.kind) {
      case TreeActionKind.Focus:
        focusRow(action.path)
        return
      case TreeActionKind.FocusSearch:
        searchField.current?.focus()
        return
      case TreeActionKind.Toggle:
        setFocused(action.path)
        toggle(action.path)
        return
      case TreeActionKind.Open:
        open(action.path)
        return
    }
  }

  const shownResults = results !== null && results.query === searching ? results : null
  const activePath = shownResults?.paths[Math.min(active, shownResults.paths.length - 1)]

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'Escape':
        if (query === '') return
        event.preventDefault()
        event.stopPropagation()
        setQuery('')
        return
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        if (searching === '') {
          if (event.key === 'ArrowDown') {
            const first = rows.find(({ entry }) => entry.path === focused) ?? rows[0]
            if (first !== undefined) focusRow(first.entry.path)
          }
          return
        }
        const count = shownResults?.paths.length ?? 0
        if (count === 0) return
        setActive((at) => Math.min(Math.max(at + (event.key === 'ArrowDown' ? 1 : -1), 0), count - 1))
        return
      }
      case 'Enter':
        if (activePath === undefined) return
        event.preventDefault()
        open(activePath)
        return
    }
  }

  // The row the tree's Tab stop is on: the one with the focus, or the first.
  const tabStop = rows.some(({ entry }) => entry.path === focused) ? focused : (rows[0]?.entry.path ?? null)

  const treeRow = ({ entry, depth, expanded: isOpen }: TreeRow): React.JSX.Element => {
    const folder = isFolder(entry)
    return (
      <div
        key={entry.path}
        ref={(element) => {
          if (element === null) rowElements.current.delete(entry.path)
          else rowElements.current.set(entry.path, element)
        }}
        role="treeitem"
        aria-level={depth + 1}
        aria-label={entry.name}
        aria-expanded={folder ? isOpen : undefined}
        aria-selected={entry.path === focused}
        tabIndex={entry.path === tabStop ? 0 : -1}
        title={entry.path}
        className={classNames(styles.row, entry.path === focused && styles.focused)}
        style={{ paddingLeft: indentOf(depth) }}
        onFocus={() => {
          setFocused(entry.path)
        }}
        onClick={() => {
          setFocused(entry.path)
          if (folder) toggle(entry.path)
          else open(entry.path)
        }}
      >
        <span className={styles.chevron}>
          {folder && <Icon icon={isOpen ? faChevronDown : faChevronRight} size={IconSize.Small} />}
        </span>
        <span className={classNames(styles.icon, folder && styles.folderIcon)}>
          <Icon icon={entryIcon(entry, isOpen)} size={IconSize.Small} />
        </span>
        <span className={styles.name}>{entry.name}</span>
        {!folder && changed.has(entry.path) && (
          <span className={styles.changed} role="img" aria-label="Changed by the agent" />
        )}
      </div>
    )
  }

  const resultRow = (path: string, index: number): React.JSX.Element => {
    const parts = resultParts(path, searching)
    return (
      <div
        key={path}
        id={`${listId}-${String(index)}`}
        role="option"
        aria-selected={path === activePath}
        title={path}
        className={classNames(styles.row, styles.result, path === activePath && styles.focused)}
        onMouseDown={(event) => {
          // The focus stays in the search field.
          event.preventDefault()
        }}
        onClick={() => {
          setActive(index)
          open(path)
        }}
      >
        <span className={styles.icon}>
          <Icon icon={fileIcon(path)} size={IconSize.Small} />
        </span>
        <span className={styles.name}>
          <Marked parts={parts.name} />
        </span>
        {parts.folder.length > 0 && (
          <span className={styles.folder}>
            <Marked parts={parts.folder} />
          </span>
        )}
      </div>
    )
  }

  const listing = (): React.JSX.Element | null => {
    if (searching !== '') {
      if (shownResults === null) return null
      if (shownResults.paths.length === 0) return <p className={styles.empty}>No files match.</p>
      return (
        <>
          <div className={styles.heading}>
            <span>Results</span>
            <span>{NUMBER.format(shownResults.paths.length + shownResults.more)}</span>
          </div>
          <div className={styles.list} role="listbox" id={listId} aria-label="Matching files">
            {shownResults.paths.map(resultRow)}
            {shownResults.more > 0 && <p className={styles.more}>{NUMBER.format(shownResults.more)} more…</p>}
          </div>
        </>
      )
    }
    if (expanded === null || !folders.has('')) return null
    if (rows.length === 0) return <p className={styles.empty}>No files here yet.</p>
    return (
      <div className={styles.list} role="tree" aria-label="Workspace files" onKeyDown={onTreeKeyDown}>
        {rows.map(treeRow)}
      </div>
    )
  }

  const activeIndex = activePath === undefined ? -1 : (shownResults?.paths.indexOf(activePath) ?? -1)
  return (
    <div
      className={styles.browse}
      aria-busy={searching === '' ? expanded === null || unloaded.length > 0 : shownResults === null}
    >
      <div className={styles.search}>
        <Input
          ref={searchField}
          type="search"
          role="combobox"
          label="Search files"
          placeholder="Search files"
          icon={faMagnifyingGlass}
          aria-expanded={shownResults !== null && shownResults.paths.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex === -1 ? undefined : `${listId}-${String(activeIndex)}`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          onKeyDown={onSearchKeyDown}
        />
      </div>
      {listing()}
    </div>
  )
}
