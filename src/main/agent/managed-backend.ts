import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  AGENTS_SERVER,
  DISPATCH_AGENT_TOOL,
  DispatchIsolation,
  MESSAGE_CHILD_TOOL,
  type DispatchAgentInput,
  type MessageChildInput,
} from '../../shared/managed-agents'
import { effortFor, findModel } from '../../shared/models'
import { AgentSource, agentSource } from '../../shared/openrouter'
import type { AccountSink } from '../account/account'
import { listModels } from '../models/models'
import { validateModel } from '../models/switches'
import { getOpenRouterChoice, openRouterConnected } from '../db/repositories/openrouter'
import { Row } from '../db/repositories/rows'
import { setAgentCallTokenTotals } from '../db/repositories/tool-events'
import {
  AgentEventKind,
  TaskOutcome,
  createSdkMessageParser,
  type AgentEvent,
  type SubagentStartedEvent,
  type TurnUsage,
} from './events'
import {
  McpServerAudience,
  PromptVerdict,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type SandboxFlagSettings,
} from './backend'
import { SILENT_LOGGER } from '../logging/logger'
import { TOOL_USE_ID_META } from './mcp-tool-caller'
import { isSubagentTool } from '../../shared/subagents'
import { isSandboxed } from './sdk-backend'
import { delegatedChildPrompt } from './system-prompt'

interface ManagedBackendOptions {
  readonly db: Database
  readonly backend: AgentBackend
  readonly account?: AccountSink
}
interface ChildRecord {
  readonly id: string
  readonly model: string
  readonly sessionId: string | null
  readonly state: TaskOutcome | 'running'
  readonly result: string
  readonly toolUseId: string
  /** The git worktree it works in, by name (#558); null in the workspace root. */
  readonly worktree: string | null
}
interface ChildRun {
  readonly record: ChildRecord
  readonly session: AgentSession
  readonly background: boolean
  readonly done: Promise<string>
  readonly finish: (result: string) => void
  readonly tasks: Map<string, SubagentStartedEvent>
  result: string
  outcome: TaskOutcome | null
  ended: boolean
  /**
   * What `message_child` pushed into this run's turn, in order, each with the uuid `send` gave it. A message pushed
   * while a turn runs is folded into it at its next tool round (`docs/sdk-notes.md` §2): the turn's own result then
   * names every uuid it answered (`TurnFinishedEvent.userMessageUuids`). Any of these not named there missed the turn:
   * its session closed at the turn's `TurnFinished` (one run is one turn), so it never reached the child.
   */
  readonly pending: { uuid: string; text: string }[]
}
const dispatchInput = z.object({
  model: z.string().min(1).describe('An exact id returned by list_models. Select a model for this job.'),
  prompt: z.string().min(1).describe('The delegated task, with the context the child needs.'),
  description: z.string().min(1).describe('A short task label. Prefix with [todo N] to file it under that todo.'),
  run_in_background: z.boolean().optional(),
  resume: z.string().min(1).optional().describe('A returned child id to continue on its original model.'),
  isolation: z
    .enum(DispatchIsolation)
    .optional()
    .describe(
      '"worktree" starts the child in its own git worktree, kept afterwards. A resumed child keeps what it had.',
    ),
}) satisfies z.ZodType<DispatchAgentInput>
const messageChildInput = z.object({
  id: z.string().min(1).describe('A child dispatch returned with run_in_background, still running in this task.'),
  text: z.string().min(1).describe('The text to send it, folded into its turn before its next tool call.'),
}) satisfies z.ZodType<MessageChildInput>
const extraSchema = z.looseObject({
  _meta: z.record(z.string(), z.unknown()).optional(),
  signal: z.instanceof(AbortSignal).optional(),
})

function readChild(db: Database, taskId: string, id: string): ChildRecord | null {
  const raw = db.prepare('SELECT * FROM managed_agents WHERE task_id = ? AND id = ?').get(taskId, id)
  return raw === undefined ? null : childRecord(raw)
}

