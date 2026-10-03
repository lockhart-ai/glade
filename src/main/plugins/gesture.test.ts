// A plugin view's last click or key press, which one `openTask` may use (#466).
import { beforeEach, describe, expect, it } from 'vitest'
import { createPluginGesture, PLUGIN_GESTURE_MS, PluginInputKind, type PluginGesture } from './gesture'

let time: number
let gesture: PluginGesture

beforeEach(() => {
  time = 1_000_000
  gesture = createPluginGesture(() => time)
})

describe('createPluginGesture', () => {
  it('has nothing to take before any input', () => {
    expect(gesture.take()).toBe(false)
  })

  it('takes a press within a second, once', () => {
    gesture.input(PluginInputKind.Press)
    time += PLUGIN_GESTURE_MS
    expect(gesture.take()).toBe(true)
    expect(gesture.take()).toBe(false)
  })

  it("doesn't take a press older than a second, and that stale press is gone", () => {
    gesture.input(PluginInputKind.Press)
    time += PLUGIN_GESTURE_MS + 1
    expect(gesture.take()).toBe(false)
    time -= PLUGIN_GESTURE_MS
    expect(gesture.take()).toBe(false)
  })

  it('times a click from its release, so a long press still counts', () => {
    gesture.input(PluginInputKind.Press)
    time += 5000
    gesture.input(PluginInputKind.Release)
    time += 500
    expect(gesture.take()).toBe(true)
  })

  it("doesn't count a release on its own, or one after its press was used", () => {
    gesture.input(PluginInputKind.Release)
    expect(gesture.take()).toBe(false)

    gesture.input(PluginInputKind.Press)
    expect(gesture.take()).toBe(true)
    gesture.input(PluginInputKind.Release)
    expect(gesture.take()).toBe(false)
  })

  it('counts each new press as a gesture of its own', () => {
    gesture.input(PluginInputKind.Press)
    expect(gesture.take()).toBe(true)
    time += 10
    gesture.input(PluginInputKind.Press)
    expect(gesture.take()).toBe(true)
  })

  it('counts two presses before a take as one gesture', () => {
    gesture.input(PluginInputKind.Press)
    gesture.input(PluginInputKind.Press)
    expect(gesture.take()).toBe(true)
    expect(gesture.take()).toBe(false)
  })
})
