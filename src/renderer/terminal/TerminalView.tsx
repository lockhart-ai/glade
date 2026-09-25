import { useEffect, useRef } from 'react'
import { EventType } from '../../shared/bridge'
import { useToast } from '../components'
import { classNames } from '../components/classNames'
import { useKeymap } from '../commands/hooks'
import { describeFailure } from '../store/hydrate'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import type { TerminalEvent } from '../store/state'
import { createTerminalScreen, type TerminalScreen } from './screen'
import { isAppKey, unseenOutput } from './terminalModel'
import styles from './Terminal.module.css'

export interface TerminalViewProps {
  readonly tabId: string
  /** Whether it's the tab showing: the others stay in the page, hidden, keeping their screens. */
  readonly active: boolean
}

/**
 * One terminal tab's screen (xterm.js). It shows the tab's output so far, which starts its shell if it hasn't
 * (`terminal.attach`), then its output as it comes; what you type goes to the shell, and the terminal's size follows
 * the card's. It takes the focus when something asks (`terminalFocusRequest`) or you pick its tab, and pastes what
 * Run again in terminal puts at its prompt.
 */
export function TerminalView({ tabId, active }: TerminalViewProps): React.JSX.Element {
  const store = useGladeStoreApi()
  const toast = useToast()
  const container = useRef<HTMLDivElement>(null)
  const screen = useRef<TerminalScreen | null>(null)
  const focusRequest = useGladeStore((state) => state.terminalFocusRequest)
  const paste = useGladeStore((state) => state.terminalPaste)
  // The keymap as it is when a key is pressed, so a shortcut you rebind reaches the app, not the shell.
  const currentKeymap = useKeymap()
  const keymap = useRef(currentKeymap)
  useEffect(() => {
    keymap.current = currentKeymap
  }, [currentKeymap])

  useEffect(() => {
    const element = container.current
    if (element === null) return
    const { attachTerminal, writeTerminal, resizeTerminal, subscribeTerminal } = store.getState()
    const shown = createTerminalScreen((event) => isAppKey(keymap.current, event))
    shown.open(element)
    shown.fit()
    screen.current = shown
    const failed = (error: unknown): void => {
      toast.show({ message: describeFailure(error) })
    }

    // Output that arrives before the tab's output so far has loaded waits, then shows what the load didn't have.
    let end: number | null = null
    const early: TerminalEvent[] = []
    const show = (event: TerminalEvent): void => {
      if (end === null) {
        early.push(event)
      } else if (event.type === EventType.TerminalCleared) {
        shown.clear()
      } else {
        shown.write(unseenOutput(event.offset, event.data, end))
        end = Math.max(end, event.offset + event.data.length)
      }
    }
    const unsubscribe = subscribeTerminal(tabId, show)
    let disposed = false
    attachTerminal(tabId, shown.size).then(({ output, end: loaded }) => {
      if (disposed) return
      shown.write(output)
      end = loaded
      for (const event of early.splice(0)) show(event)
    }, failed)

    shown.onInput((data) => {
      writeTerminal(tabId, data).catch(failed)
    })
    shown.onResize((size) => {
      resizeTerminal(tabId, size).catch(failed)
    })
    const observer = new ResizeObserver(() => {
      shown.fit()
    })
    observer.observe(element)
    return () => {
      disposed = true
      observer.disconnect()
      unsubscribe()
      shown.dispose()
      screen.current = null
    }
  }, [store, toast, tabId])

  useEffect(() => {
    if (!active || focusRequest === 0) return
    screen.current?.fit()
    screen.current?.focus()
  }, [active, focusRequest])

  useEffect(() => {
    if (paste?.tabId !== tabId) return
    store.getState().takeTerminalPaste(paste.request)
    screen.current?.paste(paste.text)
    screen.current?.focus()
  }, [store, paste, tabId])

  return (
    <div
      ref={container}
      className={classNames(styles.screen, !active && styles.hidden)}
      data-testid="terminal-screen"
      data-active={active}
    />
  )
}
