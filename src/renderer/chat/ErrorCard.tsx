import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import type { Task } from '../../shared/domain'
import { findModel } from '../../shared/models'
import { errorOpening, NOTHING_LOST, retriesSentence } from '../../shared/taskError'
import {
  Button,
  ButtonSize,
  ButtonVariant,
  Icon,
  IconSize,
  Menu,
  MenuAnchorKind,
  MenuEntryKind,
  Placement,
  useToast,
  type MenuEntry,
} from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import styles from './ErrorCard.module.css'

export interface ErrorCardProps {
  /** The task an error stopped. */
  readonly task: Task
}

/** What the toast says when a retry couldn't start. */
export function retryFailureMessage(error: unknown): string {
  return `Couldn’t retry: ${describeFailure(error)}`
}

/**
 * The pink card at the end of the chat when an error stopped the agent (`docs/design/html/16-error.html`): what
 * happened, that nothing is lost, and the ways on. Retry runs the turn again; Retry with another model picks a model
 * first; Show details shows the raw error.
 */
export function ErrorCard({ task }: ErrorCardProps): React.JSX.Element {
  const retryTask = useGladeStore((state) => state.retryTask)
  const toast = useToast()
  const offered = useGladeStore((state) => state.models)
  const [detailsShown, setDetailsShown] = useState(false)
  // The Retry with another model button, while its menu is open.
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null)
  const { error } = task
  const opening = errorOpening(error)

  const retry = (model?: string): void => {
    retryTask(task.id, model).catch((failure: unknown) => {
      toast.show({ message: retryFailureMessage(failure) })
    })
  }

  const current = findModel(offered, task.model)?.id
  const models: MenuEntry[] = offered.map((option) => ({
    kind: MenuEntryKind.Item,
    label: option.name,
    checked: option.id === current,
    onSelect: () => {
      retry(option.id)
    },
  }))

  return (
    <div role="alert" className={styles.card}>
      <div className={styles.title}>
        <Icon icon={faTriangleExclamation} size={IconSize.Medium} />
        The agent stopped
      </div>
      <p className={styles.text}>
        {opening.lead}
        {opening.label !== null && (
          <>
            <span className={styles.label}>{opening.label}</span>.
          </>
        )}{' '}
        {retriesSentence(error)} {NOTHING_LOST}
      </p>
      <div className={styles.actions}>
        <Button
          variant={ButtonVariant.Dark}
          size={ButtonSize.Small}
          className={styles.action}
          onClick={() => {
            retry()
          }}
        >
          Retry
        </Button>
        <Button
          variant={ButtonVariant.Ghost}
          size={ButtonSize.Small}
          className={styles.action}
          aria-haspopup="menu"
          aria-expanded={modelAnchor !== null}
          onClick={(event) => {
            setModelAnchor(event.currentTarget)
          }}
        >
          Retry with another model
        </Button>
        {error !== null && (
          <Button
            variant={ButtonVariant.Ghost}
            size={ButtonSize.Small}
            className={styles.action}
            aria-expanded={detailsShown}
            onClick={() => {
              setDetailsShown((shown) => !shown)
            }}
          >
            {detailsShown ? 'Hide details' : 'Show details'}
          </Button>
        )}
      </div>
      {detailsShown && error !== null && (
        <pre aria-label="Error details" className={styles.details}>
          {error.details}
        </pre>
      )}
      <Menu
        label="Retry with model"
        entries={models}
        anchor={{ kind: MenuAnchorKind.Element, element: modelAnchor, placement: Placement.BottomStart }}
        open={modelAnchor !== null}
        onClose={() => {
          setModelAnchor(null)
        }}
      />
    </div>
  )
}
