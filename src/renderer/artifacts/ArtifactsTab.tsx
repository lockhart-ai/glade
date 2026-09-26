import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faFileCode, faFileImage, faFileLines, faFolder } from '@fortawesome/free-regular-svg-icons'
import { faArrowUpRightFromSquare, faChevronDown, faChevronRight, faEllipsis } from '@fortawesome/free-solid-svg-icons'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  FileThumbnailKind,
  type Artifact,
  type ArtifactDateGroup,
  type ArtifactGroupFold,
  type EpochMs,
  type FileThumbnail,
} from '../../shared/domain'
import { Button, ButtonVariant, Collapse, Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import {
  artifactMenu,
  ContextMenu,
  useContextMenu,
  useMenuCommands,
  type ContextMenuTargetProps,
} from '../context-menus'
import { absolutePath } from '../files/FilesTab'
import { useGladeStore } from '../store/react'
import { formatFullDate } from '../task-header/headerModel'
import {
  artifactTime,
  fileTileKind,
  FileTileKind,
  fileTypeName,
  formatArtifactAge,
  groupArtifacts,
} from './artifactsModel'
import { dateGroupTitle, isGroupOpen } from './dateGroups'
import styles from './ArtifactsTab.module.css'

/** What the tab shows while the agent has declared no artifacts. */
export const NO_ARTIFACTS = 'No artifacts yet.'

const NO_ARTIFACT_LIST: readonly Artifact[] = []
const NO_FOLDS: readonly ArtifactGroupFold[] = []

/** A row's height, as the design has it (`.row` in ArtifactsTab.module.css). */
const ROW_HEIGHT = 40
/** The space between rows (`--space-2xs`). */
const ROW_GAP = 2
/** How many rows to render past each edge of what shows, so a quick scroll doesn't flash empty space. */
const OVERSCAN = 8

/** How far down the page an element is laid out, whatever is scrolled: its offsets up to the top. */
function layoutTop(element: HTMLElement): number {
  let top = 0
  for (let at: Element | null = element; at instanceof HTMLElement; at = at.offsetParent) top += at.offsetTop
  return top
}

function tileIcon(path: string): IconDefinition {
  switch (fileTileKind(path)) {
    case FileTileKind.Image:
      return faFileImage
    case FileTileKind.Code:
      return faFileCode
    case FileTileKind.Text:
      return faFileLines
  }
}

interface ArtifactRowProps {
  readonly artifact: Artifact
  readonly now: EpochMs
  /** Whether it's the file the Files tab shows: the row is outlined. */
  readonly selected: boolean
  /** What opens its context menu: a right-click, or ⇧F10 while it (or one of its buttons) has the focus. */
  readonly menuTarget: ContextMenuTargetProps
  /** Opens its context menu below its More button. */
  readonly onMore: (path: string, button: HTMLElement) => void
}

/**
 * One artifact, in one 40px row: a thumbnail of an image (once main has made it), or its type's tile, then its title,
 * its type and how long ago its file changed. Hovered or focused, the age gives way to Open, Reveal in folder and More
 * (its context menu). Clicking it opens the file in the Files tab. A file that's gone shows muted, as missing, and
 * can't be opened or revealed.
 */
const ArtifactRow = memo(function ArtifactRow({
  artifact,
  now,
  selected,
  menuTarget,
  onMore,
}: ArtifactRowProps): React.JSX.Element {
  const { taskId, path, title, modifiedAt, missing: gone } = artifact
  const fileThumbnail = useGladeStore((state) => state.fileThumbnail)
  const showFile = useGladeStore((state) => state.showFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const [thumbnail, setThumbnail] = useState<FileThumbnail>()
  // The thumbnail that has loaded, which shows.
  const [loaded, setLoaded] = useState<string | null>(null)
  const [looks, setLooks] = useState(0)

  // Look at the file (again) when the row shows, when it changes, and after an action on it failed.
  useEffect(() => {
    let current = true
    void fileThumbnail(taskId, path).then(
      (next) => {
        if (current) setThumbnail(next)
      },
      () => {
        if (current) setThumbnail({ kind: FileThumbnailKind.None })
      },
    )
    return () => {
      current = false
    }
  }, [fileThumbnail, taskId, path, modifiedAt, gone, looks])

  const lookAgain = useCallback(() => {
    setLooks((count) => count + 1)
  }, [])

  const missing = gone || thumbnail?.kind === FileThumbnailKind.Missing
  const image = thumbnail?.kind === FileThumbnailKind.Image ? thumbnail.dataUrl : null
  const time = artifactTime(artifact)
  const open = (): void => {
    void showFile(taskId, path).catch(lookAgain)
  }

  return (
    <div
      className={classNames(styles.row, selected && styles.selected, missing && styles.missing)}
      aria-label={title}
      aria-current={selected || undefined}
      // Busy until its file has been looked at, and its thumbnail has loaded: a capture waits for it.
      aria-busy={thumbnail === undefined || (image !== null && loaded !== image)}
      role="listitem"
      {...menuTarget}
    >
      <button type="button" className={styles.open} title={path} disabled={missing} onClick={open}>
        {image !== null ? (
          <span className={styles.tile}>
            <img
              className={styles.thumbnail}
              src={image}
              alt=""
              draggable={false}
              onLoad={() => {
                setLoaded(image)
              }}
              // One the window can't draw shows the type's tile.
              onError={() => {
                setThumbnail({ kind: FileThumbnailKind.None })
              }}
            />
          </span>
        ) : (
          <span className={classNames(styles.tile, styles.blank)}>
            <Icon icon={tileIcon(path)} size={IconSize.Medium} />
          </span>
        )}
        <span className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.type}>{missing ? `${fileTypeName(path)} · missing` : fileTypeName(path)}</span>
        </span>
        <span className={styles.age} title={formatFullDate(time)}>
          {formatArtifactAge(time, now)}
        </span>
      </button>
      <span className={styles.actions}>
        <Button
          variant={ButtonVariant.Icon}
          className={styles.action}
          icon={faArrowUpRightFromSquare}
          aria-label="Open"
          title="Open"
          disabled={missing}
          onClick={open}
        />
        <Button
          variant={ButtonVariant.Icon}
          className={styles.action}
          icon={faFolder}
          aria-label="Reveal in folder"
          title="Reveal in folder"
          disabled={missing}
          onClick={() => void revealFile(taskId, path).catch(lookAgain)}
        />
        <Button
          variant={ButtonVariant.Icon}
          className={styles.action}
          icon={faEllipsis}
          aria-label="More"
          aria-haspopup="menu"
          title="More"
          onClick={(event) => {
            onMore(path, event.currentTarget)
          }}
        />
      </span>
    </div>
  )
})

interface GroupRowsProps {
  readonly listId: string
  readonly artifacts: readonly Artifact[]
  /** The tab's scroller, which the rows scroll in; null until it's mounted. */
  readonly scroller: HTMLElement | null
  readonly row: (artifact: Artifact) => React.ReactNode
}

/**
 * A group's rows, which can run to hundreds: only those in or near view are rendered (`@tanstack/react-virtual`), each
 * in its place in a list as tall as all of them, so the tab scrolls as if they were all there.
 */
function GroupRows({ listId, artifacts, scroller, row }: GroupRowsProps): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  // Where the rows start in the scroller's content, below the groups and headers above them.
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    const element = list.current
    if (element === null || scroller === null) return undefined
    const measure = (): void => {
      setScrollMargin(layoutTop(element) - layoutTop(scroller))
    }
    measure()
    // The rows move whenever what's above them changes size: a group folding, or gaining or losing an artifact.
    const observer = new ResizeObserver(measure)
    for (const child of Array.from(scroller.children)) observer.observe(child)
    return () => {
      observer.disconnect()
    }
  }, [scroller])

  // TanStack Virtual hands back a new measurement each render, which the React Compiler can't memoize: it leaves this
  // component alone, as it should.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: artifacts.length,
    getScrollElement: () => scroller,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => artifacts[index]?.path ?? index,
    gap: ROW_GAP,
    overscan: OVERSCAN,
    scrollMargin,
  })

  return (
    <div id={listId} ref={list} role="list" className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const artifact = artifacts[item.index]
        if (artifact === undefined) return null
        return (
          <div
            key={item.key}
            data-index={item.index}
            // Only places the row: the list's items are the rows inside.
            role="presentation"
            className={styles.virtualRow}
            style={{ transform: `translateY(${String(item.start - scrollMargin)}px)` }}
          >
            {row(artifact)}
          </div>
        )
      })}
    </div>
  )
}

