import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READY_ATTRIBUTE } from '../shared/ready'
import {
  CAPTURE_ENV,
  captureShots,
  CaptureSpecError,
  prepareCapture,
  readCaptureSpec,
  withTimeout,
  type CaptureImage,
  type CaptureSpec,
  type CaptureWindow,
} from './capture'

const MINIMUM = { width: 1100, height: 700 }

// A folder in the temp folder; each test gets a fresh, empty one. (`it.each` tables are built before any test runs.)
let folder = join(tmpdir(), 'glade-capture-test')

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'glade-capture-test-'))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  vi.useRealTimers()
})

function spec(overrides: Partial<CaptureSpec> = {}): CaptureSpec {
  return {
    outDir: join(folder, 'shots'),
    userData: folder,
    route: '#gallery',
    shots: [{ width: 1920, height: 1200, file: 'gallery-1920x1200.png' }],
    timeoutMs: 1000,
    ...overrides,
  }
}

function env(value: unknown): NodeJS.ProcessEnv {
  return { [CAPTURE_ENV]: typeof value === 'string' ? value : JSON.stringify(value) }
}

describe('readCaptureSpec', () => {
  it('is null when no capture was asked for', () => {
    expect(readCaptureSpec({}, false, MINIMUM)).toBeNull()
  })

  it('is null in a packaged app, even when a capture was asked for', () => {
    expect(readCaptureSpec(env(spec()), true, MINIMUM)).toBeNull()
  })

  it('reads a valid spec', () => {
    expect(readCaptureSpec(env(spec()), false, MINIMUM)).toEqual(spec())
    expect(readCaptureSpec(env(spec({ route: '' })), false, MINIMUM)).toEqual(spec({ route: '' }))
    const conversation = { agentScript: 'multi-tool-turn', message: 'Fix the flaky test.' } as const
    expect(readCaptureSpec(env(spec({ conversation })), false, MINIMUM)).toEqual(spec({ conversation }))
    expect(readCaptureSpec(env(spec({ seed: '/code/fixture.json' })), false, MINIMUM)).toEqual(
      spec({ seed: '/code/fixture.json' }),
    )
    const presses = [{ key: ',', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false }]
    expect(readCaptureSpec(env(spec({ presses })), false, MINIMUM)).toEqual(spec({ presses }))
  })

  it('rejects a spec that is not JSON', () => {
    expect(() => readCaptureSpec(env('{'), false, MINIMUM)).toThrow(CaptureSpecError)
    expect(() => readCaptureSpec(env('{'), false, MINIMUM)).toThrow(/^GLADE_CAPTURE is not JSON: /)
  })

  it.each<[string, unknown]>([
    ['a relative out folder', spec({ outDir: 'shots' })],
    ['a data folder outside the temp folder', spec({ userData: '/Users/someone/Library/Application Support/glade' })],
    ['the temp folder itself as the data folder', spec({ userData: tmpdir() })],
    ['a data folder that climbs out of the temp folder', spec({ userData: join(tmpdir(), '..', 'glade') })],
    ['a route that is not a hash', spec({ route: 'gallery' })],
    ['a shot narrower than the window allows', spec({ shots: [{ width: 800, height: 700, file: 'a.png' }] })],
    ['a shot shorter than the window allows', spec({ shots: [{ width: 1100, height: 600, file: 'a.png' }] })],
    ['a shot that is too big', spec({ shots: [{ width: 9000, height: 700, file: 'a.png' }] })],
    ['a file name with a folder in it', spec({ shots: [{ width: 1100, height: 700, file: '../a.png' }] })],
    ['a file name that is not a PNG', spec({ shots: [{ width: 1100, height: 700, file: 'a.jpg' }] })],
    ['no shots', spec({ shots: [] })],
    ['no timeout', spec({ timeoutMs: 0 })],
    ['a relative seed path', spec({ seed: 'fixture.json' })],
    ['an unknown field', { ...spec(), show: true }],
    ['an unknown agent script', { ...spec(), conversation: { agentScript: 'nope', message: 'Hi' } }],
    ['an empty first message', { ...spec(), conversation: { agentScript: 'simple-reply', message: ' ' } }],
    [
      'a key press with no key',
      { ...spec(), presses: [{ key: '', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false }] },
    ],
  ])('rejects %s', (_, value) => {
    expect(() => readCaptureSpec(env(value), false, MINIMUM)).toThrow(/^GLADE_CAPTURE is invalid: /)
  })
})

