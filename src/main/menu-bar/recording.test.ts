import { describe, expect, it, vi } from 'vitest'
import { Glyph, MenuBarAppearance } from './glyph'
import type { MenuBar } from './menu-bar'
import { createRecordingTray, e2eMenuBar, RECORDED_TRAY_BOUNDS, type RecordedAppearance } from './recording'

describe('createRecordingTray', () => {
  it('has no icon until one is made, and none to click', () => {
    const recording = createRecordingTray()
    expect(recording.shown).toBe(false)
    expect(recording.title).toBe('')
    expect(recording.glyph).toBe(Glyph.Plain)
    expect(() => {
      recording.click()
    }).toThrow('There is no menu bar icon to click')
  })

  it('records what the icon shows, clicks it, and says where it is', () => {
    const recording = createRecordingTray()
    const onClick = vi.fn()
    const icon = recording.createTray({ onClick })
    expect(recording.shown).toBe(true)
    expect(recording.glyph).toBe(Glyph.Plain)
    icon.setTitle('2')
    icon.setGlyph(Glyph.DotOnLight)
    expect([recording.title, recording.glyph]).toEqual(['2', Glyph.DotOnLight])
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
  it('reads the icon and the menu bar as they are, clicks the icon, and tells the menu bar when the appearance switches', () => {
    const recording = createRecordingTray()
    const onClick = vi.fn()
    const icon = recording.createTray({ onClick })
    icon.setTitle('3')
    icon.setGlyph(Glyph.DotOnDark)
    const appearanceChanged = vi.fn()
    const menuBar = { open: false, appearanceChanged } as unknown as MenuBar
    const recorded: RecordedAppearance = { appearance: MenuBarAppearance.Dark }
    const seen = e2eMenuBar(menuBar, recording, recorded)

    expect([seen.shown, seen.title, seen.glyph, seen.open, seen.appearance]).toEqual([
      true,
      '3',
      Glyph.DotOnDark,
      false,
      MenuBarAppearance.Dark,
    ])
    seen.click()
    expect(onClick).toHaveBeenCalledOnce()
    seen.appearance = MenuBarAppearance.Light
    expect(recorded.appearance).toBe(MenuBarAppearance.Light)
    expect(seen.appearance).toBe(MenuBarAppearance.Light)
    expect(appearanceChanged).toHaveBeenCalledOnce()
  })
})
