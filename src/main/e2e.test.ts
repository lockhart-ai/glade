import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createE2eAgent,
  createE2eDesktop,
  createE2eEditor,
  createE2eNetwork,
  E2E_AGENT_GLOBAL,
  E2E_CHOSEN_FOLDER_ENV,
  E2E_DESKTOP_GLOBAL,
  E2E_EDITOR_GLOBAL,
  E2E_ENV,
  E2E_NETWORK_GLOBAL,
  e2eChosenFolder,
  E2eSpecError,
  prepareE2e,
  readE2eSpec,
  type E2eAgent,
  type E2eDesktop,
  type E2eEditor,
  type E2eNetwork,
  type E2eSpec,
} from './e2e'

let folder = join(tmpdir(), 'glade-e2e-test')

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'glade-e2e-test-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

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
    ['an unknown field', { ...spec(), show: true }],
    ['an unknown agent script', { ...spec(), agentScript: 'nope' }],
    ['an unknown agent script for a first message', { ...spec(), agentScriptsByFirstMessage: { 'Hi.': 'nope' } }],
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

describe('createE2eEditor', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_EDITOR_GLOBAL)
  })

  it('records each file it opens on the global object, and succeeds', async () => {
    const openPath = createE2eEditor()

    await expect(openPath('/code/acme-api/README.md')).resolves.toBe('')

    expect((Reflect.get(globalThis, E2E_EDITOR_GLOBAL) as E2eEditor).opened).toEqual(['/code/acme-api/README.md'])
  })
})

describe('createE2eAgent', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_AGENT_GLOBAL)
  })

  it('records the content of each message the agent is sent on the global object', () => {
    const onSent = createE2eAgent()

    onSent('Hi')
    onSent([{ type: 'text', text: 'Again' }])

    expect(Reflect.get(globalThis, E2E_AGENT_GLOBAL) as E2eAgent).toEqual({
      received: ['Hi', [{ type: 'text', text: 'Again' }]],
    })
  })
})

describe('createE2eDesktop', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, E2E_DESKTOP_GLOBAL)
  })

  it('records each file it reveals and each text it copies on the global object', async () => {
    const { revealPath, writeClipboard } = createE2eDesktop()

    revealPath('/code/acme-api/docs/notes.md')
    await writeClipboard('# Notes')

    expect(Reflect.get(globalThis, E2E_DESKTOP_GLOBAL) as E2eDesktop).toEqual({
      revealed: ['/code/acme-api/docs/notes.md'],
      copied: ['# Notes'],
    })
  })
})
