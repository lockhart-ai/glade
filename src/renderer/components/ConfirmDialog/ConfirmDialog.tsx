import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { useCallback, useId, useRef } from 'react'
import { Button, ButtonVariant } from '../Button/Button'
import { useOverlayRef } from '../overlays'
import styles from './ConfirmDialog.module.css'

export interface ConfirmDialogProps {
  open: boolean
  /** The question, e.g. "Delete “Fix flaky login test”?". It names the dialog. */
  title: string
  /** What confirming does, and what it leaves alone. */
  message: string
  /** The confirm button's label, e.g. "Delete". */
  confirmLabel: string
  /** Whether confirming destroys something: the confirm button is pink. */
  destructive?: boolean
  onConfirm: () => void
  /** Called for Cancel, Esc, or a click outside the dialog. */
  onCancel: () => void
}

/**
 * A modal that asks you to confirm an action, in the app's own chrome (the viewer has no `confirm()`), styled like the
 * Settings modal (`docs/design/html/21-settings.html`): a dimmed window behind a centred card. It takes the focus,
 * starting on Cancel so a stray ↵ never confirms, and keeps it until it closes; Esc or a click outside cancels. Focus
 * then returns to where it was.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element {
  const titleId = useId()
  const messageId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const overlay = useOverlayRef()
  const { refs, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) onCancel()
    },
  })
  const setFloating = useCallback(
    (node: HTMLElement | null) => {
      refs.setFloating(node)
    },
    [refs],
  )
  const { getFloatingProps } = useInteractions([
    useDismiss(context, { outsidePressEvent: 'mousedown' }),
    useRole(context, { role: 'alertdialog' }),
  ])

  if (!open) return <></>

  return (
    <FloatingPortal>
      <FloatingOverlay ref={overlay} className={styles.backdrop} lockScroll>
        <FloatingFocusManager context={context} initialFocus={cancelRef}>
          <div
            ref={setFloating}
            className={styles.dialog}
            aria-labelledby={titleId}
            aria-describedby={messageId}
            {...getFloatingProps()}
          >
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <p id={messageId} className={styles.message}>
              {message}
            </p>
            <div className={styles.actions}>
              <Button ref={cancelRef} variant={ButtonVariant.Ghost} onClick={onCancel}>
                Cancel
              </Button>
              <Button variant={destructive ? ButtonVariant.Danger : ButtonVariant.Primary} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </div>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  )
}
