import { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { BridgeErrorCode, isBridgeError, type PluginViewBounds } from '../../shared/bridge'
import { shownPlugin } from '../../shared/plugins'
import { useToast } from '../components'
import { HandleEdge, ResizeHandle } from '../layout/ResizeHandle'
import { usePanelSize } from '../panels/usePanel'
import {
  MIN_PLUGIN_WIDTH,
  MIN_TERMINAL_WIDTH,
  Pane,
  RESIZE_STEP,
  sizeBounds,
  type SizeBounds,
} from '../panels/panelSize'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { PluginCard } from './PluginCard'
import styles from './PluginPanel.module.css'

export interface PluginPanelProps {
  /** Whether the bottom bar is collapsed to its tab row. */
  collapsed: boolean
  /** Whether the bottom bar is sliding open or shut. */
  moving: boolean
}

/**
 * The custom property the card's width is set through; the stylesheet caps it to the room there is, using the limits
 * set beside it.
 */
const WIDTH_PROPERTY = '--plugin-width'

const px = (value: number): string => `${String(value)}px`

function widthStyle(width: number): CSSProperties {
  return {
    [WIDTH_PROPERTY]: px(width),
    '--plugin-min-width': px(MIN_PLUGIN_WIDTH),
    '--terminal-min-width': px(MIN_TERMINAL_WIDTH),
  } as CSSProperties
}

/** The room the terminal and the plugin card share in `bar`: its width, less the gap between them. */
function availableWidth(bar: HTMLElement): number {
  return bar.clientWidth - (Number.parseFloat(getComputedStyle(bar).columnGap) || 0)
}

/**
 * The shown plugin's card in the bottom bar, beside the terminal: the first enabled plugin by id, or nothing when none
 * is on. Reads the plugins folder when it first shows, as Settings › Plugins does, and keeps the plugin's view over the
 * card's body while the bar is open and still.
 *
 * A drag handle in the gap on its left resizes it, as the right panel's does, down to its minimum and up to where the
 * terminal keeps its own; the width is kept in UI state, whichever plugin shows. While you drag, the width changes in
 * place without re-rendering the card, and the view follows its slot; it's kept when you let go. The bar collapsed or
 * sliding, there's no handle.
 */
export function PluginPanel({ collapsed, moving }: PluginPanelProps): React.JSX.Element | null {
  const plugins = useGladeStore((state) => state.plugins)
  const loadPlugins = useGladeStore((state) => state.loadPlugins)
  const placePluginView = useGladeStore((state) => state.placePluginView)
  const plugin = plugins === null ? null : shownPlugin(plugins)
  const id = plugin?.folder ?? null
  const status = useGladeStore((state) => (id === null ? '' : (state.pluginStatuses[id] ?? '')))
  const toast = useToast()
  const slot = useRef<HTMLDivElement>(null)
  const { size: width, setSize: keepWidth } = usePanelSize(Pane.Plugin)

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

  // The terminal keeps its minimum width, unless that would squeeze the card below its own.
  const bounds = useCallback((): SizeBounds => {
    const bar = slot.current?.parentElement
    return sizeBounds(Pane.Plugin, (bar == null ? 0 : availableWidth(bar)) - MIN_TERMINAL_WIDTH)
  }, [])

  const showWidth = useCallback((next: number) => {
    slot.current?.style.setProperty(WIDTH_PROPERTY, px(next))
  }, [])

  if (plugin === null) return null
  return (
    <div ref={slot} className={styles.slot} style={widthStyle(width)} data-testid="plugin-slot">
      {!collapsed && !moving && (
        <ResizeHandle
          edge={HandleEdge.Left}
          label="Resize plugin panel"
          size={width}
          bounds={bounds}
          step={RESIZE_STEP}
          onResize={showWidth}
          onResizeEnd={keepWidth}
        />
      )}
      <PluginCard plugin={plugin} status={status} collapsed={collapsed} showing={!moving} place={place} />
    </div>
  )
}
