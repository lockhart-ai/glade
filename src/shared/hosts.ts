/**
 * What kind of thing a host is, as a domain's permission card says it (#514): an ordinary name, this computer, a bare
 * address, a name on the local network, or an address written so that it doesn't look like one.
 *
 * A sandboxed command can't connect to this computer directly, but a request through the sandbox's own proxy asks for
 * the host like any other, and a card that says only "reach `127.0.0.1`", or "reach `2130706433`" (the same address),
 * doesn't say that allowing it opens every service listening on this Mac, Glade's control endpoint among them.
 */

/** What kind of thing a host is. */
export enum HostKind {
  /** An ordinary name of two labels or more: `registry.npmjs.org`. */
  Name = 'name',
  /** This computer: `localhost`, a name under it, or a loopback address (`127.0.0.1`, `0.0.0.0`). */
  Loopback = 'loopback',
  /** An IPv4 address written in full (`10.0.0.5`, `169.254.169.254`): no name says whose it is. */
  Address = 'address',
  /** A name of one label (`intranet`, `db`): a machine on the local network, not a public domain. */
  LocalName = 'local_name',
  /**
   * An address in any form but four plain decimal parts (`2130706433`, `0x7f.1`, `127.1`, `0177.0.0.1`): each is another
   * spelling of an address, which nothing honest needs. Never shown on a card, and never granted.
   */
  Numeric = 'numeric',
}

/** A label that's a number, as an address's part is: decimal, or hexadecimal after `0x`. */
const NUMBER = /^(?:0x[0-9a-f]*|\d+)$/

/** One of an IPv4 address's four parts, written plainly: decimal, with no leading zero. */
const PART = /^(?:0|[1-9]\d{0,2})$/

/**
 * What kind of thing a bare host is (no scheme, port or path; a leading `*.` is left out). A host whose last label is
 * a number is an address, in full or in one of its other spellings; anything else is a name.
 */
export function hostKind(host: string): HostKind {
  const name = host.trim().toLowerCase()
  const labels = (name.startsWith('*.') ? name.slice(2) : name).split('.')
  if (NUMBER.test(labels.at(-1) ?? '')) {
    const plain = labels.length === 4 && labels.every((label) => PART.test(label) && Number(label) <= 255)
    if (!plain) return HostKind.Numeric
    const loopback = labels[0] === '127' || labels.every((label) => label === '0')
    return loopback ? HostKind.Loopback : HostKind.Address
  }
  if (labels.at(-1) === 'localhost') return HostKind.Loopback
  return labels.length === 1 ? HostKind.LocalName : HostKind.Name
}

/**
 * What a domain's permission card says under its title about a host that isn't an ordinary name; null for one that is
 * (and for an address in another spelling, which gets no card).
 */
export function hostNote(host: string): string | null {
  switch (hostKind(host)) {
    case HostKind.Loopback:
      return 'This is your own Mac. Allowing it lets the agent reach every service running on it.'
    case HostKind.Address:
      return 'This is an IP address, not a name, so nothing here says whose server it is.'
    case HostKind.LocalName:
      return 'This is a name on your local network, not a public domain.'
    case HostKind.Name:
    case HostKind.Numeric:
      return null
  }
}
