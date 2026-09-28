import { useEffect } from 'react'
import { useGladeStore } from '../store/react'

/**
 * Keeps the native traffic lights synced with whether the sidebar card is on screen (`window.setTrafficLights`): main
 * moves them to the task header's first row while it's gone, and back to the sidebar's strip once it's shown again
 * (#357). `collapsed` should be `sidebar === undefined` (`AppShell`'s own test for whether the task card takes the
 * whole width), so the timing matches exactly: false the instant the sidebar starts sliding open (before it's
 * finished, so the lights are already where the strip is growing in), true only once it's finished sliding shut (never
 * mid-slide, while the strip is still the old, open one). With Reduce motion on there's no sliding, so both happen at
 * once, on the same change.
 *
 * Also runs once at mount, to correct a stale position: first-run's sidebar is never collapsed, so opening it after
 * leaving a workspace where the sidebar was collapsed must move the lights back.
 */
export function useTrafficLightsSync(collapsed: boolean): void {
  const setTrafficLightsCollapsed = useGladeStore((state) => state.setTrafficLightsCollapsed)
  useEffect(() => {
    void setTrafficLightsCollapsed(collapsed)
  }, [collapsed, setTrafficLightsCollapsed])
}
