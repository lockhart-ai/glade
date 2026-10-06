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
 * (`GLADE_TOOL_TIMEOUT_MS`, `docs/sdk-notes.md` §3). `request_access` blocks the same way, on its permission card
 * (#450): the agent calls it when the sandbox blocked a command, and it's the one tool a subagent may call too.
 *
 * `list_children` and `file_children` (P16-05, #496) are the agent's side of the todo hub (`../todo-hub/agent-children`),
 * and `add_artifact` takes `todo`, the id of the todo the artifact belongs under, and needs it (P16-04, #495;
 * `../todo-hub/filing`).
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { GladeEvent } from '../../shared/bridge'
import { ArtifactKind, type Artifact, type ArtifactRef, type Question } from '../../shared/domain'
import type { Settings } from '../../shared/settings'
import { REQUEST_ACCESS_TOOL } from '../../shared/toolName'
import { AGENTS_SERVER } from '../../shared/managed-agents'
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
import { TOOL_USE_ID_META } from './mcp-tool-caller'
import { FileAccess } from './sandbox-requests'
import { showTaskFile } from '../files/files'
import {
  ACCESS_PATH_NOT_ABSOLUTE,
  AccessOutcomeKind,
  accessReply,
  isAccessPath,
  type AccessOutcome,
  type AccessRequest,
} from '../permissions/sandbox-ask'
import { toolResultFor, type QuestionBroker } from '../questions/questions'
import { preambleSchema, questionsSchema } from '../questions/schema'
import { updateTaskFromAgent, type TaskServiceContext } from '../tasks/service'
import {
  filedText,
  fileForAgent,
  listForAgent,
  listingText,
  NO_TODO,
  type FilingRequest,
} from '../todo-hub/agent-children'
import { artifactTodo, fileArtifact } from '../todo-hub/filing'

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
  return Object.keys(servers).filter((name) => name === GLADE_SERVER || name === AGENTS_SERVER)
}

/** `request_access` as the SDK names it: the one Glade tool a subagent may call (#450). */
export const ACCESS_TOOL_NAME = REQUEST_ACCESS_TOOL

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
  RequestAccess = 'request_access',
  ListChildren = 'list_children',
  FileChildren = 'file_children',
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
  /**
   * The id of the todo the artifact belongs under. Only in a session with the todo hub on, where the handler refuses
   * a call without one.
   */
  readonly todo?: string | undefined
}

export interface UpdateArtifactInput extends ArtifactTarget {
  readonly title?: string | undefined
  /** A file artifact's new file. */
  readonly newPath?: string | undefined
  /** A link artifact's new page. */
  readonly newUrl?: string | undefined
}

export type RemoveArtifactInput = ArtifactTarget

export interface ListChildrenInput {
  /** A todo's id, for its children alone, or `NO_TODO` for the ones under no todo; every child when left out. */
  readonly todo?: string | undefined
}