describe('prepareCapture', () => {
  function fakeApp(withDock = true) {
    return {
      setPath: vi.fn<(name: 'userData', path: string) => void>(),
      dock: withDock ? { hide: vi.fn<() => void>() } : undefined,
    }
  }

  it('points the data folder at the empty temp folder and hides the dock icon', () => {
    const app = fakeApp()

    prepareCapture(app, spec())

    expect(app.setPath).toHaveBeenCalledWith('userData', folder)
    expect(app.dock?.hide).toHaveBeenCalledOnce()
  })

  it('works where there is no dock', () => {
    const app = fakeApp(false)

    prepareCapture(app, spec())

    expect(app.setPath).toHaveBeenCalledWith('userData', folder)
  })

  it('refuses a data folder that is not empty', () => {
    writeFileSync(join(folder, 'glade.db'), '')
    const app = fakeApp()

    expect(() => {
      prepareCapture(app, spec())
    }).toThrow(`the capture data folder ${folder} is not empty`)
    expect(app.setPath).not.toHaveBeenCalled()
  })

  it('refuses a data folder that does not exist', () => {
    const app = fakeApp()

    expect(() => {
      prepareCapture(app, spec({ userData: join(folder, 'missing') }))
    }).toThrow(/^the capture data folder can't be read: ENOENT/)
    expect(app.setPath).not.toHaveBeenCalled()
  })
})

describe('captureShots', () => {
  function fakeImage(width: number, height: number): CaptureImage {
    return {
      getSize: () => ({ width, height }),
      resize: vi.fn(({ width: w, height: h }: { width: number; height: number }) => fakeImage(w, h)),
      toPNG: () => Buffer.from(`png ${String(width)}x${String(height)}`),
    }
  }

  function fakeWindow(scale: number): CaptureWindow & { calls: string[]; scripts: string[] } {
    const calls: string[] = []
    const scripts: string[] = []
    let size = { width: 0, height: 0 }
    return {
      calls,
      scripts,
      setContentSize: vi.fn((width: number, height: number) => {
        calls.push(`resize ${String(width)}x${String(height)}`)
        size = { width, height }
      }),
      webContents: {
        executeJavaScript: vi.fn((code: string) => {
          scripts.push(code)
          calls.push(
            code.includes(READY_ATTRIBUTE) ? 'wait until ready' : code.includes('keydown') ? 'press' : 'wait for size',
          )
          return Promise.resolve(true)
        }),
        capturePage: vi.fn(() => {
          calls.push('capture')
          return Promise.resolve(fakeImage(size.width * scale, size.height * scale))
        }),
      },
    }
  }

  const shots = [
    { width: 1920, height: 1200, file: 'app-1920x1200.png' },
    { width: 1100, height: 700, file: 'app-1100x700.png' },
  ]

  it('waits until the page is ready, then resizes, waits and captures each shot', async () => {
    const window = fakeWindow(1)

    const files = await captureShots(window, spec({ shots }))

    expect(window.calls).toEqual([
      'wait until ready',
      'resize 1920x1200',
      'wait for size',
      'capture',
      'resize 1100x700',
      'wait for size',
      'capture',
    ])
    expect(files).toEqual([join(folder, 'shots', 'app-1920x1200.png'), join(folder, 'shots', 'app-1100x700.png')])
    expect(readFileSync(files[0] ?? '', 'utf8')).toBe('png 1920x1200')
    expect(readFileSync(files[1] ?? '', 'utf8')).toBe('png 1100x700')
  })

  it('presses the keys asked for, in order, once the page is ready and before capturing', async () => {
    const window = fakeWindow(1)
    const presses = [
      { key: ',', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false },
      { key: 'Escape', metaKey: false, shiftKey: false, altKey: false, ctrlKey: false },
    ]

    await captureShots(window, spec({ shots: [{ width: 1100, height: 700, file: 'a.png' }], presses }))

    expect(window.calls).toEqual(['wait until ready', 'press', 'press', 'resize 1100x700', 'wait for size', 'capture'])
    expect(window.scripts[1]).toContain(`new KeyboardEvent('keydown', { ...${JSON.stringify(presses[0])}`)
    expect(window.scripts[2]).toContain('"key":"Escape"')
  })

  it('scales a Retina capture down to the requested size', async () => {
    const window = fakeWindow(2)

    const [file] = await captureShots(window, spec({ shots: [{ width: 1100, height: 700, file: 'app-1100x700.png' }] }))

    expect(readFileSync(file ?? '', 'utf8')).toBe('png 1100x700')
  })

  it('waits in the page for the size it asked for', async () => {
    const window = fakeWindow(1)

    await captureShots(window, spec({ shots: [{ width: 1100, height: 700, file: 'a.png' }] }))

    expect(window.scripts.at(-1)).toContain('window.innerWidth === 1100 && window.innerHeight === 700')
  })
})

describe('withTimeout', () => {
  it('gives the result when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done')
  })

  it('passes on the work failing', async () => {
    await expect(withTimeout(Promise.reject(new Error('broke')), 1000)).rejects.toThrow('broke')
  })

  it('fails when the work takes too long', async () => {
    vi.useFakeTimers()
    const result = withTimeout(new Promise(() => undefined), 500)
    const check = expect(result).rejects.toThrow('Capture timed out after 500 ms')

    await vi.advanceTimersByTimeAsync(500)

    await check
  })
})
