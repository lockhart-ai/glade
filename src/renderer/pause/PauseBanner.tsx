import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { useMemo, useState } from 'react'
import { findModel } from '../../shared/models'
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
import { useNow } from '../task-list/useNow'
import {
  bannerText,
  offersSwitchModel,
  pausedStatusLine,
  pausedTasks,
  switchableTasks,
  type PausedTask,
} from './pauseModel'
import styles from './PauseBanner.module.css'

/** What the toast says when a paused task couldn't be moved to another model. */
export function switchFailureMessage(error: unknown): string {
  return `Couldn’t switch the model: ${describeFailure(error)}`
}

interface DetailsProps {
  readonly paused: readonly PausedTask[]
  readonly now: number
}

/** The banner's Details: each paused task, why and until when, then what the API said. */
function Details({ paused, now }: DetailsProps): React.JSX.Element {
  const said = [...new Set(paused.map((task) => task.pause.details))]
  return (
    <div className={styles.details}>
      <ul aria-label="Paused tasks" className={styles.tasks}>
        {paused.map((task) => (
          <li key={task.id} className={styles.task}>
            <span className={styles.taskTitle}>{task.title}</span>
            <span className={styles.taskStatus}>{pausedStatusLine(task.pause, now)}</span>
          </li>
        ))}
      </ul>
      <pre aria-label="What the API said" className={styles.said}>
        {said.join('\n')}
      </pre>
    </div>
  )
}

/**
 * The one app-wide banner across the top of the window while tasks are paused, by a usage limit or the network
 * (`docs/design/html/17-usage-limit.html`): how many, and when they resume on their own. Switch model moves the tasks a
 * usage limit paused to another model and resumes them now; Details lists the paused tasks and what the API said.
 * Nothing shows while no task is paused.
 */
export function PauseBanner(): React.JSX.Element | null {
  const tasks = useGladeStore((state) => state.tasks)
  const retryTask = useGladeStore((state) => state.retryTask)
  const toast = useToast()
  const now = useNow()
  const offered = useGladeStore((state) => state.models)
  const [detailsShown, setDetailsShown] = useState(false)
  // The Switch model button, while its menu is open.
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null)
  const paused = useMemo(() => pausedTasks(tasks), [tasks])
  const text = bannerText(paused, now)
  if (text === null) return null

  const switchable = switchableTasks(paused)
  const switchTo = (model: string): void => {
    for (const task of switchable) {
      retryTask(task.id, model).catch((error: unknown) => {
        toast.show({ message: switchFailureMessage(error) })
      })
    }
  }
  const models: MenuEntry[] = offered.map((option) => ({
    kind: MenuEntryKind.Item,
    label: option.name,
    checked: switchable.every((task) => findModel(offered, task.model)?.id === option.id),
    onSelect: () => {
      switchTo(option.id)
    },
  }))

  return (
    <div role="status" aria-label="Paused tasks" className={styles.banner}>
      <div className={styles.row}>
        <span className={styles.icon}>
          <Icon icon={faTriangleExclamation} size={IconSize.Medium} />
        </span>
        <span className={styles.text}>
          <strong className={styles.title}>{text.title}</strong> {text.text}
        </span>
        <span className={styles.spacer} />
        {offersSwitchModel(paused) && (
          <Button
            variant={ButtonVariant.Dark}
            size={ButtonSize.Small}
            aria-haspopup="menu"
            aria-expanded={modelAnchor !== null}
            onClick={(event) => {
              setModelAnchor(event.currentTarget)
            }}
          >
            Switch model
          </Button>
        )}
        <Button
          variant={ButtonVariant.Ghost}
          size={ButtonSize.Small}
          aria-expanded={detailsShown}
          onClick={() => {
            setDetailsShown((shown) => !shown)
          }}
        >
          {detailsShown ? 'Hide details' : 'Details'}
        </Button>
      </div>
      {detailsShown && <Details paused={paused} now={now} />}
      <Menu
        label="Switch model"
        entries={models}
        anchor={{ kind: MenuAnchorKind.Element, element: modelAnchor, placement: Placement.BottomEnd }}
        open={modelAnchor !== null}
        onClose={() => {
          setModelAnchor(null)
        }}
      />
    </div>
  )
}
