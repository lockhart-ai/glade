/**
 * The Glade tools: the in-process MCP server that lets the agent drive the UI (`docs/model-surface.md`). Each task's
 * session gets its own server, built for that task, so the handlers know which task they change.
 *
 * The model sees the tools as `mcp__glade__<name>`. The server sets `alwaysLoad`, or the model would have to find them
 * through tool search first (`docs/sdk-notes.md` §3). The SDK checks each call's input against its zod shape before the
 * handler runs, and turns a failed check, or a handler that throws, into a tool error for the model; nothing a call
 * sends can crash the app.
 */
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getTask } from '../db/repositories/tasks'
import { updateTaskFromAgent, type TaskServiceContext } from '../tasks/service'

/** The server's name: the `glade` in `mcp__glade__set_title`. */
export const GLADE_SERVER = 'glade'

/** The tools' names, as Glade defines them. Draft names: not yet confirmed with Jared. */
export enum GladeTool {
  SetTitle = 'set_title',
  SetObjective = 'set_objective',
  SetStatus = 'set_status',
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

/** A tool's reply to the model: MCP's own result type. */
export type GladeToolResult = CallToolResult

function reply(message: string): GladeToolResult {
  return { content: [{ type: 'text', text: message }] }
}

/** The handlers for one task, given input the SDK has already checked. */
export interface GladeToolHandlers {
  setTitle(input: SetTitleInput): GladeToolResult
  setObjective(input: SetObjectiveInput): GladeToolResult
  setStatus(input: SetStatusInput): GladeToolResult
}

export function createGladeToolHandlers(context: TaskServiceContext, taskId: string): GladeToolHandlers {
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
}

/** The Glade MCP server for one task's session. */
export function createGladeMcpServer(context: TaskServiceContext, taskId: string): McpSdkServerConfigWithInstance {
  const handlers = createGladeToolHandlers(context, taskId)
  // The SDK's handlers are async; ours write SQLite synchronously, so they only need wrapping.
  return createSdkMcpServer({
    name: GLADE_SERVER,
    alwaysLoad: true,
    tools: [
      tool(GladeTool.SetTitle, DESCRIPTIONS[GladeTool.SetTitle], setTitleInput.shape, (input) =>
        Promise.resolve(handlers.setTitle(input)),
      ),
      tool(GladeTool.SetObjective, DESCRIPTIONS[GladeTool.SetObjective], setObjectiveInput.shape, (input) =>
        Promise.resolve(handlers.setObjective(input)),
      ),
      tool(GladeTool.SetStatus, DESCRIPTIONS[GladeTool.SetStatus], setStatusInput.shape, (input) =>
        Promise.resolve(handlers.setStatus(input)),
      ),
    ],
  })
}
