import { importSessionToStore } from '@anthropic-ai/claude-agent-sdk'
import type { Database } from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentSource, agentSource } from '../../shared/openrouter'
import type { AgentSessionOptions } from '../agent/backend'
import type { PreparedSdkSession, SdkSessionRuntime } from '../agent/sdk-backend'
import { validateSubagentModel } from '../models/switches'
import { getOpenRouterChoice } from '../db/repositories/openrouter'
import type { Environment } from '../login-env'
import type { OpenRouterService } from './service'
import { createOpenRouterRelay } from './relay'
import { hasTranscript, sqliteSessionStore } from './transcripts'
import { openRouterSdkModel } from './sdk-model'

export interface OpenRouterRuntimeOptions {
  readonly db: Database
  readonly service: OpenRouterService
  readonly dataDir: string
}

/** Credential isolation is per SDK process. Account sessions retain the ordinary Claude configuration. */
export function openRouterRuntime({ db, service, dataDir }: OpenRouterRuntimeOptions): SdkSessionRuntime {
  return {
    async prepare(options: AgentSessionOptions, inherited: Environment): Promise<PreparedSdkSession> {
      const store = sqliteSessionStore(db, options.taskId ?? null)
      let mirrored = true
      if (options.resumeSessionId !== null && !hasTranscript(db, options.resumeSessionId, options.taskId ?? null)) {
        try {
          await importSessionToStore(options.resumeSessionId, store, { dir: options.cwd, includeSubagents: true })
          mirrored = hasTranscript(db, options.resumeSessionId, options.taskId ?? null)
        } catch (error) {
          if (agentSource(options.model) === AgentSource.OpenRouter) throw error
          mirrored = false
        }
        if (!mirrored && agentSource(options.model) === AgentSource.OpenRouter)
          throw new Error('The saved SDK history could not be loaded. The model was not switched.')
      }
      validateSubagentModel(db, options.model, options.subagentModel)
      if (agentSource(options.model) === AgentSource.Anthropic) {
        const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.startsWith('OPENROUTER_')))
        for (const name of new Set([...Object.keys(process.env), ...Object.keys(inherited)]))
          if (name.startsWith('OPENROUTER_')) env[name] = ''
        env.CLAUDE_CODE_SUBAGENT_MODEL = options.subagentModel ?? ''
        // Old account sessions can still resume from the SDK's files if its alpha importer cannot mirror them.
        return {
          env,
          ...(mirrored ? { sessionStore: store } : {}),
          publishModels: true,
          close() {
            return undefined
          },
        }
      }
      const choice = getOpenRouterChoice(db, options.model)
      if (!choice?.enabled) throw new Error('Enable this OpenRouter model in Settings → Models before continuing.')
      service.key()
      if (!(await service.endpoints(choice.model.id)).some(({ id }) => id === choice.provider.id)) {
        throw new Error('The saved OpenRouter provider is no longer available for this model.')
      }
      const config = join(dataDir, 'openrouter-sdk')
      await mkdir(config, { recursive: true, mode: 0o700 })
      const child = options.subagentModel == null ? choice : getOpenRouterChoice(db, options.subagentModel)
      if (!child?.enabled) throw new Error('The subagent model is unavailable.')
      if (
        child.id !== choice.id &&
        !(await service.endpoints(child.model.id)).some(({ id }) => id === child.provider.id)
      ) {
        throw new Error('The saved subagent provider is no longer available for this model.')
      }
      const relay = await createOpenRouterRelay({
        choices: [choice, child],
        key: () => service.key(),
        onGeneration: (id, route) => {
          service.recordGeneration({ id, choiceId: route.id, taskId: options.taskId ?? null })
        },
        onComplete: () => {
          void service.reconcileGenerations()
        },
      })
      const model = openRouterSdkModel(choice.id)
      const childModel = openRouterSdkModel(child.id)
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
        ANTHROPIC_DEFAULT_OPUS_MODEL: childModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: childModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: childModel,
        CLAUDE_CODE_SUBAGENT_MODEL: childModel,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
        // The SDK's unknown-model default is 200K; its installed runtime supports this explicit real-window override.
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(Math.min(choice.model.contextLength, child.model.contextLength)),
      })
      return {
        model,
        env,
        sessionStore: store,
        publishModels: false,
        close: () => {
          relay.close()
        },
      }
    },
  }
}
