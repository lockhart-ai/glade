import { useLayoutEffect, useRef, type HTMLAttributes, type KeyboardEvent } from 'react'
import { ScrollRow } from './ScrollRow'
import styles from './Tabs.module.css'
import { revealScroll } from './tabScroll'

/** One tab in a tab bar. */
export interface TabItem<T extends string> {
  value: T
  label: string
  /** A count after the label, e.g. `7` for Tool calls or `3/4` for Todos. */
  count?: string | number
}

export interface TabsProps<T extends string> {
  /** A page-unique id. It links each tab to its `TabPanel`. */
  id: string
  /** The tab bar's accessible name, e.g. "Task panels". */
  label: string
  tabs: readonly TabItem<T>[]
  value: T
  onChange: (value: T) => void
  /** A class for the whole strip: the tabs and their scroll chevrons. */
  className?: string
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** The `id` of the `Tabs` this panel belongs to. */
  tabsId: string
  /** The value of the tab that shows this panel. */
  value: string
}

/** Keys that move between tabs, and which way. */
const STEPS: Readonly<Partial<Record<string, number>>> = {
  ArrowRight: 1,
  ArrowLeft: -1,
}

function tabId(tabsId: string, value: string): string {
  return `${tabsId}-tab-${value}`
}

function panelId(tabsId: string, value: string): string {
  return `${tabsId}-panel-${value}`
}

/**
 * A row of tabs, like the right panel's "Agents 4 · Files · Todos 3/4". The selected tab holds the one tab stop;
 * the left and right arrow keys select the previous or next tab, wrapping at the ends. Render the selected tab's
 * content in a `TabPanel` with the same `tabsId`.
 *
 * When the row is too narrow for its tabs it scrolls sideways, with no scroll bar: by trackpad, by the mouse wheel
 * (up and down scroll it too), and by a chevron at each end with more tabs past it, which scrolls it about a tab's
 * width (`ScrollRow`). That end fades out under its chevron. The selected tab scrolls into view whenever it changes,
 * however it was chosen.
 */
export function Tabs<T extends string>({
  id,
  label,
  tabs,
  value,
  onChange,
  className,
}: TabsProps<T>): React.JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const list = useRef<HTMLDivElement>(null)
  // If no tab is selected, the first one takes the tab stop so the bar stays reachable by keyboard.
  const selectedIndex = tabs.findIndex((tab) => tab.value === value)
  const tabStop = Math.max(selectedIndex, 0)

  // The selected tab scrolls into view as it changes (by click, arrow key, shortcut or anything else) or moves, and as
  // the row or the tab resizes (the panel narrows, the tab's count first shows). Only then, so the row stays where it
  // was scrolled to as other tabs' counts tick. A change of tab scrolls smoothly (the row's `scroll-behavior`, which
  // Reduce motion turns off); the first showing and a resize jump straight there, rather than chase the layout.
  const shown = useRef(false)
  useLayoutEffect(() => {
    const element = list.current
    const button = buttons.current[selectedIndex] ?? null
    if (element === null || button === null) return
    const reveal = (behavior: ScrollBehavior): void => {
      const left = revealScroll(element, button)
      if (left !== null) element.scrollTo({ left, behavior })
    }
    reveal(shown.current ? 'auto' : 'instant')
    shown.current = true
    // A ResizeObserver calls back as it starts watching too: only a change of width counts.
    const widths = (): string => `${String(element.clientWidth)} ${String(button.offsetWidth)}`
    let last = widths()
    const observer = new ResizeObserver(() => {
      if (widths() === last) return
      last = widths()
      reveal('instant')
    })
    observer.observe(element)
    observer.observe(button)
    return () => {
      observer.disconnect()
    }
  }, [selectedIndex])

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = STEPS[event.key]
    if (step === undefined) return

    event.preventDefault()
    const next = (index + step + tabs.length) % tabs.length
    const tab = tabs[next]
    // Always defined: the index is taken modulo the number of tabs, and this tab received the key press.
    if (tab === undefined) return
    onChange(tab.value)
    buttons.current[next]?.focus()
  }

  return (
    <ScrollRow
      listRef={list}
      content={tabs.map((tab) => `${tab.label} ${String(tab.count ?? '')}`).join('\n')}
      count={tabs.length}
      noun="tabs"
      className={className}
      role="tablist"
      aria-label={label}
    >
      {tabs.map((tab, index) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            ref={(button) => {
              buttons.current[index] = button
            }}
            type="button"
            role="tab"
            id={tabId(id, tab.value)}
            aria-selected={selected}
            aria-controls={selected ? panelId(id, tab.value) : undefined}
            tabIndex={index === tabStop ? 0 : -1}
            className={styles.tab}
            onClick={() => {
              onChange(tab.value)
            }}
            onKeyDown={(event) => {
              handleKeyDown(event, index)
            }}
          >
            {tab.count === undefined ? (
              tab.label
            ) : (
              <>
                {tab.label} <span className={styles.count}>{tab.count}</span>
              </>
            )}
          </button>
        )
      })}
    </ScrollRow>
  )
}

/** The content of the selected tab, labelled by that tab. */
export function TabPanel({ tabsId, value, ...rest }: TabPanelProps): React.JSX.Element {
  return (
    <div role="tabpanel" id={panelId(tabsId, value)} aria-labelledby={tabId(tabsId, value)} tabIndex={0} {...rest} />
  )
}
