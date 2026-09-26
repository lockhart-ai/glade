import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPulse, GLYPH_STRENGTHS, PULSE_FRAME_MS, PULSE_SEQUENCE, RESTING_FRAME } from './pulse'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it('steps through its frames, down and back up, one every frame, round and round', () => {
  const frames: number[] = []
  const pulse = createPulse((frame) => frames.push(frame))
  pulse.set(true)
  expect(pulse.on).toBe(true)
  expect(frames).toEqual([])

  vi.advanceTimersByTime(PULSE_FRAME_MS * PULSE_SEQUENCE.length * 2)
  expect(frames).toEqual([1, 2, 1, 0, 1, 2, 1, 0])
})

it('takes one round every 1.4s, as the working dots do, and only draws the glyph at its strengths', () => {
  expect(PULSE_FRAME_MS * PULSE_SEQUENCE.length).toBe(1_400)
  expect(PULSE_SEQUENCE[0]).toBe(RESTING_FRAME)
  expect(GLYPH_STRENGTHS[RESTING_FRAME]).toBe(1)
  for (const frame of PULSE_SEQUENCE) expect(GLYPH_STRENGTHS[frame]).toBeDefined()
})

it('stops and rests the glyph at full strength, whatever frame it was on', () => {
  const frames: number[] = []
  const pulse = createPulse((frame) => frames.push(frame))
  pulse.set(true)
  vi.advanceTimersByTime(PULSE_FRAME_MS * 2)
  pulse.set(false)
  expect(pulse.on).toBe(false)
  expect(frames).toEqual([1, 2, RESTING_FRAME])

  vi.advanceTimersByTime(PULSE_FRAME_MS * 10)
  expect(frames).toEqual([1, 2, RESTING_FRAME])
})

it('changes nothing when set as it already is: no second timer, no extra frame', () => {
  const frames: number[] = []
  const pulse = createPulse((frame) => frames.push(frame))
  pulse.set(false)
  expect(frames).toEqual([])
  pulse.set(true)
  pulse.set(true)
  vi.advanceTimersByTime(PULSE_FRAME_MS)
  expect(frames).toEqual([1])
})

it('starts each pulse from the top of its round', () => {
  const frames: number[] = []
  const pulse = createPulse((frame) => frames.push(frame))
  pulse.set(true)
  vi.advanceTimersByTime(PULSE_FRAME_MS * 2)
  pulse.set(false)
  frames.length = 0
  pulse.set(true)
  vi.advanceTimersByTime(PULSE_FRAME_MS)
  expect(frames).toEqual([1])
})
