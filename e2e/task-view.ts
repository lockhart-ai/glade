/**
 * Calls the renderer's own bridge (`window.glade`), for specs that check what main has behind the screen, e.g. a
 * task's session id or state. Specs drive the app and read what it shows through the locators in `./selectors`.
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
