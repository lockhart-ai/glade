import { faCheck, faMinus, faShieldHalved, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { PermissionDecisionKind, PermissionRequestState, type PermissionRequest } from '../../shared/domain'
import { Button, ButtonVariant, Icon, IconSize, Input, useToast } from '../components'
import { classNames } from '../components/classNames'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import {
  callSummary,
  closedOutcome,
  InputLineKind,
  permissionBody,
  PermissionBodyKind,
  permissionTitle,
  showAllLabel,
  shownLines,
  subagentLabel,
  type InputLine,
  type PermissionBody,
  type SubagentOrigin,
} from './permissionCardModel'
import styles from './PermissionCard.module.css'

/** The accessible name of the card, open or closed. */
export const PERMISSION_CARD_NAME = 'Permission request'
/** What the note field asks for. */
export const NOTE_PLACEHOLDER = 'Tell the agent why (optional)'

/** The card's two answers, which share one tab stop: ← → move between them. */
enum Action {
  Allow = 'allow',
  Deny = 'deny',
}

/** What each kind of line starts with in the input block: an edit's removed and added lines are marked. */
const LINE_PREFIX: Readonly<Record<InputLineKind, string>> = {
  [InputLineKind.Plain]: '',
  [InputLineKind.Removed]: '- ',
  [InputLineKind.Added]: '+ ',
  [InputLineKind.Gap]: '',
}

const LINE_CLASS: Readonly<Record<InputLineKind, string | undefined>> = {
  [InputLineKind.Plain]: undefined,
  [InputLineKind.Removed]: styles.removed,
  [InputLineKind.Added]: styles.added,
  [InputLineKind.Gap]: styles.gap,
}

/** A command, change, content or JSON, in a monospace block, line by line. */
function InputBlock({ lines, label }: { readonly lines: readonly InputLine[]; readonly label: string }) {
  return (
    <pre aria-label={label} className={styles.block}>
      {lines.map((line, index) => (
        <span key={index} className={classNames(styles.line, LINE_CLASS[line.kind])}>
          {LINE_PREFIX[line.kind]}
          {line.text === '' ? ' ' : line.text}
        </span>
      ))}
    </pre>
  )
}

/** What the block holds, as its accessible name. */
function blockLabel(body: PermissionBody): string {
  switch (body.kind) {
    case PermissionBodyKind.Command:
      return 'Command'
    case PermissionBodyKind.FileChange:
      return 'Change'
    case PermissionBodyKind.FileContent:
      return 'Content'
    case PermissionBodyKind.Json:
      return 'Input'
  }
}

/**
 * The call's input: a command and what it's for, or a file and its change or content, or JSON. Long input is trimmed,
 * with Show all to see the rest (and Show less to trim it again).
 */
function CallInput({ body }: { readonly body: PermissionBody }): React.JSX.Element {
  const [all, setAll] = useState(false)
  const shown = shownLines(body.lines, all)
  return (
    <>
      {(body.kind === PermissionBodyKind.FileChange || body.kind === PermissionBodyKind.FileContent) && (
        <div className={styles.path}>{body.path}</div>
      )}
      <InputBlock lines={shown.lines} label={blockLabel(body)} />
      {(shown.trimmed || all) && (
        <button
          type="button"
          className={styles.showAll}
          aria-expanded={all}
          onClick={() => {
            setAll(!all)
          }}
        >
          {all ? 'Show less' : showAllLabel(body.lines)}
        </button>
      )}
      {body.kind === PermissionBodyKind.Command && body.description !== null && (
        <p className={styles.description}>{body.description}</p>
      )}
    </>
  )
}

interface OpenCardProps {
  readonly request: PermissionRequest
  readonly body: PermissionBody
  readonly subagent: SubagentOrigin | null
  readonly autoFocus: boolean
}

/**
 * The open card: what's asked, the call's input, and Allow once and Deny. Deny opens a note field for the agent; ↵ in it
 * denies with the note (or without one, left empty), and Esc or Cancel closes it again. The two answers are one tab
 * stop, ← → between them: it's Allow once, so ↵ approves, unless the SDK says a stray key mustn't (`defaultToNo`), when
 * it's Deny. Given `autoFocus`, the card takes the focus as it opens, unless you're somewhere else in the window.
 */
function OpenCard({ request, body, subagent, autoFocus }: OpenCardProps): React.JSX.Element {
  const answerPermission = useGladeStore((state) => state.answerPermission)
  const toast = useToast()
  const initial = request.defaultToNo ? Action.Deny : Action.Allow
  const [stop, setStop] = useState(initial)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const card = useRef<HTMLFormElement>(null)
  const allow = useRef<HTMLButtonElement>(null)
  const deny = useRef<HTMLButtonElement>(null)
  const noteField = useRef<HTMLInputElement>(null)
  // Whether the note field was opened or closed from the card, which then moves the focus: to it, or back to Deny.
  const moved = useRef(false)

  useEffect(() => {
    if (!autoFocus) return
    const active = document.activeElement
    const log = card.current?.closest('[role="log"]')
    // Only from nowhere, or from the chat itself: never away from a field you're typing in, or another panel.
    if (active !== null && active !== document.body && log?.contains(active) !== true) return
    ;(initial === Action.Deny ? deny : allow).current?.focus()
  }, [autoFocus, initial])

  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    ;(noting ? noteField : deny).current?.focus()
  }, [noting])

  const answer = (denied: boolean): void => {
    if (sending) return
    setSending(true)
    const text = note.trim()
    const decision = denied
      ? { kind: PermissionDecisionKind.Deny, ...(text === '' ? {} : { note: text }) }
      : { kind: PermissionDecisionKind.AllowOnce }
    answerPermission(request.id, decision).catch((error: unknown) => {
      setSending(false)
      toast.show({ message: `Couldn’t answer the permission request: ${describeFailure(error)}` })
    })
  }

  const openNote = (): void => {
    setStop(Action.Deny)
    setNoting(true)
    moved.current = true
  }

  const closeNote = (): void => {
    setNoting(false)
    moved.current = true
  }

  const act = (action: Action): void => {
    if (action === Action.Allow) answer(false)
    else openNote()
  }

  const onActionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, action: Action): void => {
    if (event.key === 'Enter') {
      // Act here rather than let the button turn ↵ into a click: that would come after the focus moved to the note
      // field, whose ↵ would then send the denial at once.
      event.preventDefault()
      act(action)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = action === Action.Allow ? Action.Deny : Action.Allow
    setStop(next)
    ;(next === Action.Allow ? allow : deny).current?.focus()
  }

  return (
    <form
      ref={card}
      aria-label={PERMISSION_CARD_NAME}
      className={classNames(styles.card, styles.open)}
      onSubmit={(event) => {
        event.preventDefault()
        answer(true)
      }}
    >
      <div className={styles.title}>
        <Icon icon={faShieldHalved} size={IconSize.Large} />
        <span className={styles.titleText}>{permissionTitle(request)}</span>
        {subagent !== null && <span className={styles.subagent}>{subagentLabel(subagent)}</span>}
      </div>
      <CallInput body={body} />
      {noting ? (
        // Keyed apart from the answers, so Deny's button isn't reused as the note's Deny, a submit button, while the
        // click that opened the note is still being handled: its default action would then send the denial at once.
        <div key="note" className={styles.actions}>
          <Input
            ref={noteField}
            label="Note for the agent"
            placeholder={NOTE_PLACEHOLDER}
            value={note}
            className={styles.note}
            onChange={(event) => {
              setNote(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                answer(true)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeNote()
              }
            }}
          />
          <Button type="submit" variant={ButtonVariant.Danger} aria-disabled={sending} icon={faXmark}>
            Deny
          </Button>
          <Button variant={ButtonVariant.Ghost} onClick={closeNote}>
            Cancel
          </Button>
        </div>
      ) : (
        <div key="answer" role="group" aria-label="Answer" className={styles.actions}>
          <Button
            ref={allow}
            variant={ButtonVariant.Primary}
            icon={faCheck}
            aria-disabled={sending}
            tabIndex={stop === Action.Allow ? 0 : -1}
            onFocus={() => {
              setStop(Action.Allow)
            }}
            onKeyDown={(event) => {
              onActionKeyDown(event, Action.Allow)
            }}
            onClick={() => {
              act(Action.Allow)
            }}
          >
            Allow once
          </Button>
          <Button
            ref={deny}
            variant={ButtonVariant.Ghost}
            aria-disabled={sending}
            tabIndex={stop === Action.Deny ? 0 : -1}
            onFocus={() => {
              setStop(Action.Deny)
            }}
            onKeyDown={(event) => {
              onActionKeyDown(event, Action.Deny)
            }}
            onClick={() => {
              act(Action.Deny)
            }}
          >
            Deny
          </Button>
        </div>
      )}
    </form>
  )
}

