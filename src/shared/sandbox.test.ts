import { describe, expect, it } from 'vitest'
import {
  coversAccess,
  FOLDER_ACCESS_LABELS,
  FolderAccess,
  folderVerb,
  grantCovers,
  grantFor,
  isGrantAsk,
  isSettingsGrantTarget,
  mergeGrants,
  OTHER_AGENTS_LABELS,
  OTHER_AGENTS_TOOLS,
  OtherAgents,
  otherAgentsPhrase,
  SandboxAskKind,
  sandboxAskPhrase,
  SandboxGrantKind,
  SandboxGrantScope,
  settingsGrantScopeKey,
  type Grant,
  type SandboxAsk,
} from './sandbox'
import { setHomeFolder } from './homeFolder'

// The sample data's home folder, which paths under it are shown from as `~`.
setHomeFolder('/Users/me')

const read = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.Read })
const readWrite = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.ReadWrite })
const domain = (host: string): Grant => ({ kind: SandboxGrantKind.Domain, domain: host })
const server = (key: string, name = key): Grant => ({ kind: SandboxGrantKind.McpServer, server: key, name })
const agents = (which: OtherAgents): Grant => ({ kind: SandboxGrantKind.Agents, agents: which })

describe('coversAccess', () => {
  it('ranks read-write over read-only', () => {
    expect(coversAccess(FolderAccess.ReadWrite, FolderAccess.Read)).toBe(true)
    expect(coversAccess(FolderAccess.ReadWrite, FolderAccess.ReadWrite)).toBe(true)
    expect(coversAccess(FolderAccess.Read, FolderAccess.Read)).toBe(true)
    expect(coversAccess(FolderAccess.Read, FolderAccess.ReadWrite)).toBe(false)
  })
})

describe('mergeGrants', () => {
  it('is empty for no grants', () => {
    expect(mergeGrants([])).toEqual([])
  })

  it('keeps each folder once, with the widest access, wherever it comes in the list', () => {
    expect(mergeGrants([read('/opt/sdk'), readWrite('/opt/sdk'), read('/opt/sdk')])).toEqual([readWrite('/opt/sdk')])
    expect(mergeGrants([readWrite('/opt/sdk'), read('/opt/sdk')])).toEqual([readWrite('/opt/sdk')])
    expect(mergeGrants([read('/opt/sdk'), read('/opt/sdk')])).toEqual([read('/opt/sdk')])
  })

  it('keeps each domain once, and a domain and a folder with the same value apart', () => {
    expect(mergeGrants([domain('acme.dev'), read('acme.dev'), domain('acme.dev')])).toEqual([
      domain('acme.dev'),
      read('acme.dev'),
    ])
  })

  it('keeps each MCP server once, by its key, under the name it first had, and each of the other agents once', () => {
    expect(
      mergeGrants([
        server('claude_ai_Acme_Docs', 'claude.ai Acme Docs'),
        agents(OtherAgents.Sessions),
        server('claude_ai_Acme_Docs', 'Acme Docs'),
        server('acme-tracker'),
        agents(OtherAgents.Cloud),
        agents(OtherAgents.Sessions),
      ]),
    ).toEqual([
      server('claude_ai_Acme_Docs', 'claude.ai Acme Docs'),
      agents(OtherAgents.Sessions),
      server('acme-tracker'),
      agents(OtherAgents.Cloud),
    ])
  })

  it('keeps a server, a domain and a folder with the same value apart, and agents from a server named like them', () => {
    expect(
      mergeGrants([server('sessions'), domain('sessions'), read('sessions'), agents(OtherAgents.Sessions)]),
    ).toEqual([server('sessions'), domain('sessions'), read('sessions'), agents(OtherAgents.Sessions)])
  })

  it('keeps the order each was first granted, a widened folder in its first place', () => {
    expect(
      mergeGrants([
        read('/opt/a'),
        domain('registry.npmjs.org'),
        read('/opt/b'),
        readWrite('/opt/a'),
        domain('acme.dev'),
      ]),
    ).toEqual([readWrite('/opt/a'), domain('registry.npmjs.org'), read('/opt/b'), domain('acme.dev')])
  })

  it('keeps a single file a single file, unless a grant of the same path is a folder’s', () => {
    const file = (access: FolderAccess): Grant => ({
      kind: SandboxGrantKind.Folder,
      path: '/Users/sam/.zshrc',
      access,
      file: true,
    })
    expect(mergeGrants([file(FolderAccess.Read)])).toEqual([file(FolderAccess.Read)])
    expect(mergeGrants([file(FolderAccess.Read), file(FolderAccess.ReadWrite)])).toEqual([file(FolderAccess.ReadWrite)])
    // The same path granted as a folder is the wider grant: the folder's, with the widest access of the two.
    expect(mergeGrants([file(FolderAccess.ReadWrite), read('/Users/sam/.zshrc')])).toEqual([
      readWrite('/Users/sam/.zshrc'),
    ])
    expect(mergeGrants([read('/Users/sam/.zshrc'), file(FolderAccess.Read)])).toEqual([read('/Users/sam/.zshrc')])
  })

  it('keeps nested folders apart: each is its own grant', () => {
    expect(mergeGrants([read('/Users/sam/code'), readWrite('/Users/sam/code/acme')])).toEqual([
      read('/Users/sam/code'),
      readWrite('/Users/sam/code/acme'),
    ])
  })
})

