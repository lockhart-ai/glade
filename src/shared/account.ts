/**
 * The account the tasks run on and bill to, and how close it is to its usage limits, as Claude Code reports them
 * (`docs/sdk-notes.md` §1 and "Errors and retries"). Settings › General shows the account
 * (`docs/design/html/21-settings.html`); a quiet note in the banner's spot says when a limit is close
 * (`docs/design/html/17-usage-limit.html`). Main reads both from the SDK and keeps them in SQLite; the window only shows
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

/** The usage window a limit counts over (the SDK's `SDKRateLimitInfo.rateLimitType`). */
export enum UsageWindow {
  /** The five-hour window, which Claude Code calls the session limit. */
  Session = 'five_hour',
  Weekly = 'seven_day',
  WeeklyOpus = 'seven_day_opus',
  WeeklySonnet = 'seven_day_sonnet',
  /** Any other: extra usage, or one this version doesn't know. */
  Other = 'other',
}

/**
 * How much of a window Claude Code waits for before it warns: it shows its own warning only from here on, however early
 * the API starts saying `allowed_warning` (at 28% of a week, in one probe). Glade does the same.
 */
export const USAGE_WARNING_THRESHOLD = 0.7

/** The account is close to a usage limit: requests still go through, but not for long at this rate. */
export interface UsageWarning {
  /** How much of the window is used, from 0 to 1; null when the SDK didn't say. */
  readonly utilization: number | null
  readonly window: UsageWindow
  /** When the window resets, and the warning with it; null when the SDK didn't say. */
  readonly resetsAt: EpochMs | null
}

/** The account and its usage, as the window shows them. */
export interface AccountStatus {
  /** The account, as last read; null until a task's session has started. */
  readonly account: Account | null
  /** The warning while a usage limit is close; null otherwise. */
  readonly usageWarning: UsageWarning | null
}
