import { faCopy } from '@fortawesome/free-regular-svg-icons'
import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeFailure } from '../../store/hydrate'
import { useGladeStore } from '../../store/react'
import { Button, ButtonVariant } from '../Button/Button'
import { classNames } from '../classNames'
import { useToast } from '../Toast/Toast'
import styles from './CodeCopy.module.css'

/** How long "Copied" feedback shows once a copy succeeds, in milliseconds (#352). */
export const COPIED_FEEDBACK_MS = 1000

export interface CopyFeedback {
  /** Whether the last copy is still showing its "Copied" feedback. */
  readonly copied: boolean
  /** Puts text on the clipboard through the app's usual path, and shows "Copied" for a moment; a failure shows as a
   * toast instead, as a Copy menu item's does. */
  readonly copy: (text: string) => void
}

/**
 * Copies through `copyText` (the same clipboard path Copy menu items use, `useMenuCommands`'s `copy`), and tracks
 * whether to show "Copied" now: for `COPIED_FEEDBACK_MS` after each copy that succeeds. A copy that fails shows as a
 * toast instead of the feedback, and doesn't restart or extend it.
 */
export function useCopyFeedback(): CopyFeedback {
  const copyText = useGladeStore((state) => state.copyText)
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(
    (text: string) => {
      copyText(text)
        .then(() => {
          if (timer.current !== null) clearTimeout(timer.current)
          setCopied(true)
          timer.current = setTimeout(() => {
            timer.current = null
            setCopied(false)
          }, COPIED_FEEDBACK_MS)
        })
        .catch((error: unknown) => {
          toast.show({ message: describeFailure(error) })
        })
    },
    [copyText, toast],
  )

  return { copied, copy }
}

export interface CopiedTagProps {
  readonly className?: string
}

/**
 * The small "Copied" tooltip a copy shows for about a second, floating above its anchor (which must be
 * `position: relative`, or itself absolutely positioned): a code span, or a code block's copy button.
 */
export function CopiedTag({ className }: CopiedTagProps): React.JSX.Element {
  return (
    <span role="status" className={classNames(styles.tag, className)}>
      Copied
    </span>
  )
}

export interface CopyBlockButtonProps {
  /** Reads the exact text to copy, fresh at the moment it's clicked. */
  readonly getText: () => string
  /** What the button copies, for its accessible name and tooltip ("Copy code" by default). */
  readonly label?: string
  /**
   * Positions and reveals the button: give it `position: absolute` in the block's corner, and show it (`opacity: 1`,
   * `pointer-events: auto`) while the block is hovered or holds the focus (it's the block's only focusable part, so
   * `:focus-within` reveals it as it's tabbed to).
   */
  readonly className?: string
}

/**
 * A fenced code block's copy icon (#352): copies the whole block, showing the same "Copied" feedback a code span
 * does. Its position and when it shows are the caller's (`className`); this only renders the button and the feedback.
 */
export function CopyBlockButton({ getText, label = 'Copy code', className }: CopyBlockButtonProps): React.JSX.Element {
  const { copied, copy } = useCopyFeedback()
  return (
    <span className={classNames(styles.wrap, className)}>
      <Button
        variant={ButtonVariant.Icon}
        icon={copied ? faCheck : faCopy}
        aria-label={copied ? 'Copied' : label}
        title={copied ? 'Copied' : label}
        className={styles.button}
        onClick={() => {
          copy(getText())
        }}
      />
      {copied && <CopiedTag className={styles.blockTag} />}
    </span>
  )
}
