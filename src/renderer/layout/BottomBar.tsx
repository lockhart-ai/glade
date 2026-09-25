import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Card } from '../components'
import { classNames } from '../components/classNames'
import { isMoving, MotionPhase, panelMotionClass } from '../motion'
import styles from './BottomBar.module.css'

export interface BottomBarProps {
  /** The terminal card's tab row. */
  terminalTabs?: ReactNode
  /** The terminal itself. */
  terminal?: ReactNode
  /** The shown plugin's card, beside the terminal; with none, the terminal takes the whole bar. */
  plugin?: ReactNode
  /** The button at the end of the tab row that collapses the bar and shows it again. */
  toggle?: ReactNode
  /** Whether the bar is collapsed to its tab row. */
  collapsed?: boolean
  /** Whether the bar is sliding open or shut, or still. It's still by default. */
  motion?: MotionPhase
}

/** The custom property that holds the bar's height collapsed to its tab row, which it slides to and from. */
const COLLAPSED_HEIGHT_PROPERTY = '--bottom-bar-collapsed-height'

/**
 * The full-width bar along the bottom of the window, holding the terminal card and, beside it, the shown plugin's. Collapsed, the card shows only its tab
 * row, whose toggle shows it again; the terminal stays in the page, hidden, so its shells' screens keep what they show.
 *
 * It slides open and shut between its height and its tab row's. Meanwhile the card keeps its open height, so the
 * terminal isn't resized, and slides under the bottom of the window.
 */
export function BottomBar({
  terminalTabs,
  terminal,
  plugin,
  toggle,
  collapsed = false,
  motion = MotionPhase.Shown,
}: BottomBarProps): React.JSX.Element {
  const bar = useRef<HTMLDivElement>(null)
  const tabs = useRef<HTMLDivElement>(null)
  const moving = isMoving(motion)

  // The height it slides to or from, collapsed: the tab row and the card's border. Measured before the first frame.
  useLayoutEffect(() => {
    const row = tabs.current
    const card = row?.parentElement
    if (!moving || row == null || card == null) return
    const border = card.offsetHeight - card.clientHeight
    bar.current?.style.setProperty(COLLAPSED_HEIGHT_PROPERTY, `${String(row.offsetHeight + border)}px`)
  }, [moving])

  return (
    <div ref={bar} className={classNames(styles.bar, moving && styles.moving, panelMotionClass(motion))}>
      <Card role="region" aria-label="Terminal" className={styles.terminal}>
        <div ref={tabs} className={classNames(styles.tabs, collapsed && styles.alone)} data-testid="terminal-tabs">
          {terminalTabs}
          {toggle}
        </div>
        <div className={styles.content} hidden={collapsed}>
          {terminal}
        </div>
      </Card>
      {plugin}
    </div>
  )
}
