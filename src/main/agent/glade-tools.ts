/**
 * The Glade tools: the in-process MCP server that lets the agent drive the UI (`docs/model-surface.md`). Each task's
 * session gets its own server, built for that task, so the handlers know which task they change.
 *
 * The model sees the tools as `mcp__glade__<name>`. The server sets `alwaysLoad`, or the model would have to find them
 * through tool search first (`docs/sdk-notes.md` §3). The SDK checks each call's input against its zod shape before the
 * handler runs, and turns a failed check, or a handler that throws, into a tool error for the model; nothing a call
 * sends can crash the app.
 *
 * `ask` blocks: its handler waits until you answer (`../questions/questions`), however long that takes. Claude Code
 * bounds every MCP tool call, about 28 hours by default, so the server raises its own bound as far as it goes
 * (`GLADE_TOOL_TIMEOUT_MS`, `docs/sdk-notes.md` §3).
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { ArtifactKind, type Artifact, type ArtifactRef, type Question } from '../../shared/domain'
import type { Settings } from '../../shared/settings'
import {
  addTaskArtifact,
  addTaskLinkArtifact,
  forgetTaskArtifact,
  forgetTaskLinkArtifact,
  updateTaskArtifact,
  updateTaskLinkArtifact,
  type UpdatedArtifact,
} from '../artifacts/artifacts'
import { getTask } from '../db/repositories/tasks'
import { showTaskFile } from '../files/files'
import { toolResultFor, type QuestionBroker } from '../questions/questions'
import { preambleSchema, questionsSchema } from '../questions/schema'
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

/**
 * How long Claude Code lets a call to one of Glade's tools run before it fails it, in ms: 2^31 − 1, about 24.8 days,
 * the longest it allows (it clamps a server's `timeout` to what a timer can wait). Without it, a call gets Claude
 * Code's default of 100,000 s (about 28 hours), and an `ask` still waiting overnight and through the next day failed
 * with `MCP server "glade" tool "ask" timed out after 100000s` (#381). The SDK sets timeouts per server, not per tool,
 * so this covers every Glade tool; the others all return at once, so only `ask` ever waits on it. Other servers,
 * `glade-control` and the user's own, keep Claude Code's default (`docs/sdk-notes.md` §3).
 */
