// The commands the user's own Claude Code settings keep out of the sandbox (#514, finding 3): read from the same files
// Claude Code merges, and matched on the side of asking.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import {
  claudeSettingsFiles,
  createExcludedCommands,
  excludedPatterns,
  MANAGED_SETTINGS_FILE,
  mayBeExcluded,
  projectSettingsFiles,
  sessionSettingsFiles,
  SETTINGS_REFRESH_MS,
} from './excluded-commands'

describe('claudeSettingsFiles', () => {
  it('names the managed settings, the user’s, the project’s and the local ones', () => {
    expect(claudeSettingsFiles('/Users/me/src/acme-api', '/Users/me', {})).toEqual([
      '/Library/Application Support/ClaudeCode/managed-settings.json',
      '/Users/me/.claude/settings.json',
      '/Users/me/src/acme-api/.claude/settings.json',
      '/Users/me/src/acme-api/.claude/settings.local.json',
    ])
    expect(MANAGED_SETTINGS_FILE).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    expect(projectSettingsFiles('/Users/me/src/acme-api')).toEqual([
      '/Users/me/src/acme-api/.claude/settings.json',
      '/Users/me/src/acme-api/.claude/settings.local.json',
    ])
  })

  it('names a session’s files by its root: every one for a home folder, the project’s alone for none', () => {
    expect(sessionSettingsFiles('/Users/me')('/Users/me/src/acme-api')).toEqual(
      claudeSettingsFiles('/Users/me/src/acme-api', '/Users/me'),
    )
    // A test mode: nothing of the Mac it runs on.
    expect(sessionSettingsFiles(null)('/Users/me/src/acme-api')).toEqual(projectSettingsFiles('/Users/me/src/acme-api'))
  })

  it('follows a config folder moved with CLAUDE_CONFIG_DIR, and Glade’s own environment by default', () => {
    const moved = claudeSettingsFiles('/Users/me/src/acme-api', '/Users/me', {
      CLAUDE_CONFIG_DIR: '/Users/me/.config/claude',
    })
    expect(moved[1]).toBe('/Users/me/.config/claude/settings.json')
    expect(claudeSettingsFiles('/tmp/x', '/Users/me', { CLAUDE_CONFIG_DIR: '' })[1]).toBe(
      '/Users/me/.claude/settings.json',
    )
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/Users/me/elsewhere')
    expect(claudeSettingsFiles('/tmp/x', '/Users/me')[1]).toBe('/Users/me/elsewhere/settings.json')
    vi.unstubAllEnvs()
  })
})

describe('excludedPatterns', () => {
  it('reads the patterns a settings file excludes from the sandbox', () => {
    const text = JSON.stringify({
      permissions: { allow: ['Bash(npm test *)'] },
      sandbox: { enabled: true, excludedCommands: ['docker *', 'gh:*', '  ', 'make'] },
    })
    expect(excludedPatterns(text)).toEqual(['docker *', 'gh:*', 'make'])
  })

  it.each([
    ['no sandbox settings', '{"permissions":{}}'],
    ['no excluded commands', '{"sandbox":{"enabled":true}}'],
    ['not JSON', '{"sandbox": {excludedCommands'],
    ['an empty file', ''],
    ['JSON that isn’t an object', '["docker *"]'],
    ['a sandbox that isn’t an object', '{"sandbox":"on"}'],
    ['a list that isn’t one', '{"sandbox":{"excludedCommands":"docker *"}}'],
    ['a null', 'null'],
  ])('reads none from a file with %s', (_what, text) => {
    expect(excludedPatterns(text)).toEqual([])
  })

  it('keeps the patterns of a list with something else in it, and drops the rest', () => {
    expect(excludedPatterns('{"sandbox":{"excludedCommands":["docker *", 42, null, {"x":1}, "gh *"]}}')).toEqual([
      'docker *',
      'gh *',
    ])
  })
})

