// What a call asks of the agent sandbox, and what `request_access` does and says (#450), against real folders in a
// temporary home.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PermissionDestination,
  PermissionRuleBehavior,
  PermissionUpdateType,
  type PermissionSuggestion,
} from '../../shared/domain'
import { FolderAccess, SandboxAskKind, SandboxGrantScope } from '../../shared/sandbox'
import { FileAccess, folderSuggestions, SANDBOX_NETWORK_TOOL } from '../agent/sandbox-requests'
import {
  ACCESS_PATH_NOT_ABSOLUTE,
  ACCESS_WITHDRAWN,
  AccessOutcomeKind,
  accessPlan,
  AccessPlanKind,
  accessReply,
  isAccessPath,
  sandboxAskFor,
  type RunningCommand,
} from './sandbox-ask'
import { SandboxCrossing, sandboxBounds } from './sandbox-classify'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'glade-ask-')))
const ROOT = `${HOME}/src/acme-api`
const WEB = `${HOME}/code/acme-web`
const SHARED = `${HOME}/code/acme-shared`
mkdirSync(ROOT, { recursive: true })
mkdirSync(`${WEB}/src`, { recursive: true })
writeFileSync(`${WEB}/package.json`, '{}')
// A folder whose name is a pattern, and two links that lead to each other: neither can be granted.
mkdirSync(`${HOME}/code/a[1]`, { recursive: true })
mkdirSync(`${HOME}/code/loop`, { recursive: true })
symlinkSync(`${HOME}/code/loop/b`, `${HOME}/code/loop/a`)
symlinkSync(`${HOME}/code/loop/a`, `${HOME}/code/loop/b`)

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

const bounds = sandboxBounds({
  root: ROOT,
  home: HOME,
  grants: {
    folders: [
      { path: SHARED, access: FolderAccess.Read },
      { path: `${HOME}/code/tools`, access: FolderAccess.ReadWrite },
    ],
    domains: [],
  },
})

const COMMAND: RunningCommand = {
  toolUseId: 'toolu_npx',
  command: 'npx openapi-typescript',
  description: 'Generate the client',
  parentToolUseId: null,
}

function ask(
  toolName: string,
  input: Record<string, unknown>,
  suggestions: readonly PermissionSuggestion[] = [],
  crossing = SandboxCrossing.Boundary,
  command: RunningCommand | null = null,
) {
  return sandboxAskFor({ toolName, input, suggestions }, crossing, bounds, command)
}

