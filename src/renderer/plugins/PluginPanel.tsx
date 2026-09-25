import { useCallback, useEffect } from 'react'
import { BridgeErrorCode, isBridgeError, type PluginViewBounds } from '../../shared/bridge'
import { shownPlugin } from '../../shared/plugins'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { PluginCard } from './PluginCard'

export interface PluginPanelProps {
  /** Whether the bottom bar is collapsed to its tab row. */
  collapsed: boolean
  /** Whether the bottom bar is sliding open or shut. */
  moving: boolean
}

/**
 * The shown plugin's card in the bottom bar, beside the terminal: the first enabled plugin by id, or nothing when none
 * is on. Reads the plugins folder when it first shows, as Settings › Plugins does, and keeps the plugin's view over the
 * card's body while the bar is open and still.
 */
export function PluginPanel({ collapsed, moving }: PluginPanelProps): React.JSX.Element | null {
  const plugins = useGladeStore((state) => state.plugins)
  const loadPlugins = useGladeStore((state) => state.loadPlugins)
  const placePluginView = useGladeStore((state) => state.placePluginView)
  const plugin = plugins === null ? null : shownPlugin(plugins)
  const id = plugin?.folder ?? null
  const status = useGladeStore((state) => (id === null ? '' : (state.pluginStatuses[id] ?? '')))
  const toast = useToast()

  useEffect(() => {
    if (plugins === null) void loadPlugins()
  }, [plugins, loadPlugins])

  const place = useCallback(
    (bounds: PluginViewBounds | null) => {
      if (id === null) return
      placePluginView(id, bounds).catch((error: unknown) => {
        // Turned off meanwhile (in Settings, or its folder removed): its card is on its way out, and its view is gone.
        if (isBridgeError(error) && error.code === BridgeErrorCode.NotFound) return
        toast.show({ message: describeFailure(error) })
      })
    },
    [id, placePluginView, toast],
  )

  if (plugin === null) return null
  return <PluginCard plugin={plugin} status={status} collapsed={collapsed} showing={!moving} place={place} />
}
