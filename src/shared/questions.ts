/**
 * Checking your answers to the agent's questions (`ask`, `docs/model-surface.md`) against what it asked. Main checks
 * every `questions.answer` with it, and the question card tidies its answers with it before sending them.
 *
 * Answers are keyed by each question's index in the set, from 0. What each kind takes:
 * - **choice**: an option's id; with `multiple`, an array of them, each id once.
 * - **pills**: a pill's text; with `multiple`, an array of them, each pill once.
 * - **text**: the text typed, trimmed.
 *
 * Every question is optional (#397): one left unanswered (no key, an empty array or blank text) is dropped from the
 * answers. A text question's `optional` flag is ignored.
 */
import { QuestionKind, type AnswersReply, type Question, type QuestionAnswer, type QuestionAnswers } from './domain'

/**
 * The key the `ask` tool's result gives what you typed in the card's "Anything else?" box, beside the numbered answers.
 * Reserved: no question's index can be it.
 */
export const ANYTHING_ELSE_KEY = 'anythingElse'

/** The "Anything else?" text as it's kept: trimmed, or undefined when there's nothing in it. */
export function tidyAnythingElse(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? undefined : trimmed
}

/**
 * What the `ask` tool returns for answers given with the card: the answers keyed by question index, and the "Anything
 * else?" text under `anythingElse` when there's any.
 */
export function answersResult({ answers, anythingElse }: AnswersReply): Readonly<Record<string, QuestionAnswer>> {
  return anythingElse === undefined ? answers : { ...answers, [ANYTHING_ELSE_KEY]: anythingElse }
}

export type AnswersCheck =
  | { readonly ok: true; readonly answers: QuestionAnswers }
  | { readonly ok: false; readonly problems: readonly string[] }

/** One question's answer, checked: what to keep (undefined to drop it), or why it isn't one. */
type Checked = { readonly keep: QuestionAnswer | undefined } | { readonly problem: string }

/** A pick among `values`: one of them, or with `multiple`, an array of them, each once. None is dropped. */
function checkPick(values: readonly string[], multiple: boolean, answer: QuestionAnswer | undefined): Checked {
  if (answer === undefined) return { keep: undefined }
  if (!multiple) {
    if (typeof answer !== 'string') return { problem: 'takes one answer, not a list' }
    return values.includes(answer) ? { keep: answer } : { problem: `has no option "${answer}"` }
  }
  if (typeof answer === 'string') return { problem: 'takes a list of answers' }
  if (answer.length === 0) return { keep: undefined }
  const unknown = answer.find((value) => !values.includes(value))
  if (unknown !== undefined) return { problem: `has no option "${unknown}"` }
  if (new Set(answer).size !== answer.length) return { problem: 'has an option picked twice' }
  return { keep: answer }
}

function checkAnswer(question: Question, answer: QuestionAnswer | undefined): Checked {
  switch (question.kind) {
    case QuestionKind.Choice:
      return checkPick(
        question.options.map(({ id }) => id),
        question.multiple === true,
        answer,
      )
    case QuestionKind.Pills:
      return checkPick(question.options, question.multiple === true, answer)
    case QuestionKind.Text: {
      if (answer !== undefined && typeof answer !== 'string') return { problem: 'takes text, not a list' }
      const text = answer?.trim() ?? ''
      return { keep: text === '' ? undefined : text }
    }
  }
}

/**
 * Checks answers against the questions they answer: each answer must be one its question takes, and no answer may be
 * for a question that isn't there. Any question may be left unanswered, all of them included. Answers with them tidied
 * (text trimmed, the unanswered dropped), or every problem found, each naming its question by index.
 */
export function checkAnswers(questions: readonly Question[], answers: QuestionAnswers): AnswersCheck {
  const problems: string[] = []
  const kept: Record<string, QuestionAnswer> = {}
  for (const key of Object.keys(answers)) {
    if (!questions.some((_, index) => String(index) === key)) problems.push(`${key}: there is no such question`)
  }
  questions.forEach((question, index) => {
    const key = String(index)
    const checked = checkAnswer(question, answers[key])
    if ('problem' in checked) problems.push(`${key}: ${checked.problem}`)
    else if (checked.keep !== undefined) kept[key] = checked.keep
  })
  return problems.length === 0 ? { ok: true, answers: kept } : { ok: false, problems }
}