export const GLADE_TOOL_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Which of a session's in-process MCP servers are Glade's own, whose tools never ask (`docs/decisions.md`, "Per-call
 * permission review"): only `glade`. Its tools only touch the task itself. Another in-process server, such as
 * `glade-control` (`../control`), whose tools change other tasks, isn't: its calls ask in the ask mode, as any other
 * MCP server's do, bar the reads `../permissions/classify` lets through.
 */
export function gladeOwnServers(servers: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(servers).filter((name) => name === GLADE_SERVER)
}

/** The tools' names, as Glade defines them. Draft names: not yet confirmed with Jared. */
export enum GladeTool {
  SetTitle = 'set_title',
  SetObjective = 'set_objective',
  SetStatus = 'set_status',
  Ask = 'ask',
  ShowFile = 'show_file',
  AddArtifact = 'add_artifact',
  UpdateArtifact = 'update_artifact',
  RemoveArtifact = 'remove_artifact',
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
  readonly preamble?: string | undefined
  readonly questions: readonly Question[]
}

export interface ShowFileInput {
  readonly path: string
  readonly line?: number | undefined
}

/** An artifact as the tools name it: a file by its `path`, or a link by its `url` (#407); exactly one of them. */
export interface ArtifactTarget {
  readonly path?: string | undefined
  readonly url?: string | undefined
}

export interface AddArtifactInput extends ArtifactTarget {
  readonly title: string
}

export interface UpdateArtifactInput extends ArtifactTarget {
  readonly title?: string | undefined
  /** A file artifact's new file. */
  readonly newPath?: string | undefined
  /** A link artifact's new page. */
  readonly newUrl?: string | undefined
}

export type RemoveArtifactInput = ArtifactTarget

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
// The preamble comes first, so the model writes its reply to the user before its questions.
const askInput = z.object({
  preamble: preambleSchema
    .optional()
    .describe(
      'Optional: your reply to what the user just said, in Markdown, a few sentences: answer their question, react ' +
        "to what they told you, or say why you're asking. It's shown at the top of the card, above the questions.",
    ),
  questions: questionsSchema.describe('The questions, shown together on one card, in this order.'),
}) satisfies z.ZodType<AskInput>

const showFileInput = z.object({
  path: text('path').describe("The file's path: absolute, or relative to the workspace root."),
  line: z.int().positive().optional().describe('A line to scroll to and mark, from 1.'),
}) satisfies z.ZodType<ShowFileInput>

// The SDK checks only the fields' shape, so the handlers refuse a call that gives both a path and a url, or neither.
const addArtifactInput = z.object({
  path: text('path').optional().describe("A file's path: absolute, or relative to the workspace root."),
  url: text('url')
    .optional()
    .describe('A link instead of a file: the http or https address of a PR, an issue, a ticket or another page.'),
  title: text('title').describe('A short name for the deliverable, e.g. "Release notes 2.4".'),
}) satisfies z.ZodType<AddArtifactInput>

// The handler also refuses an update that gives neither a title nor a new path or url.
const updateArtifactInput = z.object({
  path: text('path')
    .optional()
    .describe("A file artifact's path, as it was added: absolute, or relative to the workspace root."),
  url: text('url').optional().describe("A link artifact's url, as it was added."),
  title: text('title').optional().describe('A new short name for it.'),
  newPath: text('new path')
    .optional()
    .describe(
      "The file it's to point to instead, e.g. after moving or renaming it: absolute, or relative to the root.",
    ),
  newUrl: text('new url').optional().describe("For a link artifact, the page it's to point to instead."),
}) satisfies z.ZodType<UpdateArtifactInput>

const removeArtifactInput = z.object({
  path: text('path')
    .optional()
    .describe("A file artifact's path, as it was added: absolute, or relative to the workspace root."),
  url: text('url').optional().describe("A link artifact's url, as it was added."),
}) satisfies z.ZodType<RemoveArtifactInput>

/** A tool's reply to the model: MCP's own result type. */
export type GladeToolResult = CallToolResult

function reply(message: string): GladeToolResult {
  return { content: [{ type: 'text', text: message }] }
}

/** What `update_artifact` tells the model when it gives neither a new title nor a new path. */
export const UPDATE_CHANGES_NOTHING =
  'Give a new title, a newPath (for a file) or a newUrl (for a link), or both: an update with neither changes nothing.'

/** What the artifact tools tell the model when it names a file and a link at once, or neither (#407). */
export const PATH_OR_URL = "Give the artifact's path (a file) or its url (a link): one of them, not both."

/** What `update_artifact` tells the model when it gives a file a new url, or a link a new path. */
export const NEW_TARGET_OF_ANOTHER_KIND =
  "A file artifact takes a newPath, and a link artifact a newUrl: one can't turn into the other. Remove it and add " +
  'the other instead.'

/** The artifact a tool call names: a file by its path, or a link by its url; null when it names both or neither. */
function namedArtifact({ path, url }: ArtifactTarget): ArtifactRef | null {
  if (path !== undefined && url === undefined) return { kind: ArtifactKind.File, path }
  if (url !== undefined && path === undefined) return { kind: ArtifactKind.Link, url }
  return null
}

/** How a reply names an artifact: a file by its path, a link by its URL. */
function nameOf(artifact: Artifact): string {
  switch (artifact.kind) {
    case ArtifactKind.File:
      return artifact.path
    case ArtifactKind.Link:
      return artifact.url
  }
}

/** What `update_artifact` tells the model it changed. */
function updatedReply({ before, after }: UpdatedArtifact): string {
  const [was, now] = [nameOf(before), nameOf(after)]
  const moved = was !== now
  const renamed = before.title !== after.title
  if (moved && renamed) return `Moved the artifact ${was} to ${now}, now called "${after.title}".`
  if (moved) return `Moved the artifact "${after.title}" from ${was} to ${now}.`
  if (renamed) return `Renamed the artifact ${now} to "${after.title}".`
  return `The artifact ${now} is already called "${after.title}"; nothing changed.`
}

/** What `add_artifact` tells the model it did: added the artifact, or renamed one declared before. */
function addedReply(artifact: Artifact): string {
  return artifact.addedAt === artifact.updatedAt
    ? `Added ${nameOf(artifact)} to the artifacts as "${artifact.title}".`
    : `Renamed the artifact ${nameOf(artifact)} to "${artifact.title}".`
}

/** A tool's error reply, from what its handler threw. */
function failure(error: unknown): GladeToolResult {
  return { ...reply((error as Error).message), isError: true }
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
  /** Renames one of the task's artifacts and/or points it at another file; an error result when it can't. */
  updateArtifact(input: UpdateArtifactInput): Promise<GladeToolResult>
  /** Takes one of the task's artifacts off its list (the file stays); an error result when it isn't one. */
  removeArtifact(input: RemoveArtifactInput): GladeToolResult
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
    async ask(input, signal) {
      const answered = await context.questions.ask(taskId, input, signal)
      return answered === null ? { ...reply(QUESTIONS_WITHDRAWN), isError: true } : reply(toolResultFor(answered))
    },
    async showFile({ path, line }) {
      try {
        const shown = await showTaskFile(context, taskId, path, line ?? null)
        return reply(line === undefined ? `Showing ${shown}.` : `Showing ${shown} at line ${String(line)}.`)
      } catch (error) {
        return failure(error)
      }
    },
    async addArtifact(input) {
      const named = namedArtifact(input)
      if (named === null) return { ...reply(PATH_OR_URL), isError: true }
      try {
        switch (named.kind) {
          case ArtifactKind.File:
            return reply(addedReply(await addTaskArtifact(context, taskId, named.path, input.title)))
          case ArtifactKind.Link:
            return reply(addedReply(addTaskLinkArtifact(context, taskId, named.url, input.title)))
        }
      } catch (error) {
        return failure(error)
      }
    },
    async updateArtifact(input) {
      const { title, newPath, newUrl } = input
      const named = namedArtifact(input)
      if (named === null) return { ...reply(PATH_OR_URL), isError: true }
      if (title === undefined && newPath === undefined && newUrl === undefined) {
        return { ...reply(UPDATE_CHANGES_NOTHING), isError: true }
      }
      if (named.kind === ArtifactKind.File ? newUrl !== undefined : newPath !== undefined) {
        return { ...reply(NEW_TARGET_OF_ANOTHER_KIND), isError: true }
      }
      try {
        switch (named.kind) {
          case ArtifactKind.File:
            return reply(updatedReply(await updateTaskArtifact(context, taskId, { path: named.path, title, newPath })))
          case ArtifactKind.Link:
            return reply(updatedReply(updateTaskLinkArtifact(context, taskId, { url: named.url, title, newUrl })))
        }
      } catch (error) {
        return failure(error)
      }
    },
    removeArtifact(input) {
      const named = namedArtifact(input)
      if (named === null) return { ...reply(PATH_OR_URL), isError: true }
      try {
        switch (named.kind) {
          case ArtifactKind.File: {
            const removed = forgetTaskArtifact(context, taskId, named.path)
            return reply(
              `Removed ${removed.path} ("${removed.title}") from the artifacts. The file itself is untouched.`,
            )
          }
          case ArtifactKind.Link: {
            const removed = forgetTaskLinkArtifact(context, taskId, named.url)
            return reply(`Removed ${removed.url} ("${removed.title}") from the artifacts.`)
          }
        }
      } catch (error) {
        return failure(error)
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
    'Ask the user one or more questions on a card in the chat, and wait for the answers. When you ask in response to ' +
    "the user's message, first respond to it in `preamble` (shown at the top of the card), then ask. Each question " +
    'is a choice (option cards, each with an id, a label and optionally a detail line and a sketch: a few short ' +
    'lines of plain text shown monospaced, with # lines as headings), pills (short options) or text (a text box). ' +
    'Choices and pills take one pick unless `multiple` is set. Returns the answers as JSON keyed by ' +
    'question index from 0: a choice gives the option id, pills the pill text, text the text typed (an optional one ' +
    'left empty has no key), and `multiple` gives an array. The user can reply in their own words instead; then it ' +
    'returns {"freeText": "…"}.',
  [GladeTool.ShowFile]:
    "Open a file in the user's Files tab, next to the chat, to point them at it: a change to review, say. Give a line " +
    'to scroll to and mark it. The file must be in the workspace.',
  [GladeTool.AddArtifact]:
    "Add a file you made to the task's artifacts: its deliverables, which the user finds in the Artifacts tab and " +
    'which stay with the task after it is done. Use it for what the user asked for (a report, a document, a draft), ' +
    'not for every file you change. The file must exist in the workspace. Or give a url instead of a path to add a ' +
    'link: a PR you open or work on, or the issue or ticket the task is about (http or https only). Adding the same ' +
    'path or url again renames it.',
  [GladeTool.UpdateArtifact]:
    "Change one of the task's artifacts, named by its path (a file) or its url (a link): give it a new title, point a " +
    'file at another file of the workspace (newPath), e.g. after you moved or renamed it, or a link at another page ' +
    '(newUrl), or both. It keeps its place in the Artifacts tab.',
  [GladeTool.RemoveArtifact]:
    "Take a file (by its path) or a link (by its url) off the task's artifacts, e.g. one that's no longer a " +
    'deliverable. A file itself is left alone.',
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
    timeout: GLADE_TOOL_TIMEOUT_MS,
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
      tool(GladeTool.UpdateArtifact, DESCRIPTIONS[GladeTool.UpdateArtifact], updateArtifactInput.shape, (input) =>
        handlers.updateArtifact(input),
      ),
      tool(GladeTool.RemoveArtifact, DESCRIPTIONS[GladeTool.RemoveArtifact], removeArtifactInput.shape, (input) =>
        Promise.resolve(handlers.removeArtifact(input)),
      ),
    ],
  })
}
