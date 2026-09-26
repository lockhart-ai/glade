// xterm.js, behind the small interface the terminal view uses. It needs a real browser to draw (a canvas, layout,
// `matchMedia`), which jsdom lacks, so unit tests stand in a fake for this module and the e2e specs drive the real one.
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { colors, scrollbarTokens } from '../tokens'

/** A terminal's size, in character cells. */
export interface ScreenSize {
  readonly cols: number
  readonly rows: number
}

/** A terminal screen in the page: it shows a shell's output and turns your keys into its input. */
export interface TerminalScreen {
  /** Puts the screen in `container`. */
  open(container: HTMLElement): void
  /** Its size now. */
  readonly size: ScreenSize
  /** Resizes it to fill its container; does nothing while the container isn't laid out (hidden). */
  fit(): void
  /** Shows output. */
  write(data: string): void
  /** Types text as a paste would (bracketed, when the shell asks for that), so a line break in it doesn't run it. */
  paste(text: string): void
  /** Clears the scrollback and the screen, keeping the line the cursor is on. */
  clear(): void
  focus(): void
  /** Calls `listener` with what you type or paste, for the shell. */
  onInput(listener: (data: string) => void): void
  /** Calls `listener` when it's resized. */
  onResize(listener: (size: ScreenSize) => void): void
  dispose(): void
}

/** How many lines of output the screen keeps to scroll back through. */
const SCROLLBACK_LINES = 5_000

/**
 * Makes an xterm.js screen in the designs' colours and type (`docs/design/html/task-workspace.html`). The keys
 * `isAppKey` claims go to the app, not the shell.
 */
export function createTerminalScreen(isAppKey: (event: KeyboardEvent) => boolean): TerminalScreen {
  const terminal = new Terminal({
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    fontSize: 12.5,
    lineHeight: 1.37,
    scrollback: SCROLLBACK_LINES,
    cursorBlink: false,
    macOptionIsMeta: false,
    allowProposedApi: false,
    theme: {
      background: colors['--color-bg'],
      foreground: colors['--color-muted'],
      cursor: colors['--color-text'],
      cursorAccent: colors['--color-bg'],
      selectionBackground: colors['--color-strong'],
      blue: colors['--color-blue'],
      brightBlue: colors['--color-blue-text'],
      magenta: colors['--color-purple'],
      brightMagenta: colors['--color-purple'],
      cyan: colors['--color-teal'],
      brightCyan: colors['--color-teal'],
      red: colors['--color-pink'],
      brightRed: colors['--color-pink'],
      white: colors['--color-muted'],
      brightWhite: colors['--color-text'],
      brightBlack: colors['--color-faint'],
      // Its scroll bar's thumb, as every other scroll bar's (global.css); Terminal.module.css gives it their shape.
      scrollbarSliderBackground: colors[scrollbarTokens.thumb],
      scrollbarSliderHoverBackground: colors[scrollbarTokens.thumbHover],
      scrollbarSliderActiveBackground: colors[scrollbarTokens.thumbActive],
    },
  })
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  // The app's shortcuts reach the app, not the shell.
  terminal.attachCustomKeyEventHandler((event) => !isAppKey(event))
  let parent: HTMLElement | null = null
  return {
    open: (container) => {
      parent = container
      terminal.open(container)
    },
    get size() {
      return { cols: terminal.cols, rows: terminal.rows }
    },
    fit: () => {
      // A hidden terminal (another tab's, or the collapsed bar's) has no size to fit to: it keeps the one it had.
      if (parent !== null && parent.clientWidth > 0 && parent.clientHeight > 0) fitAddon.fit()
    },
    write: (data) => {
      terminal.write(data)
    },
    paste: (text) => {
      terminal.paste(text)
    },
    clear: () => {
      terminal.clear()
    },
    focus: () => {
      terminal.focus()
    },
    onInput: (listener) => {
      terminal.onData(listener)
    },
    onResize: (listener) => {
      terminal.onResize(({ cols, rows }) => {
        listener({ cols, rows })
      })
    },
    dispose: () => {
      terminal.dispose()
    },
  }
}