function childRecord(raw: unknown): ChildRecord {
  const row = new Row('managed_agents', raw)
  return {
    id: row.text('id'),
    model: row.text('model'),
    sessionId: row.nullableText('session_id'),
    state: row.oneOf('state', ['running', ...Object.values(TaskOutcome)]),
    result: row.text('result'),
    toolUseId: row.text('tool_use_id'),
    worktree: row.nullableText('worktree'),
  }
}

/**
 * What a child's result says of the worktree it works in (#558). Claude Code keeps the worktree and its branch when
 * the session ends, changed or not, and Glade's git only reads (#487): removing them is the parent's to do.
 */
function worktreeNote(worktree: string | null): string {
  return worktree === null
    ? ''
    : ` Its git worktree is .claude/worktrees/${worktree} in the repository, on branch worktree-${worktree}. Both are kept when it ends: use them, then remove them yourself (git worktree unlock, git worktree remove, git branch -D).`
}

/**
 * What a child's completion says of a `message_child` send that missed its turn (#596): a message is folded into the
 * child's turn only at its next tool round (`docs/sdk-notes.md` §2), and the run ends at that turn's own
 * `TurnFinished`, so one pushed too late never reaches it. `userMessageUuids` names every pushed message the turn
 * actually answered (the child's own first prompt is sent by `dispatch`, under a different uuid this never tracks, so
 * it is never named here as missed); null when the SDK doesn't say, read as "no proof either way", not as a loss.
 * Only the first undelivered message is named: in practice at most the latest one, pushed right at the turn's end,
 * can ever miss it.
 */
function undeliveredNote(
  pending: readonly { uuid: string; text: string }[],
  userMessageUuids: readonly string[] | null,
): string {
  if (userMessageUuids === null) return ''
  const missed = pending.find((message) => !userMessageUuids.includes(message.uuid))
  if (missed === undefined) return ''
  return ` One of your messages to it, "${missed.text.slice(0, 80)}", did not reach it before it finished: use dispatch with resume to continue it.`
}

