import { importSessionToStore } from '@anthropic-ai/claude-agent-sdk'
import type { Database } from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AgentSource, agentSource } from '../../shared/openrouter'
import type { AgentSessionOptions } from '../agent/backend'
import type { PreparedSdkSession, SdkSessionRuntime } from '../agent/sdk-backend'
import { getOpenRouterChoice } from '../db/repositories/openrouter'
import type { Environment } from '../login-env'
import type { OpenRouterService } from './service'
import { createOpenRouterRelay } from './relay'
import {
  failedTranscriptConfig,
  beginTranscriptImport,
  finishTranscriptImport,
  discardTranscriptImport,
  hasTranscript,
  markTranscriptFailed,
  sessionProjectKey,
  sqliteSessionStore,
} from './transcripts'
import { openRouterSdkModel } from './sdk-model'
import { importLocalTranscript } from './local-transcripts'
import { exportSessionToLocal } from './local-export'

export interface OpenRouterRuntimeOptions {
  readonly db: Database
  readonly service: OpenRouterService
  readonly dataDir: string
  readonly request: typeof fetch
}

/** Credential isolation is per SDK process. Account sessions retain the ordinary Claude configuration. */
export function openRouterRuntime({ db, service, dataDir, request }: OpenRouterRuntimeOptions): SdkSessionRuntime {
  const imports = new Set<string>()
  return {
    async prepare(options: AgentSessionOptions, inherited: Environment): Promise<PreparedSdkSession> {
      const store = sqliteSessionStore(db, options.taskId ?? null)
      const router = agentSource(options.model) === AgentSource.OpenRouter
      const sessionId = options.resumeSessionId
      const configDir = router
        ? join(dataDir, 'openrouter-sdk')
        : ([inherited.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR].find(
            (path) => path !== undefined && path !== '',
          ) ?? join(homedir(), '.claude'))
      const recoveryDir = sessionId === null ? null : failedTranscriptConfig(db, sessionId, options.taskId ?? null)
      let imported = false
      let adopted = options.provisional !== true
      const activate = (): void => {
        adopted = true
        if (imported && sessionId !== null) finishTranscriptImport(db, sessionId, options.taskId ?? null)
      }
      const discard = (): void => {
        if (imported && !adopted && sessionId !== null && db.open) {
          discardTranscriptImport(db, sessionId, options.taskId ?? null)
          if (recoveryDir !== null) markTranscriptFailed(db, sessionId, options.taskId ?? null, recoveryDir)
        }
      }
      try {
        let mirrored = sessionId !== null && hasTranscript(db, sessionId, options.taskId ?? null)
        // The first handoff to OpenRouter imports Claude's local history into the store. Every later handoff to
        // OpenRouter re-imports too, merging in whatever a Claude leg wrote locally since (no Claude start mirrors
        // continuously any more — see the Anthropic branch below): `importLocalTranscript`'s upsert keys on the
        // entry's own id and never touches an existing row's ordinal, so a repeat import only adds rows, in order,
        // rather than rebuilding the store. Recovery (`recoveryDir`) still rebuilds outright, as before.
        if (sessionId !== null && (recoveryDir !== null || router)) {
          const rebuilding = recoveryDir !== null || !mirrored
          const scope = `${options.taskId ?? ''}:${sessionId}`
          if (imports.has(scope))
            throw new Error('The saved history is still being loaded. Retry when it has finished.')
          imports.add(scope)
          imported = rebuilding
          try {
            if (rebuilding) beginTranscriptImport(db, sessionId, options.taskId ?? null, recoveryDir)
            const explicitConfig = recoveryDir ?? inherited.CLAUDE_CONFIG_DIR
            if (explicitConfig && explicitConfig !== process.env.CLAUDE_CONFIG_DIR)
              await importLocalTranscript(store, { configDir: explicitConfig, sessionId })
            else await importSessionToStore(sessionId, store, { dir: options.cwd, includeSubagents: true })
          } catch (error) {
            if (recoveryDir !== null)
              throw new Error(
                'The complete SDK history could not be recovered. Retry after restoring the transcript file, or start a new task and copy the context you need from this task’s saved chat.',
                { cause: error },
              )
            throw error
          } finally {
            imports.delete(scope)
          }
          mirrored = hasTranscript(db, sessionId, options.taskId ?? null, true)
          if (!mirrored) throw new Error('The saved SDK history could not be loaded. The model was not switched.')
          if (adopted) activate()
        }
        const mirrorFailure = (failedSessionId: string): void => {
          markTranscriptFailed(db, failedSessionId, options.taskId ?? null, configDir)
        }
        if (agentSource(options.model) === AgentSource.Anthropic) {
          const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.startsWith('OPENROUTER_')))
          for (const name of new Set([...Object.keys(process.env), ...Object.keys(inherited)]))
            if (name.startsWith('OPENROUTER_')) env[name] = ''
          // A mirrored session — a task's own, or a dispatched child's (#627): same scoping, by `taskId` and its
          // own `sessionId` — exports the store's history into its real config, below, so it can resume with
          // `resume` alone and never pass `sessionStore` — the one lever that keeps the Agent SDK from building a
          // `claude-resume-<id>` temporary folder and copying the login in with its refresh token stripped
          // (`docs/sdk-notes.md`, "Cross-source resume and the login copy"). Losing the OpenRouter history is the
          // greater harm, so any doubt about the export falls back to the store.
          let useStore = false
          if (mirrored && sessionId !== null) {
            // `sessionProjectKey` reads the exact rows `hasTranscript` (which `mirrored` is built from) requires to
            // exist, so it is never null here. The code stays safe if that ever stops holding: resuming with neither
            // the store nor an export would drop the task's history, the greater harm, so a missing key falls back
            // to the store with a warning, exactly like a failed export.
            const projectKey = sessionProjectKey(db, sessionId, options.taskId ?? null)
            if (projectKey === null) {
              options.log?.warn(
                'the mirrored transcript has no project key to export under; resuming through the session store instead',
                {
                  sessionId,
                },
              )
              useStore = true
            } else {
              try {
                await exportSessionToLocal(store, { configDir, projectKey, sessionId })
              } catch (error) {
                options.log?.warn(
                  'could not export the mirrored transcript into the real Claude config; resuming through the session store instead',
                  { sessionId, error },
                )
                useStore = true
              }
            }
          }
          return {
            env,
            ...(useStore ? { sessionStore: store } : {}),
            ...(useStore ? { onMirrorError: mirrorFailure } : {}),
            publishModels: true,
            activate,
            close() {
              discard()
            },
          }
        }
        const choice = getOpenRouterChoice(db, options.model)
        if (!choice?.enabled) throw new Error('Enable this OpenRouter model in Settings → Models before continuing.')
        service.key()
        const config = configDir
        await mkdir(config, { recursive: true, mode: 0o700 })
        const choices = [choice]
        const relay = await createOpenRouterRelay({
          choices,
          key: () => service.key(),
          request,
          ...(options.log === undefined ? {} : { log: options.log }),
          onComplete: (status) => {
            service.noteResponse(status)
            void service.refreshUsage()
          },
        })
        const model = openRouterSdkModel(choice.id)
        const contextWindowTokens = choice.model.contextLength
        const env: Record<string, string> = {}
        // SDK subprocesses merge process.env under this map: omission alone would reintroduce credentials.
        for (const name of new Set([...Object.keys(process.env), ...Object.keys(inherited)])) {
          if (
            /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR|OPENROUTER_)/.test(
              name,
            )
          )
            env[name] = ''
        }
        for (const [name, value] of Object.entries(inherited)) {
          if (
            !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR|OPENROUTER_)/.test(
              name,
            )
          )
            env[name] = value
        }
        Object.assign(env, {
          ANTHROPIC_BASE_URL: relay.url,
          ANTHROPIC_AUTH_TOKEN: relay.token,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: '',
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '',
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
          // The SDK's unknown-model default is 200K; its installed runtime supports this explicit real-window override.
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindowTokens),
        })
        return {
          model,
          contextWindowTokens,
          env,
          sessionStore: store,
          onMirrorError: mirrorFailure,
          publishModels: false,
          activate,
          close: () => {
            relay.close()
            discard()
          },
        }
      } catch (error) {
        // A startup failure can happen after the import but before a prepared session exists to close.
        adopted = false
        discard()
        throw error
      }
    },
  }
}
