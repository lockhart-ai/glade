/**
 * Checking your answers to the agent's questions (`ask`, `docs/model-surface.md`) against what it asked. Main checks
 * every `questions.answer` with it; the question card can use it to tell when its answers are complete.
 *
 * Answers are keyed by each question's index in the set, from 0. What each kind takes:
 * - **choice**: an option's id; with `multiple`, an array of at least one, each id once.
 * - **pills**: a pill's text; with `multiple`, an array of at least one, each pill once.
 * - **text**: the text typed, trimmed. It must not be empty unless the question is `optional`; an optional one left
 *   empty is dropped from the answers.
 *
 * Every question but an optional text one needs an answer.
 */
import { QuestionKind, type Question, type QuestionAnswer, type QuestionAnswers } from './domain'

export type AnswersCheck =
  | { readonly ok: true; readonly answers: QuestionAnswers }
  | { readonly ok: false; readonly problems: readonly string[] }

/** One question's answer, checked: what to keep (undefined to drop it), or why it isn't one. */
type Checked = { readonly keep: QuestionAnswer | undefined } | { readonly problem: string }

/** A pick among `values`: one of them, or with `multiple`, an array of at least one, each once. */
function checkPick(values: readonly string[], multiple: boolean, answer: QuestionAnswer | undefined): Checked {
  if (answer === undefined) return { problem: 'is not answered' }
  if (!multiple) {
    if (typeof answer !== 'string') return { problem: 'takes one answer, not a list' }
    return values.includes(answer) ? { keep: answer } : { problem: `has no option "${answer}"` }
  }
  if (typeof answer === 'string') return { problem: 'takes a list of answers' }
  if (answer.length === 0) return { problem: 'is not answered' }
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
      if (text !== '') return { keep: text }
      return question.optional === true ? { keep: undefined } : { problem: 'is not answered' }
    }
  }
}

/**
 * Checks answers against the questions they answer: each question's answer must be one it takes, and no answer may be
 * for a question that isn't there. Answers with them tidied (text trimmed, empty optional text dropped), or every
 * problem found, each naming its question by index.
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
