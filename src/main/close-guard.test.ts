import { describe, expect, it } from 'vitest'
import { CloseKind, EventType, type CloseBlockedEvent } from '../shared/bridge'
import { CloseGuard } from './close-guard'

function guard(): { guard: CloseGuard; told: CloseBlockedEvent[] } {
  const told: CloseBlockedEvent[] = []
  return { guard: new CloseGuard((event) => told.push(event)), told }
}

describe('CloseGuard', () => {
  it('lets the window close, and the app quit, while nothing is unsaved', () => {
    const { guard: closing, told } = guard()

    expect(closing.callsOff(CloseKind.Window)).toBe(false)
    expect(closing.callsOff(CloseKind.Quit)).toBe(false)
    expect(told).toEqual([])
  })

  it('calls off closing and quitting while the window has unsaved edits, telling it which to ask about', () => {
    const { guard: closing, told } = guard()
    closing.setUnsaved(true)

    expect(closing.callsOff(CloseKind.Quit)).toBe(true)
    expect(closing.callsOff(CloseKind.Window)).toBe(true)
    expect(told).toEqual([
      { type: EventType.CloseBlocked, kind: CloseKind.Quit },
      { type: EventType.CloseBlocked, kind: CloseKind.Window },
    ])
  })

  it('lets them go ahead once the edits are saved or discarded', () => {
    const { guard: closing, told } = guard()
    closing.setUnsaved(true)
    closing.setUnsaved(false)

    expect(closing.callsOff(CloseKind.Quit)).toBe(false)
    expect(told).toEqual([])
  })
})
