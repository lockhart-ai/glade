import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenWith } from './files/open-path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createE2eAgent,
  createE2eAgentEnvs,
  createE2eDesktop,
  createE2eEditor,
  createE2eNetwork,
  createE2eTodoHub,
  E2E_AGENT_ENVS_GLOBAL,
  E2E_AGENT_GLOBAL,
  E2E_CHOSEN_FOLDER_ENV,
  E2E_DESKTOP_GLOBAL,
  E2E_EDITOR_GLOBAL,
  E2E_ENV,
  E2E_NETWORK_GLOBAL,
  E2E_TODO_HUB_GLOBAL,
  e2eChosenFolder,
  E2eSpecError,
  prepareE2e,
  readE2eSpec,
  type E2eAgent,
  type E2eAgentEnvs,
  type E2eDesktop,
  type E2eEditor,
  type E2eNetwork,
  type E2eSpec,
  type E2eTodoHub,
} from './e2e'

let folder = join(tmpdir(), 'glade-e2e-test')

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'glade-e2e-test-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

const STAND_IN = { baseUrl: 'http://127.0.0.1:41001', deadEndProxy: 'http://127.0.0.1:41002' } as const

function spec(overrides: Partial<E2eSpec> = {}): E2eSpec {
  return { userData: folder, route: '', ...overrides }
}

function env(value: unknown): NodeJS.ProcessEnv {
  return { [E2E_ENV]: typeof value === 'string' ? value : JSON.stringify(value) }
}

describe('readE2eSpec', () => {
  it('is null when no e2e run was asked for', () => {
    expect(readE2eSpec({}, false)).toBeNull()
  })

  it('is null in a packaged app, even when an e2e run was asked for', () => {
    expect(readE2eSpec(env(spec()), true)).toBeNull()
  })

  it('reads a valid spec', () => {
    expect(readE2eSpec(env(spec()), false)).toEqual(spec())
    expect(readE2eSpec(env(spec({ route: '#gallery' })), false)).toEqual(spec({ route: '#gallery' }))
    expect(readE2eSpec(env(spec({ agentScript: 'long-running' })), false)).toEqual(
      spec({ agentScript: 'long-running' }),
    )
    const byFirstMessage = { 'Run the suite.': 'long-running', 'Fix the bug.': 'multi-tool-turn' } as const
    expect(readE2eSpec(env(spec({ agentScriptsByFirstMessage: byFirstMessage })), false)).toEqual(
      spec({ agentScriptsByFirstMessage: byFirstMessage }),
    )
    expect(readE2eSpec(env(spec({ seed: '/repo/e2e/seeds/a.json' })), false)).toEqual(
      spec({ seed: '/repo/e2e/seeds/a.json' }),
    )
    expect(readE2eSpec(env(spec({ loginShell: '/tmp/glade-e2e/login-shell' })), false)).toEqual(
      spec({ loginShell: '/tmp/glade-e2e/login-shell' }),
    )
    expect(readE2eSpec(env(spec({ standInModel: STAND_IN })), false)).toEqual(spec({ standInModel: STAND_IN }))
  })

  it('rejects a spec that is not JSON', () => {
    expect(() => readE2eSpec(env('{'), false)).toThrow(E2eSpecError)
    expect(() => readE2eSpec(env('{'), false)).toThrow(/^GLADE_E2E is not JSON: /)
  })

  it.each<[string, unknown]>([
    ['a data folder outside the temp folder', spec({ userData: '/Users/someone/Library/Application Support/glade' })],
    ['the temp folder itself as the data folder', spec({ userData: tmpdir() })],
    ['a route that is not a hash', spec({ route: 'gallery' })],
    ['a seed that is not an absolute path', spec({ seed: 'e2e/seeds/a.json' })],
    ['a login shell that is not an absolute path', spec({ loginShell: 'login-shell' })],
    ['an unknown field', { ...spec(), show: true }],
    ['an unknown agent script', { ...spec(), agentScript: 'nope' }],
    ['an unknown agent script for a first message', { ...spec(), agentScriptsByFirstMessage: { 'Hi.': 'nope' } }],
    // A stand-in model is on this Mac's loopback address, and nowhere else: never the real endpoint.
    [
      'a stand-in model at the real endpoint',
      spec({ standInModel: { ...STAND_IN, baseUrl: 'https://api.anthropic.com' } }),
    ],
    ['a stand-in model on another host', spec({ standInModel: { ...STAND_IN, baseUrl: 'http://10.0.0.5:8080' } })],
    ['a stand-in model by a name', spec({ standInModel: { ...STAND_IN, baseUrl: 'http://localhost:8080' } })],
    ['a stand-in model with a path', spec({ standInModel: { ...STAND_IN, baseUrl: 'http://127.0.0.1:8080/v1' } })],
    [
      'a stand-in model whose address hides another host',
      spec({ standInModel: { ...STAND_IN, baseUrl: 'http://127.0.0.1:8080@api.anthropic.com' } }),
    ],
    [
      'a stand-in model whose dead end is another host',
      spec({ standInModel: { ...STAND_IN, deadEndProxy: 'http://proxy.example.invalid:3128' } }),
    ],
    ['a stand-in model with no dead end', { ...spec(), standInModel: { baseUrl: STAND_IN.baseUrl } }],
    ['a stand-in model with no address', { ...spec(), standInModel: { deadEndProxy: STAND_IN.deadEndProxy } }],
    ['a stand-in model with an unknown field', { ...spec(), standInModel: { ...STAND_IN, apiKey: 'a-real-key' } }],
  ])('rejects %s', (_, value) => {
    expect(() => readE2eSpec(env(value), false)).toThrow(/^GLADE_E2E is invalid: /)
  })
})

