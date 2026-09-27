import { describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { CommandFailure } from '../bridge/errors'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { openLink, type OpenLinkContext } from './links'

function context(): OpenLinkContext & { readonly opened: string[]; readonly records: () => unknown[] } {
  const opened: string[] = []
  const log = createMemoryLog(LogScope.Ipc)
  return {
    opened,
    openExternal: vi.fn((url: string) => {
      opened.push(url)
      return Promise.resolve()
    }),
    log: log.logger,
    records: () => log.withMessage('refused to open a link').map(({ level, fields }) => ({ level, fields })),
  }
}

describe('openLink', () => {
  it('opens a web link in the browser, as the URL parser writes it out', async () => {
    const links = context()

    await openLink(links, 'HTTPS://Example.com/docs')
    await openLink(links, 'http://localhost:4173')
    await openLink(links, 'mailto:support@example.com')

    expect(links.opened).toEqual(['https://example.com/docs', 'http://localhost:4173/', 'mailto:support@example.com'])
    expect(links.records()).toEqual([])
  })

  it.each([
    ['javascript:alert(1)', 'javascript:'],
    ['JavaScript:alert(document.cookie)', 'javascript:'],
    ['file:///etc/passwd', 'file:'],
    ['data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'data:'],
    ['glade://task/t1', 'glade:'],
  ])('refuses %s and logs its scheme, never the link', async (raw, scheme) => {
    const links = context()

    const opening = openLink(links, raw)

    await expect(opening).rejects.toBeInstanceOf(CommandFailure)
    await expect(opening).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
      message: `Glade doesn't open ${scheme} links`,
    })
    expect(links.openExternal).not.toHaveBeenCalled()
    expect(links.records()).toEqual([{ level: LogLevel.Warn, fields: { scheme } }])
  })

  it.each([' javascript:alert(1)', 'java\tscript:alert(1)', '\u0001https://example.com', 'docs/setup.md', ''])(
    'refuses %j, which is no whole link, and logs it',
    async (raw) => {
      const links = context()

      await expect(openLink(links, raw)).rejects.toMatchObject({
        code: BridgeErrorCode.InvalidRequest,
        message: 'Not a link Glade can open',
      })
      expect(links.openExternal).not.toHaveBeenCalled()
      expect(links.records()).toEqual([{ level: LogLevel.Warn, fields: { scheme: null } }])
    },
  )

  it('fails as the browser does when it cannot open the link', async () => {
    const links = { ...context(), openExternal: () => Promise.reject(new Error('No application to open it')) }

    await expect(openLink(links, 'https://example.com')).rejects.toThrow('No application to open it')
  })
})