describe('sandboxAskFor', () => {
  it('asks nothing of the sandbox for a call that stays in bounds, a protected write, or a credential path', () => {
    for (const crossing of [SandboxCrossing.None, SandboxCrossing.Protected, SandboxCrossing.Credential]) {
      expect(ask('Write', { file_path: `${WEB}/a.ts` }, [], crossing)).toBeNull()
    }
  })

  it('asks to run outside the sandbox, whatever the command', () => {
    expect(ask('Bash', { command: 'docker compose up' }, [], SandboxCrossing.Override)).toEqual({
      kind: SandboxAskKind.Outside,
    })
  })

  it('asks for a read tool’s folder read-only and a write tool’s read-write, by the suggestion or the file’s own', () => {
    const file = `${WEB}/package.json`
    expect(ask('Read', { file_path: file }, folderSuggestions(WEB, FileAccess.Read))).toEqual({
      kind: SandboxAskKind.Folder,
      path: WEB,
      access: FolderAccess.Read,
    })
    expect(ask('Write', { file_path: `${WEB}/src/new.ts` }, folderSuggestions(`${WEB}/src`, FileAccess.Write))).toEqual(
      {
        kind: SandboxAskKind.Folder,
        path: `${WEB}/src`,
        access: FolderAccess.ReadWrite,
      },
    )
    for (const tool of ['Edit', 'MultiEdit']) {
      expect(ask(tool, { file_path: file })).toMatchObject({ path: WEB, access: FolderAccess.ReadWrite })
    }
    expect(ask('NotebookEdit', { notebook_path: `${WEB}/src/a.ipynb` })).toMatchObject({ path: `${WEB}/src` })
    expect(ask('NotebookRead', { notebook_path: `${WEB}/src/a.ipynb` })).toMatchObject({ access: FolderAccess.Read })
  })

  it('asks for a folder itself when a tool names one, and a relative path from the root', () => {
    expect(ask('LS', { path: WEB })).toMatchObject({ path: WEB, access: FolderAccess.Read })
    expect(ask('Glob', { path: `${WEB}/src`, pattern: '*.ts' })).toMatchObject({ path: `${WEB}/src` })
    expect(ask('Read', { file_path: '../../code/acme-web/package.json' })).toMatchObject({ path: WEB })
  })

  it('passes over a suggestion that isn’t an allow rule for a Read folder, or doesn’t hold the file', () => {
    const file = `${WEB}/package.json`
    const session = PermissionDestination.Session
    const rules = (
      toolName: string,
      ruleContent: string | undefined,
      behavior = PermissionRuleBehavior.Allow,
      type: PermissionUpdateType.AddRules | PermissionUpdateType.ReplaceRules = PermissionUpdateType.AddRules,
    ): PermissionSuggestion => ({
      type,
      rules: [{ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) }],
      behavior,
      destination: session,
    })
    const passedOver: PermissionSuggestion[] = [
      rules('Read', `/${HOME}/**`, PermissionRuleBehavior.Deny),
      rules('Read', `/${HOME}/**`, PermissionRuleBehavior.Allow, PermissionUpdateType.ReplaceRules),
      rules('Edit', `/${HOME}/**`),
      rules('Read', undefined),
      rules('Read', 'package.json'),
      rules('Read', `/${SHARED}/**`),
      { type: PermissionUpdateType.RemoveDirectories, directories: [HOME], destination: session },
      { type: PermissionUpdateType.SetMode, mode: 'acceptEdits', destination: session },
      // The whole disk can't be granted, though it holds the file.
      { type: PermissionUpdateType.AddDirectories, directories: ['/'], destination: session },
    ]

    expect(ask('Read', { file_path: file }, passedOver)).toMatchObject({ path: WEB })
    // The first suggestion that holds the file and can be granted is the folder asked for.
    expect(ask('Read', { file_path: file }, [...passedOver, rules('Read', `/${HOME}/code/**`)])).toMatchObject({
      path: `${HOME}/code`,
    })
  })

  it('asks for nothing when the file’s folder can’t be granted, or the call names no path', () => {
    expect(ask('Read', { file_path: `${HOME}/code/a[1]/x.md` })).toBeNull()
    expect(ask('Read', { file_path: `${HOME}/code/loop/a/x.md` })).toBeNull()
    expect(ask('Read', {})).toBeNull()
    expect(ask('Read', { file_path: '  ' })).toBeNull()
    expect(ask('Bash', { command: 'ls' })).toBeNull()
  })

  it('asks for a connection’s host with the command that made it, and WebFetch’s with none', () => {
    expect(ask(SANDBOX_NETWORK_TOOL, { host: 'Registry.NPMjs.org' }, [], SandboxCrossing.Boundary, COMMAND)).toEqual({
      kind: SandboxAskKind.Domain,
      domain: 'registry.npmjs.org',
      command: 'npx openapi-typescript',
      commandDescription: 'Generate the client',
    })
    expect(ask(SANDBOX_NETWORK_TOOL, { host: 'localhost' })).toMatchObject({ command: null, commandDescription: null })
    expect(ask('WebFetch', { url: 'https://docs.acme.dev/x' }, [], SandboxCrossing.Boundary, COMMAND)).toEqual({
      kind: SandboxAskKind.Domain,
      domain: 'docs.acme.dev',
      command: null,
      commandDescription: null,
    })
  })

  it('asks for nothing when the host isn’t one a grant can name', () => {
    expect(ask(SANDBOX_NETWORK_TOOL, { host: 42 })).toBeNull()
    expect(ask(SANDBOX_NETWORK_TOOL, { host: 'https://registry.npmjs.org/' })).toBeNull()
    expect(ask('WebFetch', { url: 'nonsense' })).toBeNull()
    expect(ask('WebFetch', {})).toBeNull()
    expect(ask('WebFetch', { url: 'http://[::1]/' })).toBeNull()
  })
})

describe('accessPlan', () => {
  const plan = (path: string, access: FileAccess) => accessPlan({ path, access }, bounds)

  it('asks for the folder of a file, a folder itself, and a path that isn’t there yet as it is', () => {
    expect(plan(`${WEB}/package.json`, FileAccess.Read)).toEqual({
      kind: AccessPlanKind.Ask,
      ask: { kind: SandboxAskKind.Folder, path: WEB, access: FolderAccess.Read },
    })
    expect(plan(WEB, FileAccess.Write)).toMatchObject({ ask: { path: WEB, access: FolderAccess.ReadWrite } })
    expect(plan(`${HOME}/.cache/uv`, FileAccess.Write)).toMatchObject({ ask: { path: `${HOME}/.cache/uv` } })
    expect(plan('~/.cache/uv/', FileAccess.Write)).toMatchObject({ ask: { path: `${HOME}/.cache/uv` } })
    expect(plan('~', FileAccess.Read)).toMatchObject({ ask: { path: HOME } })
  })

  it('has nothing to decide for the workspace, what’s already usable, and credentials', () => {
    expect(plan(`${ROOT}/build/out.txt`, FileAccess.Write)).toEqual({ kind: AccessPlanKind.InWorkspace })
    expect(plan(ROOT, FileAccess.Read)).toEqual({ kind: AccessPlanKind.InWorkspace })
    expect(plan(`${SHARED}/notes.md`, FileAccess.Read)).toEqual({
      kind: AccessPlanKind.AlreadyAllowed,
      path: `${SHARED}/notes.md`,
      access: FolderAccess.Read,
    })
    expect(plan(`${HOME}/code/tools/bin`, FileAccess.Write).kind).toBe(AccessPlanKind.AlreadyAllowed)
    // Reads outside the folders the sandbox denies need no grant; writes there do.
    expect(plan('/etc/hosts', FileAccess.Read).kind).toBe(AccessPlanKind.AlreadyAllowed)
    expect(plan('/opt/acme-cache', FileAccess.Write)).toMatchObject({ kind: AccessPlanKind.Ask })
    // A read-only folder asks for a write.
    expect(plan(SHARED, FileAccess.Write)).toMatchObject({ ask: { path: SHARED, access: FolderAccess.ReadWrite } })
    for (const path of [`${HOME}/.ssh/id_ed25519`, '~/.aws', `${HOME}/.docker/config.json`]) {
      expect(plan(path, FileAccess.Read)).toEqual({ kind: AccessPlanKind.Credential })
    }
  })

  it('says why a path can’t be granted', () => {
    expect(plan('/', FileAccess.Write)).toEqual({
      kind: AccessPlanKind.NotGrantable,
      problem: 'Can\'t grant "/": the whole disk',
    })
    expect(plan(`${HOME}/code/*.md`, FileAccess.Read)).toMatchObject({ kind: AccessPlanKind.NotGrantable })
    expect(plan(`${HOME}/code/loop/a/x`, FileAccess.Read)).toEqual({
      kind: AccessPlanKind.NotGrantable,
      problem: `Can't resolve "${HOME}/code/loop/a/x"`,
    })
  })

  it('takes an absolute path, or one under ~, and no other', () => {
    for (const path of ['/Users/me/.cache', '~', '~/code']) expect(isAccessPath(path)).toBe(true)
    for (const path of ['code/cache', './x', '~me/x', '']) expect(isAccessPath(path)).toBe(false)
  })
})

