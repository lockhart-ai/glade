import { describe, expect, it } from 'vitest'
import { isAllowedPluginRequest } from './network'

describe('isAllowedPluginRequest', () => {
  it.each([
    'glade-plugin://pomodoro/index.html',
    'glade-plugin://pomodoro/app/main.js?v=2',
    'http://localhost:8000/data',
    'http://localhost/data',
    'http://127.0.0.1:5173/',
    'ws://localhost:8765/events',
    'ws://127.0.0.1:9000',
    'data:image/png;base64,iVBORw0KGgo=',
    'blob:glade-plugin://pomodoro/2f6c1c54-0000-4000-8000-000000000000',
  ])('lets %s through', (url) => {
    expect(isAllowedPluginRequest(url, 'pomodoro')).toBe(true)
  })

  it.each([
    ['a remote host over HTTPS', 'https://example.com/'],
    ['a remote host over HTTP', 'http://example.com/'],
    ['a remote WebSocket', 'wss://example.com/socket'],
    ['HTTPS to localhost, which the CSP leaves out', 'https://localhost:8443/'],
    ["another plugin's files", 'glade-plugin://other/index.html'],
    ['a file', 'file:///etc/passwd'],
    ["Glade's own page", 'file:///Applications/Glade.app/Contents/Resources/app.asar/out/renderer/index.html'],
    ['a host that only starts with localhost', 'http://localhost.example.com/'],
    ['a host that only ends with it', 'http://evil-localhost/'],
    ['localhost with a trailing dot', 'http://localhost./'],
    ['a host that starts with 127.0.0.1', 'http://127.0.0.1.nip.io/'],
    ['IPv6 loopback, which the CSP leaves out', 'http://[::1]:8000/'],
    ['another address on this machine', 'http://192.168.1.20:8000/'],
    ['FTP', 'ftp://localhost/'],
    ['devtools', 'devtools://devtools/bundled/inspector.html'],
    ['chrome', 'chrome://gpu'],
    ['not a URL', 'not a url'],
    ['nothing', ''],
  ])('cancels %s', (_name, url) => {
    expect(isAllowedPluginRequest(url, 'pomodoro')).toBe(false)
  })

  it('lets credentials in a localhost URL through only as far as localhost', () => {
    expect(isAllowedPluginRequest('http://user:pass@localhost:8000/', 'pomodoro')).toBe(true)
    expect(isAllowedPluginRequest('http://localhost:8000@example.com/', 'pomodoro')).toBe(false)
  })
})