describe('prepareE2e', () => {
  function fakeApp() {
    return { setPath: vi.fn<(name: 'userData', path: string) => void>(), dock: { hide: vi.fn<() => void>() } }
  }

  it('points the data folder at the temp folder and hides the dock icon', () => {
    const app = fakeApp()

    prepareE2e(app, spec())

    expect(app.setPath).toHaveBeenCalledWith('userData', folder)
    expect(app.dock.hide).toHaveBeenCalledOnce()
  })

  it('reuses a data folder from an earlier launch, so a test can relaunch the app', () => {
    writeFileSync(join(folder, 'glade.db'), '')
    const app = fakeApp()

    prepareE2e(app, spec())

    expect(app.setPath).toHaveBeenCalledWith('userData', folder)
  })

  it('refuses a data folder that does not exist', () => {
    const app = fakeApp()

    expect(() => {
      prepareE2e(app, spec({ userData: join(folder, 'missing') }))
    }).toThrow(E2eSpecError)
    expect(app.setPath).not.toHaveBeenCalled()
  })

  it('takes a stand-in model when the home folder is a throwaway one, by either name of the temp folder', () => {
    const home = join(folder, 'home')
    mkdirSync(home)

    const app = fakeApp()
    prepareE2e(app, spec({ standInModel: STAND_IN }), home)
    expect(app.setPath).toHaveBeenCalledWith('userData', folder)

    const byRealPath = fakeApp()
    prepareE2e(byRealPath, spec({ standInModel: STAND_IN }), realpathSync(home))
    expect(byRealPath.setPath).toHaveBeenCalledWith('userData', folder)
  })

  it.each([
    ['your own home folder', '/Users/someone'],
    ['a folder of it', '/Users/someone/code/acme-api'],
    ['the temp folder itself', tmpdir()],
    ['a path that only starts like the temp folder', `${tmpdir()}-other/home`],
    ['a path that leaves the temp folder again', join(tmpdir(), '..', 'home')],
    ['a relative path', 'home'],
  ])('refuses a stand-in model with %s as the home folder: the real Claude Code would run on it', (_, home) => {
    const app = fakeApp()

    expect(() => {
      prepareE2e(app, spec({ standInModel: STAND_IN }), home)
    }).toThrow(/^GLADE_E2E names a stand-in model, which needs a throwaway home folder/)
    expect(() => {
      prepareE2e(app, spec({ standInModel: STAND_IN }), home)
    }).toThrow(E2eSpecError)
    expect(app.setPath).not.toHaveBeenCalled()
    expect(app.dock.hide).not.toHaveBeenCalled()
  })

  it("needs no throwaway home folder without a stand-in model: a scripted run starts nothing of Claude Code's", () => {
    const app = fakeApp()

    prepareE2e(app, spec(), '/Users/someone')

    expect(app.setPath).toHaveBeenCalledWith('userData', folder)
  })

  it("reads the home folder from the app's own environment by default", () => {
    vi.stubEnv('HOME', '/Users/someone')
    const app = fakeApp()

    expect(() => {
      prepareE2e(app, spec({ standInModel: STAND_IN }))
    }).toThrow(E2eSpecError)
    vi.unstubAllEnvs()
  })
})

describe('e2eChosenFolder', () => {
  it('answers with the folder the test chose, or null (cancelled) when there is none', () => {
    expect(e2eChosenFolder({ [E2E_CHOSEN_FOLDER_ENV]: '/tmp/acme-api' })).toBe('/tmp/acme-api')
    expect(e2eChosenFolder({ [E2E_CHOSEN_FOLDER_ENV]: '' })).toBeNull()
    expect(e2eChosenFolder({})).toBeNull()
  })
})

describe('createE2eNetwork', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_NETWORK_GLOBAL)
  })

  it('starts online, and follows what a spec sets on the global object', () => {
    const isOnline = createE2eNetwork()
    expect(isOnline()).toBe(true)

    const network = Reflect.get(globalThis, E2E_NETWORK_GLOBAL) as E2eNetwork
    network.online = false
    expect(isOnline()).toBe(false)
    network.online = true
    expect(isOnline()).toBe(true)
  })
})

