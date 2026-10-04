import { faCopy, faFolder } from '@fortawesome/free-regular-svg-icons'
import { faArrowUpRightFromSquare, faEllipsis } from '@fortawesome/free-solid-svg-icons'
import type { MouseEvent } from 'react'
import { Button, ButtonVariant } from '../components'

interface ActionsProps {
  /** A class for each button: its size where it shows. */
  readonly buttonClassName: string | undefined
  /** Opens its context menu below its More button. */
  readonly onMore: (button: HTMLElement) => void
}

/** Its More button, which opens its context menu. */
function More({ buttonClassName, onMore }: ActionsProps): React.JSX.Element {
  return (
    <Button
      variant={ButtonVariant.Icon}
      className={buttonClassName}
      icon={faEllipsis}
      aria-label="More"
      aria-haspopup="menu"
      title="More"
      onClick={(event) => {
        onMore(event.currentTarget)
      }}
    />
  )
}

export interface FileActionsProps extends ActionsProps {
  /** Whether its file is gone: it can't be opened or revealed, only taken off the artifacts (More). */
  readonly missing: boolean
  readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void
  readonly onReveal: () => void
}

/**
 * A file artifact's icon buttons, which take its age's place under the pointer or with the focus: Open, Reveal in
 * folder and More. The same three in its row in the Artifacts tab and on its tile in the todo hub (P16, #498).
 */
export function FileActions({
  missing,
  buttonClassName,
  onOpen,
  onReveal,
  onMore,
}: FileActionsProps): React.JSX.Element {
  return (
    <>
      <Button
        variant={ButtonVariant.Icon}
        className={buttonClassName}
        icon={faArrowUpRightFromSquare}
        aria-label="Open"
        title="Open"
        disabled={missing}
        onClick={onOpen}
      />
      <Button
        variant={ButtonVariant.Icon}
        className={buttonClassName}
        icon={faFolder}
        aria-label="Reveal in folder"
        title="Reveal in folder"
        disabled={missing}
        onClick={onReveal}
      />
      <More buttonClassName={buttonClassName} onMore={onMore} />
    </>
  )
}

export interface LinkActionsProps extends ActionsProps {
  readonly onOpen: () => void
  readonly onCopy: () => void
}

/** A link artifact's icon buttons, in its row and on its tile: Open link, Copy link and More. */
export function LinkActions({ buttonClassName, onOpen, onCopy, onMore }: LinkActionsProps): React.JSX.Element {
  return (
    <>
      <Button
        variant={ButtonVariant.Icon}
        className={buttonClassName}
        icon={faArrowUpRightFromSquare}
        aria-label="Open link"
        title="Open link"
        onClick={onOpen}
      />
      <Button
        variant={ButtonVariant.Icon}
        className={buttonClassName}
        icon={faCopy}
        aria-label="Copy link"
        title="Copy link"
        onClick={onCopy}
      />
      <More buttonClassName={buttonClassName} onMore={onMore} />
    </>
  )
}
