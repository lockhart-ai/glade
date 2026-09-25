import { useCallback, useRef, type CSSProperties, type ReactNode } from 'react'
import { classNames } from '../components/classNames'
import { isMoving, MotionPhase, panelMotionAttributes, panelMotionClass } from '../motion'
import { Panel } from '../panels/panels'
import {
  MIN_BOTTOM_BAR_HEIGHT,
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_TASK_HEIGHT,
  RESIZE_STEP,
  sizeBounds,
  type SizeBounds,
} from '../panels/panelSize'
import { HandleEdge, ResizeHandle } from './ResizeHandle'
import styles from './AppShell.module.css'

export interface AppShellProps {
  /** The sidebar card (see `Sidebar`), or nothing while it's collapsed: the task card then takes the whole width. */
  sidebar?: ReactNode
  /** Whether the sidebar is sliding open or shut, or still. It's still (and shown) by default. */
  sidebarMotion?: MotionPhase
  /** The width you chose for the sidebar, in CSS pixels. The layout caps it so the task card keeps its minimum. */
  sidebarWidth: number
  /** The sidebar width you dragged its handle to (or moved it to with the arrow keys), to keep. */
  onSidebarWidthChange: (width: number) => void
  /** The task card (see `TaskCard`). */
  task: ReactNode
  /**
   * Whether the task card shows the right panel beside the chat, so its minimum width has room for the panel's minimum
   * as well as the chat's.
   */
  taskHasRightPanel?: boolean
  /** The full-width bottom bar (see `BottomBar`). */
  bottomBar: ReactNode
  /** Whether the bottom bar is collapsed to its tab row, which then takes only its own height. */
  bottomBarCollapsed?: boolean
  /**
   * Whether the bottom bar is sliding open or shut, or still. While it moves, the bar sizes itself (see `BottomBar`)
   * and has no handle.
   */
  bottomBarMotion?: MotionPhase
  /**
   * The height you chose for the bottom bar while it's open, in CSS pixels. The layout caps it so the task card keeps
   * its minimum height. It's the bar's own, whatever the bar holds.
   */
  bottomBarHeight: number
  /** The bottom bar height you dragged its handle to (or moved it to with the arrow keys), to keep. */
  onBottomBarHeightChange: (height: number) => void
  /**
   * The app-wide banner across the top of the window (see `PauseBanner`), when there is one. It renders nothing while
   * there's nothing to say, and then takes no room.
   */
  banner?: ReactNode
  /** What floats over the window, such as the relaunch notice; positioned by itself against the frame. */
  overlay?: ReactNode
}

/** The custom properties the sidebar's width and the bottom bar's height are set through, for the stylesheet to cap. */
const SIDEBAR_WIDTH_PROPERTY = '--sidebar-width'
const BOTTOM_BAR_HEIGHT_PROPERTY = '--bottom-bar-height'

const px = (value: number): string => `${String(value)}px`

/** Parses a computed length such as `460px`; anything else is 0. */
function pxOf(value: string): number {
  return Number.parseFloat(value) || 0
}

/** The sizes the panels are set to, and the limits the stylesheet holds them to. */
function shellStyle(sidebarWidth: number, bottomBarHeight: number): CSSProperties {
  return {
    [SIDEBAR_WIDTH_PROPERTY]: px(sidebarWidth),
    [BOTTOM_BAR_HEIGHT_PROPERTY]: px(bottomBarHeight),
    '--sidebar-min-width': px(MIN_SIDEBAR_WIDTH),
    '--bottom-bar-min-height': px(MIN_BOTTOM_BAR_HEIGHT),
    '--task-min-height': px(MIN_TASK_HEIGHT),
    '--chat-min-width': px(MIN_CHAT_WIDTH),
    '--right-panel-min-width': px(MIN_PANEL_WIDTH),
  } as CSSProperties
}

