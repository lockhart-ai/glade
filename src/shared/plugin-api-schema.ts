/**
 * zod schemas for the messages in `./plugin-api` (`docs/plugin-api.md`): main checks what a plugin posts with
 * `pluginMessageSchema`, and a plugin can check what Glade sends it with `gladeMessageSchema`. Each is checked against
 * its type (`satisfies`, and both ways in `plugin-api-schema.test.ts`), so the two can't drift apart. Every object is
 * strict: a field the schema doesn't name fails it, which is how the tests prove nothing more reaches a plugin. A plugin
 * copying these should loosen them (`z.looseObject`), since new fields may be added without a new `apiVersion`.
 */
import { z } from 'zod'
import {
  MAX_PLUGIN_MESSAGE_BYTES,
  MAX_PLUGIN_TEXT,
  PLUGIN_API_VERSION,
  PluginEventType,
  PluginMessageType,
  PluginPermissionOutcome,
  PluginQuestionOutcome,
  PluginSubagentState,
  PluginTaskActivity,
  PluginTaskState,
  PluginToolCallState,
  PluginWaitingOn,
  type GladeMessage,
  type PluginEvent,
  type PluginMessage,
  type PluginPermissionRequest,
  type PluginQuestion,
  type PluginSubagent,
  type PluginTask,
  type PluginToolCall,
} from './plugin-api'

/** Free text, cut to `MAX_PLUGIN_TEXT`. */
const text = z.string().max(MAX_PLUGIN_TEXT)
const id = z.string()
const time = z.number()

export const pluginTaskSchema = z.strictObject({
  id,
  workspaceId: id,
  workspaceName: text,
  title: text,
  status: text,
  state: z.enum(PluginTaskState),
  activity: z.enum(PluginTaskActivity),
  needsYou: z.boolean(),
  waitingOn: z.enum(PluginWaitingOn).nullable(),
  createdAt: time,
  updatedAt: time,
  doneAt: time.nullable(),
}) satisfies z.ZodType<PluginTask>

export const pluginToolCallSchema = z.strictObject({
  id,
  taskId: id,
  subagentId: id.nullable(),
  tool: text,
  summary: text,
  state: z.enum(PluginToolCallState),
  startedAt: time,
  endedAt: time.nullable(),
}) satisfies z.ZodType<PluginToolCall>

export const pluginSubagentSchema = z.strictObject({
  id,
  taskId: id,
  name: text,
  state: z.enum(PluginSubagentState),
  latest: text.nullable(),
  startedAt: time,
  endedAt: time.nullable(),
}) satisfies z.ZodType<PluginSubagent>

export const pluginQuestionSchema = z.strictObject({
  taskId: id,
  questionSetId: id,
  prompts: z.array(text).readonly(),
  openedAt: time,
}) satisfies z.ZodType<PluginQuestion>

export const pluginPermissionRequestSchema = z.strictObject({
  taskId: id,
  requestId: id,
  subagentId: id.nullable(),
  tool: text,
  summary: text,
  openedAt: time,
}) satisfies z.ZodType<PluginPermissionRequest>

export const pluginEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal(PluginEventType.Hello),
    app: z.strictObject({ name: z.literal('Glade'), version: z.string() }),
  }),
  z.strictObject({
    type: z.literal(PluginEventType.Snapshot),
    tasks: z.array(pluginTaskSchema).readonly(),
    subagents: z.array(pluginSubagentSchema).readonly(),
    questions: z.array(pluginQuestionSchema).readonly(),
    permissions: z.array(pluginPermissionRequestSchema).readonly(),
  }),
  z.strictObject({ type: z.literal(PluginEventType.TaskCreated), task: pluginTaskSchema }),
  z.strictObject({ type: z.literal(PluginEventType.TaskUpdated), task: pluginTaskSchema }),
  z.strictObject({ type: z.literal(PluginEventType.TaskDeleted), taskId: id }),
  z.strictObject({ type: z.literal(PluginEventType.AgentToolCall), call: pluginToolCallSchema }),
  z.strictObject({
    type: z.literal(PluginEventType.AgentNote),
    taskId: id,
    subagentId: id.nullable(),
    text,
    at: time,
  }),
  z.strictObject({ type: z.literal(PluginEventType.SubagentStarted), subagent: pluginSubagentSchema }),
  z.strictObject({ type: z.literal(PluginEventType.SubagentUpdated), subagent: pluginSubagentSchema }),
  z.strictObject({ type: z.literal(PluginEventType.QuestionOpened), question: pluginQuestionSchema }),
  z.strictObject({
    type: z.literal(PluginEventType.QuestionClosed),
    taskId: id,
    questionSetId: id,
    outcome: z.enum(PluginQuestionOutcome),
  }),
  z.strictObject({ type: z.literal(PluginEventType.PermissionOpened), request: pluginPermissionRequestSchema }),
  z.strictObject({
    type: z.literal(PluginEventType.PermissionClosed),
    taskId: id,
    requestId: id,
    outcome: z.enum(PluginPermissionOutcome),
  }),
]) satisfies z.ZodType<PluginEvent>

export const gladeMessageSchema = z.strictObject({
  source: z.literal('glade'),
  apiVersion: z.literal(PLUGIN_API_VERSION),
  seq: z.number().int().positive(),
  event: pluginEventSchema,
}) satisfies z.ZodType<GladeMessage>

export const pluginMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(PluginMessageType.Ready) }),
  z.strictObject({ type: z.literal(PluginMessageType.Status), text: z.string().max(MAX_PLUGIN_MESSAGE_BYTES) }),
]) satisfies z.ZodType<PluginMessage>
