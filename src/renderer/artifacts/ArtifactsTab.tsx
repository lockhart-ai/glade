import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { artifactKey } from '../../shared/artifacts'
import {
  ArtifactFilter,
  ArtifactKind,
  type Artifact,
  type ArtifactDateGroup,
  type ArtifactGroupFold,
  type EpochMs,
  type FileArtifact,
  type LinkArtifact,
} from '../../shared/domain'
import { Collapse, Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import { ContextMenu, useContextMenu, type ContextMenuTargetProps } from '../context-menus'
import { useGladeStore } from '../store/react'
import { formatFullDate } from '../task-header/headerModel'
import { FileActions, LinkActions } from './ArtifactActions'
import { useArtifactMenu, useFileArtifact, useLinkArtifact } from './artifactHooks'
import { linkIcon, tileIcon } from './artifactIcons'
import { ArtifactImageViewer, useViewedImage } from './ArtifactImageViewer'
import {
  artifactTime,
  artifactTypeName,
  countArtifacts,
  filterArtifacts,
  formatArtifactAge,
  groupArtifacts,
  isImageArtifact,
  shownFilter,
  type ArtifactCounts,
} from './artifactsModel'
import { ArtifactThumb } from './ArtifactThumb'
import { dateGroupTitle, isGroupOpen } from './dateGroups'
import styles from './ArtifactsTab.module.css'

/** What the tab shows while the agent has declared no artifacts. */
export const NO_ARTIFACTS = 'No artifacts yet.'

const NO_ARTIFACT_LIST: readonly Artifact[] = []
/** What the filter's chips say, in order (#407). */
const FILTER_CHIPS: readonly { readonly filter: ArtifactFilter; readonly label: string }[] = [
  { filter: ArtifactFilter.All, label: 'All' },
  { filter: ArtifactFilter.Files, label: 'Files' },
  { filter: ArtifactFilter.Links, label: 'Links' },
]
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

interface ArtifactRowProps {
  readonly artifact: FileArtifact
  readonly now: EpochMs
  /** Whether it's the file the Files tab shows: the row is outlined. */
  readonly selected: boolean
  /** What opens its context menu: a right-click, or ⇧F10 while it (or one of its buttons) has the focus. */
  readonly menuTarget: ContextMenuTargetProps
  /** Opens its context menu below its More button, by its key (`artifactKey`). */
  readonly onMore: (key: string, button: HTMLElement) => void
  /** Opens the image viewer on an image artifact, from the button clicked (or activated by ↵ or Space), for the focus
   * to return to once it closes. */
  readonly onOpenImage: (artifact: FileArtifact, trigger: HTMLElement) => void
}

/**
 * One artifact, in one 40px row: a thumbnail of an image (once main has made it), or its type's tile, then its title,
 * its type and how long ago its file changed. Hovered or focused, the age gives way to Open, Reveal in folder and More
 * (its context menu). Clicking an image artifact (or Open) opens the image viewer, stepping through the image artifacts
 * the list shows; any other artifact opens in the Files tab, as before. A file that's gone shows muted, as missing, and
 * can't be opened or revealed.
 */
const ArtifactRow = memo(function ArtifactRow({
  artifact,
  now,
  selected,
  menuTarget,
  onMore,
  onOpenImage,
}: ArtifactRowProps): React.JSX.Element {
  const { path, title } = artifact
  // How its file looks (again when the row shows, when it changes, and after an action on it failed), and what Open
  // and Reveal do: one with its tile in the todo hub (#498).
  const file = useFileArtifact(artifact)
  const { missing, time } = file
  const open = (event: MouseEvent<HTMLButtonElement>): void => {
    if (file.isImage) {
      onOpenImage(artifact, event.currentTarget)
      return
    }
    file.showInFiles()
  }

  return (
    <div
      className={classNames(styles.row, selected && styles.selected, missing && styles.missing)}
      aria-label={title}
      aria-current={selected || undefined}
      // Busy until its file has been looked at, and its thumbnail has loaded: a capture waits for it.
      aria-busy={file.busy}
      role="listitem"
      {...menuTarget}
    >
      <button type="button" className={styles.open} title={path} disabled={missing} onClick={open}>
        <ArtifactThumb
          image={file.image}
          icon={tileIcon(path)}
          onLoad={file.onThumbnailLoad}
          // One the window can't draw shows the type's tile.
          onError={file.onThumbnailError}
          className={styles.tile}
          blankClassName={styles.blank}
        />
        <span className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.type}>{file.typeLabel}</span>
        </span>
        <span className={styles.age} title={formatFullDate(time)}>
          {formatArtifactAge(time, now)}
        </span>
      </button>
      <span className={styles.actions}>
        <FileActions
          missing={missing}
          buttonClassName={styles.action}
          onOpen={open}
          onReveal={file.reveal}
          onMore={(button) => {
            onMore(artifactKey(artifact), button)
          }}
        />
      </span>
    </div>
  )
})

