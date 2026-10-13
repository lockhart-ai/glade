import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLog } from '../logging/memory-sink'
import {
  createHtmlPreviewFileHandler,
  htmlPreviewEntryUrl,
  htmlPreviewScheme,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SCHEME,
  isAllowedHtmlPreviewRequest,
} from './html-preview-protocol'

let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'glade-html-preview-'))
  writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Report</title>')
  writeFileSync(join(folder, 'style.css'), 'body { margin: 0 }')
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe('createHtmlPreviewFileHandler', () => {
  const handler = () => createHtmlPreviewFileHandler({ folder })

  it('serves a file of the folder with its type, the preview CSP and nosniff', async () => {
    const response = await handler()(new Request('glade-html-preview://preview/style.css'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('body { margin: 0 }')
    expect(response.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toBe(HTML_PREVIEW_CSP)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('answers HEAD without a body', async () => {
    const response = await handler()(new Request('glade-html-preview://preview/index.html', { method: 'HEAD' }))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it('refuses any host but "preview", and logs it', async () => {
    const log = createMemoryLog()
    const response = await createHtmlPreviewFileHandler({ folder, log: log.logger })(
      new Request('glade-html-preview://other/index.html'),
    )

    expect(response.status).toBe(404)
    expect(log.records).toEqual([expect.objectContaining({ message: 'html preview asked for another host' })])
  })

  it.each(['POST', 'PUT', 'DELETE'])('refuses %s', async (method) => {
    const response = await handler()(new Request('glade-html-preview://preview/index.html', { method, body: 'x' }))

    expect(response.status).toBe(405)
  })

  it('refuses a path outside the folder (`..`, encoded or not), and logs it', async () => {
    const log = createMemoryLog()
    const response = await createHtmlPreviewFileHandler({ folder, log: log.logger })(
      new Request('glade-html-preview://preview/../../etc/passwd'),
    )

    expect(response.status).toBe(404)
    expect(log.records).toEqual([expect.objectContaining({ message: 'html preview file refused' })])
  })
})

describe('isAllowedHtmlPreviewRequest', () => {
  it('allows only the preview’s own scheme', () => {
    expect(isAllowedHtmlPreviewRequest('glade-html-preview://preview/index.html')).toBe(true)
    expect(isAllowedHtmlPreviewRequest('https://example.com/')).toBe(false)
    expect(isAllowedHtmlPreviewRequest('http://127.0.0.1/')).toBe(false)
    expect(isAllowedHtmlPreviewRequest('data:text/plain,hi')).toBe(false)
    expect(isAllowedHtmlPreviewRequest('file:///etc/passwd')).toBe(false)
  })

  it('refuses a URL that fails to parse', () => {
    expect(isAllowedHtmlPreviewRequest('not a url')).toBe(false)
  })
})

describe('htmlPreviewEntryUrl', () => {
  it('builds the scheme URL for the file, encoding each path segment', () => {
    expect(htmlPreviewEntryUrl('index.html')).toBe('glade-html-preview://preview/index.html')
    expect(htmlPreviewEntryUrl('a report #1.html')).toBe('glade-html-preview://preview/a%20report%20%231.html')
  })
})

describe('htmlPreviewScheme', () => {
  it('is the scheme as standard and secure, with fetch, for the one registration call the app makes', () => {
    expect(htmlPreviewScheme()).toEqual({
      scheme: HTML_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    })
  })
})

describe('HTML_PREVIEW_CSP', () => {
  it('is offline: no network, no frames, objects or forms', () => {
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("frame-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("object-src 'none'")
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'")
    expect(HTML_PREVIEW_CSP).not.toContain('unsafe-eval')
    expect(HTML_PREVIEW_CSP).not.toContain('https:')
  })
})
