/**
 * The Glade tools: the in-process MCP server that lets the agent drive the UI (`docs/model-surface.md`). Each task's
 * session gets its own server, built for that task, so the handlers know which task they change.
 *
 * The model sees the tools as `mcp__glade__<name>`. The server sets `alwaysLoad`, or the model would have to find them
 * through tool search first (`docs/sdk-notes.md` §3). The SDK checks each call's input against its zod shape before the
 * handler runs, and turns a failed check, or a handler that throws, into a tool error for the model; nothing a call
 * sends can crash the app.
 *
 * `ask` blocks: its handler waits until you answer (`../questions/questions`), however long that takes. SDK tool calls
 * have no timeout by default (`docs/sdk-notes.md` §3).
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Question } from '../../shared/domain'
import type { Settings } from '../../shared/settings'
import { addTaskArtifact } from '../artifacts/artifacts'
import { getTask } from '../db/repositories/tasks'
import { showTaskFile } from '../files/files'
import { toolResultFor, type QuestionBroker } from '../questions/questions'
import { questionsSchema } from '../questions/schema'
import { updateTaskFromAgent, type TaskServiceContext } from '../tasks/service'

/**
 * What Settings › Agent has the agent keep current besides the objective: the status every turn (`set_status`), and
 * the title from your first message (`set_title`). A session gets neither the tool nor the prompt's ask for one that's
 * off; it's read when the session starts.
 */
export type AgentUpkeep = Pick<Settings, 'statusSummary' | 'taskTitles'>

/** Both kinds of upkeep on, as they are until you change them. */
export const ALL_UPKEEP: AgentUpkeep = { statusSummary: true, taskTitles: true }

/** The server's name: the `glade` in `mcp__glade__set_title`. */
export const GLADE_SERVER = 'glade'

/** The tools' names, as Glade defines them. Draft names: not yet confirmed with Jared. */
export enum GladeTool {
  SetTitle = 'set_title',
  SetObjective = 'set_objective',
  SetStatus = 'set_status',
  Ask = 'ask',
  ShowFile = 'show_file',
  AddArtifact = 'add_artifact',
}

export interface SetTitleInput {
  readonly title: string
}

export interface SetObjectiveInput {
  readonly objective: string
}

export interface SetStatusInput {
  readonly status: string
}

export interface AskInput {
  readonly questions: readonly Question[]
}

export interface ShowFileInput {
  readonly path: string
  readonly line?: number | undefined
}

export interface AddArtifactInput {
  readonly path: string
  readonly title: string
}

/** Text the model sends: trimmed, and never empty. */
function text(what: string) {
  return z.string().trim().min(1, `The ${what} is empty.`)
}

// Each schema is checked against its interface, so the two can't drift apart.
const setTitleInput = z.object({
  title: text('title').describe('A short name for the task, in a few words.'),
}) satisfies z.ZodType<SetTitleInput>
const setObjectiveInput = z.object({
  objective: text('objective').describe('What the task is to achieve, in one or two sentences.'),
}) satisfies z.ZodType<SetObjectiveInput>
const setStatusInput = z.object({
  status: text('status').describe('One line on where the work stands.'),
}) satisfies z.ZodType<SetStatusInput>
const askInput = z.object({
  questions: questionsSchema.describe('The questions, shown together on one card, in this order.'),
}) satisfies z.ZodType<AskInput>

const showFileInput = z.object({
  path: text('path').describe("The file's path: absolute, or relative to the workspace root."),
  line: z.int().positive().optional().describe('A line to scroll to and mark, from 1.'),
}) satisfies z.ZodType<ShowFileInput>

const addArtifactInput = z.object({
  path: text('path').describe("The file's path: absolute, or relative to the workspace root."),
  title: text('title').describe('A short name for the deliverable, e.g. "Release notes 2.4".'),
}) satisfies z.ZodType<AddArtifactInput>

/** A tool's reply to the model: MCP's own result type. */
export type GladeToolResult = CallToolResult

function reply(message: string): GladeToolResult {
  return { content: [{ type: 'text', text: message }] }
}

/** What `ask` tells the model when its questions were withdrawn: the turn was stopped, or failed, while it waited. */
export const QUESTIONS_WITHDRAWN = 'The questions were withdrawn before the user answered them.'

/** What the Glade tools need: the task service, and the questions `ask` waits on. */
export interface GladeToolContext extends TaskServiceContext {
  readonly questions: QuestionBroker
}

/** The handlers for one task, given input the SDK has already checked. */
export interface GladeToolHandlers {
  setTitle(input: SetTitleInput): GladeToolResult
  setObjective(input: SetObjectiveInput): GladeToolResult
  setStatus(input: SetStatusInput): GladeToolResult
  /** Waits until the questions are answered; `signal` is the SDK cancelling the call. */
  ask(input: AskInput, signal?: AbortSignal): Promise<GladeToolResult>
  /** Opens a file in the task's Files tab; an error result when it isn't a file in the workspace. */
  showFile(input: ShowFileInput): Promise<GladeToolResult>
  /** Declares a file as a deliverable of the task; an error result when it isn't a file in the workspace. */
  addArtifact(input: AddArtifactInput): Promise<GladeToolResult>
}

