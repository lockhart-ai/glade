import { faFolder } from '@fortawesome/free-regular-svg-icons'
import { faChevronDown, faListUl, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { TaskCommit, ToolEvent } from '../../shared/domain'
import { fileName, parseCommitFileKey } from '../../shared/files'
import { shortHash } from '../changes/changesModel'
import { WindowCommandId } from '../../shared/commands'
import { isCommandKey, useCommand, useKeymap } from '../commands/hooks'
import {
  Icon,
  IconSize,
  Menu,
  MenuAnchorKind,
  MenuEntryKind,
  useToast,
  type MenuEntry,
  type MenuItem,
} from '../components'
import { classNames } from '../components/classNames'
import { ContextMenu, fileTabMenu, useContextMenu, useMenuCommands } from '../context-menus'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { BrowseTab } from './BrowseTab'
import { FileViewer, type FileVersion } from './FileViewer'
import { isChanged, touchedCount, touchedFiles, touchOfFile, type TouchedFile, type TouchedFiles } from './filesModel'
import type { OpenFileEdit } from './unsaved'
import styles from './FilesTab.module.css'

export interface FilesTabProps {
  taskId: string
  /** The task's workspace root, which the agent's file paths are relative to. */
  rootPath: string
  /** The latest line the agent asked to show (`show_file`), marked while its file shows; null for none. */
  focus: FileLineFocus | null
}

const NO_TOOL_EVENTS: readonly ToolEvent[] = []
const NO_PATHS: readonly string[] = []
const NO_COMMITS: readonly TaskCommit[] = []
const NO_EDITS: Readonly<Record<string, OpenFileEdit>> = {}

/** A line of a file to mark, asked for by the agent's `show_file`. */
export interface FileLineFocus {
  /** Relative to the workspace root. */
  readonly path: string
  /** From 1; null for none. */
  readonly line: number | null
  /** Goes up with every request, so showing the same line again scrolls to it again. */
  readonly request: number
}

/** The dropdown's entries: the files the agent changed, then the ones it read, each under its heading. */
function menuEntries(touched: TouchedFiles, open: (path: string) => void): MenuEntry[] {
  const items = (files: readonly TouchedFile[]): MenuItem[] =>
    files.map(({ path }) => ({
      kind: MenuEntryKind.Item,
      label: path,
      onSelect: () => {
        open(path)
      },
    }))
  const entries: MenuEntry[] = []
  if (touched.changed.length > 0)
    entries.push({ kind: MenuEntryKind.Heading, label: 'Changed' }, ...items(touched.changed))
  if (touched.read.length > 0) entries.push({ kind: MenuEntryKind.Heading, label: 'Read' }, ...items(touched.read))
  return entries
}

/** A file's absolute path, from the workspace root and its path relative to it. */
export function absolutePath(rootPath: string, path: string): string {
  return `${rootPath.replace(/\/+$/, '')}/${path}`
}

/**
 * The right panel's Files tab (`docs/design/html/08-open-file.html`): a row with the list of the files the agent
 * changed or read, the fixed Browse tab (`36-browse-files.html`) and a tab for each file open, with a blue dot on the
 * ones it changed; under it, the file showing, or the workspace's tree while Browse shows (no file is showing). ⌘F,
 * with the focus in the tab while Browse shows, puts the focus in its search (the editor's own ⌘F finds in the file).
 * The open files are the task's, kept in main. Open file in editor (⌘⇧E) opens the file showing in your editor. When the agent shows a file
 * (`show_file`), it opens here (main opens it), marked at `focus`'s line. A file tab's context menu closes it or the
 * others, opens it in your editor or Finder, and copies its path.
 */
export function FilesTab({ taskId, rootPath, focus }: FilesTabProps): React.JSX.Element {
  const events = useGladeStore((state) => state.toolEvents[taskId]) ?? NO_TOOL_EVENTS
  const paths = useGladeStore((state) => state.openFiles[taskId]?.paths) ?? NO_PATHS
  const commits = useGladeStore((state) => state.commits[taskId]) ?? NO_COMMITS
  const activePath = useGladeStore((state) => state.openFiles[taskId]?.activePath) ?? null
  const openFile = useGladeStore((state) => state.openFile)
  const closeFile = useGladeStore((state) => state.closeFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const revealFile = useGladeStore((state) => state.revealFile)
  const saveFile = useGladeStore((state) => state.saveFile)
  const showBrowse = useGladeStore((state) => state.showBrowse)
  const edits = useGladeStore((state) => state.fileEdits[taskId]) ?? NO_EDITS
  const toast = useToast()
  const menu = useContextMenu<string>()
  const { run, copy, hints } = useMenuCommands()
  const touched = useMemo(() => touchedFiles(events, rootPath), [events, rootPath])
  // The list button, while its menu is open.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const searchField = useRef<HTMLInputElement>(null)
  const keymap = useKeymap()
  const changed = useMemo(() => new Set(touched.changed.map(({ path }) => path)), [touched])

  // A file as a commit left it is only in git: there's no file to open in your editor.
  useCommand(
    WindowCommandId.OpenInEditor,
    activePath === null || parseCommitFileKey(activePath) !== null
      ? null
      : () => {
          void openInEditor(taskId, activePath)
        },
  )

  // Save file (⌘S) saves the file showing; a failure says why, and the edits stay.
  useCommand(
    WindowCommandId.SaveFile,
    activePath === null || parseCommitFileKey(activePath) !== null
      ? null
      : () => {
          saveFile({ taskId, path: activePath }).catch((error: unknown) => {
            toast.show({ message: `Couldn’t save ${fileName(activePath)}: ${describeFailure(error)}` })
          })
        },
  )

  const open = (path: string): void => {
    void openFile(taskId, path)
  }

  const count = touchedCount(touched)
  const browsing = activePath === null

  // ⌘F while Browse shows searches the workspace's files rather than the tasks.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!browsing || !isCommandKey(WindowCommandId.SearchTasks, keymap, event.nativeEvent)) return
    event.preventDefault()
    event.stopPropagation()
    searchField.current?.focus()
    searchField.current?.select()
  }

  const focused = focus !== null && focus.path === activePath ? focus : null

  // Closes the tabs one by one, in order: each close shows the next tab, as closing it by hand would. Cancelling the
  // prompt about a file's unsaved edits stops there.
  const closeAll = (closing: readonly string[]): void => {
    run(async () => {
      for (const path of closing) if (!(await closeFile(taskId, path))) return
    })
  }
  const tabMenu = (path: string) => {
    const fromCommit = parseCommitFileKey(path)
    return fileTabMenu(
      {
        close: () => {
          closeAll([path])
        },
        closeOthers: () => {
          closeAll(paths.filter((other) => other !== path))
        },
        closeAll: () => {
          closeAll(paths)
        },
        // A file as a commit left it is only in git: no file to open, reveal or give the path of.
        openInEditor:
          fromCommit === null
            ? () => {
                run(() => openInEditor(taskId, path))
              }
            : null,
        reveal:
          fromCommit === null
            ? () => {
                run(() => revealFile(taskId, path))
              }
            : null,
        copyPath:
          fromCommit === null
            ? () => {
                copy(absolutePath(rootPath, path))
              }
            : null,
        copyRelativePath: () => {
          copy(fromCommit?.path ?? path)
        },
      },
      hints,
    )
  }

  /** A file as a commit left it: its path, and the commit's short hash, when the task still has the commit. */
  const versionOf = (path: string): FileVersion | null => {
    const fromCommit = parseCommitFileKey(path)
    if (fromCommit === null) return null
    const commit = commits.find(({ id }) => id === fromCommit.commitId)
    return { path: fromCommit.path, hash: commit === undefined ? null : shortHash(commit.hash) }
  }
  const activeVersion = activePath === null ? null : versionOf(activePath)

  return (
    <div className={styles.files} onKeyDown={onKeyDown}>
      <div className={styles.row}>
        <button
          type="button"
          aria-label="All files in this task"
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          disabled={count === 0}
          className={styles.list}
          onClick={(event) => {
            setMenuAnchor(event.currentTarget)
          }}
        >
          <Icon icon={faListUl} size={IconSize.Small} />
          {count}
          <Icon icon={faChevronDown} size={IconSize.Small} />
        </button>
        <Menu
          label="Files in this task"
          entries={menuEntries(touched, open)}
          anchor={{ kind: MenuAnchorKind.Element, element: menuAnchor }}
          open={menuAnchor !== null}
          onClose={() => {
            setMenuAnchor(null)
          }}
        />
        <button
          type="button"
          aria-label="Browse files"
          title="Browse files"
          aria-pressed={browsing}
          className={classNames(styles.browse, browsing && styles.active)}
          onClick={() => void showBrowse(taskId)}
        >
          <Icon icon={faFolder} size={IconSize.Small} />
        </button>
        <div className={styles.tabs} role="group" aria-label="Open files">
          {paths.map((path) => {
            const fromCommit = versionOf(path)
            const name = fileName(fromCommit?.path ?? path)
            const active = path === activePath
            const unsaved = edits[path]?.unsaved === true
            return (
              <div
                key={path}
                className={classNames(styles.tab, active && styles.active)}
                title={fromCommit === null ? path : `${fromCommit.path} (${fromCommit.hash ?? 'a commit'})`}
                data-unsaved={unsaved ? true : undefined}
                {...menu.targetProps(path)}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  className={styles.select}
                  onClick={() => {
                    open(path)
                  }}
                >
                  {isChanged(touched, path) && (
                    <span className={styles.changed} role="img" aria-label="Changed by the agent" />
                  )}
                  <span className={styles.name}>{name}</span>
                  {fromCommit?.hash != null && <span className={styles.version}>{fromCommit.hash}</span>}
                </button>
                {/* Unsaved edits show as a dot in place of the cross, as a Mac shows an edited document's; hovering shows the cross. */}
                <button
                  type="button"
                  aria-label={unsaved ? `Close ${name} (unsaved edits)` : `Close ${name}`}
                  title={unsaved ? 'Unsaved edits · Close (⌘W)' : 'Close (⌘W)'}
                  className={styles.close}
                  onClick={() => void closeFile(taskId, path)}
                >
                  {unsaved && <span className={styles.unsaved} />}
                  <Icon icon={faXmark} size={IconSize.Small} className={styles.cross} />
                </button>
              </div>
            )
          })}
        </div>
        <ContextMenu label="File actions" state={menu} entries={tabMenu} />
      </div>
      {/* Kept while a file shows, so its search, open folders and place are there to come back to. */}
      <div className={styles.browsePane} hidden={!browsing}>
        <BrowseTab key={taskId} taskId={taskId} changed={changed} searchField={searchField} />
      </div>
      {activePath !== null && (
        <FileViewer
          key={activePath}
          taskId={taskId}
          path={activePath}
          fromCommit={activeVersion}
          touched={touchOfFile(touched, activePath)}
          focusLine={focused?.line ?? null}
          focusRequest={focused?.request ?? 0}
        />
      )}
    </div>
  )
}
