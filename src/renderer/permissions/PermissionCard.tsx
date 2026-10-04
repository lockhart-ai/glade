import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { PermissionDecisionKind, type PermissionDecision, type PermissionRequest } from '../../shared/domain'
import { SandboxAskKind, type SandboxAsk } from '../../shared/sandbox'
import { Button, ButtonVariant, CopyBlockButton, Icon, IconSize, Input, useToast } from '../components'
import { classNames } from '../components/classNames'
import { LinkedText } from '../links'
import { APPEAR_WINDOW_MS } from '../questions/QuestionCard'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import {
  InputLineKind,
  permissionBody,
  PermissionBodyKind,
  permissionTitle,
  reasonParts,
  sandboxDetail,
  SandboxDetailKind,
  sandboxTitle,
  showAllLabel,
  shownLines,
  subagentLabel,
  taskGrant,
  TaskGrantKind,
  taskGrantWords,
  type InputLine,
  type PermissionBody,
  type SandboxDetail,
  type SubagentOrigin,
  type TaskGrant,
} from './permissionCardModel'
import { PERMISSION_SHIELD } from './PermissionLine'
import styles from './PermissionCard.module.css'

/** The accessible name of the card. */
export const PERMISSION_CARD_NAME = 'Permission request'
/** What the note field asks for. */
export const NOTE_PLACEHOLDER = 'Tell the agent why (optional)'

/** The card's answers, which share one tab stop: ← → move between them. */
enum Action {
  Allow = 'allow',
  AllowForTask = 'allow_for_task',
  AllowForWorkspace = 'allow_for_workspace',
  Deny = 'deny',
}

/** The answers a card offers, in order; the first is the one ↵ gives, unless the card opens on Deny. */
function actionsFor(sandbox: SandboxAsk | null, grant: TaskGrant | null): readonly Action[] {
  // A folder or domain is granted to the task or the workspace, never once.
  if (sandbox !== null && sandbox.kind !== SandboxAskKind.Outside) {
    return [Action.AllowForTask, Action.AllowForWorkspace, Action.Deny]
  }
  return grant === null ? [Action.Allow, Action.Deny] : [Action.Allow, Action.AllowForTask, Action.Deny]
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

/** The block's exact text, real newlines between its lines (#352): what a copy of it gets, blank lines and all. */
function blockText(lines: readonly InputLine[]): string {
  return lines.map((line) => `${LINE_PREFIX[line.kind]}${line.text}`).join('\n')
}

/**
 * A command, change, content or JSON, in a monospace block, line by line, with a copy icon in its corner (#352):
 * shown on hover and on focus, it copies what's shown (the whole block, or its trimmed lines until Show all).
 */
function InputBlock({ lines, label }: { readonly lines: readonly InputLine[]; readonly label: string }) {
  return (
    <div className={styles.blockWrapper}>
      <pre aria-label={label} className={styles.block}>
        {lines.map((line, index) => (
          <span key={index} className={classNames(styles.line, LINE_CLASS[line.kind])}>
            {LINE_PREFIX[line.kind]}
            {line.text === '' ? ' ' : line.text}
          </span>
        ))}
      </pre>
      <CopyBlockButton getText={() => blockText(lines)} className={styles.blockCopy} />
    </div>
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
        <p className={styles.description}>
          <LinkedText text={body.description} />
        </p>
      )}
    </>
  )
}

/** Allow for this task's label: what it grants, a command or prefix set as code. */
function TaskGrantText({ grant }: { readonly grant: TaskGrant }): React.JSX.Element {
  const { before, after } = taskGrantWords(grant)
  if (grant.kind === TaskGrantKind.Tool) return <>{`${before} ${grant.subject} ${after}`}</>
  return (
    <>
      {before}{' '}
      <code className={styles.grantSubject} title={grant.subject}>
        {grant.subject}
      </code>{' '}
      {after}
    </>
  )
}

