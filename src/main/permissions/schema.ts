/**
 * The zod schemas for permission review: the SDK's suggested permission updates (parsed at the SDK boundary and stored
 * with each request), and the decision `permissions.answer` takes. Each is checked against its named type in
 * `src/shared/domain.ts`, so the two can't drift apart. They live on the main side only, so the renderer never bundles
 * zod for them.
 */
import { z } from 'zod'
import {
  PermissionDecisionKind,
  PermissionDestination,
  PermissionRuleBehavior,
  PermissionUpdateType,
  type PermissionDecision,
  type PermissionRule,
  type PermissionSuggestion,
} from '../../shared/domain'

/** A permission rule: a tool, and optionally what of it. */
export const permissionRuleSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
}) satisfies z.ZodType<PermissionRule>

const destination = z.enum(PermissionDestination)

/** One permission update the SDK suggests (its `PermissionUpdate`). Fields a newer SDK adds are dropped. */
export const permissionSuggestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum([PermissionUpdateType.AddRules, PermissionUpdateType.ReplaceRules, PermissionUpdateType.RemoveRules]),
    rules: z.array(permissionRuleSchema).readonly(),
    behavior: z.enum(PermissionRuleBehavior),
    destination,
  }),
  z.object({ type: z.literal(PermissionUpdateType.SetMode), mode: z.string(), destination }),
  z.object({
    type: z.enum([PermissionUpdateType.AddDirectories, PermissionUpdateType.RemoveDirectories]),
    directories: z.array(z.string()).readonly(),
    destination,
  }),
]) satisfies z.ZodType<PermissionSuggestion>

/** The suggestions stored with a request. */
export const permissionSuggestionsSchema = z.array(permissionSuggestionSchema).readonly()

/** How you answer a permission request: Allow once, Allow for this task, or Deny with an optional note. */
export const permissionDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(PermissionDecisionKind.AllowOnce) }),
  z.strictObject({ kind: z.literal(PermissionDecisionKind.AllowForTask) }),
  z.strictObject({ kind: z.literal(PermissionDecisionKind.Deny), note: z.string().optional() }),
]) satisfies z.ZodType<PermissionDecision>