describe('mayBeExcluded', () => {
  const DOCKER = ['docker *']

  it('matches nothing with no pattern', () => {
    expect(mayBeExcluded('docker ps', [])).toBe(false)
  })

  it.each([
    'docker ps',
    'docker',
    // The review's attack: the home folder mounted into a container.
    'docker run -v ~:/h alpine cat /h/.ssh/id_rsa',
    '  docker   compose up -d',
    'cd infra && docker compose up -d',
    'npm test; docker ps',
    'npm test || docker ps',
    'echo ok | docker load',
    'FOO=1 BAR=2 docker ps',
    'timeout 30 docker ps',
    'sudo docker ps',
    '/usr/local/bin/docker ps',
    '$(which docker) ps',
    'DOCKER=docker; $DOCKER ps',
    '(docker ps)',
    '{ docker ps; }',
    'docker\tps',
    'npm test\ndocker ps',
    '"docker" ps',
    "'docker' ps",
    'd""ocker ps',
    "d''ocker ps",
    'd\\ocker ps',
    'xargs docker rm < ids.txt',
    'x=$(docker ps -q)',
    'echo `docker ps`',
    // Too many is the cheap side to be wrong on: a word of the command is the command excluded.
    'echo docker',
  ])('asks about %j, which `docker *` may cover', (command) => {
    expect(mayBeExcluded(command, DOCKER)).toBe(true)
  })

  it.each(['npm test', 'dockerize up', 'ls docker-compose.yml', 'cat notes/docker.md', 'echo dockers', ''])(
    'lets %j go: no word of it is the command',
    (command) => {
      expect(mayBeExcluded(command, DOCKER)).toBe(false)
    },
  )

  it.each([
    ['docker', 'docker ps'],
    ['docker:*', 'docker ps'],
    ['docker compose *', 'docker ps'],
    ['docker compose:*', 'cd x && docker run y'],
    ['  docker  *  ', 'docker ps'],
    ['./scripts/deploy.sh *', './scripts/deploy.sh prod'],
    ['./scripts/deploy.sh *', 'bash scripts/deploy.sh prod'],
    ['/opt/homebrew/bin/gh *', 'gh pr list'],
    ['npm run deploy:*', 'npm ci'],
  ])('reads the pattern %j as the command it names: it may cover %j', (pattern, command) => {
    expect(mayBeExcluded(command, [pattern])).toBe(true)
  })

  it('takes a wildcard in the command’s own name for any run of characters', () => {
    expect(mayBeExcluded('npm test', ['*'])).toBe(true)
    expect(mayBeExcluded('', ['*'])).toBe(false)
    expect(mayBeExcluded('kubectl get pods', ['kube*'])).toBe(true)
    expect(mayBeExcluded('echo cube', ['kube*'])).toBe(false)
    expect(mayBeExcluded('aws-vault exec x', ['aws-*'])).toBe(true)
    // A character an expression would read as its own is the character itself.
    expect(mayBeExcluded('g++ a.cc', ['g++*'])).toBe(true)
    expect(mayBeExcluded('ggg a.cc', ['g++*'])).toBe(false)
    expect(mayBeExcluded('run.sh x', ['run.sh*'])).toBe(true)
    expect(mayBeExcluded('runxsh x', ['run.sh*'])).toBe(false)
  })

  it('asks when any one of several patterns may cover the command', () => {
    const patterns = ['docker *', 'gh *', 'make']
    expect(mayBeExcluded('gh pr list', patterns)).toBe(true)
    expect(mayBeExcluded('make build', patterns)).toBe(true)
    expect(mayBeExcluded('npm run build', patterns)).toBe(false)
  })
})

describe('createExcludedCommands', () => {
  let folder: string
  let user: string
  let project: string
  let now: number

  const write = (file: string, excludedCommands: unknown): void => {
    writeFileSync(file, JSON.stringify({ sandbox: { excludedCommands } }))
  }
  const excluded = (files: readonly string[] = [user, project], log?: Logger) =>
    createExcludedCommands({ files, now: () => now, ...(log === undefined ? {} : { log }) })
  /** A second later: the files are looked at again. */
  const later = (): void => {
    now += SETTINGS_REFRESH_MS
  }

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'glade-excluded-')))
    user = join(folder, 'home', '.claude', 'settings.json')
    project = join(folder, 'acme-api', '.claude', 'settings.json')
    mkdirSync(join(user, '..'), { recursive: true })
    mkdirSync(join(project, '..'), { recursive: true })
    now = 1_000_000
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('matches nothing with no file to read, or none there', () => {
    expect(excluded([]).matches('docker ps')).toBe(false)
    expect(excluded().matches('docker ps')).toBe(false)
  })

  it('reads every file’s patterns: the user’s settings and the project’s alike', () => {
    write(user, ['gh *'])
    write(project, ['docker *'])
    const commands = excluded()

    expect(commands.matches('docker run -v ~:/h alpine cat /h/.ssh/id_rsa')).toBe(true)
    expect(commands.matches('gh pr list')).toBe(true)
    expect(commands.matches('npm test')).toBe(false)
  })

  it('reads a file again once it has changed, as Claude Code picks the change up', () => {
    write(project, ['docker *'])
    const commands = excluded()
    expect(commands.matches('gh pr list')).toBe(false)

    write(project, ['docker *', 'gh:*'])
    // Not looked at again within the second.
    expect(commands.matches('gh pr list')).toBe(false)
    later()
    expect(commands.matches('gh pr list')).toBe(true)

    // A file that appears, and one that goes.
    write(user, ['make'])
    rmSync(project)
    later()
    expect(commands.matches('make build')).toBe(true)
    expect(commands.matches('docker ps')).toBe(false)
  })

  it('reads a file only when it has changed, and looks no more than once a second', () => {
    write(project, ['docker *'])
    const commands = excluded()
    expect(commands.matches('docker ps')).toBe(true)

    // Rewritten with the same size and time: taken for unchanged, and not read again.
    const unchanged = new Date(1_700_000_000_000)
    utimesSync(project, unchanged, unchanged)
    later()
    expect(commands.matches('docker ps')).toBe(true)
    writeFileSync(project, JSON.stringify({ sandbox: { excludedCommands: ['podman *'] } }))
    utimesSync(project, unchanged, unchanged)
    later()
    expect(commands.matches('podman ps')).toBe(false)

    // A hundred checks within a second look at the disk once.
    write(project, ['kubectl *'])
    for (let check = 0; check < 100; check += 1) expect(commands.matches('kubectl get pods')).toBe(false)
    later()
    expect(commands.matches('kubectl get pods')).toBe(true)
  })

  it('takes a file it can’t read, or that isn’t settings, for one that excludes nothing, and notes the first', () => {
    const warn = vi.fn<Logger['warn']>()
    writeFileSync(user, 'not json')
    // A folder where the file should be: it's there, and can't be read.
    mkdirSync(project)
    const commands = excluded([user, project], { ...SILENT_LOGGER, warn })

    expect(commands.matches('docker ps')).toBe(false)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "couldn't read a Claude Code settings file for its excluded commands",
      expect.objectContaining({ file: project }),
    )
  })

  it('uses the clock, and logs nowhere, unless told otherwise', () => {
    write(project, ['docker *'])
    expect(createExcludedCommands({ files: [project] }).matches('docker ps')).toBe(true)
  })
})
