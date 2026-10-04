import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons'
import type { HTMLAttributes, ReactNode, RefObject } from 'react'
import { Button, ButtonVariant } from '../Button/Button'
import { classNames } from '../classNames'
import { Icon, IconSize } from '../Icon/Icon'
import styles from './Tabs.module.css'
import { chevronScroll, ScrollDirection, useSidewaysWheel } from './tabScroll'
import { useOverflowEdges } from './useOverflowEdges'

export interface ScrollRowProps extends HTMLAttributes<HTMLDivElement> {
  /** The row that scrolls: its owner's ref, which can scroll it too (`revealScroll`, to bring a tab into view). */
  listRef: RefObject<HTMLDivElement | null>
  /** A key for what's in the row (its tabs' labels, say): which ends have more past them is measured again as it changes. */
  content: string
  /** How many things are in the row: a chevron scrolls it by about the width of one. */
  count: number
  /** What the chevrons say they scroll: `tabs` makes "Scroll tabs left". */
  noun: string
  /** A class for the whole strip: the row and its scroll chevrons. */
  className?: string | undefined
  /** A class for the row itself. */
  rowClassName?: string | undefined
  children: ReactNode
}

const CHEVRONS = {
  [ScrollDirection.Start]: { icon: faChevronLeft, side: 'left' },
  [ScrollDirection.End]: { icon: faChevronRight, side: 'right' },
} as const

interface ScrollChevronProps {
  direction: ScrollDirection
  noun: string
  onClick: () => void
}

/**
 * The chevron over an end of the row with more past it. It's for the pointer: out of the tab order, since the arrow
 * keys already move between a row's tabs and bring each into view.
 */
function ScrollChevron({ direction, noun, onClick }: ScrollChevronProps): React.JSX.Element {
  const { icon, side } = CHEVRONS[direction]
  const label = `Scroll ${noun} ${side}`
  return (
    <Button
      variant={ButtonVariant.Icon}
      aria-label={label}
      title={label}
      tabIndex={-1}
      className={classNames(styles.chevron, styles[direction])}
      onClick={onClick}
    >
      <Icon icon={icon} size={IconSize.Small} />
    </Button>
  )
}

/**
 * A row that scrolls sideways when it's too narrow for what's in it, with no scroll bar: by trackpad, by the mouse
 * wheel (up and down scroll it too), and by a chevron at each end with more past it, which scrolls it about one
 * thing's width. That end fades out under its chevron. The right panel's tabs (`Tabs`) and the Agents tab's strip of
 * agents are both one. Any other prop goes on the row itself (its `role`, its label).
 */
export function ScrollRow({
  listRef,
  content,
  count,
  noun,
  className,
  rowClassName,
  children,
  ...rest
}: ScrollRowProps): React.JSX.Element {
  const overflow = useOverflowEdges(listRef, content)
  useSidewaysWheel(listRef)

  const scrollBy = (direction: ScrollDirection): void => {
    listRef.current?.scrollBy({ left: chevronScroll(listRef.current, count, direction) })
  }

  return (
    <div
      className={classNames(styles.strip, className)}
      data-overflow-start={overflow.start}
      data-overflow-end={overflow.end}
    >
      <div ref={listRef} className={classNames(styles.tablist, rowClassName)} {...rest}>
        {children}
      </div>
      {overflow.start && (
        <ScrollChevron
          direction={ScrollDirection.Start}
          noun={noun}
          onClick={() => {
            scrollBy(ScrollDirection.Start)
          }}
        />
      )}
      {overflow.end && (
        <ScrollChevron
          direction={ScrollDirection.End}
          noun={noun}
          onClick={() => {
            scrollBy(ScrollDirection.End)
          }}
        />
      )}
    </div>
  )
}