describe('grantCovers', () => {
  const task = { id: 't1', workspaceId: 'w1' }

  it('covers every task Glade-wide, a workspace’s tasks, and one task', () => {
    expect(grantCovers({ scope: SandboxGrantScope.Glade }, task)).toBe(true)
    expect(grantCovers({ scope: SandboxGrantScope.Workspace, workspaceId: 'w1' }, task)).toBe(true)
    expect(grantCovers({ scope: SandboxGrantScope.Workspace, workspaceId: 'w2' }, task)).toBe(false)
    expect(grantCovers({ scope: SandboxGrantScope.Task, taskId: 't1' }, task)).toBe(true)
    expect(grantCovers({ scope: SandboxGrantScope.Task, taskId: 't2' }, task)).toBe(false)
  })

  it('never takes a task id for a workspace id', () => {
    expect(grantCovers({ scope: SandboxGrantScope.Task, taskId: 'w1' }, task)).toBe(false)
    expect(grantCovers({ scope: SandboxGrantScope.Workspace, workspaceId: 't1' }, task)).toBe(false)
  })
})

describe('what a sandbox request is about', () => {
  const folder = (path: string, access: FolderAccess): SandboxAsk => ({ kind: SandboxAskKind.Folder, path, access })
  const reach: SandboxAsk = {
    kind: SandboxAskKind.Domain,
    domain: 'registry.npmjs.org',
    command: 'npm install',
    commandDescription: null,
  }

  it('says it in the verbs every permission line uses, the home folder as ~', () => {
    expect(sandboxAskPhrase(folder('/Users/me/code/acme-web', FolderAccess.Read))).toBe('read ~/code/acme-web')
    expect(sandboxAskPhrase(folder('/Users/me/.cache/uv', FolderAccess.ReadWrite))).toBe('write to ~/.cache/uv')
    expect(sandboxAskPhrase(folder('/opt/tools', FolderAccess.Read))).toBe('read /opt/tools')
    expect(sandboxAskPhrase(reach)).toBe('reach registry.npmjs.org')
    expect(sandboxAskPhrase({ kind: SandboxAskKind.Outside })).toBe('run outside the sandbox')
    expect(
      sandboxAskPhrase({ kind: SandboxAskKind.McpServer, server: 'claude_ai_Acme_Docs', name: 'claude.ai Acme Docs' }),
    ).toBe('use the claude.ai Acme Docs MCP server')
    // A name with nothing to show reads as the key its tools carry.
    expect(sandboxAskPhrase({ kind: SandboxAskKind.McpServer, server: 'gmail', name: ' \n ' })).toBe(
      'use the gmail MCP server',
    )
    expect(sandboxAskPhrase({ kind: SandboxAskKind.Agents, agents: OtherAgents.Sessions })).toBe(
      'message other Claude sessions',
    )
    expect(sandboxAskPhrase({ kind: SandboxAskKind.Agents, agents: OtherAgents.Cloud })).toBe('manage cloud agents')
    expect(folderVerb(FolderAccess.Read)).toBe('read')
    expect(folderVerb(FolderAccess.ReadWrite)).toBe('write to')
  })

  it('grants the folder with the access asked for, or the domain', () => {
    const ask = {
      kind: SandboxAskKind.Folder,
      path: '/Users/me/code/acme-web',
      access: FolderAccess.ReadWrite,
    } as const
    const host = {
      kind: SandboxAskKind.Domain,
      domain: 'registry.npmjs.org',
      command: null,
      commandDescription: null,
    } as const
    expect(grantFor(ask)).toEqual(readWrite('/Users/me/code/acme-web'))
    expect(grantFor(host)).toEqual(domain('registry.npmjs.org'))
  })

  it('grants the MCP server by its key, with its name, or the other agents', () => {
    expect(
      grantFor({ kind: SandboxAskKind.McpServer, server: 'claude_ai_Acme_Docs', name: 'claude.ai Acme Docs' }),
    ).toEqual(server('claude_ai_Acme_Docs', 'claude.ai Acme Docs'))
    expect(grantFor({ kind: SandboxAskKind.Agents, agents: OtherAgents.Cloud })).toEqual(agents(OtherAgents.Cloud))
  })

  it('can be granted, all but running outside the sandbox', () => {
    expect(isGrantAsk(folder('/opt/tools', FolderAccess.Read))).toBe(true)
    expect(isGrantAsk(reach)).toBe(true)
    expect(isGrantAsk({ kind: SandboxAskKind.McpServer, server: 'gmail', name: 'gmail' })).toBe(true)
    expect(isGrantAsk({ kind: SandboxAskKind.Agents, agents: OtherAgents.Sessions })).toBe(true)
    expect(isGrantAsk({ kind: SandboxAskKind.Outside })).toBe(false)
  })

  it('names the other agents by what reaching them does, and by the tool that does it', () => {
    expect(otherAgentsPhrase(OtherAgents.Sessions)).toBe('message other Claude sessions')
    expect(otherAgentsPhrase(OtherAgents.Cloud)).toBe('manage cloud agents')
    expect(OTHER_AGENTS_LABELS).toEqual({
      [OtherAgents.Sessions]: 'Messaging other Claude sessions',
      [OtherAgents.Cloud]: 'Cloud agents',
    })
    expect(OTHER_AGENTS_TOOLS).toEqual({
      [OtherAgents.Sessions]: 'SendMessage',
      [OtherAgents.Cloud]: 'RemoteTrigger',
    })
  })
})

