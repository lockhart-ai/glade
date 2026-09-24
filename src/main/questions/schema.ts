/**
 * The zod schemas for the agent's questions (`ask`): its tool input, the replies stored with each question set, and the
 * answers `questions.answer` takes. Each is checked against its named type in `src/shared/domain.ts`, so the two can't
 * drift apart. They live on the main side only, so the renderer never bundles zod for them.
 */
import { z } from 'zod'
import {
  QuestionKind,
  QuestionReplyKind,
  type AnswersReply,
  type ChoiceOption,
  type ChoiceQuestion,
  type FreeTextReply,
  type PillsQuestion,
  type Question,
  type QuestionAnswers,
  type QuestionReply,
  type TextQuestion,
} from '../../shared/domain'

/** Text the model sends: trimmed, and never empty. */
function text(what: string) {
  return z.string().trim().min(1, `The ${what} is empty.`)
}

/** Whether no two of the values are the same. */
function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

const choiceOption = z.object({
  id: text('option id').describe('What the answer names this option by. Unique within the question.'),
  label: text('option label').describe('A few words.'),
  detail: text('option detail').optional().describe('Optional: one line on what picking it means.'),
  sketch: text('option sketch')
    .optional()
    .describe(
      'Optional: a tiny sketch of what the option would look like, e.g. a layout, in a few short lines of plain text ' +
        '(up to about 6 lines of 40 characters). Shown as is, monospaced, above the label in a small frame; lines ' +
        'starting with # are shown as headings. No Markdown beyond that.',
    ),
}) satisfies z.ZodType<ChoiceOption>

const choiceQuestion = z.object({
  kind: z.literal(QuestionKind.Choice),
  prompt: text('question'),
  options: z
    .array(choiceOption)
    .min(2, 'A choice needs at least two options.')
    .refine((options) => distinct(options.map(({ id }) => id)), 'Each option needs its own id.'),
  multiple: z.boolean().optional().describe('Whether the user can pick more than one. One by default.'),
}) satisfies z.ZodType<ChoiceQuestion>

const pillsQuestion = z.object({
  kind: z.literal(QuestionKind.Pills),
  prompt: text('question'),
  options: z
    .array(text('pill'))
    .min(2, 'Pills need at least two options.')
    .refine(distinct, 'Each pill must be different.')
    .describe('Short options, a word or three each. The answer gives back the text of the one picked.'),
  multiple: z.boolean().optional().describe('Whether the user can pick more than one. One by default.'),
}) satisfies z.ZodType<PillsQuestion>

const textQuestion = z.object({
  kind: z.literal(QuestionKind.Text),
  prompt: text('question'),
  placeholder: text('placeholder').optional().describe('Optional: example text shown in the empty box.'),
  optional: z.boolean().optional().describe('Whether the user can leave it empty. Required by default.'),
}) satisfies z.ZodType<TextQuestion>

/** One question, as the model asks it and as it's stored. */
export const questionSchema = z.discriminatedUnion('kind', [
  choiceQuestion,
  pillsQuestion,
  textQuestion,
]) satisfies z.ZodType<Question>

/** The questions of one `ask` call: at least one. */
export const questionsSchema = z.array(questionSchema).min(1, 'Ask at least one question.')

/** Answers keyed by question index, as `questions.answer` takes them. `checkAnswers` checks them against the questions. */
export const questionAnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string()).readonly()]),
) satisfies z.ZodType<QuestionAnswers>

const answersReply = z.strictObject({
  kind: z.literal(QuestionReplyKind.Answers),
  answers: questionAnswersSchema,
}) satisfies z.ZodType<AnswersReply>

const freeTextReply = z.strictObject({
  kind: z.literal(QuestionReplyKind.FreeText),
  text: z.string(),
}) satisfies z.ZodType<FreeTextReply>

/** How the user answered a question set, as it's stored. */
export const questionReplySchema = z.discriminatedUnion('kind', [
  answersReply,
  freeTextReply,
]) satisfies z.ZodType<QuestionReply>
