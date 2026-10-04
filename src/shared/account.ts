/**
 * The account the tasks run on and bill to, and how close it is to its usage limits, as Claude Code reports them
 * (`docs/sdk-notes.md` §1 and "Errors and retries"). Settings › General shows the account
 * (`docs/design/html/21-settings.html`); the usage meter at the foot of the sidebar shows how much of each limit is used
 * (`docs/design/html/32-usage-meter.html`). Main reads both from the SDK and keeps them in SQLite; the window only shows
 * them.
 */
import type { EpochMs } from './domain'

/**
 * What Claude Code last said about the account (the SDK's `accountInfo()`), field for field as it said it: a field it
 * left out is null. Which fields it fills depends on the credential (see `accountKind`).
 */
export interface Account {
  readonly email: string | null
  readonly organization: string | null
  /** The Claude plan, as Claude Code names it (e.g. `Claude Max`): only for a subscription login. */
  readonly subscriptionType: string | null
  /** Where the login's token came from (e.g. `claude.ai`, `CLAUDE_CODE_OAUTH_TOKEN`, `none`), when not a plan's. */
  readonly tokenSource: string | null
  /** Where the API key came from (`ApiKeySource` names the known ones), when there is one. */
  readonly apiKeySource: string | null
  /** The API it runs on (`ApiProvider` names the known ones): Anthropic's own, a cloud provider's or a gateway. */
  readonly apiProvider: string | null
  /** When Glade read it: as a task's session started. */
  readonly readAt: EpochMs
}

/** Where Claude Code found an API key (the SDK's `ApiKeySource`). */
export enum ApiKeySource {
  /** The `ANTHROPIC_API_KEY` environment variable. */
  AnthropicApiKey = 'ANTHROPIC_API_KEY',
  /** The `apiKeyHelper` script in Claude Code's settings. */
  ApiKeyHelper = 'apiKeyHelper',
  /** The Console key Claude Code's `/login` made. */
  LoginManagedKey = '/login managed key',
  None = 'none',
  User = 'user',
  Project = 'project',
  Org = 'org',
  Temporary = 'temporary',
  OAuth = 'oauth',
}

/** The API Claude Code runs on (the SDK's `AccountInfo.apiProvider`). */
export enum ApiProvider {
  /** Anthropic's own API, which a Claude login or an API key uses. */
  FirstParty = 'firstParty',
  Bedrock = 'bedrock',
  Vertex = 'vertex',
  Foundry = 'foundry',
  AnthropicAws = 'anthropicAws',
  AnthropicGoogleCloud = 'anthropicGoogleCloud',
  Mantle = 'mantle',
  /** An enterprise gateway Claude Code is signed in to. */
  Gateway = 'gateway',
}

/** What kind of credential the tasks run on. */
export enum AccountKind {
  /** A Claude login: a subscription plan (Pro, Max, Team, Enterprise), or a token of one (`claude setup-token`). */
  Login = 'login',
  /** An API key, billed per token. */
  ApiKey = 'api_key',
  /** A cloud provider's or a gateway's own credentials (Bedrock, Vertex, …). */
  CloudProvider = 'cloud_provider',
  /** No credential: tasks can't run until you sign in to Claude Code. */
  NotSignedIn = 'not_signed_in',
}

/** How Claude Code says there's no API key, and names Anthropic's own API: plain strings, as the fields are. */
const NONE: string = ApiKeySource.None
const FIRST_PARTY: string = ApiProvider.FirstParty

/** Whether a source names a credential, rather than saying there's none. */
function present(source: string | null): source is string {
  return source !== null && source !== NONE
}

/**
 * The kind of credential Claude Code runs the tasks on, by its precedence (`docs/sdk-notes.md` §1): a cloud provider's
 * API takes its own credentials; a subscription login is used over an API key it finds (Claude Code calls that key "not
 * in use"); otherwise an API key wins over a token. With none of them, nothing is signed in.
 */
export function accountKind(account: Account): AccountKind {
  if (account.apiProvider !== null && account.apiProvider !== FIRST_PARTY) return AccountKind.CloudProvider
  if (account.subscriptionType !== null) return AccountKind.Login
  if (present(account.apiKeySource)) return AccountKind.ApiKey
  if (present(account.tokenSource) || account.email !== null) return AccountKind.Login
  return AccountKind.NotSignedIn
}

/** The usage window a rate limit event names (the SDK's `SDKRateLimitInfo.rateLimitType`). */
export enum UsageWindow {
  /** The five-hour window, which Claude Code calls the session limit. */
  Session = 'five_hour',
  Weekly = 'seven_day',
  WeeklyOpus = 'seven_day_opus',
  WeeklySonnet = 'seven_day_sonnet',
  /** Extra usage, billed past the plan's limits. */
  Overage = 'overage',
  /** Any other: one this version doesn't know (e.g. `seven_day_overage_included`). */
  Other = 'other',
}

/**
 * How much of a window Claude Code waits for before it warns: it shows its own warning only from here on, however early
 * the API starts saying `allowed_warning` (at 28% of a week, in one probe). The usage meter turns purple from here too.
 */
export const USAGE_WARNING_THRESHOLD = 0.7