describe('the scopes Settings lists', () => {
  it('lists the Glade-wide grants and a workspace’s, never a task’s', () => {
    expect(isSettingsGrantTarget({ scope: SandboxGrantScope.Glade })).toBe(true)
    expect(isSettingsGrantTarget({ scope: SandboxGrantScope.Workspace, workspaceId: 'w1' })).toBe(true)
    expect(isSettingsGrantTarget({ scope: SandboxGrantScope.Task, taskId: 't1' })).toBe(false)
  })

  it('keeps each scope’s grants under a key of its own', () => {
    expect(settingsGrantScopeKey({ scope: SandboxGrantScope.Glade })).toBe('glade')
    expect(settingsGrantScopeKey({ scope: SandboxGrantScope.Workspace, workspaceId: 'w1' })).toBe('workspace:w1')
    expect(settingsGrantScopeKey({ scope: SandboxGrantScope.Workspace, workspaceId: 'w2' })).toBe('workspace:w2')
    // A workspace whose id is "glade" is still a workspace.
    expect(settingsGrantScopeKey({ scope: SandboxGrantScope.Workspace, workspaceId: 'glade' })).not.toBe('glade')
  })

  it('reads a folder’s access as the lists and their selects show it', () => {
    expect(FOLDER_ACCESS_LABELS).toEqual({ read: 'Read-only', read_write: 'Read-write' })
  })
})
