import { CommandId } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { useGladeStoreApi } from '../store/react'

/** Settings (⌘,) opens Settings, wherever the focus is. While it's open, it stays on the section it shows. */
export function useSettingsShortcut(): void {
  const store = useGladeStoreApi()
  useCommand(CommandId.OpenSettings, () => {
    const { settingsSection, openSettings } = store.getState()
    if (settingsSection === null) openSettings()
  })
}
