import { describe, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { createMemoryLog } from '../logging/memory-sink'
import { createFakeHtmlPreviewViews } from './fake-html-preview-view'
import { createHtmlPreviewViews } from './html-preview'

const BOUNDS = { x: 0, y: 0, width: 300, height: 200 }

describe('createHtmlPreviewViews', () => {
  it('does nothing with no createView: no view, nothing to hide, nothing to reload', () => {
    const emit = vi.fn()
    const views = createHtmlPreviewViews({ emit })

    expect(() => {
      views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)
      views.hide('t1', 'index.html')
      views.reload('t1', 'index.html')
      views.close()
    }).not.toThrow()
    expect(emit).not.toHaveBeenCalled()
  })

  it('makes the view the first time, places it, and reuses it for the same file', () => {
    const emit = vi.fn()
    const fake = createFakeHtmlPreviewViews()
    const views = createHtmlPreviewViews({ emit, createView: fake.create })

    views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)
    expect(fake.views).toHaveLength(1)
    expect(fake.last().spec).toMatchObject({ folder: '/root', fileName: 'index.html' })
    expect(fake.last().bounds).toEqual(BOUNDS)

    views.place('t1', 'index.html', '/root', 'index.html', { ...BOUNDS, width: 400 })
    expect(fake.views).toHaveLength(1)
    expect(fake.last().bounds).toEqual({ ...BOUNDS, width: 400 })
  })

  it('destroys the last view and makes a fresh one when a different file is shown', () => {
    const fake = createFakeHtmlPreviewViews()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)
    const first = fake.last()

    views.place('t1', 'other.html', '/root', 'other.html', BOUNDS)

    expect(first.destroyed).toBe(true)
    expect(fake.views).toHaveLength(2)
    expect(fake.last().destroyed).toBe(false)
  })

  it('hides the shown file’s view, keeping its page, and ignores a hide for a file that isn’t shown', () => {
    const fake = createFakeHtmlPreviewViews()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)

    views.hide('t1', 'other.html')
    expect(fake.last().bounds).toEqual(BOUNDS)
    expect(fake.last().destroyed).toBe(false)

    views.hide('t1', 'index.html')
    expect(fake.last().bounds).toBeNull()
    expect(fake.last().destroyed).toBe(false)
  })

  it('reloads only the shown file’s view, clearing its blocked notice so it can recur', () => {
    const emit = vi.fn()
    const fake = createFakeHtmlPreviewViews()
    const views = createHtmlPreviewViews({ emit, createView: fake.create })
    views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)

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

  it('destroys the view and tells nothing further once its page is gone', () => {
    const fake = createFakeHtmlPreviewViews()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)

    fake.last().crash()

    expect(fake.last().destroyed).toBe(true)
    views.hide('t1', 'index.html')
    expect(fake.last().bounds).toBeNull()
  })

  it('answers null from create when it’s refused (unsafe settings, or no window): nothing is placed', () => {
    const fake = createFakeHtmlPreviewViews()
    fake.refuseNext()
    const log = createMemoryLog()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create, log: log.logger })

    views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)

    expect(fake.views).toHaveLength(0)
  })

  it('destroys the shown view when the app quits', () => {
    const fake = createFakeHtmlPreviewViews()
    const views = createHtmlPreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', 'index.html', '/root', 'index.html', BOUNDS)

    views.close()

    expect(fake.last().destroyed).toBe(true)
    // Closing again, with nothing shown, does nothing more.
    views.close()
  })
})