/** What a sandbox card shows under its title (`sandboxDetail`). */
function SandboxDetails({ detail }: { readonly detail: SandboxDetail }): React.JSX.Element | null {
  switch (detail.kind) {
    case SandboxDetailKind.None:
      return null
    case SandboxDetailKind.Target:
      return (
        <div className={styles.target}>
          <span className={styles.targetTool}>{detail.tool}</span>
          <span className={styles.path}>{detail.target}</span>
        </div>
      )
    case SandboxDetailKind.Reason:
      return (
        <p className={styles.description}>
          {reasonParts(detail.reason).map((part, index) =>
            part.code ? (
              <code key={index} className={styles.reasonCode}>
                {part.text}
              </code>
            ) : (
              <LinkedText key={index} text={part.text} />
            ),
          )}
        </p>
      )
    case SandboxDetailKind.Command:
      return (
        <>
          {detail.note !== null && <p className={styles.description}>{detail.note}</p>}
          <CallInput body={detail.body} />
        </>
      )
  }
}

/** A sandbox card's title: what the agent wants, the folder or domain set as code. */
function SandboxTitleText({ ask }: { readonly ask: SandboxAsk }): React.JSX.Element {
  const { text, subject } = sandboxTitle(ask)
  return (
    <span className={classNames(styles.titleText, styles.sandboxTitle)}>
      {text}
      {subject !== null && <code className={styles.titleSubject}>{subject}</code>}
    </span>
  )
}

interface OpenCardProps {
  readonly request: PermissionRequest
  /** The call's input, as a card that isn't the sandbox's shows it. */
  readonly body: PermissionBody
  readonly subagent: SubagentOrigin | null
  readonly autoFocus: boolean
  /** Whether it has just asked: it then rises and fades in, as the question card does. */
  readonly appear: boolean
}

/**
 * The open card: what's asked, the call's input, and its answers. A call in the ask mode offers Allow once, Allow for
 * this task (when it's offered: `taskGrant`) and Deny. A sandbox request for a folder or domain
 * (`docs/design/html/42-sandbox-folder-card.html`, `43-sandbox-domain-card.html`) offers Allow for this task, Allow
 * for this workspace and Deny, and one to run a command outside the sandbox (`44-sandbox-outside-card.html`) only
 * Allow once and Deny. Deny opens a note field for the agent; ↵ in it denies with the note (or without one, left
 * empty), and Esc or Cancel closes it again. The answers are one tab stop, ← → between them: it's the first, so ↵
 * approves, unless the SDK says a stray key mustn't (`defaultToNo`), when it's Deny. Given `autoFocus`, the card takes
 * the focus as it opens, unless you're somewhere else in the window.
 */
