// The shapes the sandbox's requests and results come in, as the P15-01 probes recorded them (`docs/sdk-notes.md` §15).
import { describe, expect, it } from 'vitest'
import { PermissionDestination, PermissionRuleBehavior, PermissionUpdateType } from '../../shared/domain'
import {
  FileAccess,
  OUTSIDE_WORKING_DIRECTORIES,
  SANDBOX_NETWORK_TOOL,
  SANDBOX_OVERRIDE_REASON,
  SCRIPTED_SANDBOX_TAG,
  SandboxOperation,
  commandFailure,
  domainRule,
  domainRuleString,
  folderSuggestions,
  homeAbbreviated,
  hostMatches,
  isBareHost,
  isInside,
  networkAccessCall,
  networkDenial,
  outsideFileCall,
  readRuleContent,
  sandboxInitFailure,
  sandboxOverrideCall,
  sandboxViolations,
  seatbeltLog,
  webFetchCall,
} from './sandbox-requests'

/** What every call the sandbox asks about leaves at its default, unless it says otherwise. */
const BARE = {
  agentId: null,
  title: null,
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
  mcpServer: null,
  matchedAskRule: false,
  blockedPath: null,
  decisionReason: null,
}

describe('the sandbox requests', () => {
  it('asks about a command’s connection as the probe saw: its own tool, the host, and the domain rule', () => {
    expect(networkAccessCall('www.example.org', '9d760934-dd51-4c1c-873d-e07c35272b29')).toEqual({
      ...BARE,
      toolName: SANDBOX_NETWORK_TOOL,
      input: { host: 'www.example.org' },
      toolUseId: '9d760934-dd51-4c1c-873d-e07c35272b29',
      displayName: 'SandboxNetworkAccess',
      description: 'Allow network connection to www.example.org?',
      suggestions: [
        {
          type: PermissionUpdateType.AddRules,
          rules: [{ toolName: 'WebFetch', ruleContent: 'domain:www.example.org' }],
          behavior: PermissionRuleBehavior.Allow,
          destination: PermissionDestination.LocalSettings,
        },
      ],
    })
  })

  it('asks about WebFetch with its URL as the description and the same domain rule', () => {
    const input = { url: 'https://www.example.org/help/', prompt: 'What is it about?' }
    expect(webFetchCall('toolu_01', input)).toEqual({
      ...BARE,
      toolName: 'WebFetch',
      input,
      toolUseId: 'toolu_01',
      displayName: 'WebFetch',
      description: 'https://www.example.org/help/',
      suggestions: [expect.objectContaining({ rules: [domainRule('www.example.org')] })],
    })
  })

  it('asks about a file outside the folders with the reason, the path, and its folder, and no blockedPath', () => {
    const read = outsideFileCall(
      'toolu_01',
      'Read',
      { file_path: '/Users/me/probe/outside/secret.txt' },
      '/Users/me/probe/outside/secret.txt',
      FileAccess.Read,
      '/Users/me',
    )
    expect(read).toEqual({
      ...BARE,
      toolName: 'Read',
      input: { file_path: '/Users/me/probe/outside/secret.txt' },
      toolUseId: 'toolu_01',
      displayName: 'Read',
      description: '~/probe/outside/secret.txt',
      decisionReason: OUTSIDE_WORKING_DIRECTORIES,
      suggestions: [
        {
          type: PermissionUpdateType.AddRules,
          rules: [{ toolName: 'Read', ruleContent: '//Users/me/probe/outside/**' }],
          behavior: PermissionRuleBehavior.Allow,
          destination: PermissionDestination.Session,
        },
      ],
    })
    const write = outsideFileCall(
      'toolu_02',
      'Write',
      { file_path: '/etc/hosts', content: '' },
      '/etc/hosts',
      FileAccess.Write,
      '/Users/me',
    )
    expect(write).toMatchObject({
      description: '/etc/hosts',
      suggestions: [
        {
          type: PermissionUpdateType.AddDirectories,
          directories: ['/etc'],
          destination: PermissionDestination.Session,
        },
      ],
    })
  })

  it('asks about running outside the sandbox with its reason, saying when Glade’s ask rule forced it', () => {
    const input = { command: 'docker compose up -d', dangerouslyDisableSandbox: true }
    expect(sandboxOverrideCall('toolu_01', input, true)).toEqual({
      ...BARE,
      toolName: 'Bash',
      input,
      toolUseId: 'toolu_01',
      displayName: 'Bash',
      description: null,
      suggestions: [],
      decisionReason: SANDBOX_OVERRIDE_REASON,
      matchedAskRule: true,
    })
    expect(sandboxOverrideCall('toolu_01', input, false).matchedAskRule).toBe(false)
  })

  it('names a domain grant as the rule settings take', () => {
    expect(domainRuleString('registry.npmjs.org')).toBe('WebFetch(domain:registry.npmjs.org)')
    expect(readRuleContent('/Users/me/notes')).toBe('//Users/me/notes/**')
    expect(folderSuggestions('/Users/me/notes', FileAccess.Write)).toEqual([
      {
        type: PermissionUpdateType.AddDirectories,
        directories: ['/Users/me/notes'],
        destination: PermissionDestination.Session,
      },
    ])
  })
})

