import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { CaptureView } from './capture-views'

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
    const extras = { clicks: ['nav button:nth-of-type(6)'], plugins: [join(folder, 'fixtures')] }
    expect(readCaptureSpec(env(spec(extras)), false, MINIMUM)).toEqual(spec(extras))
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

  it("copies the plugins in the spec's sample folders into the data folder's plugins folder", () => {
    const fixtures = mkdtempSync(join(tmpdir(), 'glade-capture-plugins-'))
    try {
      mkdirSync(join(fixtures, 'valid', 'pomodoro'), { recursive: true })
      writeFileSync(join(fixtures, 'valid', 'pomodoro', 'manifest.json'), '{}')
      mkdirSync(join(fixtures, 'invalid', 'broken'), { recursive: true })

      prepareCapture(fakeApp(), spec({ plugins: [join(fixtures, 'valid'), join(fixtures, 'invalid')] }))

      expect(readdirSync(join(folder, 'plugins')).sort()).toEqual(['broken', 'pomodoro'])
      expect(readFileSync(join(folder, 'plugins', 'pomodoro', 'manifest.json'), 'utf8')).toBe('{}')
    } finally {
      rmSync(fixtures, { recursive: true, force: true })
    }
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
      toBitmap: () => Buffer.alloc(width * height * 4),
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
            code.includes(READY_ATTRIBUTE)
              ? 'wait until ready'
              : code.includes('keydown')
                ? 'press'
                : code.includes('.click()')
                  ? 'click'
                  : 'wait for size',
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

  it('clicks the elements asked for, in order, after the presses, waiting until nothing is busy', async () => {
    const window = fakeWindow(1)
    const presses = [{ key: ',', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false }]
    const clicks = ['nav button:nth-of-type(6)', '#done']

    await captureShots(window, spec({ shots: [{ width: 1100, height: 700, file: 'a.png' }], presses, clicks }))

    expect(window.calls).toEqual([
      'wait until ready',
      'press',
      'click',
      'click',
      'resize 1100x700',
      'wait for size',
      'capture',
    ])
    expect(window.scripts[2]).toContain('const selector = "nav button:nth-of-type(6)"')
    expect(window.scripts[2]).toContain(`document.querySelector('[aria-busy="true"]') === null`)
    expect(window.scripts[2]).toContain('document.getAnimations()')
    expect(window.scripts[3]).toContain('const selector = "#done"')
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

describe('captureShots with native views', () => {
  function bitmapImage(width: number, height: number, value: number): CaptureImage {
    return {
      getSize: () => ({ width, height }),
      resize: ({ width: w, height: h }) => bitmapImage(w, h, value),
      toPNG: () => Buffer.from(`png ${String(width)}x${String(height)} ${String(value)}`),
      toBitmap: () => Buffer.alloc(width * height * 4, value),
    }
  }

  function windowWith(views: () => CaptureView[], slots: () => unknown) {
    let size = { width: 0, height: 0 }
    const calls: string[] = []
    const window: CaptureWindow = {
      setContentSize: (width, height) => {
        size = { width, height }
      },
      webContents: {
        executeJavaScript: (code: string) => {
          if (code.includes('data-native-view-slot')) {
            calls.push('find slots')
            return Promise.resolve(slots())
          }
          return Promise.resolve(true)
        },
        capturePage: () => Promise.resolve(bitmapImage(size.width, size.height, 10)),
      },
      nativeViews: views,
    }
    return { window, calls }
  }

  const slot = { x: 100, y: 500, width: 600, height: 150 }
  const shot = [{ width: 1100, height: 700, file: 'a.png' }]

  function pluginView(bounds = slot, visible = true): CaptureView & { settled: number } {
    const captured: CaptureView & { settled: number } = {
      bounds,
      visible,
      radius: 15,
      settled: 0,
      settle: () => {
        captured.settled += 1
        return Promise.resolve()
      },
      capture: () => Promise.resolve(bitmapImage(bounds.width, bounds.height, 200)),
    }
    return captured
  }

  it('waits for each view to settle over its slot, then pastes it into the capture', async () => {
    const view = pluginView()
    // The view isn't over its slot yet the first time the page is asked.
    const placed = [false, true]
    const { window, calls } = windowWith(
      () => [placed.shift() === true ? view : pluginView({ ...slot, x: 0 })],
      () => JSON.stringify([slot]),
    )
    const fromBitmap = vi.fn(({ width, height }: { width: number; height: number }) => bitmapImage(width, height, 7))

    const [file] = await captureShots(window, spec({ shots: shot }), fromBitmap)

    expect(calls).toEqual(['find slots', 'find slots'])
    expect(view.settled).toBe(1)
    expect(fromBitmap).toHaveBeenCalledOnce()
    const [bitmap] = fromBitmap.mock.calls[0] ?? []
    expect(bitmap).toMatchObject({ width: 1100, height: 700 })
    expect(readFileSync(file ?? '', 'utf8')).toBe('png 1100x700 7')
  })

  it('captures the page alone when it has no slot showing, or no way to paste', async () => {
    const hidden = pluginView(slot, false)
    const { window } = windowWith(
      () => [hidden],
      () => '[]',
    )
    const fromBitmap = vi.fn()

    const [file] = await captureShots(window, spec({ shots: shot }), fromBitmap)
    const [other] = await captureShots(window, spec({ shots: [{ ...shot[0], file: 'b.png' }] as typeof shot }))

    expect(fromBitmap).not.toHaveBeenCalled()
    expect(hidden.settled).toBe(0)
    expect(readFileSync(file ?? '', 'utf8')).toBe('png 1100x700 10')
    expect(readFileSync(other ?? '', 'utf8')).toBe('png 1100x700 10')
  })

  it('gives up when a view never settles over its slot', async () => {
    vi.useFakeTimers()
    try {
      const { window } = windowWith(
        () => [],
        () => JSON.stringify([slot]),
      )
      const capturing = captureShots(window, spec({ shots: shot }), vi.fn())
      const failed = expect(capturing).rejects.toThrow("The page's native views didn't settle over their slots")

      await vi.advanceTimersByTimeAsync(11_000)
      await failed
    } finally {
      vi.useRealTimers()
    }
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
