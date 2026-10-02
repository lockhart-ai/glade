import { faCircleQuestion } from '@fortawesome/free-regular-svg-icons'
import { faArrowUp } from '@fortawesome/free-solid-svg-icons'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  QuestionKind,
  QuestionReplyKind,
  type ChoiceOption,
  type ChoiceQuestion,
  type PillsQuestion,
  type Question,
  type QuestionSet,
  type TextQuestion,
} from '../../shared/domain'
import { tidyAnythingElse } from '../../shared/questions'
import { Markdown } from '../chat/Markdown'
import { Button, ButtonVariant, Icon, IconSize, Input, Textarea, useToast } from '../components'
import { classNames } from '../components/classNames'
import { LinkedText } from '../links'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import {
  ANYTHING_ELSE_PLACEHOLDER,
  ANYTHING_ELSE_PROMPT,
  answeredLabel,
  answersToSend,
  answerText,
  cardTitle,
  closedAs,
  closedTitle,
  ClosedAs,
  optionValues,
  pick,
  picked,
  sendLabel,
  sketchLines,
  takesMany,
  typed,
  type AnswerDraft,
} from './questionCardModel'
import styles from './QuestionCard.module.css'

/** The accessible name of the card, open or closed. */
export const QUESTION_CARD_NAME = 'Questions from the agent'

/** What marks text in the card's preamble: the sidebar's search, as in the chat's replies (`highlightPattern`). */
interface HighlightProps {
  readonly highlight?: RegExp | null | undefined
}

export interface QuestionCardProps extends HighlightProps {
  readonly questionSet: QuestionSet
}

/**
 * What the agent said before its questions, at the top of the card: its reply to your message, rendered as a chat
 * reply is. Nothing for a set asked without one.
 */
function Preamble({ questionSet, highlight }: QuestionCardProps) {
  if (questionSet.preamble === null) return null
  return <Markdown source={questionSet.preamble} highlight={highlight ?? null} className={styles.preamble} />
}

/** Where a key moves the focus within the card: a question, the "Anything else?" box, or Send. */
type Move = { readonly question: number } | 'anythingElse' | 'send'

interface OptionKeys {
  /** The question's index in the set. */
  readonly question: number
  /** The option's index in the question. */
  readonly option: number
}

interface QuestionBodyProps {
  readonly index: number
  readonly draft: AnswerDraft
  /** The option that holds the question's tab stop. */
  readonly stop: number
  readonly onPick: (value: string, option: number) => void
  readonly onFocusOption: (option: number) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>, keys: OptionKeys) => void
}

/** A choice option's sketch: its lines in a small monospace frame, headings in the accent colour. */
function Sketch({ sketch }: { readonly sketch: string }): React.JSX.Element {
  return (
    <span aria-hidden className={styles.sketch}>
      {sketchLines(sketch).map((line, index) => (
        <span key={index} className={classNames(styles.sketchLine, line.heading && styles.sketchHeading)}>
          {line.text === '' ? ' ' : line.text}
        </span>
      ))}
    </span>
  )
}