/** Each delegated agent runs the existing backend on its own connection, with the task's permissions and tools. */
export function managedBackend({ db, backend, account }: ManagedBackendOptions): AgentBackend {
  const wrap = (options: AgentSessionOptions): AgentSession => {
    if (options.taskId === undefined || !openRouterConnected(db)) return backend.start(options)
    const taskId = options.taskId
    const log = options.log ?? SILENT_LOGGER
    const runs = new Map<string, ChildRun>()
    const calls = new Map<string, string[]>()
    let closed = false
    let settings = { model: options.model, effort: options.effort, permissionMode: options.permissionMode }
    let flags: SandboxFlagSettings | undefined = options.flagSettings
    const emit = (event: AgentEvent): void => {
      if (!closed) options.onSubagentEvent?.(event)
    }
    const readUsage = (run: ChildRun): void => {
      if (account === undefined || agentSource(run.record.model) !== AgentSource.Anthropic) return
      void run.session.usage().then(
        (usage) => {
          if (!closed) account.usageRead(usage)
        },
        (error: unknown) => {
          log.info('could not read child account usage', { error })
        },
      )
    }
    const finish = (run: ChildRun, state: TaskOutcome, result: string): void => {
      if (run.ended) return
      run.ended = true
      run.outcome = state
      runs.delete(run.record.id)
      // A completed delegation owns no surviving processes. Its descendants can be resumed explicitly later.
      run.session.close()
      for (const event of run.tasks.values())
        emit({
          kind: AgentEventKind.TaskFinished,
          sdkTaskId: event.sdkTaskId,
          toolUseId: event.toolUseId,
          outcome: TaskOutcome.Stopped,
          summary: 'The delegated agent ended.',
          contextTokens: null,
        })
      if (db.open)
        db.prepare('UPDATE managed_agents SET state = ?, result = ? WHERE id = ? AND task_id = ?').run(
          state,
          result,
          run.record.id,
          taskId,
        )
      emit({
        kind: AgentEventKind.TaskFinished,
        sdkTaskId: run.record.id,
        toolUseId: run.record.toolUseId,
        outcome: state,
        summary: result,
        contextTokens: null,
      })
      run.finish(result)
      if (run.background && !closed) {
        try {
          parent.send(
            `Child ${run.record.id} (${run.record.model}) ${state}: ${result}${worktreeNote(run.record.worktree)}`,
            randomUUID(),
          )
        } catch (error) {
          log.warn('could not deliver child completion', { childId: run.record.id, error })
        }
      }
    }
    const stop = (run: ChildRun): void => {
      finish(run, TaskOutcome.Stopped, 'You stopped it.')
    }
    /**
     * What this run spent, kept on the dispatch call that started the child for its line on the Agents tab (#589):
     * "in" counts the turn's prompt, its cache reads and its cache writes, and "out" its replies. A run is one turn —
     * it ends here — so its totals are what this run's usage alone says, whatever an earlier run of the child's used;
     * a turn that says nothing writes nothing. Subagents' tokens are never here — the turn's usage already leaves
     * them out.
     */
    const noteChildTotals = (run: ChildRun, usage: TurnUsage | null): void => {
      if (usage === null || !db.open) return
      const totalInputTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
      if (totalInputTokens === 0 && usage.outputTokens === 0) return
      setAgentCallTokenTotals(db, {
        taskId,
        toolUseId: run.record.toolUseId,
        totalInputTokens,
        totalOutputTokens: usage.outputTokens,
      })
    }
    const dispatch = async (input: DispatchAgentInput, extra: unknown) => {
      if (closed) throw new Error('The parent session has ended.')
      validateModel(db, input.model)
      if (findModel(listModels(db), input.model) === undefined)
        throw new Error('Choose a currently available model id from list_models.')
      if (agentSource(input.model) === agentSource(settings.model))
        throw new Error(
          'Use the built-in Agent tool for children on the same source. Dispatch is only for the other source.',
        )
      const parsed = extraSchema.safeParse(extra)
      const metaId = parsed.success ? parsed.data._meta?.[TOOL_USE_ID_META] : undefined
      const key = JSON.stringify(input)
      const pending = calls.get(key)
      const toolUseId = typeof metaId === 'string' ? metaId : pending?.[0]
      if (toolUseId === undefined) throw new Error('Glade could not associate this dispatch with its tool call.')
      if (pending !== undefined) {
        const index = pending.indexOf(toolUseId)
        if (index >= 0) pending.splice(index, 1)
        if (pending.length === 0) calls.delete(key)
      }
      const duplicate = db
        .prepare('SELECT * FROM managed_agents WHERE task_id = ? AND tool_use_id = ?')
        .get(taskId, toolUseId)
      if (duplicate !== undefined) {
        const prior = childRecord(duplicate)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Child ${prior.id}: ${prior.state}. ${prior.result}${worktreeNote(prior.worktree)}`,
            },
          ],
        }
      }
      const previous = input.resume === undefined ? null : readChild(db, taskId, input.resume)
      if (input.resume !== undefined && previous?.sessionId == null)
        throw new Error('This child has no saved SDK session to resume in this task.')
      if (previous !== null && (previous.model !== input.model || previous.state === 'running'))
        throw new Error('Resume the child on its original model after it has finished.')
      const id = `glade-child-${randomUUID()}`
      // A resumed child goes back into the worktree its first run had, whatever this call says: its session is there.
      const fresh = input.isolation === DispatchIsolation.Worktree ? id : null
      const worktree = previous === null ? fresh : previous.worktree
      if (worktree !== null && isSandboxed({ flagSettings: flags }))
        throw new Error(
          'A sandboxed session cannot give a child a git worktree, as it is not offered EnterWorktree. Dispatch without isolation.',
        )
      db.prepare(
        "INSERT INTO managed_agents (id, task_id, tool_use_id, model, state, worktree) VALUES (?, ?, ?, ?, 'running', ?)",
      ).run(id, taskId, toolUseId, input.model, worktree)
      const active: { run?: ChildRun } = {}
      // The child runs in the sandbox its parent runs in, if any, and gets the servers and prompt built for a child:
      // only what it may use, and none of the main agent's Glade instructions (#560).
      const sandboxed = isSandboxed({ flagSettings: flags })
      const onToolPermission = options.onToolPermission
      const { onAccessRequested, onToolStarting, onChildStarting } = options.hooks ?? {}
      const childOptions: AgentSessionOptions = {
        ...options,
        provisional: false,
        managedAgentId: id,
        // Its own worktree, or else the one this session works in (from `options`): a child's children share its folder.
        ...(worktree === null ? {} : { worktree }),
        model: input.model,
        resumeSessionId: previous?.sessionId ?? null,
        effort: effortFor(listModels(db), input.model, settings.effort),
        permissionMode: settings.permissionMode,
        flagSettings: flags,
        mcpServers: options.createMcpServers?.({ audience: McpServerAudience.DispatchedChild, sandboxed }) ?? {},
        systemPromptAppend: delegatedChildPrompt(sandboxed),
        onSubagentEvent: (event) => {
          if (event.kind === AgentEventKind.SubagentStarted) active.run?.tasks.set(event.sdkTaskId, event)
          if (event.kind === AgentEventKind.TaskFinished) active.run?.tasks.delete(event.sdkTaskId)
          emit(event)
        },
        onToolPermission:
          onToolPermission === undefined
            ? undefined
            : (call) => onToolPermission({ ...call, agentId: call.agentId ?? id }),
        hooks: {
          ...options.hooks,
          onPrompt: () => PromptVerdict.Allow,
          onTurnEnded: () => undefined,
          onCompacted: () => undefined,
          onBatchFinished: undefined,
          onTurnEnding: undefined,
          onAccessRequested:
            onAccessRequested === undefined
              ? undefined
              : (call) => {
                  onAccessRequested({ ...call, agentId: call.agentId ?? id })
                },
          onToolStarting:
            onToolStarting === undefined
              ? undefined
              : (call) => onToolStarting({ ...call, agentId: call.agentId ?? id }),
          onChildStarting:
            onChildStarting === undefined
              ? undefined
              : (call) => onChildStarting({ ...call, agentId: call.agentId ?? id }),
        },
      }
      let child: AgentSession
      try {
        child = wrap(childOptions)
      } catch (error) {
        db.prepare("UPDATE managed_agents SET state = 'failed', result = ? WHERE id = ?").run(String(error), id)
        throw error
      }
      let resolve: (result: string) => void = () => undefined
      const done = new Promise<string>((ready) => {
        resolve = ready
      })
      const background = input.run_in_background === true
      const run: ChildRun = {
        record: { id, model: input.model, sessionId: null, state: 'running', result: '', toolUseId, worktree },
        session: child,
        background,
        done,
        finish: resolve,
        tasks: new Map(),
        result: '',
        outcome: null,
        ended: false,
        pending: [],
      }
      active.run = run
      const ended = (): boolean => run.ended || closed
      runs.set(id, run)
      emit({
        kind: AgentEventKind.SubagentStarted,
        sdkTaskId: id,
        toolUseId,
        background,
        taskType: 'local_agent',
        isBackgrounded: background,
        description: input.description,
      })
      const signal = parsed.success ? parsed.data.signal : undefined
      const cancel = (): void => {
        if (!background) stop(run)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      const parse = createSdkMessageParser(log)
      void (async () => {
        try {
          await child.ready?.()
          if (ended()) return
          if (flags !== undefined) await child.applyFlagSettings(flags)
          if (ended()) return
          if (account !== undefined && agentSource(input.model) === AgentSource.Anthropic) {
            void child.accountInfo().then(
              (info) => {
                if (!closed) account.accountRead(info)
              },
              (error: unknown) => {
                log.info('could not read child account', { error })
              },
            )
            readUsage(run)
          }
          child.send(input.prompt, randomUUID())
          for await (const raw of child.messages)
            for (const event of parse(raw)) {
              if (ended()) return
              switch (event.kind) {
                case AgentEventKind.SessionStarted:
                  db.prepare('UPDATE managed_agents SET session_id = ? WHERE id = ?').run(event.sessionId, id)
                  break
                case AgentEventKind.TurnFinished:
                  noteChildTotals(run, event.usage)
                  readUsage(run)
                  finish(
                    run,
                    event.isError ? TaskOutcome.Failed : TaskOutcome.Completed,
                    `${event.result || run.result || 'Child finished.'}${undeliveredNote(run.pending, event.userMessageUuids)}`,
                  )
                  return
                case AgentEventKind.Text:
                  if (event.parentToolUseId === null) run.result += `${run.result ? '\n\n' : ''}${event.text}`
                  emit({ ...event, parentToolUseId: event.parentToolUseId ?? toolUseId })
                  break
                case AgentEventKind.ToolCallStarted:
                  emit({
                    ...event,
                    parentToolUseId: event.parentToolUseId ?? toolUseId,
                    input:
                      isSubagentTool(event.name) &&
                      event.name !== DISPATCH_AGENT_TOOL &&
                      agentSource(input.model) === AgentSource.OpenRouter
                        ? { ...event.input, model: input.model }
                        : event.input,
                  })
                  break
                case AgentEventKind.ToolResult:
                case AgentEventKind.MessagesEvicted:
                case AgentEventKind.SubagentProgress:
                case AgentEventKind.SubagentBackgrounded:
                  emit(event)
                  break
                case AgentEventKind.SubagentStarted:
                  run.tasks.set(event.sdkTaskId, event)
                  emit(event)
                  break
                case AgentEventKind.TaskFinished:
                  run.tasks.delete(event.sdkTaskId)
                  emit(event)
                  break
                case AgentEventKind.RateLimit:
                  if (agentSource(input.model) === AgentSource.Anthropic) account?.rateLimit(event)
                  break
                // Child context, errors and compaction belong to the child's transcript, never the parent task.
                case AgentEventKind.McpServersReported:
                case AgentEventKind.ContextUsed:
                case AgentEventKind.Compacting:
                case AgentEventKind.Compacted:
                case AgentEventKind.CompactionFailed:
                case AgentEventKind.SessionFailed:
                case AgentEventKind.ApiRetry:
                case AgentEventKind.ApiError:
                case AgentEventKind.ModelRefusalFallback:
                case AgentEventKind.ModelRefusalNoFallback:
                  break
              }
            }
          finish(run, TaskOutcome.Failed, 'The child SDK session ended before completing its task.')
        } catch (error) {
          finish(run, TaskOutcome.Failed, error instanceof Error ? error.message : String(error))
        } finally {
          signal?.removeEventListener('abort', cancel)
        }
      })()
      if (background)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Started child ${id} on ${input.model}. Its completion will be delivered to this session.${worktreeNote(worktree)}`,
            },
          ],
        }
      const result = await done
      return {
        isError: run.outcome !== TaskOutcome.Completed,
        content: [{ type: 'text' as const, text: `Child ${id} (${input.model}): ${result}${worktreeNote(worktree)}` }],
      }
    }
    const messageChild = (input: MessageChildInput) => {
      const found = readChild(db, taskId, input.id)
      const run = runs.get(input.id)
      if (found?.state !== 'running' || run === undefined)
        throw new Error('This child cannot be messaged now. Use dispatch with resume to continue it.')
      const uuid = randomUUID()
      const marked = `Message from your parent:\n\n${input.text}`
      run.session.send(marked, uuid)
      run.pending.push({ uuid, text: input.text })
      emit({ kind: AgentEventKind.Text, text: marked, parentToolUseId: run.record.toolUseId, sdkUuid: null })
      return Promise.resolve({
        content: [{ type: 'text' as const, text: `Queued for ${input.id}'s next tool call.` }],
      })
    }
    const server = createSdkMcpServer({
      name: AGENTS_SERVER,
      alwaysLoad: true,
      tools: [
        tool(
          'list_models',
          'List currently available Claude-account and curated OpenRouter models. Settings controls providers.',
          {},
          () =>
            Promise.resolve({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    listModels(db).map((model) => {
                      const route = getOpenRouterChoice(db, model.id)
                      return {
                        ...model,
                        ...(route === undefined
                          ? {}
                          : {
                              inputPrice: route.model.inputPrice,
                              outputPrice: route.model.outputPrice,
                              priceUnit: 'USD per token',
                            }),
                      }
                    }),
                  ),
                },
              ],
            }),
        ),
        tool(
          'dispatch',
          'Delegate work to a child on the other source (Claude account or OpenRouter). Use the built-in Agent tool for same-source children. Call list_models first. Use resume with a child id to continue its saved conversation while its source differs from the parent.',
          dispatchInput.shape,
          dispatch,
        ),
        tool(
          'message_child',
          'Send text to a child dispatch started with run_in_background, while it still runs: folded into its current ' +
            'turn before its next tool call, not read at once. Only works while it is running in the background (a ' +
            "foreground child's id is unknown until it finishes); one way, with nothing returned but the queued " +
            'confirmation. A refusal means the child cannot be messaged now: use dispatch with resume instead.',
          messageChildInput.shape,
          messageChild,
        ),
      ],
    })
    const recover = (): void => {
      if (options.managedAgentId === undefined)
        db.prepare(
          "UPDATE managed_agents SET state = 'stopped', result = 'The task session ended. Resume this child to continue.' WHERE task_id = ? AND state = 'running'",
        ).run(taskId)
    }
    if (!options.provisional) recover()
    const parent = backend.start({
      ...options,
      mcpServers: { ...options.mcpServers, [AGENTS_SERVER]: server },
      systemPromptAppend: `${options.systemPromptAppend}\nUse the built-in Agent tool for subagents on your own source, retaining its agent types, worktree isolation and SendMessage. Only to start a child on the other source (Claude account or OpenRouter), call mcp__glade-agents__list_models for current models and OpenRouter prices, then use ${DISPATCH_AGENT_TOOL}. Pass isolation: "worktree" to start that child in its own git worktree, which is kept afterwards for you to use and remove. Choose that child's model for its job; provider selection is controlled by Settings. Native Agent children under OpenRouter use this process's current route; another OpenRouter route is not supported for a child. Resume cross-source children with dispatch's resume id while their source differs from yours; SendMessage only addresses native children. While a background child still runs, ${MESSAGE_CHILD_TOOL} can send it more text, one way, folded into its current turn.`,
      hooks: {
        onPrompt: () => PromptVerdict.Allow,
        onTurnEnded: () => undefined,
        onCompacted: () => undefined,
        ...options.hooks,
        onChildStarting: async (call) => {
          const updated = await options.hooks?.onChildStarting?.(call)
          if (call.toolName === DISPATCH_AGENT_TOOL) {
            const key = JSON.stringify(dispatchInput.parse(updated ?? call.input))
            calls.set(key, [...(calls.get(key) ?? []), call.toolUseId])
          }
          return updated ?? null
        },
      },
    })
    return {
      get contextWindowTokens() {
        return parent.contextWindowTokens
      },
      ready: () => parent.ready?.() ?? Promise.resolve(),
      activate: () => {
        parent.activate?.()
        recover()
      },
      messages: parent.messages,
      send: (text, uuid, images) => {
        parent.send(text, uuid, images)
      },
      configure: (next) => {
        const configured = parent.configure(next)
        const children = (): void | Promise<void> => {
          settings = next
          if (runs.size === 0) return
          return Promise.all(
            [...runs.values()].map(async ({ session, record }) => {
              await session.configure({
                ...next,
                model: record.model,
                effort: effortFor(listModels(db), record.model, next.effort),
              })
            }),
          ).then(() => undefined)
        }
        return configured === undefined ? children() : configured.then(children)
      },
      applyFlagSettings: (next) =>
        parent.applyFlagSettings(next).then(async () => {
          flags = { ...flags, ...next }
          await Promise.all([...runs.values()].map(({ session }) => session.applyFlagSettings(next)))
        }),
      interrupt: async () => {
        for (const run of [...runs.values()]) if (!run.background) stop(run)
        await parent.interrupt()
      },
      stopTask: async (id) => {
        const run = runs.get(id)
        if (run !== undefined) stop(run)
        else {
          const owner = [...runs.values()].find(({ tasks }) => tasks.has(id))
          await (owner?.session ?? parent).stopTask(id)
        }
      },
      contextUsage: () => parent.contextUsage(),
      accountInfo: () => parent.accountInfo(),
      usage: () => parent.usage(),
      close: () => {
        closed = true
        for (const run of [...runs.values()]) stop(run)
        parent.close()
      },
    }
  }
  return { start: wrap }
}
