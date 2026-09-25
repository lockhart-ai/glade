import { describe, expect, it } from 'vitest'
import { loginShell, shellEnv, shellName, testShell } from './shell'

describe('shellEnv', () => {
  it('passes the app’s environment on, less Electron’s and Glade’s own, naming the terminal', () => {
    const env = shellEnv({
      PATH: '/usr/bin',
      LANG: 'en_GB.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
      GLADE_E2E: '{}',
      UNSET: undefined,
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_GB.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Glade',
    })
  })

  it('gives a UTF-8 locale when there is none, and adds what it’s asked to', () => {
    expect(shellEnv({}, { PS1: '$ ' })).toMatchObject({ LANG: 'en_US.UTF-8', PS1: '$ ' })
  })
})

describe('loginShell', () => {
  it('is $SHELL as a login shell', () => {
    const shell = loginShell({ SHELL: '/opt/homebrew/bin/fish' })
    expect(shell).toMatchObject({ file: '/opt/homebrew/bin/fish', args: ['-l'] })
    expect(shellName(shell)).toBe('fish')
  })

  it('is zsh, macOS’s default, when $SHELL isn’t set', () => {
    expect(loginShell({}).file).toBe('/bin/zsh')
    expect(loginShell({ SHELL: '' }).file).toBe('/bin/zsh')
  })
})

describe('testShell', () => {
  it('is bash with no profile, and a prompt of the folder’s name', () => {
    const shell = testShell({ HOME: '/Users/sample' })
    expect(shell).toMatchObject({ file: '/bin/bash', args: ['--noprofile', '--norc'] })
    expect(shell.env).toMatchObject({ PS1: '\\W $ ', HOME: '/Users/sample' })
    expect(shellName(shell)).toBe('bash')
  })
})