export interface FileChildrenInput {
  readonly filings: readonly FilingRequest[]
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
// The todo is optional to the SDK's check too, so a call without one reaches the handler, whose refusal lists the
// task's todos.
const addArtifactInput = z.object({
  path: text('path').optional().describe("A file's path: absolute, or relative to the workspace root."),
  url: text('url')
    .optional()
    .describe('A link instead of a file: the http or https address of a PR, an issue, a ticket or another page.'),
  title: text('title').describe('A short name for the deliverable, e.g. "Release notes 2.4".'),
  todo: text('todo')
    .optional()
    .describe(
      'Needed: the id of the todo it belongs under (the N of Task #N, e.g. "2"). Create the todo first if none fits.',
    ),
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

const listChildrenInput = z.object({
  todo: text('todo')
    .optional()
    .describe(
      `Only the children under this todo, by its id (the N of Task #N), or "${NO_TODO}" for the ones under no todo. ` +
        'Leave it out to list them all.',
    ),
}) satisfies z.ZodType<ListChildrenInput>

const fileChildrenInput = z.object({
  filings: z
    .array(
      z.object({
        child: text('child').describe('The child\'s short id, e.g. "c3".'),
        todo: text('todo').describe('The id of the todo to put it under: the N of Task #N, e.g. "2".'),
      }),
    )
    .min(1, 'Give at least one filing.')
    .describe('Every filing to make, in this one call: each a child and the todo it goes under.'),
}) satisfies z.ZodType<FileChildrenInput>

/** The longest path `request_access` takes: macOS's own limit is far below it. */
export const ACCESS_PATH_MAX = 4096

/** The longest reason `request_access` takes: a sentence, which the card shows whole. */
export const ACCESS_REASON_MAX = 500

/**
 * What a permission card must never show as if it were plain text: control characters (a line break, an escape, a NUL)
 * and the characters that reorder the text around them (the bidirectional overrides, embeddings and isolates), which
 * could make a path or a reason read as something it isn't.
 */
const UNSHOWABLE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u

/** Text the card shows as the agent wrote it: not empty, not too long, and nothing in it that the card can't show. */
function shownText(what: string, max: number) {
  return text(what)
    .max(max, `The ${what} is too long: ${String(max)} characters at most.`)
    .refine((value) => !UNSHOWABLE.test(value), {
      message: `The ${what} has a control or text-direction character in it. Give it as plain text.`,
    })
}

const requestAccessInput = z.object({
  path: shownText('path', ACCESS_PATH_MAX).describe(
    'The absolute path the command was blocked from: a file or a folder.',
  ),
  access: z.enum(FileAccess).describe('"read" to read it, or "write" to write to it (which lets you read it too).'),
  reason: shownText('reason', ACCESS_REASON_MAX).describe(
    'Why you need it, in one short sentence: the user reads it on the card.',
  ),
}) satisfies z.ZodType<AccessRequest>

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

/**
 * What `add_artifact` tells the model it did: added the artifact, or renamed one declared before; and, with the todo
 * hub on, which todo it's under.
 */
function addedReply(artifact: Artifact, todoId: string): string {
  const added =
    artifact.addedAt === artifact.updatedAt
      ? `Added ${nameOf(artifact)} to the artifacts as "${artifact.title}".`
      : `Renamed the artifact ${nameOf(artifact)} to "${artifact.title}".`
  return `${added} It's under todo #${todoId}.`
}

/** A tool's error reply, from what its handler threw. */
function failure(error: unknown): GladeToolResult {
  return { ...reply((error as Error).message), isError: true }
}

/** What `ask` tells the model when its questions were withdrawn: the turn was stopped, or failed, while it waited. */
export const QUESTIONS_WITHDRAWN = 'The questions were withdrawn before the user answered them.'

/** Which call of `request_access` a handler answers, as far as the MCP request says. */
export interface AccessCall {
  /** The call's `tool_use` id (Claude Code sends it with the request); null when it sent none. */
  readonly toolUseId: string | null
  /** The SDK cancelling the call. */
  readonly signal?: AbortSignal | undefined
}

/** Asks you for the folder a task's `request_access` call names, and resolves with how that ended. */
export type RequestAccess = (taskId: string, request: AccessRequest, call: AccessCall) => Promise<AccessOutcome>

/**
 * What the Glade tools need: the task service, the questions `ask` waits on, and, for `request_access`, whoever asks
 * you for a folder (the agent runner). Without it the session has no `request_access` tool.
 */
export interface GladeToolContext extends TaskServiceContext {
  readonly questions: QuestionBroker
  readonly requestAccess?: RequestAccess
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
  /**
   * Declares a file as a deliverable of the task; an error result when it isn't a file in the workspace. With the todo
   * hub on, files it under the todo it names: an error result, with nothing added, when it names none, or one that
   * isn't in the task's list.
   */
  addArtifact(input: AddArtifactInput): Promise<GladeToolResult>
  /** Renames one of the task's artifacts and/or points it at another file; an error result when it can't. */
  updateArtifact(input: UpdateArtifactInput): Promise<GladeToolResult>
  /** Takes one of the task's artifacts off its list (the file stays); an error result when it isn't one. */
  removeArtifact(input: RemoveArtifactInput): GladeToolResult
  /**
   * Asks you for the folder of a path the sandbox blocked, and waits for your answer (`docs/model-surface.md`); an
   * error result when the path isn't absolute, or the answer is no.
   */
  requestAccess(input: AccessRequest, call: AccessCall): Promise<GladeToolResult>
  /**
   * Lists the task's children by the todo each is under, with their short ids; an error result for a todo that isn't
   * in the task's list.
   */
  listChildren(input: ListChildrenInput): GladeToolResult
  /**
   * Files children under todos, or moves them, all of them or none; an error result, with nothing filed, when a child
   * or a todo isn't there.
   */
  fileChildren(input: FileChildrenInput): GladeToolResult
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
        // Checked before anything is added: a call without a todo of the task's adds nothing.
        const todoId = artifactTodo(context.db, taskId, input.todo)
        // The windows hear of the artifact once it's filed, so it's under its todo from the moment it shows.
        const added: GladeEvent[] = []
        const adding = { ...context, emit: (event: GladeEvent) => added.push(event) }
        const artifact =
          named.kind === ArtifactKind.File
            ? await addTaskArtifact(adding, taskId, named.path, input.title)
            : addTaskLinkArtifact(adding, taskId, named.url, input.title)
        fileArtifact(context, taskId, artifact, todoId)
        for (const event of added) context.emit(event)
        return reply(addedReply(artifact, todoId))
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
    async requestAccess(input, call) {
      if (!isAccessPath(input.path)) return { ...reply(ACCESS_PATH_NOT_ABSOLUTE), isError: true }
      try {
        const ask = context.requestAccess
        const outcome: AccessOutcome =
          ask === undefined ? { kind: AccessOutcomeKind.SandboxOff } : await ask(taskId, input, call)
        const { text: answer, isError } = accessReply(outcome, input)
        return isError ? { ...reply(answer), isError } : reply(answer)
      } catch (error) {
        return failure(error)
      }
    },
    listChildren({ todo }) {
      try {
        return reply(listingText(listForAgent(context.db, taskId, todo)))
      } catch (error) {
        return failure(error)
      }
    },
    fileChildren({ filings }) {
      try {
        return reply(filedText(fileForAgent(context, taskId, filings)))
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
    'Choices and pills take one pick unless `multiple` is set. Every question is optional, and the card always ends ' +
    'with an "Anything else?" box. Returns JSON with the answers keyed by question index from 0: a choice gives the ' +
    'option id, pills the pill text, text the text typed, and `multiple` gives an array. A question the user skipped ' +
    'has no key, and any of them may be skipped, all of them included. What they typed in "Anything else?" comes ' +
    'under "anythingElse": read it first, since it may be their real answer (why no option fits, say). The user can ' +
    'reply in their own words instead; then it returns {"freeText": "…"}.',
  [GladeTool.ShowFile]:
    "Open a file in the user's Files tab, next to the chat, to point them at it: a change to review, say. Give a line " +
    'to scroll to and mark it. The file must be in the workspace.',
  [GladeTool.AddArtifact]:
    "Add a file you made to the task's artifacts: its deliverables, which the user finds under a todo in the Todos " +
    'tab and which stay with the task after it is done. Use it for what the user asked for (a report, a document, a ' +
    'draft), not for every file you change. The file must exist in the workspace. Or give a url instead of a path to ' +
    'add a link: a PR you open or work on, or the issue or ticket the task is about (http or https only). Adding the ' +
    'same path or url again renames it. Give the id of the todo it belongs under as todo: the user finds it under ' +
    'that todo.',
  [GladeTool.UpdateArtifact]:
    "Change one of the task's artifacts, named by its path (a file) or its url (a link): give it a new title, point a " +
    'file at another file of the workspace (newPath), e.g. after you moved or renamed it, or a link at another page ' +
    '(newUrl), or both. It stays under its todo in the Todos tab.',
  [GladeTool.RemoveArtifact]:
    "Take a file (by its path) or a link (by its url) off the task's artifacts, e.g. one that's no longer a " +
    'deliverable. A file itself is left alone.',
  [GladeTool.RequestAccess]:
    'Ask the user to let you read or write a folder outside your workspace, and wait for their answer. Call it when ' +
    'a command fails with "Operation not permitted" on a path outside the workspace (the sandbox blocked it), ' +
    'instead of retrying the command outside the sandbox. Give the absolute path that was blocked, whether you need ' +
    'to read or write it, and a short reason the user will read. It returns the decision: once it says the access ' +
    "is allowed, run the command again; if it's denied, don't, and it returns the user's note if they left one.",
  [GladeTool.ListChildren]:
    'List what this task has produced, its children: the files and links among its artifacts, and its commits. They ' +
    'come grouped by the todo each is under, with the ones under no todo last, and each has a short id (c1, c2, …) ' +
    'to file it by, its kind and its title. A subagent is listed only while it has no todo, with the ones under no ' +
    'todo: file it under the todo it works on. A child marked "follows cN" was made by that subagent and goes ' +
    `wherever it goes. Give a todo's id to list that todo's children alone, or "${NO_TODO}" for the ones under no todo.`,
  [GladeTool.FileChildren]:
    'File children of this task under its todos, or move them from one todo to another: the user finds each file, ' +
    "link and commit under its todo in the Todos tab. Give every filing in one call, each a child's short id (from " +
    `${GladeTool.ListChildren}, or as Glade named it to you) and the id of the todo to put it under (the N of Task ` +
    '#N). Filing a subagent says which todo it works on, and its commits go under that todo with it, so file those ' +
    "apart only to keep them somewhere else. If a child or a todo isn't there, nothing is filed and the error says " +
    'which. Create the todo first (TaskCreate) if none fits.',
}

/** The signal an MCP tool call is cancelled by, from the handler's `extra` (MCP's `RequestHandlerExtra`). */
function signalOf(extra: unknown): AbortSignal | undefined {
  const signal: unknown = typeof extra === 'object' && extra !== null ? Reflect.get(extra, 'signal') : undefined
  return signal instanceof AbortSignal ? signal : undefined
}

/** The `tool_use` id Claude Code sends with an MCP tool call, in the request's `_meta`; null when it sent none. */
function toolUseIdOf(extra: unknown): string | null {
  const meta: unknown = typeof extra === 'object' && extra !== null ? Reflect.get(extra, '_meta') : undefined
  const id: unknown = typeof meta === 'object' && meta !== null ? Reflect.get(meta, TOOL_USE_ID_META) : undefined
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * The `glade` server a dispatched child gets (#560): `request_access` and nothing else, the one Glade tool a subagent
 * may call (#450). A child's work never touches Glade's metadata, so it's offered none of the metadata tools. The
 * tool is in only when there's someone to ask (`GladeToolContext.requestAccess`), as in the main server.
 */
export function createGladeAccessMcpServer(context: GladeToolContext, taskId: string): McpSdkServerConfigWithInstance {
  const handlers = createGladeToolHandlers(context, taskId)
  return createSdkMcpServer({
    name: GLADE_SERVER,
    alwaysLoad: true,
    timeout: GLADE_TOOL_TIMEOUT_MS,
    tools: [
      ...(context.requestAccess === undefined
        ? []
        : [
            tool(
              GladeTool.RequestAccess,
              DESCRIPTIONS[GladeTool.RequestAccess],
              requestAccessInput.shape,
              (input, extra) =>
                handlers.requestAccess(input, { toolUseId: toolUseIdOf(extra), signal: signalOf(extra) }),
            ),
          ]),
    ],
  })
}

/**
 * The Glade MCP server for one task's session, without the tools for any upkeep that's off in `settings`, and with
 * `request_access` when there's someone to ask (`GladeToolContext.requestAccess`).
 */
export function createGladeMcpServer(
  context: GladeToolContext,
  taskId: string,
  settings: AgentUpkeep = ALL_UPKEEP,
): McpSdkServerConfigWithInstance {
  const handlers = createGladeToolHandlers(context, taskId)
  // The SDK's handlers are async; ours write SQLite synchronously, so they only need wrapping.
  return createSdkMcpServer({
    name: GLADE_SERVER,
    alwaysLoad: true,
    timeout: GLADE_TOOL_TIMEOUT_MS,
    tools: [
      ...(settings.taskTitles
        ? [
            tool(GladeTool.SetTitle, DESCRIPTIONS[GladeTool.SetTitle], setTitleInput.shape, (input) =>
              Promise.resolve(handlers.setTitle(input)),
            ),
          ]
        : []),
      tool(GladeTool.SetObjective, DESCRIPTIONS[GladeTool.SetObjective], setObjectiveInput.shape, (input) =>
        Promise.resolve(handlers.setObjective(input)),
      ),
      ...(settings.statusSummary
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
      tool(GladeTool.ListChildren, DESCRIPTIONS[GladeTool.ListChildren], listChildrenInput.shape, (input) =>
        Promise.resolve(handlers.listChildren(input)),
      ),
      tool(GladeTool.FileChildren, DESCRIPTIONS[GladeTool.FileChildren], fileChildrenInput.shape, (input) =>
        Promise.resolve(handlers.fileChildren(input)),
      ),
      ...(context.requestAccess === undefined
        ? []
        : [
            tool(
              GladeTool.RequestAccess,
              DESCRIPTIONS[GladeTool.RequestAccess],
              requestAccessInput.shape,
              (input, extra) =>
                handlers.requestAccess(input, { toolUseId: toolUseIdOf(extra), signal: signalOf(extra) }),
            ),
          ]),
    ],
  })
}
