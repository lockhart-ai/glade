import { describe, expect, it } from 'vitest'
import type { WebContentsView } from 'electron'
import { setViewRadius, viewRadius } from './native-view-radius'

function fakeView(): WebContentsView {
  return {} as WebContentsView
}

describe('native view radius', () => {
  it('answers the fallback for a view never tagged', () => {
    expect(viewRadius(fakeView(), 15)).toBe(15)
  })

  it('answers the radius a view was tagged with, not the fallback', () => {
    const view = fakeView()
    setViewRadius(view, 0)
    expect(viewRadius(view, 15)).toBe(0)
    expect(viewRadius(fakeView(), 15)).toBe(15)
  })
})