interface LinkArtifactRowProps {
  readonly artifact: LinkArtifact
  readonly now: EpochMs
  readonly menuTarget: ContextMenuTargetProps
  /** Opens its context menu below its More button, by its key (`artifactKey`). */
  readonly onMore: (key: string, button: HTMLElement) => void
}

/**
 * One link artifact (#407), in a row like a file's: its kind's icon (a pull request, an issue, a ticket, a link), its
 * title, what it is (`#412 · acme/api`, `API-123`, `example.com`) and how long ago it was declared. Clicking it opens it
 * in the browser, through main, as any link does; it never opens in Glade. Hovered or focused, the age gives way to
 * Open link, Copy link and More (its context menu).
 */
const LinkArtifactRow = memo(function LinkArtifactRow({
  artifact,
  now,
  menuTarget,
  onMore,
}: LinkArtifactRowProps): React.JSX.Element {
  const { url, title } = artifact
  const { open, copy } = useLinkArtifact(artifact)
  const time = artifactTime(artifact)
  return (
    <div className={styles.row} aria-label={title} role="listitem" {...menuTarget}>
      <button type="button" className={styles.open} title={url} onClick={open}>
        <ArtifactThumb image={null} icon={linkIcon(url)} className={styles.tile} blankClassName={styles.blank} />
        <span className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.type}>{artifactTypeName(artifact)}</span>
        </span>
        <span className={styles.age} title={formatFullDate(time)}>
          {formatArtifactAge(time, now)}
        </span>
      </button>
      <span className={styles.actions}>
        <LinkActions
          buttonClassName={styles.action}
          onOpen={open}
          onCopy={copy}
          onMore={(button) => {
            onMore(artifactKey(artifact), button)
          }}
        />
      </span>
    </div>
  )
})

interface FilterChipsProps {
  readonly counts: ArtifactCounts
  readonly chosen: ArtifactFilter
  readonly onChoose: (filter: ArtifactFilter) => void
}

/**
 * The All · Files · Links filter (#407), as the task list's filter chips have theirs: one pressed, Files and Links
 * with their counts. It only shows while the task has both files and links.
 */
