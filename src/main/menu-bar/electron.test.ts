import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindowConstructorOptions, NativeImage } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNEL, EventType } from '../../shared/bridge'
import { EMPTY_MENU_BAR_SNAPSHOT, MENU_BAR_POPOVER_WIDTH } from '../../shared/menuBar'
import {
  createElectronPopover,
  createElectronTray,
  FIRST_FIT_TIMEOUT_MS,
  GLYPH_FOLDER,
  glyphFile,
  loadGlyphImages,
  TRAY_TOOLTIP,
  type ElectronPopoverOptions,
  type TrayClass,
  type WindowClass,
} from './electron'
import { MIN_POPOVER_HEIGHT, POPOVER_GAP, type Bounds } from './position'
import { GLYPH_STRENGTHS, RESTING_FRAME } from './pulse'

const ROOT = join(__dirname, '..', '..', '..')

type Listener = (...args: unknown[]) => unknown

/** A glyph image, by the path it was read from. */
interface FakeImage {
  readonly path: string
  readonly setTemplateImage: ReturnType<typeof vi.fn>
}

function fakeImage(path: string): FakeImage {
  return { path, setTemplateImage: vi.fn() }
}

/** Electron's `Tray`, recording what it's asked to show. */
class FakeTray {
  static made: FakeTray[] = []
  readonly listeners = new Map<string, Listener>()
  readonly setToolTip = vi.fn()
  readonly setImage = vi.fn()
  readonly setTitle = vi.fn()
  readonly getBounds = vi.fn((): Bounds => ({ x: 1480, y: 0, width: 32, height: 24 }))
  readonly destroy = vi.fn()
  constructor(readonly image: unknown) {
    FakeTray.made.push(this)
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, listener)
    return this
  }
}

/** Electron's `BrowserWindow`, recording what it's asked to do. */
class FakeWindow {
  static made: FakeWindow[] = []
  readonly listeners = new Map<string, Listener>()
  readonly pageListeners = new Map<string, Listener>()
  readonly setVisibleOnAllWorkspaces = vi.fn()
  readonly setBounds = vi.fn()
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly hide = vi.fn()
  readonly destroy = vi.fn()
  windowOpenHandler: Listener | undefined
  readonly webContents = {
    send: vi.fn(),
    setWindowOpenHandler: (handler: Listener) => {
      this.windowOpenHandler = handler
    },
    on: (event: string, listener: Listener) => {
      this.pageListeners.set(event, listener)
    },
  }
  constructor(readonly options: BrowserWindowConstructorOptions) {
    FakeWindow.made.push(this)
  }
  on(event: string, listener: Listener): this {
    this.listeners.set(event, listener)
    return this
  }
}

const images = GLYPH_STRENGTHS.map((_, frame) => fakeImage(glyphFile(frame))) as unknown as NativeImage[]

