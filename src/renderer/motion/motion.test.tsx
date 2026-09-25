import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMoving, motionDuration, MotionPhase, MOTION_DURATION_PROPERTY, parseDuration, usePresence } from './motion'
import { panelMotionAttributes, panelMotionClass } from './panelMotion'
import styles from './PanelMotion.module.css'

/** Sets the motion token, as tokens.css does (200ms) or as Reduce motion does (0ms). */
function setDuration(value: string): void {
  document.documentElement.style.setProperty(MOTION_DURATION_PROPERTY, value)
}

afterEach(() => {
  document.documentElement.style.removeProperty(MOTION_DURATION_PROPERTY)
  vi.useRealTimers()
})

describe('parseDuration', () => {
  it('reads milliseconds and seconds', () => {
    expect(parseDuration('200ms')).toBe(200)
    expect(parseDuration(' 0.2s ')).toBe(200)
    expect(parseDuration('.5s')).toBe(500)
    expect(parseDuration('0ms')).toBe(0)
  })

  it('takes anything else as no time at all', () => {
    expect(parseDuration('')).toBe(0)
    expect(parseDuration('fast')).toBe(0)
    expect(parseDuration('200')).toBe(0)
    expect(parseDuration('-200ms')).toBe(0)
  })
})

describe('motionDuration', () => {
  it('is the --motion-duration token', () => {
    setDuration('200ms')
    expect(motionDuration()).toBe(200)
  })

  it('is 0 with Reduce motion on, or with no stylesheet', () => {
    expect(motionDuration()).toBe(0)
    setDuration('0ms')
    expect(motionDuration()).toBe(0)
  })
})

describe('isMoving', () => {
  it('is true only on the way in or out', () => {
    expect(isMoving(MotionPhase.Entering)).toBe(true)
    expect(isMoving(MotionPhase.Leaving)).toBe(true)
    expect(isMoving(MotionPhase.Shown)).toBe(false)
    expect(isMoving(MotionPhase.Hidden)).toBe(false)
  })
})

describe('usePresence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('shows or hides what is there from the start without moving', () => {
    setDuration('200ms')
    expect(renderHook(() => usePresence(true)).result.current).toEqual({ mounted: true, phase: MotionPhase.Shown })
    expect(renderHook(() => usePresence(false)).result.current).toEqual({ mounted: false, phase: MotionPhase.Hidden })
  })

  it('stays mounted while it leaves, for the motion duration, then goes', () => {
    setDuration('200ms')
    const { result, rerender } = renderHook(({ shown }) => usePresence(shown), { initialProps: { shown: true } })

    rerender({ shown: false })
    expect(result.current).toEqual({ mounted: true, phase: MotionPhase.Leaving })
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(result.current.phase).toBe(MotionPhase.Leaving)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toEqual({ mounted: false, phase: MotionPhase.Hidden })
  })

  it('enters for the motion duration, then is still', () => {
    setDuration('200ms')
    const { result, rerender } = renderHook(({ shown }) => usePresence(shown), { initialProps: { shown: false } })

    rerender({ shown: true })
    expect(result.current).toEqual({ mounted: true, phase: MotionPhase.Entering })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toEqual({ mounted: true, phase: MotionPhase.Shown })
  })

  it('turns back if shown again on its way out, and never goes', () => {
    setDuration('200ms')
    const { result, rerender } = renderHook(({ shown }) => usePresence(shown), { initialProps: { shown: true } })

    rerender({ shown: false })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ shown: true })
    expect(result.current.phase).toBe(MotionPhase.Entering)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    // The leaving timer was cancelled: it's still in, not gone.
    expect(result.current).toEqual({ mounted: true, phase: MotionPhase.Entering })
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(result.current).toEqual({ mounted: true, phase: MotionPhase.Shown })
  })

  it('shows and hides at once with Reduce motion on', () => {
    setDuration('0ms')
    const { result, rerender } = renderHook(({ shown }) => usePresence(shown), { initialProps: { shown: true } })

    rerender({ shown: false })
    expect(result.current).toEqual({ mounted: false, phase: MotionPhase.Hidden })
    rerender({ shown: true })
    expect(result.current).toEqual({ mounted: true, phase: MotionPhase.Shown })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('panel motion', () => {
  it('slides a panel open or shut only while it moves', () => {
    expect(panelMotionClass(MotionPhase.Entering)).toBe(styles.entering)
    expect(panelMotionClass(MotionPhase.Leaving)).toBe(styles.leaving)
    expect(panelMotionClass(MotionPhase.Shown)).toBeUndefined()
    expect(panelMotionClass(MotionPhase.Hidden)).toBeUndefined()
  })

  it('marks a moving panel with its phase, and makes a leaving one inert', () => {
    expect(panelMotionAttributes(MotionPhase.Entering)).toEqual({ 'data-motion': 'entering' })
    expect(panelMotionAttributes(MotionPhase.Leaving)).toEqual({ 'data-motion': 'leaving', inert: true })
    expect(panelMotionAttributes(MotionPhase.Shown)).toEqual({})
    expect(panelMotionAttributes(MotionPhase.Hidden)).toEqual({})
  })
})