/**
 * The window frame: a flat background with the sidebar and task card side by side above the bottom bar, under the
 * app-wide banner when there is one. They all start below the title bar row, which holds the macOS traffic lights and
 * drags the window.
 *
 * The sidebar and the bottom bar each have a drag handle on the edge facing the task card. Dragging one takes room from
 * the task card, or gives it back, down to the task card's minimum: the chat keeps its minimum width (and the right
 * panel its own), and its minimum height. When the window shrinks, the task card gives up its room first, then the
 * sidebar and the bottom bar shrink towards their minimums. While you drag, the size changes in place without
 * re-rendering the panels; it's handed on when you let go.
 *
 * The sidebar and the bottom bar slide open and shut (`sidebarMotion`, `bottomBarMotion`); neither has a handle while
 * it moves.
 */
export function AppShell({
  sidebar,
  sidebarMotion = MotionPhase.Shown,
  sidebarWidth,
  onSidebarWidthChange,
  task,
  taskHasRightPanel = false,
  bottomBar,
  bottomBarCollapsed = false,
  bottomBarMotion = MotionPhase.Shown,
  bottomBarHeight,
  onBottomBarHeightChange,
  banner,
  overlay,
}: AppShellProps): React.JSX.Element {
  const shell = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const sidebarSlot = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)

  // The sidebar can take whatever room the task card has beyond its minimum width.
  const sidebarBounds = useCallback((): SizeBounds => {
    const slot = sidebarSlot.current
    const card = slot?.nextElementSibling
    if (slot === null || card == null) return sizeBounds(Panel.Sidebar, 0)
    const spare = card.getBoundingClientRect().width - pxOf(getComputedStyle(card).minWidth)
    return sizeBounds(Panel.Sidebar, slot.getBoundingClientRect().width + spare)
  }, [])

  // The bottom bar can take whatever room the row above it has beyond the task card's minimum height.
  const bottomBarBounds = useCallback((): SizeBounds => {
    const row = top.current
    const bar = bottom.current
    if (row === null || bar === null) return sizeBounds(Panel.BottomBar, 0)
    const spare = row.getBoundingClientRect().height - pxOf(getComputedStyle(row).minHeight)
    return sizeBounds(Panel.BottomBar, bar.getBoundingClientRect().height + spare)
  }, [])

  const showSidebarWidth = useCallback((width: number) => {
    shell.current?.style.setProperty(SIDEBAR_WIDTH_PROPERTY, px(width))
  }, [])

  const showBottomBarHeight = useCallback((height: number) => {
    shell.current?.style.setProperty(BOTTOM_BAR_HEIGHT_PROPERTY, px(height))
  }, [])

  return (
    <div ref={shell} className={styles.shell} style={shellStyle(sidebarWidth, bottomBarHeight)}>
      <div className={styles.titleBar} data-testid="window-title-bar" />
      {banner}
      <div
        ref={top}
        className={classNames(styles.top, sidebar === undefined ? styles.full : panelMotionClass(sidebarMotion))}
        data-right-panel={taskHasRightPanel}
      >
        {sidebar !== undefined && (
          <div
            ref={sidebarSlot}
            className={styles.sidebarSlot}
            data-testid="sidebar-slot"
            {...panelMotionAttributes(sidebarMotion)}
          >
            {sidebar}
            {!isMoving(sidebarMotion) && (
              <ResizeHandle
                edge={HandleEdge.Right}
                label="Resize task list"
                size={sidebarWidth}
                bounds={sidebarBounds}
                step={RESIZE_STEP}
                onResize={showSidebarWidth}
                onResizeEnd={onSidebarWidthChange}
              />
            )}
          </div>
        )}
        {task}
      </div>
      <div
        ref={bottom}
        className={classNames(styles.bottom, bottomBarCollapsed && styles.collapsed)}
        data-testid="bottom-bar-slot"
        {...panelMotionAttributes(bottomBarMotion)}
      >
        {bottomBar}
        {!bottomBarCollapsed && !isMoving(bottomBarMotion) && (
          <ResizeHandle
            edge={HandleEdge.Top}
            label="Resize bottom panel"
            size={bottomBarHeight}
            bounds={bottomBarBounds}
            step={RESIZE_STEP}
            onResize={showBottomBarHeight}
            onResizeEnd={onBottomBarHeightChange}
          />
        )}
      </div>
      {overlay}
    </div>
  )
}