interface OptionCardProps {
  readonly option: ChoiceOption
  readonly checked: boolean
  readonly many: boolean
  readonly tabStop: boolean
  readonly onPick: () => void
  readonly onFocus: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/** One option card of a choice question: its sketch, if any, then a radio (or checkbox), its label and detail. */
function OptionCard({ option, checked, many, tabStop, onPick, onFocus, onKeyDown }: OptionCardProps) {
  const id = useId()
  return (
    <button
      type="button"
      role={many ? 'checkbox' : 'radio'}
      aria-checked={checked}
      aria-labelledby={`${id}-label`}
      aria-describedby={option.detail === undefined ? undefined : `${id}-detail`}
      tabIndex={tabStop ? 0 : -1}
      className={classNames(styles.option, checked && styles.checked)}
      onClick={onPick}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      {option.sketch !== undefined && <Sketch sketch={option.sketch} />}
      <span className={styles.optionRow}>
        <span aria-hidden className={classNames(many ? styles.box : styles.radio, checked && styles.on)} />
        <span className={styles.optionText}>
          <span id={`${id}-label`} className={styles.optionLabel}>
            {option.label}
          </span>
          {option.detail !== undefined && (
            <span id={`${id}-detail`} className={styles.optionDetail}>
              {option.detail}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}

function ChoiceBody({ question, ...props }: QuestionBodyProps & { readonly question: ChoiceQuestion }) {
  const { index, draft, stop, onPick, onFocusOption, onKeyDown } = props
  const values = picked(draft, index)
  const many = takesMany(question)
  return question.options.map((option, optionIndex) => (
    <OptionCard
      key={option.id}
      option={option}
      checked={values.includes(option.id)}
      many={many}
      tabStop={optionIndex === stop}
      onPick={() => {
        onPick(option.id, optionIndex)
      }}
      onFocus={() => {
        onFocusOption(optionIndex)
      }}
      onKeyDown={(event) => {
        onKeyDown(event, { question: index, option: optionIndex })
      }}
    />
  ))
}

function PillsBody({ question, ...props }: QuestionBodyProps & { readonly question: PillsQuestion }) {
  const { index, draft, stop, onPick, onFocusOption, onKeyDown } = props
  const values = picked(draft, index)
  const many = takesMany(question)
  return question.options.map((pill, optionIndex) => {
    const checked = values.includes(pill)
    return (
      <button
        key={pill}
        type="button"
        role={many ? 'checkbox' : 'radio'}
        aria-checked={checked}
        tabIndex={optionIndex === stop ? 0 : -1}
        className={classNames(styles.pill, checked && styles.checked)}
        onClick={() => {
          onPick(pill, optionIndex)
        }}
        onFocus={() => {
          onFocusOption(optionIndex)
        }}
        onKeyDown={(event) => {
          onKeyDown(event, { question: index, option: optionIndex })
        }}
      >
        {pill}
      </button>
    )
  })
}

interface TextBodyProps {
  readonly question: TextQuestion
  readonly index: number
  readonly draft: AnswerDraft
  readonly onType: (text: string) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

function TextBody({ question, index, draft, onType, onKeyDown }: TextBodyProps): React.JSX.Element {
  const answer = draft[String(index)]
  return (
    <Input
      label={question.prompt}
      placeholder={question.placeholder}
      value={typeof answer === 'string' ? answer : ''}
      className={styles.text}
      onChange={(event) => {
        onType(event.target.value)
      }}
      onKeyDown={onKeyDown}
    />
  )
}

/** A question's number and prompt. Every question is optional, so none is marked as such. */
function Prompt({ question, index, id }: { readonly question: Question; readonly index: number; readonly id: string }) {
  return (
    <div className={styles.prompt}>
      <span className={styles.number}>{index + 1}</span>
      <span id={id} className={styles.promptText}>
        <LinkedText text={question.prompt} />
      </span>
    </div>
  )
}

interface AnythingElseProps {
  readonly text: string
  readonly onType: (text: string) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * The "Anything else?" box at the foot of every open card, below the last question: a note in your own words, sent
 * with the answers, or alone.
 */
function AnythingElse({ text, onType, onKeyDown }: AnythingElseProps): React.JSX.Element {
  return (
    <div className={styles.question}>
      <div className={styles.prompt}>
        <span className={styles.promptText}>{ANYTHING_ELSE_PROMPT}</span>
      </div>
      <Textarea
        label={ANYTHING_ELSE_PROMPT}
        placeholder={ANYTHING_ELSE_PLACEHOLDER}
        value={text}
        data-anything-else
        className={styles.anythingElse}
        onChange={(event) => {
          onType(event.target.value)
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}

interface OpenQuestionProps extends QuestionBodyProps {
  readonly question: Question
  readonly onType: (text: string) => void
  readonly onTextKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/** One open question: its prompt, then its options (a radio group, or a group of checkboxes) or its text field. */
function OpenQuestion({ question, onType, onTextKeyDown, ...props }: OpenQuestionProps): React.JSX.Element {
  const promptId = useId()
  const { index } = props
  if (question.kind === QuestionKind.Text) {
    return (
      <div className={styles.question} data-question={index}>
        <Prompt question={question} index={index} id={promptId} />
        <TextBody question={question} index={index} draft={props.draft} onType={onType} onKeyDown={onTextKeyDown} />
      </div>
    )
  }
  return (
    <div className={styles.question}>
      <Prompt question={question} index={index} id={promptId} />
      <div
        role={takesMany(question) ? 'group' : 'radiogroup'}
        aria-labelledby={promptId}
        data-question={index}
        className={question.kind === QuestionKind.Choice ? styles.options : styles.pills}
      >
        {question.kind === QuestionKind.Choice ? (
          <ChoiceBody question={question} {...props} />
        ) : (
          <PillsBody question={question} {...props} />
        )}
      </div>
    </div>
  )
}

/** Which option holds each question's tab stop: the one you last focused, else the first picked, else the first. */
function tabStop(question: Question, draft: AnswerDraft, index: number, focused: number | undefined): number {
  if (focused !== undefined) return focused
  const first = picked(draft, index)[0]
  return first === undefined ? 0 : Math.max(0, optionValues(question).indexOf(first))
}

/**
 * The open card: each question with its options or text field, the "Anything else?" box, "N of M answered" and Send
 * answers (Skip questions, with nothing answered or typed). Every question is optional, so it sends whatever you've
 * answered, none included. The keyboard answers it on its own: Tab moves between the questions (one stop each), the box
 * and Send, ← → between a question's options, ↑ ↓ between the questions, the box and Send, 1–9 pick the focused
 * question's options, Space picks the focused one, and ↵ sends (⌘↵ in the box, where ↵ starts a new line).
 */
interface OpenCardProps extends QuestionCardProps {
  readonly appear: boolean
}

function OpenCard({ questionSet, appear, highlight }: OpenCardProps) {
  const { questions } = questionSet
  const answerQuestions = useGladeStore((state) => state.answerQuestions)
  const toast = useToast()
  const [draft, setDraft] = useState<AnswerDraft>({})
  const [anythingElse, setAnythingElse] = useState('')
  const [focused, setFocused] = useState<Readonly<Record<number, number>>>({})
  const [sending, setSending] = useState(false)
  const card = useRef<HTMLFormElement>(null)
  const answers = answersToSend(questions, draft)
  const ready = answers !== null && !sending

  const send = (): void => {
    if (!ready) return
    setSending(true)
    answerQuestions(questionSet.id, answers, tidyAnythingElse(anythingElse)).catch((error: unknown) => {
      setSending(false)
      toast.show({ message: `Couldn’t send your answers: ${describeFailure(error)}` })
    })
  }

  const focus = (move: Move): void => {
    const root = card.current
    if (root === null) return
    const target =
      move === 'send'
        ? root.querySelector<HTMLElement>('[data-send]')
        : move === 'anythingElse'
          ? root.querySelector<HTMLElement>('[data-anything-else]')
          : root.querySelector<HTMLElement>(
              `[data-question="${String(move.question)}"] [tabindex="0"], [data-question="${String(move.question)}"] input`,
            )
    target?.focus()
  }

  /** ↑ ↓ to the question before or after, or from the last question down to the "Anything else?" box. */
  const moveBetweenQuestions = (event: KeyboardEvent<HTMLElement>, question: number): boolean => {
    if (event.key === 'ArrowUp') {
      if (question > 0) focus({ question: question - 1 })
      return true
    }
    if (event.key !== 'ArrowDown') return false
    focus(question < questions.length - 1 ? { question: question + 1 } : 'anythingElse')
    return true
  }

  /**
   * In the "Anything else?" box, ↵ starts a new line and ⌘↵ (or ⌃↵) sends. ↑ on its first line's start goes back to
   * the last question, and ↓ at its end on to Send; elsewhere the arrows move the caret.
   */
  const onAnythingElseKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const box = event.currentTarget
    const caretAt = box.selectionStart === box.selectionEnd ? box.selectionStart : null
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) send()
    else if (event.key === 'ArrowUp' && !event.shiftKey && caretAt === 0) focus({ question: questions.length - 1 })
    else if (event.key === 'ArrowDown' && !event.shiftKey && caretAt === box.value.length) focus('send')
    else return
    event.preventDefault()
  }

  const pickOption = (index: number, option: number): void => {
    const question = questions[index]
    const value = question === undefined ? undefined : optionValues(question)[option]
    if (question === undefined || value === undefined) return
    setDraft((current) => pick(current, question, index, value))
    setFocused((current) => ({ ...current, [index]: option }))
  }

  const onOptionKeyDown = (event: KeyboardEvent<HTMLElement>, { question, option }: OptionKeys): void => {
    const current = questions[question]
    if (current === undefined) return
    const count = optionValues(current).length
    const many = takesMany(current)
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step !== 0) {
      const next = (option + step + count) % count
      // Arrows move the focus; in a radio group they pick too, as a radio group's arrows do.
      if (many) setFocused((was) => ({ ...was, [question]: next }))
      else pickOption(question, next)
      const group = card.current?.querySelector(`[data-question="${String(question)}"]`)
      group?.querySelectorAll<HTMLElement>('button')[next]?.focus()
    } else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const target = Number(event.key) - 1
      if (target >= count) return
      pickOption(question, target)
      const group = card.current?.querySelector(`[data-question="${String(question)}"]`)
      group?.querySelectorAll<HTMLElement>('button')[target]?.focus()
    } else if (event.key === 'Enter') {
      send()
    } else if (!moveBetweenQuestions(event, question)) {
      return
    }
    event.preventDefault()
  }

  const onTextKeyDown = (event: KeyboardEvent<HTMLElement>, question: number): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) send()
    else if (!moveBetweenQuestions(event, question)) return
    event.preventDefault()
  }

  return (
    <form
      ref={card}
      aria-label={QUESTION_CARD_NAME}
      className={classNames(styles.card, styles.open, appear && styles.appearing)}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <Preamble questionSet={questionSet} highlight={highlight} />
      <div className={styles.title}>
        <Icon icon={faCircleQuestion} size={IconSize.Large} />
        {cardTitle(questions)}
      </div>
      {questions.map((question, index) => (
        <OpenQuestion
          key={index}
          question={question}
          index={index}
          draft={draft}
          stop={tabStop(question, draft, index, focused[index])}
          onPick={(_value, option) => {
            pickOption(index, option)
          }}
          onFocusOption={(option) => {
            setFocused((current) => (current[index] === option ? current : { ...current, [index]: option }))
          }}
          onKeyDown={onOptionKeyDown}
          onType={(text) => {
            setDraft((current) => typed(current, index, text))
          }}
          onTextKeyDown={(event) => {
            onTextKeyDown(event, index)
          }}
        />
      ))}
      <AnythingElse text={anythingElse} onType={setAnythingElse} onKeyDown={onAnythingElseKeyDown} />
      <div className={styles.footer}>
        <Button
          type="submit"
          variant={ButtonVariant.Primary}
          icon={faArrowUp}
          aria-disabled={!ready}
          data-send
          className={classNames(styles.send, !ready && styles.sendOff)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp') return
            event.preventDefault()
            focus('anythingElse')
          }}
        >
          {sendLabel(questions, draft, anythingElse)}
        </Button>
        <span aria-live="polite" className={styles.count}>
          {answeredLabel(questions, draft)}
        </span>
      </div>
    </form>
  )
}

/**
 * A closed card: what was asked, and each answer or that it was skipped, with anything else you typed; or that it was
 * answered in words, or withdrawn.
 */
interface ClosedCardProps extends QuestionCardProps {
  readonly closed: ClosedAs
  /** Whether it has just closed, in view: it then fades in over the open card it replaces. */
  readonly fadeIn: boolean
}

function ClosedCard({ questionSet, closed, fadeIn, highlight }: ClosedCardProps) {
  const { questions, reply } = questionSet
  const answers = reply?.kind === QuestionReplyKind.Answers ? reply.answers : {}
  const anythingElse = reply?.kind === QuestionReplyKind.Answers ? reply.anythingElse : undefined
  const showsAnswers = closed === ClosedAs.Answers || closed === ClosedAs.Skipped
  return (
    <section
      aria-label={QUESTION_CARD_NAME}
      className={classNames(
        styles.card,
        closed === ClosedAs.Withdrawn && styles.withdrawn,
        fadeIn && styles.justClosed,
      )}
    >
      <Preamble questionSet={questionSet} highlight={highlight} />
      <div className={styles.closedTitle}>
        <Icon icon={faCircleQuestion} size={IconSize.Large} />
        {closedTitle(questions, closed)}
      </div>
      <dl className={styles.answers}>
        {questions.map((question, index) => (
          <div key={index} className={styles.answer}>
            <dt className={styles.prompt}>
              <span className={styles.number}>{index + 1}</span>
              <span className={styles.promptText}>
                <LinkedText text={question.prompt} />
              </span>
            </dt>
            {showsAnswers && (
              <dd className={classNames(styles.answerText, answers[String(index)] === undefined && styles.skipped)}>
                <LinkedText text={answerText(question, answers[String(index)])} />
              </dd>
            )}
          </div>
        ))}
        {anythingElse !== undefined && (
          <div className={styles.answer}>
            <dt className={styles.prompt}>
              <span className={styles.promptText}>{ANYTHING_ELSE_PROMPT}</span>
            </dt>
            <dd className={classNames(styles.answerText, styles.note)}>
              <LinkedText text={anythingElse} />
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}

/**
 * How recently a question set was asked for its card to rise into view as it shows: it arrived while you were looking,
 * or you opened its task just as it did. A card for an older question, shown as its chat opens, stays put.
 */
export const APPEAR_WINDOW_MS = 2000

/**
 * The agent's questions in the chat (`docs/design/html/03-rich-question.html`): a card you answer while they're open,
 * which closes once they're answered (showing the answers, or that you answered in your own words) or withdrawn. The
 * agent's preamble, if it gave one, leads the card, open or closed. A card that has just been asked rises and fades in,
 * and one that closes while it's showing fades to its closed state.
 */
export function QuestionCard({ questionSet, highlight }: QuestionCardProps): React.JSX.Element {
  const closed = closedAs(questionSet)
  // Whether it was open when it showed, so its closing happens in view, and whether it had just been asked.
  const [shownOpen] = useState(closed === null)
  const [appear] = useState(() => Date.now() - questionSet.createdAt < APPEAR_WINDOW_MS)
  return closed === null ? (
    <OpenCard questionSet={questionSet} appear={appear} highlight={highlight} />
  ) : (
    <ClosedCard questionSet={questionSet} closed={closed} fadeIn={shownOpen} highlight={highlight} />
  )
}
