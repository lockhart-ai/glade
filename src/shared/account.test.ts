import { describe, expect, it } from 'vitest'
import { accountKind, AccountKind, ApiKeySource, ApiProvider, type Account } from './account'

/** Nothing reported: every field left out. */
const BLANK: Account = {
  email: null,
  organization: null,
  subscriptionType: null,
  tokenSource: null,
  apiKeySource: null,
  apiProvider: null,
  readAt: 1,
}

describe('accountKind', () => {
  it('reads a subscription login, as Claude Code reports one (a probe on SDK 0.3.281)', () => {
    const login = {
      ...BLANK,
      email: 'sam@acme.dev',
      organization: 'Acme Robotics',
      subscriptionType: 'Claude Max',
      apiProvider: ApiProvider.FirstParty,
    }
    expect(accountKind(login)).toBe(AccountKind.Login)
    // Claude Code uses the plan over an API key it finds, calling the key "not in use".
    expect(accountKind({ ...login, apiKeySource: ApiKeySource.AnthropicApiKey })).toBe(AccountKind.Login)
  })

  it('reads no credential as not signed in, as Claude Code reports it with no login (a probe on SDK 0.3.281)', () => {
    expect(accountKind({ ...BLANK, tokenSource: 'none', apiProvider: ApiProvider.FirstParty })).toBe(
      AccountKind.NotSignedIn,
    )
    expect(accountKind(BLANK)).toBe(AccountKind.NotSignedIn)
    expect(accountKind({ ...BLANK, apiKeySource: ApiKeySource.None })).toBe(AccountKind.NotSignedIn)
  })

  it.each(Object.values(ApiKeySource).filter((source) => source !== ApiKeySource.None))(
    'reads an API key from %s as an API key, over a claude.ai token with no plan',
    (apiKeySource) => {
      // As probed with ANTHROPIC_API_KEY set on a machine that also has a login: the key wins.
      expect(accountKind({ ...BLANK, tokenSource: 'claude.ai', apiKeySource, apiProvider: 'firstParty' })).toBe(
        AccountKind.ApiKey,
      )
    },
  )

  it('reads a token without a plan as a login: a setup token, or an email alone', () => {
    expect(accountKind({ ...BLANK, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' })).toBe(AccountKind.Login)
    expect(accountKind({ ...BLANK, email: 'sam@acme.dev' })).toBe(AccountKind.Login)
  })

  it.each(Object.values(ApiProvider).filter((provider) => provider !== ApiProvider.FirstParty))(
    'reads the %s API as a cloud provider, whatever else is set',
    (apiProvider) => {
      expect(accountKind({ ...BLANK, apiProvider, subscriptionType: 'Claude Max' })).toBe(AccountKind.CloudProvider)
    },
  )

  it('reads a provider this version does not know as a cloud provider too', () => {
    expect(accountKind({ ...BLANK, apiProvider: 'someNewCloud' })).toBe(AccountKind.CloudProvider)
  })
})