/** What a usage limit counts, as the sidebar's usage meter names it. */
export enum UsageLimitKind {
  /** The five-hour window: "Session". */
  Session = 'session',
  /** The seven-day window across every model: "This week". */
  Weekly = 'weekly',
  /** A seven-day window on one model's use: "This week · Opus". */
  WeeklyModel = 'weekly_model',
  /** Extra usage, billed past the plan's limits, while it's turned on. */
  ExtraUsage = 'extra_usage',
}

/** A usage limit: the window it counts over, and for a per-model one, which model. */
export type UsageLimit =
  | { readonly kind: UsageLimitKind.Session | UsageLimitKind.Weekly | UsageLimitKind.ExtraUsage }
  | { readonly kind: UsageLimitKind.WeeklyModel; readonly model: string }

/** Where a limit stands, as the meter colours it. */
export enum UsageLevel {
  /** Within the limit: below `USAGE_WARNING_THRESHOLD`, or not saying how much. */
  Within = 'within',
  /** Close to the limit: at `USAGE_WARNING_THRESHOLD` or more, or Claude Code warned without saying how much. */
  Warning = 'warning',
  /** At the limit: requests are refused until it resets. */
  Limited = 'limited',
}

/**
 * What has been spent on extra usage this month, as the usage call says it (#530). The amounts are in the currency's
 * minor units: cents, for a currency with 2 decimal places.
 */
export interface ExtraUsageSpend {
  /** What's been spent, in minor units. */
  readonly spent: number
  /** The monthly cap, in minor units; null when there's none. */
  readonly cap: number | null
  /** The currency's ISO 4217 code, in capitals: `CAD`. */
  readonly currency: string
  /** How many decimal places the currency's amounts have: 2 for dollars and cents, 0 for yen. */
  readonly decimalPlaces: number
}

/** What the usage call last said of extra usage, beyond how much of its cap is spent (#530). */
export interface ExtraUsageStatus {
  /** Whether it can take the requests a plan limit turns away (`UsageSnapshot.extraUsageAvailable`). */
  readonly available: boolean
  /** What's been spent; null when the call didn't say all of it (the amount, the cap, the currency and its places). */
  readonly spend: ExtraUsageSpend | null
}

/** The latest reading of one usage limit, from Claude Code's usage call or its rate limit events. */
export interface UsageReading {
  readonly limit: UsageLimit
  /** How much of the limit is used, from 0 to 1; null when Claude Code didn't say. */
  readonly utilization: number | null
  /** When the window resets, and the reading with it; null when Claude Code didn't say. */
  readonly resetsAt: EpochMs | null
  readonly level: UsageLevel
  /** When Glade read it. */
  readonly readAt: EpochMs
  /**
   * Extra usage's reading alone: what the last usage call said of it. Left out for every other limit, and for extra
   * usage until a usage call has told of it (a rate limit event says none of this, and keeps what the last call said).
   */
  readonly extraUsage?: ExtraUsageStatus | undefined
}

/** The level a reading of `utilization` is at: at the limit from 100%, close to it from the threshold. */
export function usageLevel(utilization: number | null): UsageLevel {
  if (utilization === null) return UsageLevel.Within
  if (utilization >= 1) return UsageLevel.Limited
  return utilization >= USAGE_WARNING_THRESHOLD ? UsageLevel.Warning : UsageLevel.Within
}

/** A limit's key: there's one reading per key. */
export function usageLimitKey(limit: UsageLimit): string {
  return limit.kind === UsageLimitKind.WeeklyModel ? `${limit.kind}:${limit.model}` : limit.kind
}

/** Where each kind of limit comes in the meter's list: the session, the week, each model's week, then extra usage. */
const KIND_ORDER: Readonly<Record<UsageLimitKind, number>> = {
  [UsageLimitKind.Session]: 0,
  [UsageLimitKind.Weekly]: 1,
  [UsageLimitKind.WeeklyModel]: 2,
  [UsageLimitKind.ExtraUsage]: 3,
}

/** Readings in the meter's order (`KIND_ORDER`), each model's week by the model's name. */
export function sortUsageReadings(readings: readonly UsageReading[]): UsageReading[] {
  return [...readings].sort(
    (a, b) =>
      KIND_ORDER[a.limit.kind] - KIND_ORDER[b.limit.kind] ||
      usageLimitKey(a.limit).localeCompare(usageLimitKey(b.limit)),
  )
}

/**
 * What one answer of Claude Code's usage call says (`docs/sdk-notes.md`, "Usage limits"): a reading of each limit it
 * tells of, and whether extra usage can take the requests a plan limit turns away. Main puts each answer to the tasks a
 * usage limit paused (`canRunAgain` in `src/main/agent/pauses.ts`, #519).
 */
export interface UsageSnapshot {
  readonly readings: readonly UsageReading[]
  /**
   * Whether extra usage is on with room left: turned on, not disabled, its spend limit not reached, and under its
   * monthly cap (or with none). False whenever the answer doesn't say all of that outright.
   */
  readonly extraUsageAvailable: boolean
}

/** The account and its usage, as the window shows them. */
export interface AccountStatus {
  /** The account, as last read; null until a task's session has started. */
  readonly account: Account | null
  /** The latest reading of each usage limit, in the meter's order (`sortUsageReadings`); none until one is read. */
  readonly usage: readonly UsageReading[]
}
