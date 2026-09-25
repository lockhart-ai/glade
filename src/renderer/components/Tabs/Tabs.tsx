import { useRef, type HTMLAttributes, type KeyboardEvent } from 'react'
import { classNames } from '../classNames'
import styles from './Tabs.module.css'
import { useOverflowEdges } from './useOverflowEdges'

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
 * A row of tabs, like the right panel's "Tool calls 7 · Files · Todos 3/4". The selected tab holds the one tab stop;
 * the left and right arrow keys select the previous or next tab, wrapping at the ends. Render the selected tab's
 * content in a `TabPanel` with the same `tabsId`. When the row is too narrow for its tabs and scrolls sideways (given
 * `overflow-x: auto` through `className`), it fades out at an end with more tabs past it.
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
  const overflow = useOverflowEdges(list, tabs.map((tab) => `${tab.label} ${String(tab.count ?? '')}`).join('\n'))
  // If no tab is selected, the first one takes the tab stop so the bar stays reachable by keyboard.
  const tabStop = Math.max(
    tabs.findIndex((tab) => tab.value === value),
    0,
  )

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
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={classNames(styles.tablist, className)}
      data-overflow-start={overflow.start}
      data-overflow-end={overflow.end}
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
    </div>
  )
}

/** The content of the selected tab, labelled by that tab. */
export function TabPanel({ tabsId, value, ...rest }: TabPanelProps): React.JSX.Element {
  return (
    <div role="tabpanel" id={panelId(tabsId, value)} aria-labelledby={tabId(tabsId, value)} tabIndex={0} {...rest} />
  )
}
