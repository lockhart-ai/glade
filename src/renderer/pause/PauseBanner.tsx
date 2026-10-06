import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import { useMemo, useState } from 'react'
import { findModel } from '../../shared/models'
import { AgentSource, agentSource } from '../../shared/openrouter'
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
  offersResumeNow,
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

/** What the toast says when the tasks a usage limit paused couldn't be resumed. */
export function resumeFailureMessage(error: unknown): string {
  return `Couldn’t resume the paused tasks: ${describeFailure(error)}`
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
 * (`docs/design/html/17-usage-limit.html`): how many, and when they resume on their own. Resume now tries the tasks a
 * usage limit paused again at once, each on its own model (one still over the limit pauses again); Switch model moves
 * them to another model and resumes them now; Details lists the paused tasks and what the API said. Nothing shows
 * while no task is paused.
 */
export function PauseBanner(): React.JSX.Element | null {
  const tasks = useGladeStore((state) => state.tasks)
  const retryTask = useGladeStore((state) => state.retryTask)
  const resumePausedTasks = useGladeStore((state) => state.resumePausedTasks)
  const toast = useToast()
  const now = useNow()
  const offered = useGladeStore((state) => state.models)
  const [detailsShown, setDetailsShown] = useState(false)
  // The Switch model button, while its menu is open.
  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null)
  const [switching, setSwitching] = useState(false)
  const paused = useMemo(() => pausedTasks(tasks), [tasks])
  const text = bannerText(paused, now)
  if (text === null) return null

  const resumeNow = (): void => {
    resumePausedTasks().catch((error: unknown) => {
      toast.show({ message: resumeFailureMessage(error) })
    })
  }
  const switchable = switchableTasks(paused)
  const switchTo = async (model: string): Promise<void> => {
    setSwitching(true)
    for (const task of switchable) {
      try {
        await retryTask(task.id, model)
      } catch (error) {
        toast.show({ message: switchFailureMessage(error) })
      }
    }
    setSwitching(false)
  }
  const models: MenuEntry[] = []
  let group: AgentSource | null = null
  for (const option of offered) {
    const source = agentSource(option.id)
    if (offered.some(({ id }) => agentSource(id) === AgentSource.OpenRouter) && group !== source) {
      models.push({
        kind: MenuEntryKind.Heading,
        label: source === AgentSource.OpenRouter ? 'OpenRouter' : 'Anthropic account',
      })
      group = source
    }
    models.push({
      kind: MenuEntryKind.Item,
      label: option.name,
      checked: switchable.every((task) => findModel(offered, task.model)?.id === option.id),
      onSelect: () => {
        void switchTo(option.id)
      },
    })
  }

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
        {offersResumeNow(paused) && (
          <Button variant={ButtonVariant.Dark} size={ButtonSize.Small} disabled={switching} onClick={resumeNow}>
            Resume now
          </Button>
        )}
        {offersSwitchModel(paused) && (
          <Button
            variant={ButtonVariant.Dark}
            size={ButtonSize.Small}
            aria-haspopup="menu"
            aria-expanded={modelAnchor !== null}
            disabled={switching}
            onClick={(event) => {
              setModelAnchor(event.currentTarget)
            }}
          >
            {switching ? 'Switching…' : 'Switch model'}
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
