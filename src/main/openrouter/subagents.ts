import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { OpenRouterChoice } from '../../shared/openrouter'
import { openRouterSdkModel } from './sdk-model'

export interface OpenRouterSubagents {
  readonly agents: Record<string, AgentDefinition>
  readonly instructions: string
}

/** Native Agent.model takes Claude aliases; named definitions accept each route's full SDK model ID. */
export function openRouterSubagents(choices: readonly OpenRouterChoice[]): OpenRouterSubagents {
  const agents = Object.fromEntries(
    choices.map((choice) => [
      openRouterSdkModel(choice.id),
      {
        model: openRouterSdkModel(choice.id),
        description:
          `Delegate work to ${choice.model.name} via ${choice.provider.name} (OpenRouter). ` +
          `Context: ${String(choice.model.contextLength)} tokens. ` +
          `USD per million tokens: input ${String(Number(choice.model.inputPrice) * 1_000_000)}, ` +
          `output ${String(Number(choice.model.outputPrice) * 1_000_000)}.`,
        prompt: 'Complete the task delegated by your parent agent, then report your findings to that agent.',
      },
    ]),
  )
  return {
    agents,
    instructions:
      'Choose the model for each subagent when dispatching it, following the user’s preferences and the work’s ' +
      'difficulty. The named OpenRouter subagents describe the models enabled in Settings, with their selected ' +
      'providers and indicative prices. Use Agent with the chosen subagent_type and omit model so its configured ' +
      'model is used. Do not use Claude model aliases to select an OpenRouter model. Built-in subagent types ' +
      'and SDK helper calls use the task’s OpenRouter model. Native children share this task’s OpenRouter connection.',
  }
}