export function createGladeToolHandlers(context: GladeToolContext, taskId: string): GladeToolHandlers {
  return {
    setTitle({ title }) {
      updateTaskFromAgent(context, taskId, { title })
      return reply(`Title set to "${title}".`)
    },
    setObjective({ objective }) {
      // Meant to be set once, but a second call still applies: the user may have changed what they want. The reply
      // says it replaced one, so a model that calls it by mistake can tell.
      const replaced = (getTask(context.db, taskId)?.objective ?? '') !== ''
      updateTaskFromAgent(context, taskId, { objective })
      return reply(replaced ? 'Objective replaced.' : 'Objective set.')
    },
    setStatus({ status }) {
      updateTaskFromAgent(context, taskId, { status })
      return reply('Status updated.')
    },
    async ask({ questions }, signal) {
      const answered = await context.questions.ask(taskId, questions, signal)
      return answered === null ? { ...reply(QUESTIONS_WITHDRAWN), isError: true } : reply(toolResultFor(answered))
    },
    async showFile({ path, line }) {
      try {
        const shown = await showTaskFile(context, taskId, path, line ?? null)
        return reply(line === undefined ? `Showing ${shown}.` : `Showing ${shown} at line ${String(line)}.`)
      } catch (error) {
        return { ...reply((error as Error).message), isError: true }
      }
    },
    async addArtifact({ path, title }) {
      try {
        const artifact = await addTaskArtifact(context, taskId, path, title)
        return reply(
          artifact.addedAt === artifact.updatedAt
            ? `Added ${artifact.path} to the artifacts as "${title}".`
            : `Renamed the artifact ${artifact.path} to "${title}".`,
        )
      } catch (error) {
        return { ...reply((error as Error).message), isError: true }
      }
    },
  }
}

const DESCRIPTIONS: Readonly<Record<GladeTool, string>> = {
  [GladeTool.SetTitle]: "Name the task. Call it once, after the user's first message. The user can rename it later.",
  [GladeTool.SetObjective]:
    "Record the task's objective, distilled from the user's first message. Set it once; call it again only if the " +
    'user changes what the task is for, which replaces it.',
  [GladeTool.SetStatus]:
    'Replace the one-line status shown to the user in the header and the task list. Keep it current every turn. When ' +
    'the task is done, it is the outcome.',
  [GladeTool.Ask]:
    'Ask the user one or more questions on a card in the chat, and wait for the answers. Each question is a choice ' +
    '(option cards, each with an id, a label and optionally a detail line and a sketch: a few short lines of plain ' +
    'text shown monospaced, with # lines as headings), pills (short options) or text ' +
    '(a text box). Choices and pills take one pick unless `multiple` is set. Returns the answers as JSON keyed by ' +
    'question index from 0: a choice gives the option id, pills the pill text, text the text typed (an optional one ' +
    'left empty has no key), and `multiple` gives an array. The user can reply in their own words instead; then it ' +
    'returns {"freeText": "…"}.',
  [GladeTool.ShowFile]:
    "Open a file in the user's Files tab, next to the chat, to point them at it: a change to review, say. Give a line " +
    'to scroll to and mark it. The file must be in the workspace.',
  [GladeTool.AddArtifact]:
    "Add a file you made to the task's artifacts: its deliverables, which the user finds in the Artifacts tab and " +
    'which stay with the task after it is done. Use it for what the user asked for (a report, a document, a draft), ' +
    'not for every file you change. The file must exist in the workspace. Adding the same path again renames it.',
}

/** The signal an MCP tool call is cancelled by, from the handler's `extra` (MCP's `RequestHandlerExtra`). */
function signalOf(extra: unknown): AbortSignal | undefined {
  const signal: unknown = typeof extra === 'object' && extra !== null ? Reflect.get(extra, 'signal') : undefined
  return signal instanceof AbortSignal ? signal : undefined
}

/** The Glade MCP server for one task's session, without the tools for any `upkeep` that's off. */
export function createGladeMcpServer(
  context: GladeToolContext,
  taskId: string,
  upkeep: AgentUpkeep = ALL_UPKEEP,
): McpSdkServerConfigWithInstance {
  const handlers = createGladeToolHandlers(context, taskId)
  // The SDK's handlers are async; ours write SQLite synchronously, so they only need wrapping.
  return createSdkMcpServer({
    name: GLADE_SERVER,
    alwaysLoad: true,
    tools: [
      ...(upkeep.taskTitles
        ? [
            tool(GladeTool.SetTitle, DESCRIPTIONS[GladeTool.SetTitle], setTitleInput.shape, (input) =>
              Promise.resolve(handlers.setTitle(input)),
            ),
          ]
        : []),
      tool(GladeTool.SetObjective, DESCRIPTIONS[GladeTool.SetObjective], setObjectiveInput.shape, (input) =>
        Promise.resolve(handlers.setObjective(input)),
      ),
      ...(upkeep.statusSummary
        ? [
            tool(GladeTool.SetStatus, DESCRIPTIONS[GladeTool.SetStatus], setStatusInput.shape, (input) =>
              Promise.resolve(handlers.setStatus(input)),
            ),
          ]
        : []),
      tool(GladeTool.Ask, DESCRIPTIONS[GladeTool.Ask], askInput.shape, (input, extra) =>
        handlers.ask(input, signalOf(extra)),
      ),
      tool(GladeTool.ShowFile, DESCRIPTIONS[GladeTool.ShowFile], showFileInput.shape, (input) =>
        handlers.showFile(input),
      ),
      tool(GladeTool.AddArtifact, DESCRIPTIONS[GladeTool.AddArtifact], addArtifactInput.shape, (input) =>
        handlers.addArtifact(input),
      ),
    ],
  })
}
