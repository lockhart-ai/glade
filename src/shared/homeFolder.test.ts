import { afterEach, describe, expect, it } from 'vitest'
import { homeArgument, homeFromArguments, SAMPLE_HOME, setHomeFolder, shortenHomePath } from './homeFolder'

afterEach(() => {
  setHomeFolder(null)
})

describe('shortenHomePath', () => {
  it('shortens the home folder, and a path in it, to start with ~', () => {
    setHomeFolder('/Users/me')

    expect(shortenHomePath('/Users/me')).toBe('~')
    expect(shortenHomePath('/Users/me/code/api')).toBe('~/code/api')
    expect(shortenHomePath('/Users/me/.gitconfig')).toBe('~/.gitconfig')
  })

  it('leaves another user’s folder as it is: it is not yours', () => {
    setHomeFolder('/Users/me')

    // Before #510's review, any `/Users/<name>` showed as `~`: a card for another user's folder named yours.
    expect(shortenHomePath('/Users/someone/Documents')).toBe('/Users/someone/Documents')
    expect(shortenHomePath('/Users/someone')).toBe('/Users/someone')
    // A folder whose name only starts like the home folder's isn't in it.
    expect(shortenHomePath('/Users/meg/code')).toBe('/Users/meg/code')
    expect(shortenHomePath('/Users/Shared/acme-shared')).toBe('/Users/Shared/acme-shared')
    expect(shortenHomePath('/Users')).toBe('/Users')
    expect(shortenHomePath('/tmp/Users/me')).toBe('/tmp/Users/me')
    expect(shortenHomePath('/Volumes/Users/me/api')).toBe('/Volumes/Users/me/api')
  })

  it('shortens nothing until it’s told the home folder, or when there’s none to tell', () => {
    expect(shortenHomePath('/Users/me/code/api')).toBe('/Users/me/code/api')

    for (const none of [null, '', '/']) {
      setHomeFolder(none)
      expect(shortenHomePath('/Users/me/code/api')).toBe('/Users/me/code/api')
      expect(shortenHomePath('/')).toBe('/')
    }
  })

  it('takes a home folder written with a trailing slash, or anywhere on the disk', () => {
    setHomeFolder('/Users/me/')
    expect(shortenHomePath('/Users/me/code')).toBe('~/code')

    setHomeFolder('/home/sam')
    expect(shortenHomePath('/home/sam/code')).toBe('~/code')
    expect(shortenHomePath('/Users/me/code')).toBe('/Users/me/code')
  })
})

describe('the argument that names the home folder to a window', () => {
  it('is read back from the window’s arguments, whatever comes with it', () => {
    const argument = homeArgument('/Users/me/My Folder')

    expect(argument).toBe('--glade-home=/Users/me/My Folder')
    expect(homeFromArguments(['/Applications/Glade.app', '--type=renderer', argument, '--lang=en'])).toBe(
      '/Users/me/My Folder',
    )
    expect(homeFromArguments([homeArgument(SAMPLE_HOME)])).toBe('/Users/sample')
  })

  it('is null when the window wasn’t told', () => {
    expect(homeFromArguments([])).toBeNull()
    expect(homeFromArguments(['--type=renderer', '--glade-homestead=/x'])).toBeNull()
  })
})
