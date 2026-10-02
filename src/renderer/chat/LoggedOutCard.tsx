import { faRightToBracket } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import type { Task, TaskError } from '../../shared/domain'
import { LoginState, type LoginStatus } from '../../shared/login'
import { errorOpening, isStoppedLoggedOut, LOGGED_OUT_TITLE, NOTHING_LOST } from '../../shared/taskError'
import { Button, ButtonSize, ButtonVariant, Icon, IconSize, useToast } from '../components'
import { useGladeStore } from '../store/react'
import { loginFailureMessage, retryFailureMessage } from './cardFailures'
import styles from './ErrorCard.module.css'

export interface LoggedOutCardProps {
  /** The task a lost login stopped. */
  readonly task: Task
  /** The error it stopped on: a lost login. */
  readonly error: TaskError
}

/** The label of Retry all, for the tasks a lost login stops: `Retry all 3 tasks`. */
export function retryAllLabel(count: number): string {
  return `Retry all ${String(count)} tasks`
}

/** What the card says of logging in, after what happened, for where logging in stands and whether this task asked. */
export function loginSentence(login: LoginStatus, taskId: string): string {
  switch (login.state) {
    case LoginState.Idle:
      return 'Log in, and Claude Code’s sign-in page opens in your browser.'
    case LoginState.Waiting:
      return login.taskIds.includes(taskId)
        ? 'Finish logging in in your browser: this task carries on once you’re in.'
        : 'Finish logging in in your browser, then retry this task.'
    case LoginState.LoggedIn:
      return 'You’re logged in again: retry to carry on.'
    case LoginState.Failed:
      return `Logging in didn’t finish: ${login.message.replace(/\.?$/, '.')}`
  }
}

/**
 * The card at the end of the chat when a lost login stopped the agent (#409, `docs/design/html/38-logged-out.html`),
 * in the error card's style: what happened, where logging in stands, that nothing is lost, and the ways on. Log in
 * runs Claude Code's own login, which opens the browser, and retries this task once you're in; while it runs, Cancel
 * stops it. Retry runs the turn again (once you've logged in some other way, say), and Retry all every task a lost
 * login stops, when there's more than this one. Show details shows the raw error.
 */
export function LoggedOutCard({ task, error }: LoggedOutCardProps): React.JSX.Element {
  const retryTask = useGladeStore((state) => state.retryTask)
  const retryLoggedOut = useGladeStore((state) => state.retryLoggedOut)
  const startLogin = useGladeStore((state) => state.startLogin)
  const cancelLogin = useGladeStore((state) => state.cancelLogin)
  const login = useGladeStore((state) => state.login)
  const loggedOut = useGladeStore((state) => Object.values(state.tasks).filter(isStoppedLoggedOut).length)
  const toast = useToast()
  const [detailsShown, setDetailsShown] = useState(false)
  const waiting = login.state === LoginState.Waiting
  const loggedIn = login.state === LoginState.LoggedIn

  const failed = (message: (error: unknown) => string) => (failure: unknown) => {
    toast.show({ message: message(failure) })
  }
  const retry = (): void => {
    retryTask(task.id).catch(failed(retryFailureMessage))
  }

  return (
    <div role="alert" className={styles.card}>
      <div className={styles.title}>
        <Icon icon={faRightToBracket} size={IconSize.Medium} />
        {LOGGED_OUT_TITLE}
      </div>
      <p className={styles.text}>
        {errorOpening(error).lead} {loginSentence(login, task.id)} {NOTHING_LOST}
      </p>
      <div className={styles.actions}>
        {waiting ? (
          <>
            <Button variant={ButtonVariant.Dark} size={ButtonSize.Small} className={styles.action} disabled>
              Waiting for the browser…
            </Button>
            <Button
              variant={ButtonVariant.Ghost}
              size={ButtonSize.Small}
              className={styles.action}
              onClick={() => {
                cancelLogin().catch(failed(loginFailureMessage))
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            {!loggedIn && (
              <Button
                variant={ButtonVariant.Dark}
                size={ButtonSize.Small}
                className={styles.action}
                onClick={() => {
                  startLogin(task.id).catch(failed(loginFailureMessage))
                }}
              >
                Log in
              </Button>
            )}
            <Button
              variant={loggedIn ? ButtonVariant.Dark : ButtonVariant.Ghost}
              size={ButtonSize.Small}
              className={styles.action}
              onClick={retry}
            >
              Retry
            </Button>
            {loggedOut > 1 && (
              <Button
                variant={ButtonVariant.Ghost}
                size={ButtonSize.Small}
                className={styles.action}
                onClick={() => {
                  retryLoggedOut().catch(failed(retryFailureMessage))
                }}
              >
                {retryAllLabel(loggedOut)}
              </Button>
            )}
          </>
        )}
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
      </div>
      {detailsShown && (
        <pre aria-label="Error details" className={styles.details}>
          {error.details}
        </pre>
      )}
    </div>
  )
}
