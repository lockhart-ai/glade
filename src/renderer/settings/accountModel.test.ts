import { describe, expect, it } from 'vitest'
import { ApiKeySource, ApiProvider, type Account } from '../../shared/account'
import {
  ACCOUNT_INTRO,
  accountView,
  apiKeySourceLabel,
  apiProviderLabel,
  NOT_READ_INTRO,
  NOT_SIGNED_IN_INTRO,
  readTime,
  tokenSourceLabel,
} from './accountModel'

const NOW = new Date(2026, 8, 26, 14, 30).getTime()
const READ_AT = new Date(2026, 8, 26, 14, 2).getTime()

const BLANK: Account = {
  email: null,
  organization: null,
  subscriptionType: null,
  tokenSource: null,
  apiKeySource: null,
  apiProvider: null,
  readAt: READ_AT,
}

/** The view's rows, as name and value. */
function rows(account: Account): [string, string][] {
  return accountView(account, NOW).rows.map(({ name, value }) => [name, value])
}

describe('apiKeySourceLabel', () => {
  it.each([
    [ApiKeySource.AnthropicApiKey, 'ANTHROPIC_API_KEY variable'],
    [ApiKeySource.ApiKeyHelper, 'apiKeyHelper script'],
    [ApiKeySource.LoginManagedKey, 'Claude Code login (Console)'],
    [ApiKeySource.None, 'No API key'],
    [ApiKeySource.User, 'Your Claude Code settings'],
    [ApiKeySource.Project, 'The project’s Claude Code settings'],
    [ApiKeySource.Org, 'Your organization’s settings'],
    [ApiKeySource.Temporary, 'A temporary key'],
    [ApiKeySource.OAuth, 'Claude Code login'],
  ])('words %s as “%s”', (source, label) => {
    expect(apiKeySourceLabel(source)).toBe(label)
  })

  it('names every source the SDK has', () => {
    for (const source of Object.values(ApiKeySource)) expect(apiKeySourceLabel(source)).not.toBe(source)
  })

  it('shows a source this version does not know as Claude Code names it', () => {
    expect(apiKeySourceLabel('keychain')).toBe('keychain')
  })

  it.each(Object.values(ApiKeySource).filter((source) => source !== ApiKeySource.None))(
    'shows an API key from %s in the Signed in with row',
    (apiKeySource) => {
      expect(rows({ ...BLANK, apiKeySource })).toEqual([
        ['Account', 'API key'],
        ['Plan', 'Pay as you go'],
        ['Signed in with', apiKeySourceLabel(apiKeySource)],
      ])
    },
  )
})

describe('tokenSourceLabel and apiProviderLabel', () => {
  it("words Claude Code's own login, and shows any other token source as named", () => {
    expect(tokenSourceLabel(null)).toBe('Claude Code login')
    expect(tokenSourceLabel('claude.ai')).toBe('Claude Code login')
    expect(tokenSourceLabel('CLAUDE_CODE_OAUTH_TOKEN')).toBe('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('names every provider the SDK has, and shows another as named', () => {
    for (const provider of Object.values(ApiProvider)) expect(apiProviderLabel(provider)).not.toBe(provider)
    expect(apiProviderLabel(ApiProvider.Bedrock)).toBe('Amazon Bedrock')
    expect(apiProviderLabel('someNewCloud')).toBe('someNewCloud')
  })
})

describe('accountView', () => {
  it('has nothing to show before an account is read', () => {
    expect(accountView(null, NOW)).toEqual({ intro: NOT_READ_INTRO, rows: [], readLine: null })
  })

  it('shows a subscription login, organization and plan when Claude Code gives them', () => {
    const login = { ...BLANK, email: 'sam@acme.dev', organization: 'Acme Robotics', subscriptionType: 'Claude Pro' }
    expect(accountView(login, NOW)).toMatchObject({
      intro: ACCOUNT_INTRO,
      readLine: 'Read from Claude Code at 14:02, when a task last started.',
    })
    expect(rows(login)).toEqual([
      ['Account', 'sam@acme.dev'],
      ['Organization', 'Acme Robotics'],
      ['Plan', 'Claude Pro'],
      ['Signed in with', 'Claude Code login'],
    ])
  })

  it('shows a setup token login with no email or plan', () => {
    expect(rows({ ...BLANK, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' })).toEqual([
      ['Account', 'Claude account'],
      ['Signed in with', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ])
  })

  it("shows a Console login's email and organization with its key", () => {
    const console = {
      ...BLANK,
      email: 'sam@acme.dev',
      organization: 'Acme Robotics',
      apiKeySource: ApiKeySource.LoginManagedKey,
    }
    expect(rows(console)).toEqual([
      ['Account', 'sam@acme.dev'],
      ['Organization', 'Acme Robotics'],
      ['Plan', 'Pay as you go'],
      ['Signed in with', 'Claude Code login (Console)'],
    ])
  })

  it('shows a cloud provider, billed through it', () => {
    const view = accountView({ ...BLANK, apiProvider: ApiProvider.Vertex }, NOW)
    expect(view.rows.map(({ name, value }) => [name, value])).toEqual([
      ['Account', 'Google Vertex AI'],
      ['Plan', 'Pay as you go'],
      ['Signed in with', 'The provider’s own credentials'],
    ])
    expect(view.rows[1]?.description).toBe('Billed through Google Vertex AI.')
  })

  it('says how to sign in when nothing is', () => {
    const view = accountView({ ...BLANK, tokenSource: 'none', apiProvider: ApiProvider.FirstParty }, NOW)
    expect(view.intro).toBe(NOT_SIGNED_IN_INTRO)
    expect(view.rows.map(({ name, value }) => [name, value])).toEqual([['Account', 'Not signed in']])
  })
})

describe('readTime', () => {
  it('gives the time today, and the day too on another day', () => {
    expect(readTime(READ_AT, NOW)).toBe('14:02')
    expect(readTime(new Date(2026, 8, 24, 8, 0).getTime(), NOW)).toBe('Sep 24 08:00')
  })
})
