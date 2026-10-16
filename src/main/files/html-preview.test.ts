import { describe, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { createMemoryLog } from '../logging/memory-sink'
import { createFakeHtmlPreviewViews } from './fake-html-preview-view'
import { createHtmlPreviewViews, type HtmlPreviewFile } from './html-preview'

const BOUNDS = { x: 0, y: 0, width: 300, height: 200 }

/** A resolver whose every call is a deferred a test answers in order, recording what was asked. */
function deferredResolver(): {
  resolveFile: (taskId: string, path: string) => Promise<HtmlPreviewFile | null>
  calls: { taskId: string; path: string }[]
  answer: (index: number, file: HtmlPreviewFile | null) => void
  fail: (index: number, error: unknown) => void
} {
  const calls: { taskId: string; path: string }[] = []
  const pending: ((file: HtmlPreviewFile | null, error?: unknown) => void)[] = []
  return {
    calls,
    resolveFile: (taskId, path) =>
      new Promise<HtmlPreviewFile | null>((resolve, reject) => {
        calls.push({ taskId, path })
        pending.push((file, error) => {
          if (error === undefined) resolve(file)
          else reject(error instanceof Error ? error : new Error('the file failed to resolve'))
        })
      }),
    answer: (index, file) => pending[index]?.(file),
    fail: (index, error) => pending[index]?.(null, error),
  }
}

/** A resolver that answers at once with the file at `/root`, recording its calls. */
function settledResolver(): {
  resolveFile: (taskId: string, path: string) => Promise<HtmlPreviewFile | null>
  calls: { taskId: string; path: string }[]
} {
  const calls: { taskId: string; path: string }[] = []
  return {
    calls,
    resolveFile: (taskId, path) => {
      calls.push({ taskId, path })
      return Promise.resolve({ folder: '/root', fileName: path.split('/').at(-1) ?? path })
    },
  }
}

describe('createHtmlPreviewViews', () => {
  it('does nothing with no createView: no view, nothing to hide, nothing to reload', async () => {
    const emit = vi.fn()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({ emit, resolveFile: resolver.resolveFile })

    expect(() => {
      views.place('t1', 'index.html', BOUNDS)
      views.hide('t1', 'index.html')
      views.reload('t1', 'index.html')
      views.close()
    }).not.toThrow()
    // The hide gave the open up before the file ever resolved, so nothing was asked of the resolver.
    await new Promise<void>((done) => setTimeout(done, 10))
    expect(resolver.calls).toHaveLength(0)
    expect(emit).not.toHaveBeenCalled()
  })

  it('makes the view the first time, places it, and reuses it for the same file without resolving again', async () => {
    const emit = vi.fn()
    const fake = createFakeHtmlPreviewViews()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({ emit, createView: fake.create, resolveFile: resolver.resolveFile })

    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })
    expect(fake.last().spec).toMatchObject({ folder: '/root', fileName: 'index.html' })
    expect(fake.last().bounds).toEqual(BOUNDS)
    expect(resolver.calls).toEqual([{ taskId: 't1', path: 'index.html' }])

    // The file's view is showing: the new bounds go straight through, and the file resolves no second time.
    views.place('t1', 'index.html', { ...BOUNDS, width: 400 })
    expect(fake.views).toHaveLength(1)
    expect(fake.last().bounds).toEqual({ ...BOUNDS, width: 400 })
    expect(resolver.calls).toHaveLength(1)
  })

  it('destroys the last view and makes a fresh one when a different file is shown', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })
    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })
    const first = fake.last()

    views.place('t1', 'other.html', BOUNDS)
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(2)
    })

    expect(first.destroyed).toBe(true)
    expect(fake.last().destroyed).toBe(false)
    expect(fake.last().spec).toMatchObject({ fileName: 'other.html' })
  })

  it('hides the shown file’s view, keeping its page, and ignores a hide for a file that isn’t shown', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })
    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })

    views.hide('t1', 'other.html')
    expect(fake.last().bounds).toEqual(BOUNDS)
    expect(fake.last().destroyed).toBe(false)

    views.hide('t1', 'index.html')
    expect(fake.last().bounds).toBeNull()
    expect(fake.last().destroyed).toBe(false)
  })

  it('reloads only the shown file’s view, clearing its blocked notice so it can recur', async () => {
    const emit = vi.fn()
    const fake = createFakeHtmlPreviewViews()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({ emit, createView: fake.create, resolveFile: resolver.resolveFile })
    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })

    views.reload('t1', 'other.html')
    expect(fake.last().reloaded).toBe(0)

    views.reload('t1', 'index.html')
    expect(fake.last().reloaded).toBe(1)

    // Blocked once, reloaded, blocked again: a second notice goes out, since the reload cleared the first.
    fake.last().block()
    expect(emit).toHaveBeenCalledWith({ type: EventType.HtmlPreviewBlocked, taskId: 't1', path: 'index.html' })
    emit.mockClear()
    fake.last().block()
    expect(emit).not.toHaveBeenCalled()
    views.reload('t1', 'index.html')
    fake.last().block()
    expect(emit).toHaveBeenCalledOnce()
  })

  it('destroys the view and tells nothing further once its page is gone', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })
    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })

    fake.last().crash()

    expect(fake.last().destroyed).toBe(true)
    views.hide('t1', 'index.html')
    expect(fake.last().bounds).toBeNull()
  })

  it('answers null from create when it’s refused (unsafe settings, or no window): nothing is placed', async () => {
    const fake = createFakeHtmlPreviewViews()
    fake.refuseNext()
    const log = createMemoryLog()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({
      emit: vi.fn(),
      createView: fake.create,
      resolveFile: resolver.resolveFile,
      log: log.logger,
    })

    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(1)
    })

    expect(fake.views).toHaveLength(0)
  })

  it('destroys the shown view when the app quits', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = settledResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })
    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })

    views.close()

    expect(fake.last().destroyed).toBe(true)
    // Closing again, with nothing shown, does nothing more.
    views.close()
  })

  it('acts on the newest bounds of a file asked for twice before its view opened, so nothing stale shows (#656)', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = deferredResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })

    // A burst of resizes while the file's view opens: the ask that opened acts on the newest bounds, and the file
    // resolves for it once — the older ask is never resolved at all.
    views.place('t1', 'index.html', BOUNDS)
    views.place('t1', 'index.html', { ...BOUNDS, width: 400 })
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(1)
    })
    resolver.answer(0, { folder: '/root', fileName: 'index.html' })
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })

    expect(fake.views).toHaveLength(1)
    expect(fake.last().bounds).toEqual({ ...BOUNDS, width: 400 })
    expect(resolver.calls).toHaveLength(1)
  })

  it('opens the newer of two files asked for together, and never the older', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = deferredResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })

    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(1)
    })
    // While `index.html` resolves, another file is asked for: the resolve comes back to nothing, and the newer
    // ask opens in its own turn.
    views.place('t1', 'other.html', BOUNDS)
    resolver.answer(0, { folder: '/root', fileName: 'index.html' })
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(2)
    })
    expect(fake.views).toHaveLength(0)
    resolver.answer(1, { folder: '/root', fileName: 'other.html' })
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })

    expect(fake.views).toHaveLength(1)
    expect(fake.last().spec).toMatchObject({ fileName: 'other.html' })
    expect(fake.last().destroyed).toBe(false)
  })

  it('gives up an open the slot hid before its file resolved, and shows nothing', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = deferredResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })

    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(1)
    })
    views.hide('t1', 'index.html')
    resolver.answer(0, { folder: '/root', fileName: 'index.html' })
    await new Promise<void>((done) => setTimeout(done, 10))

    expect(fake.views).toHaveLength(0)
  })

  it('opens nothing for a file that isn’t there, and the next ask still opens', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = deferredResolver()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, resolveFile: resolver.resolveFile })

    views.place('t1', 'gone.html', BOUNDS)
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(1)
    })
    resolver.answer(0, null)
    await new Promise<void>((done) => setTimeout(done, 10))
    expect(fake.views).toHaveLength(0)

    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(2)
    })
    resolver.answer(1, { folder: '/root', fileName: 'index.html' })
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })
    expect(fake.last().spec).toMatchObject({ fileName: 'index.html' })
  })

  it('keeps working when the file’s resolution fails, and logs it', async () => {
    const fake = createFakeHtmlPreviewViews()
    const resolver = deferredResolver()
    const log = createMemoryLog()
    const views = createHtmlPreviewViews({
      emit: vi.fn(),
      createView: fake.create,
      resolveFile: resolver.resolveFile,
      log: log.logger,
    })

    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(1)
    })
    resolver.fail(0, new Error('outside workspace'))
    await new Promise<void>((done) => setTimeout(done, 10))
    expect(fake.views).toHaveLength(0)
    expect(log.withMessage("html preview's file didn't resolve")).toHaveLength(1)

    views.place('t1', 'index.html', BOUNDS)
    await vi.waitFor(() => {
      expect(resolver.calls).toHaveLength(2)
    })
    resolver.answer(1, { folder: '/root', fileName: 'index.html' })
    await vi.waitFor(() => {
      expect(fake.views).toHaveLength(1)
    })
  })
})