const CLOSED_ICON = {
  [PermissionRequestState.Allowed]: faCheck,
  [PermissionRequestState.Denied]: faXmark,
  [PermissionRequestState.Withdrawn]: faMinus,
} as const

const CLOSED_CLASS = {
  [PermissionRequestState.Allowed]: styles.allowed,
  [PermissionRequestState.Denied]: styles.denied,
  [PermissionRequestState.Withdrawn]: styles.withdrawn,
} as const

interface ClosedCardProps {
  readonly request: PermissionRequest
  readonly state: keyof typeof CLOSED_ICON
  readonly outcome: string
  readonly rootPath: string | undefined
}

/** A closed card, in one line: the call, and that it was allowed once, denied (with your note) or withdrawn. */
function ClosedCard({ request, state, outcome, rootPath }: ClosedCardProps): React.JSX.Element {
  const summary = callSummary(request, rootPath)
  return (
    <section
      aria-label={PERMISSION_CARD_NAME}
      title={`${summary} · ${outcome}`}
      className={classNames(styles.closed, CLOSED_CLASS[state])}
    >
      <Icon icon={CLOSED_ICON[state]} size={IconSize.Medium} className={styles.closedIcon} />
      <span className={styles.summary}>{summary}</span>
      <span aria-hidden className={styles.dot}>
        ·
      </span>
      <span className={styles.outcome}>{outcome}</span>
    </section>
  )
}

export interface PermissionCardProps {
  readonly request: PermissionRequest
  /** The task's workspace root, which the card shows file paths relative to. */
  readonly rootPath?: string | undefined
  /** Which subagent made the call; null for the agent's own. */
  readonly subagent: SubagentOrigin | null
  /** Whether an open card takes the focus (the first open one in the chat does). */
  readonly autoFocus?: boolean
}

/**
 * A tool call waiting on your OK, in the chat (`docs/design/html/23-permission-card.html`): open, the card you answer
 * it on; answered or withdrawn, one line saying what happened.
 */
export function PermissionCard({ request, rootPath, subagent, autoFocus = false }: PermissionCardProps) {
  const { state } = request
  if (state === PermissionRequestState.Open) {
    const body = permissionBody(request, rootPath)
    return <OpenCard request={request} body={body} subagent={subagent} autoFocus={autoFocus} />
  }
  return <ClosedCard request={request} state={state} outcome={closedOutcome(request) ?? ''} rootPath={rootPath} />
}
