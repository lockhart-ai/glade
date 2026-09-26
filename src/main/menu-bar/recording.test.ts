import { describe, expect, it, vi } from 'vitest'
import type { MenuBar } from './menu-bar'
import { createRecordingTray, e2eMenuBar, RECORDED_TRAY_BOUNDS } from './recording'
import { RESTING_FRAME } from './pulse'

describe('createRecordingTray', () => {
  it('has no icon until one is made, and none to click', () => {
    const recording = createRecordingTray()
    expect(recording.shown).toBe(false)
    expect(recording.title).toBe('')
    expect(recording.frame).toBe(RESTING_FRAME)
    expect(() => {
      recording.click()
    }).toThrow('There is no menu bar icon to click')
  })

  it('records what the icon shows, clicks it, and says where it is', () => {
    const recording = createRecordingTray()
    const onClick = vi.fn()
    const icon = recording.createTray({ onClick })
    expect(recording.shown).toBe(true)
    icon.setTitle('2')
    icon.setFrame(2)
    expect([recording.title, recording.frame]).toEqual(['2', 2])
    expect(icon.bounds()).toEqual(RECORDED_TRAY_BOUNDS)
    recording.click()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('forgets the icon when it goes, but not a newer one when an older one goes', () => {
    const recording = createRecordingTray()
    const first = recording.createTray({ onClick: vi.fn() })
    first.destroy()
    expect(recording.shown).toBe(false)

    const second = recording.createTray({ onClick: vi.fn() })
    second.setTitle('1')
    first.destroy()
    expect(recording.shown).toBe(true)
    expect(recording.title).toBe('1')
  })
})

describe('e2eMenuBar', () => {
  it('reads the icon and the menu bar as they are, clicks the icon, and tells the menu bar when Reduce motion changes', () => {
    const recording = createRecordingTray()
    const onClick = vi.fn()
    recording.createTray({ onClick }).setTitle('3')
    const motionChanged = vi.fn()
    const menuBar = { pulsing: true, open: false, motionChanged } as unknown as MenuBar
    const motion = { reduceMotion: false }
    const seen = e2eMenuBar(menuBar, recording, motion)

    expect([seen.shown, seen.title, seen.pulsing, seen.open, seen.reduceMotion]).toEqual([
      true,
      '3',
      true,
      false,
      false,
    ])
    seen.click()
    expect(onClick).toHaveBeenCalledOnce()
    seen.reduceMotion = true
    expect(motion.reduceMotion).toBe(true)
    expect(seen.reduceMotion).toBe(true)
    expect(motionChanged).toHaveBeenCalledOnce()
  })
})
