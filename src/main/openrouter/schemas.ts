import { z } from 'zod'
import type {
  OpenRouterChoice,
  OpenRouterModel,
  OpenRouterProvider,
  OpenRouterUsageReading,
} from '../../shared/openrouter'

export const openRouterUsageReadingSchema = z.object({
  freeRequests: z
    .object({
      used: z.number().int().nonnegative(),
      limit: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
    })
    .optional(),
  readAt: z.number().int().nonnegative(),
  total: z.number().nonnegative(),
  daily: z.number().nonnegative(),
  weekly: z.number().nonnegative(),
  monthly: z.number().nonnegative(),
  byokTotal: z.number().nonnegative(),
  byokMonthly: z.number().nonnegative(),
  limit: z.number().nonnegative().nullable(),
  remaining: z.number().nullable(),
  limitReset: z.string().nullable(),
  includesByok: z.boolean(),
}) satisfies z.ZodType<OpenRouterUsageReading>

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
