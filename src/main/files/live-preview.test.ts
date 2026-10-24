import { describe, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { createMemoryLog } from '../logging/memory-sink'
import { createFakeLivePreviewViews } from './fake-live-preview-view'
import { createLivePreviewViews } from './live-preview'

const BOUNDS = { x: 0, y: 0, width: 300, height: 200 }
const URL = 'http://localhost:3000/'

describe('createLivePreviewViews', () => {
  it('does nothing with no createView: no view, nothing to hide, nothing to reload', () => {
    const emit = vi.fn()
    const views = createLivePreviewViews({ emit })

    expect(() => {
      views.place('t1', URL, BOUNDS)
      views.hide('t1', URL)
      views.reload('t1', URL)
      views.close()
    }).not.toThrow()
    expect(emit).not.toHaveBeenCalled()
  })

  it('makes the view the first time, places it, and reuses it for the same URL', () => {
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit: vi.fn(), createView: fake.create })

    views.place('t1', URL, BOUNDS)
    expect(fake.views).toHaveLength(1)
    expect(fake.last().spec).toMatchObject({ url: URL })
    expect(fake.last().bounds).toEqual(BOUNDS)

    // That URL's view is showing: the new bounds go straight through, and no second view is made.
    views.place('t1', URL, { ...BOUNDS, width: 400 })
    expect(fake.views).toHaveLength(1)
    expect(fake.last().bounds).toEqual({ ...BOUNDS, width: 400 })
  })

  it('destroys the last view and makes a fresh one when a different URL is shown', () => {
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', URL, BOUNDS)
    const first = fake.last()

    views.place('t1', 'http://localhost:4000/', BOUNDS)

    expect(fake.views).toHaveLength(2)
    expect(first.destroyed).toBe(true)
    expect(fake.last().destroyed).toBe(false)
    expect(fake.last().spec).toMatchObject({ url: 'http://localhost:4000/' })
  })

  it('hides the shown URL’s view, keeping its page, and ignores a hide for a URL that isn’t shown', () => {
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', URL, BOUNDS)

    views.hide('t1', 'http://localhost:4000/')
    expect(fake.last().bounds).toEqual(BOUNDS)
    expect(fake.last().destroyed).toBe(false)

    views.hide('t1', URL)
    expect(fake.last().bounds).toBeNull()
    expect(fake.last().destroyed).toBe(false)
  })

  it('reports a blocked request, once per load, naming the host it refused', () => {
    const emit = vi.fn()
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit, createView: fake.create })
    views.place('t1', URL, BOUNDS)

    fake.last().block('fonts.googleapis.com')
    expect(emit).toHaveBeenCalledWith({
      type: EventType.LivePreviewBlocked,
      taskId: 't1',
      path: URL,
      host: 'fonts.googleapis.com',
    })
    emit.mockClear()
    fake.last().block('fonts.googleapis.com')
    expect(emit).not.toHaveBeenCalled()
  })

  it('reloads only the shown URL’s view, clearing its blocked notice so it can recur', () => {
    const emit = vi.fn()
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit, createView: fake.create })
    views.place('t1', URL, BOUNDS)

    views.reload('t1', 'http://localhost:4000/')
    expect(fake.last().reloaded).toBe(0)

    views.reload('t1', URL)
    expect(fake.last().reloaded).toBe(1)

    // Blocked once, reloaded, blocked again: a second notice goes out, since the reload cleared the first.
    fake.last().block('a.example')
    expect(emit).toHaveBeenCalledWith({
      type: EventType.LivePreviewBlocked,
      taskId: 't1',
      path: URL,
      host: 'a.example',
    })
    emit.mockClear()
    fake.last().block('a.example')
    expect(emit).not.toHaveBeenCalled()
    views.reload('t1', URL)
    fake.last().block('a.example')
    expect(emit).toHaveBeenCalledOnce()
  })

  it('reports the connection going up and down, only for the shown view', () => {
    const emit = vi.fn()
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit, createView: fake.create })
    views.place('t1', URL, BOUNDS)

    fake.last().connect(true)
    expect(emit).toHaveBeenCalledWith({
      type: EventType.LivePreviewConnectionChanged,
      taskId: 't1',
      path: URL,
      connected: true,
    })

    fake.last().connect(false)
    expect(emit).toHaveBeenCalledWith({
      type: EventType.LivePreviewConnectionChanged,
      taskId: 't1',
      path: URL,
      connected: false,
    })
  })

  it('tells nothing further once its page is gone, even if the old view still fires', () => {
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', URL, BOUNDS)
    const first = fake.last()

    first.crash()
    expect(first.destroyed).toBe(true)
    views.hide('t1', URL)
    expect(first.bounds).toBeNull()

    // A connection event from the view that's gone (a late async callback) is dropped, not misattributed.
    const emit = vi.fn()
    const views2 = createLivePreviewViews({ emit, createView: fake.create })
    views2.place('t2', URL, BOUNDS)
    const second = fake.last()
    views2.place('t2', 'http://localhost:4000/', BOUNDS)
    second.connect(true)
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: EventType.LivePreviewConnectionChanged }))
  })

  it('answers null from create when it’s refused (unsafe settings, or no window): nothing is placed', () => {
    const fake = createFakeLivePreviewViews()
    fake.refuseNext()
    const log = createMemoryLog()
    const views = createLivePreviewViews({ emit: vi.fn(), createView: fake.create, log: log.logger })

    views.place('t1', URL, BOUNDS)

    expect(fake.views).toHaveLength(0)
  })

  it('destroys the shown view when the app quits', () => {
    const fake = createFakeLivePreviewViews()
    const views = createLivePreviewViews({ emit: vi.fn(), createView: fake.create })
    views.place('t1', URL, BOUNDS)

    views.close()

    expect(fake.last().destroyed).toBe(true)
    // Closing again, with nothing shown, does nothing more.
    views.close()
  })
})
