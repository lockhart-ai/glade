import { describe, expect, it } from 'vitest'
import { isLoopbackEndpoint, STAND_IN_API_KEY, standInEnv, type StandInModel } from './stand-in'

const STAND_IN: StandInModel = { baseUrl: 'http://127.0.0.1:41001', deadEndProxy: 'http://127.0.0.1:41002' }

describe('isLoopbackEndpoint', () => {
  it.each(['http://127.0.0.1:1', 'http://127.0.0.1:8080', 'http://127.0.0.1:65535'])('takes %s', (url) => {
    expect(isLoopbackEndpoint(url)).toBe(true)
  })

  it.each([
    // The real endpoint, and anything else that isn't this Mac.
    'https://api.anthropic.com',
    'http://api.anthropic.com:80',
    'http://10.0.0.5:8080',
    'http://169.254.169.254:80',
    // A name a hosts file or a resolver could point anywhere.
    'http://localhost:8080',
    'http://127.0.0.1.example.invalid:8080',
    // An address that only starts like this Mac's, or a user part that hides the real host.
    'http://127.0.0.1:8080@api.anthropic.com',
    'http://api.anthropic.com#@127.0.0.1:8080',
    'http://127.0.0.10:8080',
    'http://127.0.0.1:8080.example.invalid',
    // Other spellings of the address, which nothing here needs.
    'http://2130706433:8080',
    'http://127.1:8080',
    'http://[::1]:8080',
    'http://0.0.0.0:8080',
    // No port, a port that isn't one, or something after it.
    'http://127.0.0.1',
    'http://127.0.0.1:',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:123456',
    'http://127.0.0.1:8080/',
    'http://127.0.0.1:8080/v1',
    'http://127.0.0.1:8080?x=https://api.anthropic.com',
    // Another scheme, or none.
    'https://127.0.0.1:8080',
    '127.0.0.1:8080',
    ' http://127.0.0.1:8080',
    'http://127.0.0.1:8080\nhttps://api.anthropic.com',
    '',
  ])('refuses %j', (url) => {
    expect(isLoopbackEndpoint(url)).toBe(false)
  })
})

describe('standInEnv', () => {
  it('names the stand-in as the only endpoint, with a key that is no key, and the dead end as the proxy', () => {
    expect(standInEnv({ PATH: '/usr/bin:/bin', HOME: '/tmp/glade-home' }, STAND_IN)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/glade-home',
      ANTHROPIC_BASE_URL: STAND_IN.baseUrl,
      ANTHROPIC_API_KEY: STAND_IN_API_KEY,
      ANTHROPIC_AUTH_TOKEN: STAND_IN_API_KEY,
      HTTP_PROXY: STAND_IN.deadEndProxy,
      HTTPS_PROXY: STAND_IN.deadEndProxy,
      http_proxy: STAND_IN.deadEndProxy,
      https_proxy: STAND_IN.deadEndProxy,
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
  })

  it('drops everything that names another endpoint, a provider or a login, however it is spelled', () => {
    const env = standInEnv(
      {
        PATH: '/usr/bin',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_API_KEY: 'a-real-key',
        ANTHROPIC_AUTH_TOKEN: 'a-real-token',
        ANTHROPIC_CUSTOM_HEADERS: 'authorization: Bearer a-real-token',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example.invalid',
        anthropic_auth_token: 'a-real-token',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'a-real-token',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'a-real-token',
        CLAUDE_CONFIG_DIR: '/Users/someone/.claude',
        AWS_BEARER_TOKEN_BEDROCK: 'a-real-token',
        ALL_PROXY: 'socks5://proxy.example.invalid:1080',
        all_proxy: 'socks5://proxy.example.invalid:1080',
        HTTPS_PROXY: 'http://proxy.example.invalid:3128',
        https_proxy: 'http://proxy.example.invalid:3128',
        NO_PROXY: 'api.anthropic.com,.anthropic.com',
        no_proxy: 'api.anthropic.com',
        // What a Claude Code session the run was started from leaves behind.
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SSE_PORT: '4141',
        // Kept: nothing about where requests go, or who sends them.
        TERM: 'xterm-256color',
      },
      STAND_IN,
    )

    expect(Object.values(env).filter((value) => /real|anthropic\.com|example\.invalid|someone/.test(value))).toEqual([])
    expect(Object.keys(env).sort()).toEqual(
      [
        'PATH',
        'TERM',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'http_proxy',
        'https_proxy',
        'NO_PROXY',
        'no_proxy',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      ].sort(),
    )
    expect(env.ANTHROPIC_BASE_URL).toBe(STAND_IN.baseUrl)
    expect(env.ANTHROPIC_API_KEY).toBe(STAND_IN_API_KEY)
    expect(env.NO_PROXY).toBe('127.0.0.1')
  })
})
