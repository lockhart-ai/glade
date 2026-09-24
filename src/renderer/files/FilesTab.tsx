import { faChevronDown, faListUl, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useMemo, useState } from 'react'
import type { ToolEvent } from '../../shared/domain'
import { fileName } from '../../shared/files'
import { Icon, IconSize, Menu, MenuAnchorKind, MenuEntryKind, type MenuEntry, type MenuItem } from '../components'
import { classNames } from '../components/classNames'
import { ContextMenu, fileTabMenu, useContextMenu, useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'
import { FileViewer } from './FileViewer'
import { isChanged, touchedCount, touchedFiles, touchOfFile, type TouchedFile, type TouchedFiles } from './filesModel'
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

/** A line of a file to mark, asked for by the agent's `show_file`. */
export interface FileLineFocus {
  /** Relative to the workspace root. */
  readonly path: string
  /** From 1; null for none. */
  readonly line: number | null
  /** Goes up with every request, so showing the same line again scrolls to it again. */
  readonly request: number
}

/** Whether a key press is ⌘⇧E, Open in editor. */
export function isOpenInEditorKey(event: KeyboardEvent): boolean {
  return event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey && event.code === 'KeyE'
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
 * changed or read, and a tab for each file open, with a blue dot on the ones it changed; under it, the file showing.
 * The open files are the task's, kept in main. ⌘⇧E opens the file showing in your editor. When the agent shows a file
 * (`show_file`), it opens here (main opens it), marked at `focus`'s line. A file tab's context menu closes it or the
 * others, opens it in your editor or Finder, and copies its path.
 */
export function FilesTab({ taskId, rootPath, focus }: FilesTabProps): React.JSX.Element {
  const events = useGladeStore((state) => state.toolEvents[taskId]) ?? NO_TOOL_EVENTS
  const paths = useGladeStore((state) => state.openFiles[taskId]?.paths) ?? NO_PATHS
  const activePath = useGladeStore((state) => state.openFiles[taskId]?.activePath) ?? null
  const openFile = useGladeStore((state) => state.openFile)
  const closeFile = useGladeStore((state) => state.closeFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const revealFile = useGladeStore((state) => state.revealFile)
  const menu = useContextMenu<string>()
  const { run, copy } = useMenuCommands()
  const touched = useMemo(() => touchedFiles(events, rootPath), [events, rootPath])
  // The list button, while its menu is open.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (activePath === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isOpenInEditorKey(event)) return
      event.preventDefault()
      void openInEditor(taskId, activePath)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [openInEditor, taskId, activePath])

  const open = (path: string): void => {
    void openFile(taskId, path)
  }

  const count = touchedCount(touched)
  if (count === 0 && paths.length === 0) return <p className={styles.empty}>No files yet.</p>

  const focused = focus !== null && focus.path === activePath ? focus : null

  // Closes the tabs one by one, in order: each close shows the next tab, as closing it by hand would.
  const closeAll = (closing: readonly string[]): void => {
    run(async () => {
      for (const path of closing) await closeFile(taskId, path)
    })
  }
  const tabMenu = (path: string) =>
    fileTabMenu({
      close: () => {
        closeAll([path])
      },
      closeOthers: () => {
        closeAll(paths.filter((other) => other !== path))
      },
      closeAll: () => {
        closeAll(paths)
      },
      openInEditor: () => {
        run(() => openInEditor(taskId, path))
      },
      reveal: () => {
        run(() => revealFile(taskId, path))
      },
      copyPath: () => {
        copy(absolutePath(rootPath, path))
      },
      copyRelativePath: () => {
        copy(path)
      },
    })

  return (
    <div className={styles.files}>
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
        <div className={styles.tabs} role="group" aria-label="Open files">
          {paths.map((path) => {
            const name = fileName(path)
            const active = path === activePath
            return (
              <div
                key={path}
                className={classNames(styles.tab, active && styles.active)}
                title={path}
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
                </button>
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  title="Close (⌘W)"
                  className={styles.close}
                  onClick={() => void closeFile(taskId, path)}
                >
                  <Icon icon={faXmark} size={IconSize.Small} />
                </button>
              </div>
            )
          })}
        </div>
        <ContextMenu label="File actions" state={menu} entries={tabMenu} />
      </div>
      {activePath === null ? (
        <p className={styles.empty}>No file open.</p>
      ) : (
        <FileViewer
          key={activePath}
          taskId={taskId}
          path={activePath}
          touched={touchOfFile(touched, activePath)}
          focusLine={focused?.line ?? null}
          focusRequest={focused?.request ?? 0}
        />
      )}
    </div>
  )
}
