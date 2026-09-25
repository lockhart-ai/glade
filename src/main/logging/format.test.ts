import { describe, expect, it } from 'vitest'
import { EXCERPT_LENGTH, excerpt, formatRecord, isSecretName, MAX_STRING_LENGTH, REDACTED, redactEnv } from './format'
import { LogLevel, LogScope, type LogFields } from './logger'

const TIME = new Date('2026-09-24T10:15:00.000Z')

/** A record's line, parsed back. */
function line(fields: LogFields, message = 'turn started'): Record<string, unknown> {
  const text = formatRecord({ time: TIME, level: LogLevel.Info, scope: LogScope.Runner, message, fields })
  return JSON.parse(text) as Record<string, unknown>
}

describe('formatRecord', () => {
  it('writes one line of JSON: time, level, scope, task id and message first, then the fields', () => {
    const text = formatRecord({
      time: TIME,
      level: LogLevel.Warn,
      scope: LogScope.Runner,
      message: 'turn failed\non two lines',
      fields: { turn: 2, taskId: 'task-1', terminalReason: 'api_error' },
    })

    expect(text).not.toContain('\n')
    expect(text).toBe(
      '{"time":"2026-09-24T10:15:00.000Z","level":"warn","scope":"runner","taskId":"task-1",' +
        '"msg":"turn failed\\non two lines","turn":2,"terminalReason":"api_error"}',
    )
  })

  it('leaves the task id out when there is none', () => {
    expect(Object.keys(line({ count: 1 }))).toEqual(['time', 'level', 'scope', 'msg', 'count'])
  })

  it("keeps a field named like the record's own under another name", () => {
    expect(line({ time: 5, level: 'x', scope: 'y', msg: 'z' })).toMatchObject({
      time: TIME.toISOString(),
      level: 'info',
      msg: 'turn started',
      'field.time': 5,
      'field.level': 'x',
      'field.scope': 'y',
      'field.msg': 'z',
    })
  })

  it('spells out an error: its name, message, code, stack and cause', () => {
    const cause = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    const error = new TypeError('spawn claude ENOTDIR', { cause })

    expect(line({ error })).toMatchObject({
      error: {
        name: 'TypeError',
        message: 'spawn claude ENOTDIR',
        stack: expect.stringContaining('TypeError: spawn claude ENOTDIR') as unknown,
        cause: { name: 'Error', message: 'ENOENT: no such file', code: 'ENOENT' },
      },
    })
    const bare = new Error('no stack')
    bare.stack = undefined
    expect(line({ error: bare }).error).toEqual({ name: 'Error', message: 'no stack' })
  })

  it('redacts secrets however deep they are, and leaves token counts alone', () => {
    const logged = line({
      input: { command: 'curl', headers: { Authorization: 'Bearer sk-sample', 'x-api-key': 'sk-sample' } },
      env: [{ GH_TOKEN: 'ghp_sample', PATH: '/usr/bin' }],
      apiKey: 'sk-sample',
      password: 'hunter2',
      usage: { input_tokens: 10, outputTokens: 5 },
    })

    expect(logged).toEqual(
      expect.objectContaining({
        input: { command: 'curl', headers: { Authorization: REDACTED, 'x-api-key': REDACTED } },
        env: [{ GH_TOKEN: REDACTED, PATH: '/usr/bin' }],
        apiKey: REDACTED,
        password: REDACTED,
        usage: { input_tokens: 10, outputTokens: 5 },
      }),
    )
    expect(JSON.stringify(logged)).not.toContain('sk-sample')
  })

  it('keeps anything JSON can’t say as text: dates, big numbers, functions, symbols, loops and depths', () => {
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop
    let deep: Record<string, unknown> = { bottom: true }
    for (let level = 0; level < 12; level += 1) deep = { deeper: deep }
    const shared = { id: 'x' }

    const logged = line({
      at: new Date('2026-01-02T03:04:05.000Z'),
      big: 12n,
      fn: function named() {
        return 1
      },
      symbol: Symbol('tag'),
      loop,
      deep,
      twice: [shared, shared],
      nothing: null,
      gone: undefined,
    })

    expect(logged).toMatchObject({
      at: '2026-01-02T03:04:05.000Z',
      big: '12',
      fn: expect.stringContaining('function named') as unknown,
      symbol: 'Symbol(tag)',
      loop: { name: 'loop', self: '[circular]' },
      twice: [{ id: 'x' }, { id: 'x' }],
      nothing: null,
    })
    expect(JSON.stringify(logged.deep)).toContain('[too deep]')
    expect(logged).not.toHaveProperty('gone')
  })

  it('cuts any string down to the most a record holds', () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 10)
    expect(line({ output: long }).output).toBe(`${'x'.repeat(MAX_STRING_LENGTH)}… (10 more characters)`)
  })
})

describe('excerpt', () => {
  it('keeps short text as it is, and cuts long text to 500 characters, saying how much is gone', () => {
    expect(EXCERPT_LENGTH).toBe(500)
    expect(excerpt('Fix the login redirect.')).toBe('Fix the login redirect.')
    expect(excerpt('a'.repeat(500))).toBe('a'.repeat(500))
    expect(excerpt('a'.repeat(750))).toBe(`${'a'.repeat(500)}… (250 more characters)`)
    expect(excerpt('abcdef', 3)).toBe('abc… (3 more characters)')
  })
})

describe('isSecretName', () => {
  it.each([
    'ANTHROPIC_API_KEY',
    'OPENAI_KEY',
    'apiKey',
    'x-api-key',
    'GH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'accessToken',
    'AWS_SECRET_ACCESS_KEY',
    'CLIENT_SECRET',
    'DB_PASSWORD',
    'MYSQLPASSWORD',
    'PGPASSWD',
    'Authorization',
    'cookie',
    'NPM_AUTH',
    'credentials',
    'passphrase',
  ])('treats %s as a secret', (name) => {
    expect(isSecretName(name)).toBe(true)
  })

  it.each([
    'PATH',
    'HOME',
    'PWD',
    'OLDPWD',
    'SHELL',
    'EDITOR',
    'outputTokens',
    'input_tokens',
    'preTokens',
    'keys',
    'keyBindings',
    'monkey',
    'taskId',
  ])('leaves %s alone', (name) => {
    expect(isSecretName(name)).toBe(false)
  })
})

describe('redactEnv', () => {
  it("redacts the secrets' values, keeps the rest, and leaves out what isn't set", () => {
    expect(
      redactEnv({
        PATH: '/opt/homebrew/bin:/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-sample',
        GITHUB_TOKEN: 'ghp_sample',
        SESSION_SECRET: 'sample',
        DB_PASSWORD: 'hunter2',
        UNSET: undefined,
      }),
    ).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      ANTHROPIC_API_KEY: REDACTED,
      GITHUB_TOKEN: REDACTED,
      SESSION_SECRET: REDACTED,
      DB_PASSWORD: REDACTED,
    })
  })
})
