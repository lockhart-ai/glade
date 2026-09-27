/**
 * Links in what the agent and you write: which ones Glade opens, in your browser or mail app, through main (Electron's
 * `shell.openExternal`). The renderer never loads or follows one itself. Only web and mail links open: anything else
 * (`file:`, `javascript:`, `data:`, a custom scheme, a relative path) is refused, and main refuses it again.
 */

/** The schemes a link may open with, as `URL.protocol` names them. */
export const OPENABLE_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:']

/** Whitespace or a control character anywhere in a link: the URL parser would quietly drop or trim it. */
const HIDDEN_CHARACTERS = /[\s\p{Cc}]/u

export enum LinkCheckKind {
  /** A web or mail link, to open. */
  Openable = 'openable',
  /** A link with a scheme Glade won't open. */
  Refused = 'refused',
  /** Not a whole URL: a relative path, an anchor, or text with whitespace or control characters in it. */
  Invalid = 'invalid',
}

/** What a link turned out to be (`checkLink`). */
export type LinkCheck =
  | {
      readonly kind: LinkCheckKind.Openable
      /** The link as the URL parser writes it out: what's opened. */
      readonly url: string
    }
  | {
      readonly kind: LinkCheckKind.Refused
      /** Its scheme, lower-cased, e.g. `javascript:`. */
      readonly scheme: string
    }
  | { readonly kind: LinkCheckKind.Invalid }

/**
 * Whether a link may open: it must parse as a whole URL (`new URL`, which lower-cases the scheme) with an `http:`,
 * `https:` or `mailto:` scheme, and have no whitespace or control characters in it, since the parser would drop those
 * (`java\tscript:` parses as `javascript:`) and the link would say one thing and open another.
 */
export function checkLink(raw: string): LinkCheck {
  if (HIDDEN_CHARACTERS.test(raw) || !URL.canParse(raw)) return { kind: LinkCheckKind.Invalid }
  const url = new URL(raw)
  if (!OPENABLE_PROTOCOLS.includes(url.protocol)) return { kind: LinkCheckKind.Refused, scheme: url.protocol }
  return { kind: LinkCheckKind.Openable, url: url.href }
}

/** The link to open, as the URL parser writes it out, or null for one Glade won't open (`checkLink`). */
export function openableUrl(raw: string): string | null {
  const check = checkLink(raw)
  return check.kind === LinkCheckKind.Openable ? check.url : null
}
