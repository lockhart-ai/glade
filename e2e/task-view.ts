/**
 * Drives the app through the renderer's own bridge (`window.glade`), for what no screen does yet: sending a message
 * until the input bar lands (P1-06). Specs read what a task shows through the locators in `./selectors`.
 */
import type { Page } from '@playwright/test'
import {
  BRIDGE_KEY,
  type CommandName,
  type CommandRequest,
  type CommandResponse,
  type GladeBridge,
} from '../src/shared/bridge'

/** Runs a bridge command in the page, as the renderer would. */
export function invoke<C extends CommandName>(
  page: Page,
  command: C,
  request: CommandRequest<C>,
): Promise<CommandResponse<C>> {
  return page.evaluate(
    ({ key, command, request }) => {
      const bridge = (globalThis as unknown as Record<string, GladeBridge>)[key]
      if (bridge === undefined) throw new Error('No bridge on the page')
      return bridge.invoke(command, request)
    },
    { key: BRIDGE_KEY, command, request },
  )
}