describe('the sandbox results', () => {
  it('words a failed command, a denied connection, and a sandbox that could not start as Claude Code does', () => {
    expect(commandFailure('cat: /x: Operation not permitted')).toBe('Exit code 1\ncat: /x: Operation not permitted')
    expect(commandFailure('curl: (56) CONNECT tunnel failed, response 403\n000', 56)).toBe(
      'Exit code 56\ncurl: (56) CONNECT tunnel failed, response 403\n000',
    )
    expect(sandboxViolations([networkDenial('www.example.org')])).toBe(
      '<sandbox_violations>\ndeny network-outbound www.example.org:443 (user denied)\n</sandbox_violations>',
    )
    expect(networkDenial('github.com', 22)).toBe('deny network-outbound github.com:22 (user denied)')
    expect(sandboxInitFailure('tlsTerminate: caCertPath and caKeyPath must be provided together')).toBe(
      'Sandbox is required but failed to initialize: tlsTerminate: caCertPath and caKeyPath must be provided together. Restart to retry.',
    )
  })

  it('logs a denial as log stream prints it: the kernel line, then the tag naming the call in base64', () => {
    const logged = seatbeltLog(
      'toolu_01Kx7Qm2VwP9sJ4nR8tYb3Lc',
      { process: 'cat', operation: SandboxOperation.ReadData, path: '/Users/me/probe/outside/secret.txt' },
      new Date('2026-10-02T23:11:16.513Z'),
      44794,
    )
    expect(logged).toBe(
      [
        '2026-10-02 23:11:16.513 E  kernel[0:1a2b3c] (Sandbox) Sandbox: cat(44794) deny(1) file-read-data /Users/me/probe/outside/secret.txt',
        `CMD64_dG9vbHVfMDFLeDdRbTJWd1A5c0o0blI4dFliM0xj_END_${SCRIPTED_SANDBOX_TAG}`,
      ].join('\n'),
    )
    expect(logged.endsWith('_SBX')).toBe(true)
  })

  it('tags a call by the first 100 characters of its id only, as Claude Code does', () => {
    const id = `toolu_${'x'.repeat(200)}`
    const tag = /CMD64_(.+?)_END_/.exec(
      seatbeltLog(id, { process: 'rm', operation: SandboxOperation.WriteUnlink, path: '/x' }),
    )?.[1]
    expect(Buffer.from(tag ?? '', 'base64').toString()).toBe(id.slice(0, 100))
  })
})

describe('matching hosts and folders', () => {
  it('takes only a bare host name', () => {
    for (const host of ['registry.npmjs.org', 'localhost', 'a-b.c', 'x1']) expect(isBareHost(host)).toBe(true)
    for (const host of ['', 'https://x.org', 'x.org:443', 'x.org/', '-x.org', 'x-.org', 'x..org', 'a b']) {
      expect(isBareHost(host)).toBe(false)
    }
  })

  it('matches a host exactly, or under a wildcard, but not the wildcard’s own domain or a lookalike', () => {
    expect(hostMatches('registry.npmjs.org', 'registry.npmjs.org')).toBe(true)
    expect(hostMatches('registry.npmjs.org', '*.npmjs.org')).toBe(true)
    expect(hostMatches('npmjs.org', '*.npmjs.org')).toBe(false)
    expect(hostMatches('evilnpmjs.org', '*.npmjs.org')).toBe(false)
    expect(hostMatches('registry.npmjs.org', 'npmjs.org')).toBe(false)
  })

  it('finds a path in a folder, or the folder itself, but not a sibling that shares its name’s start', () => {
    expect(isInside('/code/acme-api/src/a.ts', '/code/acme-api')).toBe(true)
    expect(isInside('/code/acme-api', '/code/acme-api/')).toBe(true)
    expect(isInside('/code/acme-api-old/a.ts', '/code/acme-api')).toBe(false)
  })

  it('abbreviates the home folder, and only it', () => {
    expect(homeAbbreviated('/Users/me', '/Users/me')).toBe('~')
    expect(homeAbbreviated('/Users/me/notes.md', '/Users/me')).toBe('~/notes.md')
    expect(homeAbbreviated('/Users/meg/notes.md', '/Users/me')).toBe('/Users/meg/notes.md')
    expect(homeAbbreviated('/etc/hosts')).toBe('/etc/hosts')
  })
})