describe('the glyph images', () => {
  it('are one per strength, each a template image read from the folder, @2x beside it', () => {
    const createFromPath = vi.fn(fakeImage)
    const loaded = loadGlyphImages({ createFromPath } as unknown as Parameters<typeof loadGlyphImages>[0], '/app')
    expect(createFromPath.mock.calls.map(([path]) => path)).toEqual([
      join('/app', 'glyph-0Template.png'),
      join('/app', 'glyph-1Template.png'),
      join('/app', 'glyph-2Template.png'),
    ])
    for (const image of loaded as unknown as FakeImage[]) expect(image.setTemplateImage).toHaveBeenCalledWith(true)
  })

  it('are in the repo, @1x and @2x, 18 and 36 pixels square, and packaged with the app', () => {
    for (const [frame] of GLYPH_STRENGTHS.entries()) {
      const file = join(ROOT, GLYPH_FOLDER, glyphFile(frame))
      for (const [path, size] of [
        [file, 18],
        [file.replace('.png', '@2x.png'), 36],
      ] as const) {
        expect(existsSync(path), path).toBe(true)
        const png = readFileSync(path)
        // The PNG header's width and height.
        expect([png.readUInt32BE(16), png.readUInt32BE(20)], path).toEqual([size, size])
      }
    }
    expect(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')).toContain(`- ${GLYPH_FOLDER}/*`)
  })
})

describe('the tray', () => {
  it('shows the glyph at full strength, named, and hears clicks', () => {
    FakeTray.made = []
    const onClick = vi.fn()
    createElectronTray(FakeTray as unknown as TrayClass, images)({ onClick })
    const [tray] = FakeTray.made
    expect(tray?.image).toBe(images[RESTING_FRAME])
    expect(tray?.setToolTip).toHaveBeenCalledWith(TRAY_TOOLTIP)
    tray?.listeners.get('click')?.()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('draws each frame, sets the count in digits of one width, says where it is, and goes', () => {
    FakeTray.made = []
    const icon = createElectronTray(FakeTray as unknown as TrayClass, images)({ onClick: vi.fn() })
    const [tray] = FakeTray.made
    icon.setFrame(2)
    icon.setFrame(99)
    expect(tray?.setImage.mock.calls).toEqual([[images[2]], [images[RESTING_FRAME]]])
    icon.setTitle('3')
    expect(tray?.setTitle).toHaveBeenCalledWith('3', { fontType: 'monospacedDigit' })
    expect(icon.bounds()).toEqual({ x: 1480, y: 0, width: 32, height: 24 })
    icon.destroy()
    expect(tray?.destroy).toHaveBeenCalledOnce()
  })

  it('refuses to be made with no images', () => {
    expect(() => createElectronTray(FakeTray as unknown as TrayClass, [])({ onClick: vi.fn() })).toThrow(
      'No menu bar glyph images',
    )
  })
})

describe('the popover window', () => {
  const WORK_AREA: Bounds = { x: 0, y: 25, width: 1512, height: 900 }
  const ANCHOR: Bounds = { x: 1000, y: 0, width: 32, height: 24 }
  const PREFERENCES = { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: '/app/preload.js' }

  function make(overrides: Partial<ElectronPopoverOptions> = {}) {
    FakeWindow.made = []
    const load = vi.fn()
    const track = vi.fn()
    const onHidden = vi.fn()
    const popover = createElectronPopover({
      BrowserWindow: FakeWindow as unknown as WindowClass,
      webPreferences: PREFERENCES,
      load,
      workArea: () => WORK_AREA,
      hidden: false,
      track,
      ...overrides,
    })({ onHidden })
    const [window] = FakeWindow.made
    if (window === undefined) throw new Error('no window')
    return { popover, window, load, track, onHidden }
  }

  it("is a small frameless panel, hidden, with every window's security settings, loading Glade's page", () => {
    const { window, load, track } = make()
    expect(window.options).toMatchObject({
      width: MENU_BAR_POPOVER_WIDTH,
      height: MIN_POPOVER_HEIGHT,
      show: false,
      type: 'panel',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: PREFERENCES,
    })
    expect(window.options).not.toHaveProperty('paintWhenInitiallyHidden')
    expect(window.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true })
    expect(load).toHaveBeenCalledWith(window)
    expect(track).toHaveBeenCalledWith(window, true)
  })

  it('opens no popups and never navigates away', () => {
    const { window } = make()
    expect(window.windowOpenHandler?.()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    window.pageListeners.get('will-navigate')?.(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('shows under the icon, the first time once its page has said how tall it is, and takes the focus', () => {
    const { popover, window } = make()
    popover.show(ANCHOR)
    expect(window.setBounds).toHaveBeenLastCalledWith({
      x: 1000 + 16 - MENU_BAR_POPOVER_WIDTH / 2,
      y: 25 + POPOVER_GAP,
      width: MENU_BAR_POPOVER_WIDTH,
      height: MIN_POPOVER_HEIGHT,
    })
    expect(window.show).not.toHaveBeenCalled()

    popover.fit(412)
    expect(window.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 412 }))
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()

    // It already knows how tall it is: later, it shows at once, and a change of height only moves it.
    popover.hide()
    popover.show(ANCHOR)
    expect(window.show).toHaveBeenCalledTimes(2)
    popover.fit(300)
    expect(window.show).toHaveBeenCalledTimes(2)
    expect(window.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 300 }))
  })

  describe('waiting for its page', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('shows anyway when its page takes too long to say how tall it is, and only once', () => {
      const { popover, window } = make()
      popover.show(ANCHOR)
      popover.show(ANCHOR)
      vi.advanceTimersByTime(FIRST_FIT_TIMEOUT_MS - 1)
      expect(window.show).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(window.show).toHaveBeenCalledOnce()
      popover.fit(412)
      expect(window.show).toHaveBeenCalledOnce()
    })

    it('stops waiting when it is hidden or destroyed first', () => {
      const hiding = make()
      hiding.popover.show(ANCHOR)
      hiding.popover.hide()
      hiding.popover.fit(412)
      vi.advanceTimersByTime(FIRST_FIT_TIMEOUT_MS)
      expect(hiding.window.show).not.toHaveBeenCalled()

      const going = make()
      going.popover.show(ANCHOR)
      going.popover.destroy()
      vi.advanceTimersByTime(FIRST_FIT_TIMEOUT_MS)
      expect(going.window.show).not.toHaveBeenCalled()
    })
  })

  it('waits to be placed until it has been shown under the icon', () => {
    const { popover, window } = make()
    popover.fit(300)
    expect(window.setBounds).not.toHaveBeenCalled()
    popover.show(ANCHOR)
    expect(window.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ height: 300 }))
  })

  it('hides when it loses the focus, and says so', () => {
    const { popover, window, onHidden } = make()
    popover.show(ANCHOR)
    window.listeners.get('blur')?.()
    expect(window.hide).toHaveBeenCalledOnce()
    expect(onHidden).toHaveBeenCalledOnce()
    popover.hide()
    expect(window.hide).toHaveBeenCalledTimes(2)
  })

  it("sends its page events on the bridge's event channel", () => {
    const { popover, window } = make()
    const event = { type: EventType.MenuBarChanged, snapshot: EMPTY_MENU_BAR_SNAPSHOT } as const
    popover.send(event)
    expect(window.webContents.send).toHaveBeenCalledWith(EVENT_CHANNEL, event)
  })

  it('is untracked and destroyed for good', () => {
    const { popover, window, track } = make()
    popover.destroy()
    expect(track).toHaveBeenLastCalledWith(window, false)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('never shows in a test mode, but still paints and is placed', () => {
    const { popover, window } = make({ hidden: true })
    expect(window.options).toMatchObject({ show: false, paintWhenInitiallyHidden: true })
    popover.show(ANCHOR)
    popover.fit(300)
    expect(window.setBounds).toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
})
