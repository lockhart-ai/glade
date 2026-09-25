import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { findPlugins } from './discovery'
import { tempPluginsParent, writePlugin } from './test-plugins'

// A plugin removed while Glade reads it: its manifest vanishes with its folder between finding and reading it. The
// real file system can't be timed that closely, so reading a manifest removes the plugin's folder first.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: vi.fn((path: string, options?: BufferEncoding) => {
      if (path.endsWith('manifest.json') && path.includes('vanishing')) {
        rmSync(join(path, '..'), { recursive: true, force: true })
      }
      return options === undefined ? fs.readFile(path) : fs.readFile(path, options)
    }),
  }
})

let parent: string

beforeEach(() => {
  parent = tempPluginsParent()
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

it('leaves out a plugin removed while it was being read, and finds the rest', async () => {
  const plugins = join(parent, 'plugins')
  writePlugin(plugins, 'vanishing')
  writePlugin(plugins, 'pomodoro')

  expect((await findPlugins(plugins)).map(({ folder }) => folder)).toEqual(['pomodoro'])
})
