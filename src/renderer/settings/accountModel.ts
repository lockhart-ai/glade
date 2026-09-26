/**
 * How Settings › General words the account the tasks run on (`docs/design/html/21-settings.html`), from what Claude Code
 * last reported (`src/shared/account.ts`).
 */
import { accountKind, AccountKind, ApiKeySource, ApiProvider, type Account } from '../../shared/account'
import type { EpochMs } from '../../shared/domain'
import { clockTime } from '../chat/chatModel'
import { formatDay } from '../task-header/headerModel'

/** One row of the account block: its name, a line on what it is, and its value. */
export interface AccountRow {
  readonly name: string
  readonly description: string
  readonly value: string
}

/** The account block: the line under its heading, its rows, and when it was read. */
export interface AccountView {
  readonly intro: string
  readonly rows: readonly AccountRow[]
  /** When Glade read it; null when it hasn't. */
  readonly readLine: string | null
}

/** What the block says under its heading while it has an account to show. */
export const ACCOUNT_INTRO =
  'The account your tasks run on and bill to, as Claude Code reports it. To change it, sign in again in Claude Code.'

/** What it says before any task's session has started, so there's nothing read yet. */
export const NOT_READ_INTRO =
  'Glade reads the account from Claude Code each time a task starts. Start a task to see it here.'

/** What it says when Claude Code has no credential. */
export const NOT_SIGNED_IN_INTRO =
  'Claude Code isn’t signed in, so tasks can’t run. Run claude in a terminal and sign in with /login, or set ANTHROPIC_API_KEY.'

/** Where Claude Code found an API key, in words. A source this version doesn't know shows as Claude Code names it. */
export function apiKeySourceLabel(source: string): string {
  switch (source as ApiKeySource) {
    case ApiKeySource.AnthropicApiKey:
      return 'ANTHROPIC_API_KEY variable'
    case ApiKeySource.ApiKeyHelper:
      return 'apiKeyHelper script'
    case ApiKeySource.LoginManagedKey:
      return 'Claude Code login (Console)'
    case ApiKeySource.None:
      return 'No API key'
    case ApiKeySource.User:
      return 'Your Claude Code settings'
    case ApiKeySource.Project:
      return 'The project’s Claude Code settings'
    case ApiKeySource.Org:
      return 'Your organization’s settings'
    case ApiKeySource.Temporary:
      return 'A temporary key'
    case ApiKeySource.OAuth:
      return 'Claude Code login'
    default:
      return source
  }
}

/** A login's token source, in words: Claude Code's own login, or the variable or file it came from, as named. */
export function tokenSourceLabel(source: string | null): string {
  return source === null || source === 'claude.ai' ? 'Claude Code login' : source
}

/** A cloud provider or gateway, by name. One this version doesn't know shows as Claude Code names it. */
export function apiProviderLabel(provider: string): string {
  switch (provider as ApiProvider) {
    case ApiProvider.FirstParty:
      return 'Anthropic'
    case ApiProvider.Bedrock:
      return 'Amazon Bedrock'
    case ApiProvider.Vertex:
      return 'Google Vertex AI'
    case ApiProvider.Foundry:
      return 'Microsoft Foundry'
    case ApiProvider.AnthropicAws:
      return 'Anthropic on AWS'
    case ApiProvider.AnthropicGoogleCloud:
      return 'Anthropic on Google Cloud'
    case ApiProvider.Mantle:
      return 'Mantle'
    case ApiProvider.Gateway:
      return 'An enterprise gateway'
    default:
      return provider
  }
}

/** When the account was read: `14:02` today, `Sep 27 14:02` on another day. */
export function readTime(at: EpochMs, now: EpochMs): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  return sameDay ? clockTime(at) : `${formatDay(at)} ${clockTime(at)}`
}

const ACCOUNT_DESCRIPTION = 'Who your tasks bill to.'
const SIGNED_IN_WITH = 'Signed in with'
const SIGNED_IN_DESCRIPTION = 'Where Claude Code found the credential.'

/** The organization's row, when Claude Code named one. */
function organizationRows(account: Account): AccountRow[] {
  return account.organization === null
    ? []
    : [
        {
          name: 'Organization',
          description: 'The organization the account belongs to.',
          value: account.organization,
        },
      ]
}

/** The rows for an account, by its kind. */
function rowsFor(account: Account): AccountRow[] {
  switch (accountKind(account)) {
    case AccountKind.Login:
      return [
        { name: 'Account', description: ACCOUNT_DESCRIPTION, value: account.email ?? 'Claude account' },
        ...organizationRows(account),
        ...(account.subscriptionType === null
          ? []
          : [
              {
                name: 'Plan',
                description: 'Its usage limits are shared by every task, and by Claude Code.',
                value: account.subscriptionType,
              },
            ]),
        { name: SIGNED_IN_WITH, description: SIGNED_IN_DESCRIPTION, value: tokenSourceLabel(account.tokenSource) },
      ]
    case AccountKind.ApiKey:
      return [
        { name: 'Account', description: ACCOUNT_DESCRIPTION, value: account.email ?? 'API key' },
        ...organizationRows(account),
        {
          name: 'Plan',
          description: 'Billed per token to the key’s Console organization, with no plan limits.',
          value: 'Pay as you go',
        },
        {
          name: SIGNED_IN_WITH,
          description: SIGNED_IN_DESCRIPTION,
          value: apiKeySourceLabel(account.apiKeySource ?? ApiKeySource.None),
        },
      ]
    case AccountKind.CloudProvider: {
      const provider = apiProviderLabel(account.apiProvider ?? ApiProvider.FirstParty)
      return [
        { name: 'Account', description: ACCOUNT_DESCRIPTION, value: provider },
        { name: 'Plan', description: `Billed through ${provider}.`, value: 'Pay as you go' },
        { name: SIGNED_IN_WITH, description: SIGNED_IN_DESCRIPTION, value: 'The provider’s own credentials' },
      ]
    }
    case AccountKind.NotSignedIn:
      return [{ name: 'Account', description: ACCOUNT_DESCRIPTION, value: 'Not signed in' }]
  }
}

/** The account block for the account last read (null for none yet), at `now`. */
export function accountView(account: Account | null, now: EpochMs): AccountView {
  if (account === null) return { intro: NOT_READ_INTRO, rows: [], readLine: null }
  const intro = accountKind(account) === AccountKind.NotSignedIn ? NOT_SIGNED_IN_INTRO : ACCOUNT_INTRO
  return {
    intro,
    rows: rowsFor(account),
    readLine: `Read from Claude Code at ${readTime(account.readAt, now)}, when a task last started.`,
  }
}