interface DateGroupProps {
  readonly group: ArtifactDateGroup
  readonly artifacts: readonly Artifact[]
  readonly open: boolean
  readonly onToggle: (group: ArtifactDateGroup, open: boolean) => void
  readonly scroller: HTMLElement | null
  readonly row: (artifact: Artifact) => React.ReactNode
}

/** A date group: its header (chevron, name, count), which folds the rows below it, and they slide open and shut. */
function DateGroup({ group, artifacts, open, onToggle, scroller, row }: DateGroupProps): React.JSX.Element {
  const listId = useId()
  const title = dateGroupTitle(group)
  return (
    <section className={styles.group} aria-label={title}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          onToggle(group, !open)
        }}
      >
        <span className={styles.chevron}>
          <Icon icon={open ? faChevronDown : faChevronRight} size={IconSize.Small} />
        </span>
        <span className={styles.name}>{title}</span>
        <span>{artifacts.length}</span>
      </button>
      <Collapse open={open}>
        <GroupRows listId={listId} artifacts={artifacts} scroller={scroller} row={row} />
      </Collapse>
    </section>
  )
}

export interface ArtifactsTabProps {
  readonly taskId: string
  readonly now: EpochMs
}

/**
 * The right panel's Artifacts tab (`docs/design/html/10-artifacts.html`, #307): the files the agent declared as the
 * task's deliverables (`add_artifact`), newest first by when each file last changed, under date headers (Today,
 * Yesterday, This week, Last week, This month, Older) that fold, and stay as you left them for the task. Each is a
 * compact row (`ArtifactRow`). They stay after the task is done. While the tab shows, main watches their files, so an
 * edit from anywhere moves one to the top. A row's context menu, from a right-click or its More button, has Open in
 * editor, Copy contents, Copy path and Remove from artifacts, which leaves the file.
 */