function OpenCard({ request, body, subagent, autoFocus, appear }: OpenCardProps): React.JSX.Element {
  const answerPermission = useGladeStore((state) => state.answerPermission)
  const toast = useToast()
  const { sandbox } = request
  const grant = sandbox === null ? taskGrant(request) : null
  const actions = actionsFor(sandbox, grant)
  const first = actions[0] ?? Action.Deny
  const initial = request.defaultToNo ? Action.Deny : first
  const [stop, setStop] = useState(initial)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const card = useRef<HTMLFormElement>(null)
  const buttons = useRef(new Map<Action, HTMLButtonElement>())
  const noteField = useRef<HTMLInputElement>(null)
  // Whether the note field was opened or closed from the card, which then moves the focus: to it, or back to Deny.
  const moved = useRef(false)

  useEffect(() => {
    if (!autoFocus) return
    const active = document.activeElement
    const log = card.current?.closest('[role="log"]')
    // Only from nowhere, or from the chat itself: never away from a field you're typing in, or another panel.
    if (active !== null && active !== document.body && log?.contains(active) !== true) return
    buttons.current.get(initial)?.focus()
  }, [autoFocus, initial])

  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    if (noting) noteField.current?.focus()
    else buttons.current.get(Action.Deny)?.focus()
  }, [noting])

  const answer = (decision: PermissionDecision): void => {
    if (sending) return
    setSending(true)
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

  const denyWithNote = (): void => {
    const text = note.trim()
    answer({ kind: PermissionDecisionKind.Deny, ...(text === '' ? {} : { note: text }) })
  }

  const act = (action: Action): void => {
    switch (action) {
      case Action.Allow:
        answer({ kind: PermissionDecisionKind.AllowOnce })
        return
      case Action.AllowForTask:
        answer({ kind: PermissionDecisionKind.AllowForTask })
        return
      case Action.AllowForWorkspace:
        answer({ kind: PermissionDecisionKind.AllowForWorkspace })
        return
      case Action.Deny:
        openNote()
    }
  }

  /** What an answer's button says: Allow for this task names what it grants, but for a folder or domain's. */
  const label = (action: Action): ReactNode => {
    switch (action) {
      case Action.Allow:
        return 'Allow once'
      case Action.AllowForTask:
        return grant === null ? 'Allow for this task' : <TaskGrantText grant={grant} />
      case Action.AllowForWorkspace:
        return 'Allow for this workspace'
      case Action.Deny:
        return 'Deny'
    }
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
    const step = event.key === 'ArrowRight' ? 1 : actions.length - 1
    const next = actions[(actions.indexOf(action) + step) % actions.length] ?? action
    setStop(next)
    buttons.current.get(next)?.focus()
  }

  return (
    <form
      ref={card}
      aria-label={PERMISSION_CARD_NAME}
      className={classNames(styles.card, styles.open, appear && styles.appearing)}
      onSubmit={(event) => {
        event.preventDefault()
        denyWithNote()
      }}
    >
      <div className={styles.title}>
        <Icon icon={PERMISSION_SHIELD} size={IconSize.Large} />
        {sandbox === null ? (
          <span className={styles.titleText}>{permissionTitle(request)}</span>
        ) : (
          <SandboxTitleText ask={sandbox} />
        )}
        {subagent !== null && <span className={styles.subagent}>{subagentLabel(subagent)}</span>}
      </div>
      {sandbox === null ? <CallInput body={body} /> : <SandboxDetails detail={sandboxDetail(request, sandbox)} />}
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
                denyWithNote()
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
          {actions.map((action) => (
            <Button
              key={action}
              ref={(button) => {
                if (button === null) buttons.current.delete(action)
                else buttons.current.set(action, button)
              }}
              variant={action === first ? ButtonVariant.Primary : ButtonVariant.Ghost}
              {...(action === first ? { icon: faCheck } : {})}
              {...(action === Action.AllowForTask && grant !== null ? { className: styles.grant } : {})}
              aria-disabled={sending}
              tabIndex={stop === action ? 0 : -1}
              onFocus={() => {
                setStop(action)
              }}
              onKeyDown={(event) => {
                onActionKeyDown(event, action)
              }}
              onClick={() => {
                act(action)
              }}
            >
              {label(action)}
            </Button>
          ))}
        </div>
      )}
    </form>
  )
}

export interface PermissionCardProps {
  /** An open request: the card shows only while it waits on you. */
  readonly request: PermissionRequest
  /** The task's workspace root, which the card shows file paths relative to. */
  readonly rootPath?: string | undefined
  /** Which subagent made the call; null for the agent's own. */
  readonly subagent: SubagentOrigin | null
  /** Whether the card takes the focus (the first one in the chat does). */
  readonly autoFocus?: boolean
}

/**
 * A tool call waiting on your OK, in the chat (`docs/design/html/23-permission-card.html`): the card you answer it on.
 * Like the question card, one that has just asked rises and fades in. The chat shows it only while its request is open
 * (#459): once it's answered or withdrawn it leaves the chat, and what was decided shows on its call's row in the Tool
 * calls list (`PermissionLine`).
 */
export function PermissionCard({ request, rootPath, subagent, autoFocus = false }: PermissionCardProps) {
  // Whether it had just asked when it showed.
  const [appear] = useState(() => Date.now() - request.createdAt < APPEAR_WINDOW_MS)
  const body = permissionBody(request, rootPath)
  return <OpenCard request={request} body={body} subagent={subagent} autoFocus={autoFocus} appear={appear} />
}
