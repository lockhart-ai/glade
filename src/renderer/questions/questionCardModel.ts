/**
 * What the question card (`docs/design/html/03-rich-question.html`) works out from a question set and your answers so
 * far: what each question's answer is, how many are answered, whether they can be sent, and what an answered set says.
 */
import {
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  type Question,
  type QuestionAnswer,
  type QuestionAnswers,
  type QuestionSet,
} from '../../shared/domain'
import { checkAnswers } from '../../shared/questions'

/**
 * Your answers so far, keyed by question index from 0 like `QuestionAnswers`: a choice's option id or a pill's text (an
 * array of them for a question that takes more than one), or the text typed.
 */
export type AnswerDraft = Readonly<Record<string, QuestionAnswer>>

/** The values a question's options answer with: a choice's option ids, or the pills' texts. None for a text question. */
export function optionValues(question: Question): readonly string[] {
  switch (question.kind) {
    case QuestionKind.Choice:
      return question.options.map(({ id }) => id)
    case QuestionKind.Pills:
      return question.options
    case QuestionKind.Text:
      return []
  }
}

/** Whether a question takes more than one of its options. */
export function takesMany(question: Question): boolean {
  return question.kind !== QuestionKind.Text && question.multiple === true
}

/** The values picked for a question in the draft: none, one, or with `multiple`, any number. */
export function picked(draft: AnswerDraft, index: number): readonly string[] {
  const answer = draft[String(index)]
  if (answer === undefined) return []
  return typeof answer === 'string' ? [answer] : answer
}

/**
 * The draft with an option picked: for a question that takes one, it replaces the answer; for one that takes more, it
 * goes in or, if it's already in, comes out.
 */
export function pick(draft: AnswerDraft, question: Question, index: number, value: string): AnswerDraft {
  const key = String(index)
  if (!takesMany(question)) return { ...draft, [key]: value }
  const current = picked(draft, index)
  const next = current.includes(value) ? current.filter((one) => one !== value) : [...current, value]
  // Kept in the options' order, so the answers read the way the card does.
  const values = optionValues(question)
  return { ...draft, [key]: values.filter((one) => next.includes(one)) }
}

/** The draft with a text question's text. */
export function typed(draft: AnswerDraft, index: number, text: string): AnswerDraft {
  return { ...draft, [String(index)]: text }
}

/** Whether a question has an answer in the draft: an option picked, or text that isn't blank. */
export function isAnswered(draft: AnswerDraft, index: number): boolean {
  const answer = draft[String(index)]
  if (typeof answer === 'string') return answer.trim() !== ''
  return answer !== undefined && answer.length > 0
}

/** How many of the questions have an answer in the draft. */
export function answeredCount(questions: readonly Question[], draft: AnswerDraft): number {
  return questions.filter((_, index) => isAnswered(draft, index)).length
}

/** "2 of 3 answered". */
export function answeredLabel(questions: readonly Question[], draft: AnswerDraft): string {
  return `${String(answeredCount(questions, draft))} of ${String(questions.length)} answered`
}

/**
 * The answers to send, once the draft answers every question that needs one (all but an optional text question); null
 * until then. Unanswered questions are left out, and `checkAnswers` tidies the rest, as main will.
 */
export function answersToSend(questions: readonly Question[], draft: AnswerDraft): QuestionAnswers | null {
  const answers: Record<string, QuestionAnswer> = {}
  questions.forEach((_, index) => {
    const answer = draft[String(index)]
    if (answer !== undefined && isAnswered(draft, index)) answers[String(index)] = answer
  })
  const check = checkAnswers(questions, answers)
  return check.ok ? check.answers : null
}

/** The card's title: "3 questions before I finish", "1 question before I finish". */
export function cardTitle(questions: readonly Question[]): string {
  const count = questions.length
  return `${String(count)} question${count === 1 ? '' : 's'} before I finish`
}

/** What the card says once it's closed. */
export enum ClosedAs {
  /** Answered with the card: each question shows its answer. */
  Answers = 'answers',
  /** Answered in your own words: your message follows in the chat. */
  InWords = 'in_words',
  /** The turn ended without an answer. */
  Withdrawn = 'withdrawn',
}

/** How a question set was closed, or null while it's open. */
export function closedAs(set: Pick<QuestionSet, 'state' | 'reply'>): ClosedAs | null {
  switch (set.state) {
    case QuestionSetState.Open:
      return null
    case QuestionSetState.Withdrawn:
      return ClosedAs.Withdrawn
    case QuestionSetState.Answered:
      return set.reply?.kind === QuestionReplyKind.FreeText ? ClosedAs.InWords : ClosedAs.Answers
  }
}

/** What a closed card's title says: "3 questions · answered", "… · answered in your words", "… · withdrawn". */
export function closedTitle(questions: readonly Question[], closed: ClosedAs): string {
  const count = `${String(questions.length)} question${questions.length === 1 ? '' : 's'}`
  switch (closed) {
    case ClosedAs.Answers:
      return `${count} · answered`
    case ClosedAs.InWords:
      return `${count} · answered in your words`
    case ClosedAs.Withdrawn:
      return `${count} · withdrawn`
  }
}

/** What a question left without an answer (an optional text one) says on a card answered with it. */
export const NO_ANSWER = 'No answer'

/** A question's answer as a card answered with it shows it: the options' labels or the pills, and the text typed. */
export function answerText(question: Question, answer: QuestionAnswer | undefined): string {
  if (answer === undefined) return NO_ANSWER
  const values = typeof answer === 'string' ? [answer] : answer
  if (question.kind !== QuestionKind.Choice) return values.join(', ')
  return values.map((id) => question.options.find((option) => option.id === id)?.label ?? id).join(', ')
}

/** One line of an option's sketch: its text, and whether it's a heading (a line starting with `#`). */
export interface SketchLine {
  readonly text: string
  readonly heading: boolean
}

/**
 * An option's sketch, line by line (`docs/model-surface.md`): shown as is in a small monospace frame, with lines that
 * start with `#` as headings, their marks dropped.
 */
export function sketchLines(sketch: string): readonly SketchLine[] {
  return sketch.split('\n').map((line) => {
    const heading = /^\s*#+\s*/.exec(line)
    return heading === null ? { text: line, heading: false } : { text: line.slice(heading[0].length), heading: true }
  })
}