export function ArtifactsTab({ taskId, now }: ArtifactsTabProps): React.JSX.Element {
  const artifacts = useGladeStore((state) => state.artifacts[taskId]) ?? NO_ARTIFACT_LIST
  const folds = useGladeStore((state) => state.artifactGroups[taskId]) ?? NO_FOLDS
  const selectedPath = useGladeStore((state) => state.openFiles[taskId]?.activePath ?? null)
  const rootPath = useGladeStore(
    (state) => state.workspaces.find((workspace) => workspace.id === state.tasks[taskId]?.workspaceId)?.rootPath,
  )
  const showFile = useGladeStore((state) => state.showFile)
  const openInEditor = useGladeStore((state) => state.openInEditor)
  const copyFile = useGladeStore((state) => state.copyFile)
  const revealFile = useGladeStore((state) => state.revealFile)
  const removeArtifact = useGladeStore((state) => state.removeArtifact)
  const setArtifactGroupOpen = useGladeStore((state) => state.setArtifactGroupOpen)
  const watchArtifacts = useGladeStore((state) => state.watchArtifacts)
  const unwatchArtifacts = useGladeStore((state) => state.unwatchArtifacts)
  const menu = useContextMenu<string>()
  const { run, copy, hints } = useMenuCommands()
  // The scroller, as state rather than a ref: the groups' rows can only lay out once it's mounted.
  const [scroller, setScroller] = useState<HTMLElement | null>(null)

  // While the tab shows the task, main watches its artifacts' files for edits from anywhere.
  useEffect(() => {
    // A failed watch only means an outside edit shows once the tab is opened again.
    watchArtifacts(taskId).catch(() => undefined)
    return () => {
      unwatchArtifacts(taskId).catch(() => undefined)
    }
  }, [taskId, watchArtifacts, unwatchArtifacts])

  const groups = useMemo(() => groupArtifacts(artifacts, now), [artifacts, now])
  const { openBelow, targetProps } = menu
  const row = useCallback(
    (artifact: Artifact) => (
      <ArtifactRow
        artifact={artifact}
        now={now}
        selected={artifact.path === selectedPath}
        menuTarget={targetProps(artifact.path)}
        onMore={openBelow}
      />
    ),
    [now, selectedPath, targetProps, openBelow],
  )
  const toggle = useCallback(
    (group: ArtifactDateGroup, open: boolean) => {
      // The fold shows at once; one that isn't remembered is only forgotten on the next launch.
      setArtifactGroupOpen(taskId, group, open).catch(() => undefined)
    },
    [setArtifactGroupOpen, taskId],
  )

  if (artifacts.length === 0) return <p className={styles.empty}>{NO_ARTIFACTS}</p>

  const entries = (path: string) =>
    artifactMenu(
      {
        open: () => {
          run(() => showFile(taskId, path))
        },
        openInEditor: () => {
          run(() => openInEditor(taskId, path))
        },
        copyContents: () => {
          run(() => copyFile(taskId, path))
        },
        copyPath: () => {
          copy(rootPath === undefined ? path : absolutePath(rootPath, path))
        },
        reveal: () => {
          run(() => revealFile(taskId, path))
        },
        remove: () => {
          run(() => removeArtifact(taskId, path))
        },
      },
      hints,
    )

  return (
    <div ref={setScroller} className={styles.artifacts} role="group" aria-label="Artifacts">
      {groups.map(({ group, items }) => (
        <DateGroup
          key={group}
          group={group}
          artifacts={items}
          open={isGroupOpen(group, folds)}
          onToggle={toggle}
          scroller={scroller}
          row={row}
        />
      ))}
      <ContextMenu label="Artifact actions" state={menu} entries={entries} />
    </div>
  )
}
