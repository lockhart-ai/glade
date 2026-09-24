// Test helper: a stand-in for `./screen` (xterm.js), which needs a real browser to draw. Tests mock the module with
// this one: `vi.mock('./screen', () => import('./test-screen'))`.
import type { ScreenSize, TerminalScreen } from './screen'

/** A terminal screen that records what it's asked to do, and types and resizes when its test says. */
export class FakeScreen implements TerminalScreen {
  size: ScreenSize = { cols: 80, rows: 24 }
  /** What it shows: everything written since it was last cleared. */
  shown = ''
  /** The element it was put in. */
  container: HTMLElement | null = null
  fits = 0
  focuses = 0
  clears = 0
  disposed = false
  private readonly inputListeners: ((data: string) => void)[] = []
  private readonly resizeListeners: ((size: ScreenSize) => void)[] = []

  open(container: HTMLElement): void {
    this.container = container
  }

  fit(): void {
    this.fits += 1
  }

  write(data: string): void {
    this.shown += data
  }

  /** Types the text, as xterm.js does with a paste. */
  paste(text: string): void {
    this.type(text)
  }

  clear(): void {
    this.clears += 1
    this.shown = ''
  }

  focus(): void {
    this.focuses += 1
  }

  onInput(listener: (data: string) => void): void {
    this.inputListeners.push(listener)
  }

  onResize(listener: (size: ScreenSize) => void): void {
    this.resizeListeners.push(listener)
  }

  dispose(): void {
    this.disposed = true
  }

  /** Types into the screen, as you would. */
  type(data: string): void {
    for (const listener of this.inputListeners) listener(data)
  }

  /** Resizes the screen, as fitting it to a larger card would. */
  resize(size: ScreenSize): void {
    this.size = size
    for (const listener of this.resizeListeners) listener(size)
  }
}

/** Every screen made, oldest first. Tests empty it between them. */
export const screens: FakeScreen[] = []

export function createTerminalScreen(): TerminalScreen {
  const screen = new FakeScreen()
  screens.push(screen)
  return screen
}
