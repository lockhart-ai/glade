import { z } from 'zod'
import type { OpenRouterChoice, OpenRouterModel, OpenRouterProvider } from '../../shared/openrouter'

export const openRouterModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  contextLength: z.number().int().positive(),
  inputs: z.array(z.string()),
  parameters: z.array(z.string()),
  inputPrice: z.string(),
  outputPrice: z.string(),
}) satisfies z.ZodType<OpenRouterModel>

export const openRouterProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  inputPrice: z.string().optional(),
  outputPrice: z.string().optional(),
  contextLength: z.number().int().positive().optional(),
  parameters: z.array(z.string()).optional(),
}) satisfies z.ZodType<OpenRouterProvider>

export const openRouterChoiceSchema = z.object({
  id: z.string(),
  model: openRouterModelSchema,
  provider: openRouterProviderSchema,
  enabled: z.boolean(),
}) satisfies z.ZodType<OpenRouterChoice>
