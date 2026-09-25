import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import playwrightConfig from '../../playwright.config'
import { ensureTestBuild, TEST_BUILD_INPUTS, TestBuildError, testBuildIsStale, type TestBuild } from './test-build.mjs'

const REPO = resolve(__dirname, '..', '..')

/** A time `seconds` after the epoch, as a date for `utimesSync`. */
function at(seconds: number): Date {
  return new Date(seconds * 1000)
}

/** Writes a file (and its folders) and sets its modification time. */
function touch(path: string, seconds: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
  utimesSync(path, at(seconds), at(seconds))
}

describe('the test build', () => {
  let root: string
  let main: string
  let build: ReturnType<typeof vi.fn<() => boolean>>
  let testBuild: TestBuild

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'glade-test-build-'))
    main = join(root, 'out', 'testing', 'main', 'index.js')
    // A source tree: a file in a nested folder, and a config file, all from t=100.
    touch(join(root, 'src', 'main', 'app.ts'), 100)
    utimesSync(join(root, 'src', 'main'), at(100), at(100))
    utimesSync(join(root, 'src'), at(100), at(100))
    touch(join(root, 'package.json'), 100)
    build = vi.fn(() => {
      touch(main, 200)
      return true
    })
    testBuild = { root, inputs: ['src', 'package.json'], main, build }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is stale when it was never built, and is built then', () => {
    expect(testBuildIsStale(testBuild)).toBe(true)
    expect(ensureTestBuild(testBuild)).toBe(true)
    expect(build).toHaveBeenCalledOnce()
    expect(existsSync(main)).toBe(true)
  })

  it('is left alone when nothing it is made from changed since', () => {
    touch(main, 200)
    expect(testBuildIsStale(testBuild)).toBe(false)
    expect(ensureTestBuild(testBuild)).toBe(false)
    expect(build).not.toHaveBeenCalled()
  })

  it('is rebuilt when a file deep in a source folder changed after it', () => {
    touch(main, 200)
    utimesSync(join(root, 'src', 'main', 'app.ts'), at(300), at(300))
    expect(testBuildIsStale(testBuild)).toBe(true)
    expect(ensureTestBuild(testBuild)).toBe(true)
    expect(build).toHaveBeenCalledOnce()
  })

  it('is rebuilt when a single-file input changed after it', () => {
    touch(main, 200)
    utimesSync(join(root, 'package.json'), at(300), at(300))
    expect(ensureTestBuild(testBuild)).toBe(true)
  })

  it('fails rather than letting a spec launch an app that failed to build', () => {
    build.mockReturnValue(false)
    expect(() => ensureTestBuild(testBuild)).toThrow(new TestBuildError('the test build failed'))
  })

  it('fails when the build says it worked but made no main script', () => {
    build.mockReturnValue(true)
    expect(() => ensureTestBuild(testBuild)).toThrow(TestBuildError)
    expect(() => ensureTestBuild(testBuild)).toThrow(`made no ${main}`)
  })

  it("is made from the repo's sources and build config, which all exist", () => {
    for (const input of TEST_BUILD_INPUTS) expect(existsSync(join(REPO, input))).toBe(true)
  })
})

describe('the e2e specs', () => {
  // A bare `npx playwright test` skipped the build scripts/e2e.mjs does, and Electron, launched on a missing
  // out/testing, opened no window: every spec waited out its 60s timeout (#216). The global setup builds it first.
  it('bring the test build up to date before any spec runs, however Playwright is started', () => {
    expect(playwrightConfig.globalSetup).toBe('./scripts/e2e-setup.mjs')
    expect(existsSync(join(REPO, 'scripts', 'e2e-setup.mjs'))).toBe(true)
  })
})
