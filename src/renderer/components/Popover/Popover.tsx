import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { useCallback, useLayoutEffect, type ReactNode } from 'react'
import { classNames } from '../classNames'
import { useOverlayRef } from '../overlays'
import { Placement } from '../Placement'
import styles from './Popover.module.css'

export interface PopoverProps {
  /** The popover's accessible name, e.g. "Context". */
  label: string
  /** The element it opens beside, usually the button that opened it. */
  anchor: HTMLElement | null
  open: boolean
  /** Called when Esc or a click outside dismisses the popover. */
  onClose: () => void
  /** Defaults to above the anchor, aligned to its end, like the context meter's popover. */
  placement?: Placement
  className?: string
  children: ReactNode
}

/** Gap between the popover and its anchor. */
const OFFSET = 8
/** How close the popover may come to the window's edge. */
const EDGE_PADDING = 8

/**
 * A floating card anchored to an element, like the context meter's popover. It is controlled, and a non-modal dialog:
 * it takes focus when it opens (its first focusable element, or itself), Esc or a click outside closes it, and focus
 * then returns to where it was when it opened.
 */
export function Popover({
  label,
  anchor,
  open,
  onClose,
  placement = Placement.TopEnd,
  className,
  children,
}: PopoverProps): React.JSX.Element {
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) onClose()
    },
    placement,
    middleware: [offset(OFFSET), flip({ padding: EDGE_PADDING }), shift({ padding: EDGE_PADDING })],
    whileElementsMounted: autoUpdate,
  })

  useLayoutEffect(() => {
    refs.setReference(anchor)
  }, [refs, anchor])

  const overlay = useOverlayRef()
  const setFloating = useCallback(
    (node: HTMLElement | null) => {
      refs.setFloating(node)
      overlay(node)
    },
    [refs, overlay],
  )

  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context, { role: 'dialog' })])

  if (!open) return <></>

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false}>
        <div
          ref={setFloating}
          aria-label={label}
          className={classNames(styles.popover, className)}
          style={floatingStyles}
          {...getFloatingProps()}
        >
          {children}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  )
}
