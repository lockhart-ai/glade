/**
 * Opening a link from the window (`links.open`): a link in a reply, a todo or anything else the app shows opens in your
 * browser or mail app, never in Glade. Main makes the call, so the renderer never follows a link itself, and only web
 * and mail links open (`checkLink`); anything else is refused and logged.
 */
import { BridgeErrorCode } from '../../shared/bridge'
import { checkLink, LinkCheckKind } from '../../shared/links'
import { CommandFailure } from '../bridge/errors'
import type { Logger } from '../logging/logger'

/** Opens a link in the app macOS opens its kind of link with: Electron's `shell.openExternal`. */
export type OpenExternal = (url: string) => Promise<void>

export interface OpenLinkContext {
  readonly openExternal: OpenExternal
  /** Where a refused link is logged: its scheme, never the link itself, which may be anything. */
  readonly log: Logger
}

/**
 * Opens `raw` in the browser (or, for `mailto:`, the mail app), as the URL parser writes it out. Fails with
 * `invalid_request` for a link that isn't a whole `http:`, `https:` or `mailto:` URL, which is logged and never opened.
 */
export async function openLink({ openExternal, log }: OpenLinkContext, raw: string): Promise<void> {
  const check = checkLink(raw)
  switch (check.kind) {
    case LinkCheckKind.Openable:
      await openExternal(check.url)
      return
    case LinkCheckKind.Refused:
      log.warn('refused to open a link', { scheme: check.scheme })
      throw new CommandFailure(BridgeErrorCode.InvalidRequest, `Glade doesn't open ${check.scheme} links`)
    case LinkCheckKind.Invalid:
      log.warn('refused to open a link', { scheme: null })
      throw new CommandFailure(BridgeErrorCode.InvalidRequest, 'Not a link Glade can open')
  }
}
