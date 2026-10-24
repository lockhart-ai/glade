import { describe, expect, it } from 'vitest'
import { isAllowedLivePreviewRequest, isLoopbackUrl } from './live-preview-network'

describe('isLoopbackUrl', () => {
  it.each(['http://localhost:3000/', 'http://localhost/', 'http://127.0.0.1:8080/', 'http://[::1]:5173/'])(
    'lets %s through',
    (url) => {
      expect(isLoopbackUrl(url)).toBe(true)
    },
  )

  it('is case-insensitive on the host', () => {
    expect(isLoopbackUrl('http://LOCALHOST:3000/')).toBe(true)
  })

  it.each([
    ['https, which loopback dev servers never carry', 'https://localhost:3000/'],
    ['a websocket, not a page', 'ws://localhost:3000/'],
    ['a host that only starts with localhost', 'http://localhost.example.com/'],
    ['another address near loopback', 'http://127.0.0.2/'],
    ['another address on this machine', 'http://192.168.1.20:8000/'],
    ['a remote host', 'http://example.com/'],
    ['a userinfo trick: the host is evil.com, not localhost', 'http://localhost@evil.com/'],
    ['not a URL', 'not a url'],
    ['nothing', ''],
  ])('refuses %s', (_name, url) => {
    expect(isLoopbackUrl(url)).toBe(false)
  })
})

describe('isAllowedLivePreviewRequest', () => {
  it.each([
    'http://localhost:3000/',
    'http://localhost:3000/main.js',
    'http://127.0.0.1:8080/api',
    'http://[::1]:5173/',
    'ws://localhost:3000/vite-hmr',
    'ws://127.0.0.1:24678',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:http://localhost:3000/2f6c1c54-0000-4000-8000-000000000000',
  ])('lets %s through', (url) => {
    expect(isAllowedLivePreviewRequest(url)).toBe(true)
  })

  it.each([
    ['https anywhere', 'https://localhost:3000/'],
    ['a remote host', 'http://example.com/'],
    ['a remote websocket', 'wss://example.com/socket'],
    ['a host that only starts with localhost', 'http://localhost.example.com/'],
    ['another address near loopback', 'http://127.0.0.2/'],
    ['uppercase host, still refused off loopback', 'http://EXAMPLE.com/'],
    ['a userinfo trick', 'http://localhost@evil.com/'],
    ['a file', 'file:///etc/passwd'],
    ['not a URL', 'not a url'],
    ['nothing', ''],
  ])('cancels %s', (_name, url) => {
    expect(isAllowedLivePreviewRequest(url)).toBe(false)
  })

  it('lets credentials in a localhost URL through only as far as localhost', () => {
    expect(isAllowedLivePreviewRequest('http://user:pass@localhost:3000/')).toBe(true)
    expect(isAllowedLivePreviewRequest('http://localhost:3000@example.com/')).toBe(false)
  })
})