describe('accessReply', () => {
  const request = { path: '/Users/me/.cache/uv' }

  it('says what was allowed, for whom, and to run the command again', () => {
    expect(
      accessReply(
        {
          kind: AccessOutcomeKind.Allowed,
          folder: '/Users/me/.cache/uv',
          access: FolderAccess.ReadWrite,
          scope: SandboxGrantScope.Task,
        },
        request,
      ),
    ).toEqual({
      text: 'Allowed for this task: you can now read and write /Users/me/.cache/uv. Run the command that was blocked again.',
      isError: false,
    })
    expect(
      accessReply(
        {
          kind: AccessOutcomeKind.Allowed,
          folder: '/Users/me/code/acme-web',
          access: FolderAccess.Read,
          scope: SandboxGrantScope.Workspace,
        },
        request,
      ).text,
    ).toBe(
      'Allowed for this workspace: you can now read /Users/me/code/acme-web. Run the command that was blocked again.',
    )
  })

  it('says a denial, with the note when there is one, and a withdrawal, as errors', () => {
    const denied =
      "Denied: the user didn't allow /Users/me/.cache/uv, so nothing was granted. Don't retry outside the sandbox."
    expect(accessReply({ kind: AccessOutcomeKind.Denied, note: null }, request)).toEqual({
      text: denied,
      isError: true,
    })
    expect(accessReply({ kind: AccessOutcomeKind.Denied, note: 'Use ./cache.' }, request)).toEqual({
      text: `${denied} The user said: Use ./cache.`,
      isError: true,
    })
    expect(accessReply({ kind: AccessOutcomeKind.Withdrawn }, request)).toEqual({
      text: ACCESS_WITHDRAWN,
      isError: true,
    })
  })

  it('says there’s nothing to grant, each a message the agent can act on', () => {
    expect(accessReply({ kind: AccessOutcomeKind.SandboxOff }, request)).toMatchObject({ isError: false })
    expect(accessReply({ kind: AccessOutcomeKind.InWorkspace }, request)).toMatchObject({
      text: expect.stringContaining('is inside the workspace') as unknown,
      isError: false,
    })
    const scopes: [SandboxGrantScope | null, string][] = [
      [SandboxGrantScope.Task, 'is already granted for this task with that access'],
      [SandboxGrantScope.Workspace, 'is already granted for this workspace with that access'],
      [SandboxGrantScope.Glade, 'is already granted for every workspace with that access'],
      [null, 'You can already use /Users/me/.cache/uv that way'],
    ]
    for (const [scope, text] of scopes) {
      const reply = accessReply({ kind: AccessOutcomeKind.AlreadyAllowed, scope }, request)
      expect(reply.text).toContain(text)
      expect(reply.isError).toBe(false)
    }
  })

  it('refuses a credential path and a path no grant can name, as errors', () => {
    expect(accessReply({ kind: AccessOutcomeKind.Credential }, { path: '/Users/me/.ssh' })).toEqual({
      text:
        'Refused: /Users/me/.ssh is one of the credential files and folders the sandbox never opens, even inside a ' +
        "granted folder. Don't try to reach it another way.",
      isError: true,
    })
    expect(
      accessReply({ kind: AccessOutcomeKind.NotGrantable, problem: 'Can\'t grant "/": the whole disk' }, request),
    ).toEqual({ text: 'Can\'t grant "/": the whole disk. Ask for a folder, by its absolute path.', isError: true })
    expect(ACCESS_PATH_NOT_ABSOLUTE).toContain('absolute path')
  })
})