describe('createE2eTodoHub', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_TODO_HUB_GLOBAL)
  })

  it('puts main’s filing service on the global object for a spec to call', () => {
    const hub: E2eTodoHub = { file: vi.fn(() => []), unfile: vi.fn(() => []) }

    createE2eTodoHub(hub)

    expect(Reflect.get(globalThis, E2E_TODO_HUB_GLOBAL)).toBe(hub)
  })
})

describe('createE2eEditor', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_EDITOR_GLOBAL)
  })

  it('records each file it opens on the global object, and succeeds', async () => {
    const openPath = createE2eEditor()

    await expect(openPath('/code/acme-api/README.md')).resolves.toBe('')

    expect((Reflect.get(globalThis, E2E_EDITOR_GLOBAL) as E2eEditor).opened).toEqual(['/code/acme-api/README.md'])
  })

  it('records which files were opened as text, in the text editor', async () => {
    const openPath = createE2eEditor()

    await openPath('/code/acme-api/shot.png', OpenWith.Default)
    await openPath('/code/acme-api/deploy.command', OpenWith.TextEditor)

    expect(Reflect.get(globalThis, E2E_EDITOR_GLOBAL)).toEqual({
      opened: ['/code/acme-api/shot.png', '/code/acme-api/deploy.command'],
      asText: ['/code/acme-api/deploy.command'],
    })
  })
})

describe('createE2eAgent', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_AGENT_GLOBAL)
  })

  it("records each session's options, sandbox changes and log, and each message the agent is sent, on the global object", () => {
    const { onSent, onStart, onFlagSettings, onSandboxLog } = createE2eAgent()
    const sandboxed = {
      sandbox: { enabled: true, filesystem: { allowWrite: ['/code/acme-api'] } },
      permissions: { ask: ['Bash(dangerouslyDisableSandbox:true)'] },
    }

    onStart({ systemPromptAppend: 'You are running inside Glade.', resumeSessionId: null })
    onSent('Hi')
    onSent([{ type: 'text', text: 'Again' }])
    onStart({ systemPromptAppend: 'Again inside Glade.', resumeSessionId: 'session-1', flagSettings: sandboxed })
    onFlagSettings({ permissions: { allow: ['WebFetch(domain:registry.npmjs.org)'] } })
    onFlagSettings({ sandbox: null })
    onSandboxLog('… Sandbox: cat(4242) deny(1) file-read-data /code/acme-shared/notes.txt')

    expect(Reflect.get(globalThis, E2E_AGENT_GLOBAL) as E2eAgent).toEqual({
      received: ['Hi', [{ type: 'text', text: 'Again' }]],
      sessions: [
        { systemPromptAppend: 'You are running inside Glade.', resumeSessionId: null, flagSettings: null },
        { systemPromptAppend: 'Again inside Glade.', resumeSessionId: 'session-1', flagSettings: sandboxed },
      ],
      flagSettings: [{ permissions: { allow: ['WebFetch(domain:registry.npmjs.org)'] } }, { sandbox: null }],
      sandboxLog: ['… Sandbox: cat(4242) deny(1) file-read-data /code/acme-shared/notes.txt'],
      extraUsage: false,
    })
  })

  it('says the account’s extra usage is off until a spec turns it on, on the global object', () => {
    const { extraUsageOn } = createE2eAgent()
    expect(extraUsageOn()).toBe(false)

    ;(Reflect.get(globalThis, E2E_AGENT_GLOBAL) as E2eAgent).extraUsage = true

    expect(extraUsageOn()).toBe(true)
  })
})

describe('createE2eDesktop', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_DESKTOP_GLOBAL)
  })

  it('records each file it reveals, each text it copies and each link it opens on the global object', async () => {
    const { revealPath, writeClipboard, openExternal } = createE2eDesktop()

    revealPath('/code/acme-api/docs/notes.md')
    await writeClipboard('# Notes')
    await openExternal('https://example.com/docs')

    expect(Reflect.get(globalThis, E2E_DESKTOP_GLOBAL) as E2eDesktop).toEqual({
      revealed: ['/code/acme-api/docs/notes.md'],
      copied: ['# Notes'],
      opened: ['https://example.com/docs'],
    })
  })
})

describe('createE2eAgentEnvs', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_AGENT_ENVS_GLOBAL)
  })

  it("records each session's environment on the global object, oldest first", () => {
    const record = createE2eAgentEnvs()
    expect(Reflect.get(globalThis, E2E_AGENT_ENVS_GLOBAL) as E2eAgentEnvs).toEqual({ sessions: [] })

    record({ PATH: '/opt/sample/bin:/usr/bin' })
    record({ PATH: '/usr/bin' })

    expect(Reflect.get(globalThis, E2E_AGENT_ENVS_GLOBAL) as E2eAgentEnvs).toEqual({
      sessions: [{ PATH: '/opt/sample/bin:/usr/bin' }, { PATH: '/usr/bin' }],
    })
  })
})
