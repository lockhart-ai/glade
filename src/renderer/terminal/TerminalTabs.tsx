import { faPlus, faTerminal, faXmark } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useRef, useState } from 'react'
import { terminalTitle, type TerminalTab } from '../../shared/terminal'
import { Icon, IconSize, useToast } from '../components'
import { classNames } from '../components/classNames'
import { ContextMenu, terminalTabMenu, useContextMenu, useMenuCommands } from '../context-menus'
import { shortenHomePath } from '../paths'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { activeTerminalTab } from './terminalModel'
import styles from './TerminalTabs.module.css'

interface RenameFieldProps {
  readonly tab: TerminalTab
  readonly onRename: (name: string) => Promise<boolean>
  readonly onCancel: () => void
}

/**
 * A tab's name as a text field, while renaming it, with the name selected. ↵ saves it, Esc cancels; a blank name is
 * refused, and the field stays until you type one or cancel. Leaving the field saves it too, unless it's blank: then it
 * cancels. (As a task's title field does in the task list.)
 */
function RenameField({ tab, onRename, onCancel }: RenameFieldProps): React.JSX.Element {
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const save = async (name: string): Promise<void> => {
    finished.current = true
    if (await onRename(name)) return
    finished.current = false
    setInvalid(true)
  }
  const cancel = (): void => {
    finished.current = true
    onCancel()
  }

  return (
    <input
      ref={input}
      className={styles.rename}
      aria-label="Terminal name"
      aria-invalid={invalid}
      defaultValue={terminalTitle(tab)}
      onChange={() => {
        setInvalid(false)
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') void save(event.currentTarget.value)
        else if (event.key === 'Escape') cancel()
      }}
      onBlur={(event) => {
        if (finished.current) return
        if (event.currentTarget.value.trim() === '') cancel()
        else void save(event.currentTarget.value)
      }}
    />
  )
}

/**
 * The terminal card's tab row (`docs/design/html/task-workspace.html`): a tab for each shell, with a blue dot while a
 * program runs in it and a button to close it, then + for a new tab; at the far end, the folder the tab showing
 * started in. A tab's context menu renames, duplicates, clears, interrupts or closes it.
 */
export function TerminalTabs(): React.JSX.Element {
  const tabs = useGladeStore((state) => state.terminalTabs)
  const active = useGladeStore((state) => activeTerminalTab(state.terminalTabs, state.uiState))
  const renamingId = useGladeStore((state) => state.renamingTerminalId)
  const selectTerminal = useGladeStore((state) => state.selectTerminal)
  const createTerminal = useGladeStore((state) => state.createTerminal)
  const closeTerminal = useGladeStore((state) => state.closeTerminal)
  const duplicateTerminal = useGladeStore((state) => state.duplicateTerminal)
  const clearTerminal = useGladeStore((state) => state.clearTerminal)
  const interruptTerminal = useGladeStore((state) => state.interruptTerminal)
  const startRename = useGladeStore((state) => state.startTerminalRename)
  const cancelRename = useGladeStore((state) => state.cancelTerminalRename)
  const renameTerminal = useGladeStore((state) => state.renameTerminal)
  const menu = useContextMenu<string>()
  const { run } = useMenuCommands()
  const toast = useToast()

  const rename = async (tabId: string, name: string): Promise<boolean> => {
    try {
      return await renameTerminal(tabId, name)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
      cancelRename()
      return true
    }
  }

  const tabMenu = (tabId: string) =>
    terminalTabMenu({
      rename: () => {
        startRename(tabId)
      },
      duplicate: () => {
        run(() => duplicateTerminal(tabId))
      },
      clear: () => {
        run(() => clearTerminal(tabId))
      },
      kill: () => {
        run(() => interruptTerminal(tabId))
      },
      close: () => {
        run(() => closeTerminal(tabId))
      },
    })

  return (
    <>
      <span className={styles.icon} aria-hidden="true">
        <Icon icon={faTerminal} size={IconSize.Small} />
      </span>
      <div className={styles.tabs} role="group" aria-label="Terminal tabs">
        {tabs.map((tab) => {
          const title = terminalTitle(tab)
          const selected = tab.id === active?.id
          return (
            <div
              key={tab.id}
              className={classNames(styles.tab, selected && styles.active)}
              title={shortenHomePath(tab.cwd)}
              {...menu.targetProps(tab.id)}
            >
              {tab.id === renamingId ? (
                <span className={styles.select}>
                  <RenameField tab={tab} onRename={(name) => rename(tab.id, name)} onCancel={cancelRename} />
                </span>
              ) : (
                <button
                  type="button"
                  aria-pressed={selected}
                  className={styles.select}
                  onClick={() => {
                    run(() => selectTerminal(tab.id))
                  }}
                >
                  {tab.running && <span className={styles.running} role="img" aria-label="Running" />}
                  <span className={styles.name}>{title}</span>
                </button>
              )}
              <button
                type="button"
                aria-label={`Close ${title}`}
                title="Close (⌘W)"
                className={styles.close}
                onClick={() => {
                  run(() => closeTerminal(tab.id))
                }}
              >
                <Icon icon={faXmark} size={IconSize.Small} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal (⌘T)"
        className={styles.add}
        onClick={() => {
          run(() => createTerminal())
        }}
      >
        <Icon icon={faPlus} size={IconSize.Small} />
      </button>
      <span className={styles.spacer} />
      {active !== undefined && <span className={styles.cwd}>{shortenHomePath(active.cwd)}</span>}
      <ContextMenu label="Terminal tab actions" state={menu} entries={tabMenu} />
    </>
  )
}
