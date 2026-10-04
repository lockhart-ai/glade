// What kind of thing a host is (#514, finding 5): a domain's card says when it's this Mac, a bare address or a local
// name, and an address in another spelling never gets a card or a grant.
import { describe, expect, it } from 'vitest'
import { hostKind, HostKind, hostNote } from './hosts'

describe('hostKind', () => {
  it.each(['registry.npmjs.org', 'docs.acme.dev', 'a.b.c.d.example', 'acme.dev', '*.acme.dev', 'xn--caf-dma.example'])(
    'takes %s for an ordinary name',
    (host) => {
      expect(hostKind(host)).toBe(HostKind.Name)
    },
  )

  it.each([
    'localhost',
    'LOCALHOST',
    ' localhost ',
    'api.localhost',
    '*.localhost',
    '127.0.0.1',
    '127.0.0.53',
    '127.255.255.254',
    '0.0.0.0',
  ])('takes %s for this Mac', (host) => {
    expect(hostKind(host)).toBe(HostKind.Loopback)
  })

  it.each(['10.0.0.5', '192.168.1.20', '169.254.169.254', '8.8.8.8', '255.255.255.255', '1.2.3.4'])(
    'takes %s for a bare address',
    (host) => {
      expect(hostKind(host)).toBe(HostKind.Address)
    },
  )

  it.each(['intranet', 'db', 'my-nas', 'localhost1', 'x'])('takes %s for a name on the local network', (host) => {
    expect(hostKind(host)).toBe(HostKind.LocalName)
  })

  // Each is `127.0.0.1`, or another address, written so that it doesn't look like one.
  it.each([
    '2130706433',
    '0x7f000001',
    '0x7f.1',
    '0X7F.0.0.1',
    '127.1',
    '127.0.1',
    '0177.0.0.1',
    '017700000001',
    '127.0.0.01',
    '127.0.0.256',
    '1.2.3.4.5',
    '0',
    '0x',
    'acme.0x7f',
    'example.123',
    '*.2130706433',
  ])('takes %s for an address in another spelling', (host) => {
    expect(hostKind(host)).toBe(HostKind.Numeric)
  })
})

describe('hostNote', () => {
  it('says what a host is when it isn’t an ordinary name', () => {
    expect(hostNote('127.0.0.1')).toBe(
      'This is your own Mac. Allowing it lets the agent reach every service running on it.',
    )
    expect(hostNote('localhost')).toBe(hostNote('127.0.0.1'))
    expect(hostNote('169.254.169.254')).toBe(
      'This is an IP address, not a name, so nothing here says whose server it is.',
    )
    expect(hostNote('intranet')).toBe('This is a name on your local network, not a public domain.')
  })

  it('says nothing more of an ordinary name, or of an address that gets no card', () => {
    expect(hostNote('registry.npmjs.org')).toBeNull()
    expect(hostNote('2130706433')).toBeNull()
  })
})
