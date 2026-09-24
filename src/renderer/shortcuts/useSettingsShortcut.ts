import { useEffect } from 'react'
import { useGladeStoreApi } from '../store/react'

/** Whether the key is ⌘, with no other modifier. */
function isSettingsKey(event: KeyboardEvent): boolean {
  return event.key === ',' && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

/** ⌘, opens Settings, wherever the focus is. While it's open, it stays on the section it shows. */
export function useSettingsShortcut(): void {
  const store = useGladeStoreApi()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSettingsKey(event)) return
      event.preventDefault()
      const { settingsSection, openSettings } = store.getState()
      if (settingsSection === null) openSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [store])
}
