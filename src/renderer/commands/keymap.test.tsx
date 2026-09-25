// "Every shortcut in the keymap works": walks every row of docs/keymap.md and checks that a command in the registry
// has that row's default binding, and that the window's dispatcher has something to run for each command it
// dispatches once the app is up. The other commands belong to the element with the focus, each tested with it.
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import KEYMAP_DOC from '../../../docs/keymap.md?raw'
import { UiStateKey } from '../../shared/domain'
import { AppCommandId, TaskCommandId, WindowCommandId, WorkspaceCommandId } from '../../shared/commands'
import {
  COMMANDS,
  DEFAULT_KEYMAP,
  DISPATCHED_SCOPES,
  formatBinding,
  KeymapArea,
  KeyScope,
  type CommandDefinition,
  type ShortcutId,
} from '../../shared/keymap'
import { App } from '../App'
import { PanelTab } from '../right-panel/panelModel'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace } from '../store/test-bridge'
import { commandRegistry } from './registry'

/** One row of the keymap's table: its area (carried down from the row that names it), action and keys. */
interface DocRow {
  readonly area: string
  readonly action: string
  /** Each binding the row lists: `⌥↓ / ⌥↑` is two. */
  readonly keys: readonly string[]
}

function docRows(): DocRow[] {
  let area = ''
  return KEYMAP_DOC.split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Area') && !line.startsWith('|---'))
    .map((line) => {
      const [, named = '', action = '', keys = ''] = line.split('|').map((cell) => cell.trim())
      if (named !== '') area = named
      return { area, action, keys: keys.split(' / ') }
    })
}

/** Every command with a shortcut: the menu bar's that have one, and all the window's own. */
const SHORTCUT_IDS: readonly ShortcutId[] = [
  ...Object.values(AppCommandId),
  WorkspaceCommandId.Switch,
  WorkspaceCommandId.Close,
  TaskCommandId.TogglePin,
  TaskCommandId.Rename,
  TaskCommandId.MarkUnread,
  TaskCommandId.MarkDone,
  ...Object.values(WindowCommandId),
]

/** The commands in an area whose default binding shows as `keys`. */
function commandsFor(area: string, keys: string): CommandDefinition[] {
  return COMMANDS.filter(
    (command) => (command.area as string) === area && formatBinding(command.id, DEFAULT_KEYMAP) === keys,
  )
}

/** Where each command the dispatcher doesn't run is handled: the menu bar, or the element with the focus. */
const HANDLED_BY_FOCUS: Readonly<Record<Exclude<KeyScope, KeyScope.Window | KeyScope.OutsideTextFields>, string>> = {
  [KeyScope.FocusedItem]: 'useContextMenu',
  [KeyScope.MessageField]: 'InputBar',
  [KeyScope.RightPanel]: 'TaskPanel',
  [KeyScope.Terminal]: 'Terminal',
  [KeyScope.OpenMenu]: 'Menu (Floating UI’s list navigation)',
  [KeyScope.MenuBar]: 'the menu bar (src/main/menu/template.ts, which template.test.ts checks)',
  [KeyScope.QuestionCard]: 'QuestionCard',
}

describe('docs/keymap.md', () => {
  const rows = docRows()

  it('has the areas the keymap groups commands in', () => {
    expect([...new Set(rows.map(({ area }) => area))]).toEqual(Object.values(KeymapArea))
  })

  it.each(rows.flatMap((row) => row.keys.map((keys) => [row.area, row.action, keys] as const)))(
    '%s › %s (%s) is a command with that default binding',
    (area, _, keys) => {
      expect(commandsFor(area, keys)).toHaveLength(1)
    },
  )

  it('lists every command in the registry', () => {
    const listed = rows.flatMap((row) => row.keys.flatMap((keys) => commandsFor(row.area, keys).map(({ id }) => id)))
    expect([...listed].sort()).toEqual([...SHORTCUT_IDS].sort())
  })

  it('has each command handled: by the window’s dispatcher once the app is up, or by the element with the focus', async () => {
    const task = { ...sampleTask('t1', 'w1'), sessionId: 's1' }
    const store = createGladeStore(
      fakeBridge({
        workspaces: [sampleWorkspace('w1')],
        tasks: [task],
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
          { key: UiStateKey.RightPanelTab, value: PanelTab.Files },
        ],
        openFiles: [{ taskId: 't1', paths: ['src/app.ts'], activePath: 'src/app.ts' }],
      }).bridge,
    )
    render(
      <GladeStoreProvider store={store}>
        <App />
      </GladeStoreProvider>,
    )
    await act(() => store.getState().hydrate())
    const registry = commandRegistry(store)

    const unhandled = COMMANDS.filter(({ id, scope }) =>
      DISPATCHED_SCOPES.includes(scope) ? !registry.has(id) : !(scope in HANDLED_BY_FOCUS),
    ).map(({ id }) => id)
    expect(unhandled).toEqual([])
  })
})