function FilterChips({ counts, chosen, onChoose }: FilterChipsProps): React.JSX.Element {
  const count = (filter: ArtifactFilter): number | null => {
    switch (filter) {
      case ArtifactFilter.All:
        return null
      case ArtifactFilter.Files:
        return counts.files
      case ArtifactFilter.Links:
        return counts.links
    }
  }
  return (
    <div className={styles.chips} role="group" aria-label="Show">
      {FILTER_CHIPS.map(({ filter, label }) => {
        const on = filter === chosen
        const n = count(filter)
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={on}
            className={classNames(styles.chip, on && styles.chipOn)}
            onClick={() => {
              onChoose(filter)
            }}
          >
            {label}
            {n !== null && <span className={styles.count}>{n}</span>}
          </button>
        )
      })}
    </div>
  )
}

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
    getItemKey: (index) => {
      const artifact = artifacts[index]
      return artifact === undefined ? index : artifactKey(artifact)
    },
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
 *
 * Links are artifacts too (#407): the PRs, issues and tickets the task is about, each a row of its own
 * (`LinkArtifactRow`) dated by when it was declared, which opens in the browser. While the task has both files and
 * links, the All · Files · Links filter above the groups shows only one kind, remembered for the task.
 */
export function ArtifactsTab({ taskId, now }: ArtifactsTabProps): React.JSX.Element {
  const artifacts = useGladeStore((state) => state.artifacts[taskId]) ?? NO_ARTIFACT_LIST
  const folds = useGladeStore((state) => state.artifactGroups[taskId]) ?? NO_FOLDS
  const chosen = useGladeStore((state) => state.artifactFilters[taskId]) ?? ArtifactFilter.All
  const selectedPath = useGladeStore((state) => state.openFiles[taskId]?.activePath ?? null)
  const setArtifactGroupOpen = useGladeStore((state) => state.setArtifactGroupOpen)
  const setArtifactFilter = useGladeStore((state) => state.setArtifactFilter)
  const watchArtifacts = useGladeStore((state) => state.watchArtifacts)
  const unwatchArtifacts = useGladeStore((state) => state.unwatchArtifacts)
  const menu = useContextMenu<string>()
  // An artifact's menu, and the image viewer over the list's images, are one with the todo hub's tiles (#498).
  const menuEntries = useArtifactMenu(taskId)
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

  const counts = useMemo(() => countArtifacts(artifacts), [artifacts])
  const filter = shownFilter(counts, chosen)
  const groups = useMemo(() => groupArtifacts(filterArtifacts(artifacts, filter), now), [artifacts, filter, now])
  // The newest group actually showing: it starts open too, whichever one it is (#399).
  const topmostGroup = groups[0]?.group
  const { openBelow, targetProps } = menu

  // The image viewer, over an image artifact: which of the image artifacts the list shows, in its own (newest-first)
  // order; null while it's shut. Those in a folded date group aren't listed, so it never steps to them (#378).
  const imageArtifacts = useMemo(
    () =>
      groups
        .filter(({ group }) => isGroupOpen(group, folds, topmostGroup))
        .flatMap(({ items }) => items)
        .filter(isImageArtifact),
    [groups, folds, topmostGroup],
  )
  // Once the artifact it shows is no longer one of them (removed, or its file changed kind), it closes.
  const viewed = useViewedImage(imageArtifacts.map(({ path }) => path))
  const openViewer = viewed.open
  const onOpenImage = useCallback(
    (artifact: FileArtifact, trigger: HTMLElement) => {
      openViewer(artifact.path, trigger)
    },
    [openViewer],
  )

  const row = useCallback(
    (artifact: Artifact) => {
      switch (artifact.kind) {
        case ArtifactKind.File:
          return (
            <ArtifactRow
              artifact={artifact}
              now={now}
              selected={artifact.path === selectedPath}
              menuTarget={targetProps(artifactKey(artifact))}
              onMore={openBelow}
              onOpenImage={onOpenImage}
            />
          )
        case ArtifactKind.Link:
          return (
            <LinkArtifactRow
              artifact={artifact}
              now={now}
              menuTarget={targetProps(artifactKey(artifact))}
              onMore={openBelow}
            />
          )
      }
    },
    [now, selectedPath, targetProps, openBelow, onOpenImage],
  )
  const choose = useCallback(
    (next: ArtifactFilter) => {
      // The choice shows at once; one that isn't remembered is only forgotten on the next launch.
      setArtifactFilter(taskId, next).catch(() => undefined)
    },
    [setArtifactFilter, taskId],
  )
  const toggle = useCallback(
    (group: ArtifactDateGroup, open: boolean) => {
      // The fold shows at once; one that isn't remembered is only forgotten on the next launch.
      setArtifactGroupOpen(taskId, group, open).catch(() => undefined)
    },
    [setArtifactGroupOpen, taskId],
  )

  if (artifacts.length === 0) return <p className={styles.empty}>{NO_ARTIFACTS}</p>

  const entries = (key: string) => {
    const artifact = artifacts.find((each) => artifactKey(each) === key)
    // The artifact went while its menu was open: there's nothing left to act on.
    return artifact === undefined ? [] : menuEntries(artifact)
  }

  return (
    <div ref={setScroller} className={styles.artifacts} role="group" aria-label="Artifacts">
      {counts.files > 0 && counts.links > 0 && <FilterChips counts={counts} chosen={filter} onChoose={choose} />}
      {groups.map(({ group, items }) => (
        <DateGroup
          key={group}
          group={group}
          artifacts={items}
          open={isGroupOpen(group, folds, topmostGroup)}
          onToggle={toggle}
          scroller={scroller}
          row={row}
        />
      ))}
      <ContextMenu label="Artifact actions" state={menu} entries={entries} />
      <ArtifactImageViewer taskId={taskId} images={imageArtifacts} viewed={viewed} />
    </div>
  )
}
