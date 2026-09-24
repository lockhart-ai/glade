/** Helpers for specs that check how the window lays out: its size, and where things land in it. */
import type { Locator } from '@playwright/test'
import { expect, type Glade } from './fixtures'

/** The window's minimum size (src/main/app.ts). */
export const MIN_WINDOW = { width: 1100, height: 700 } as const

/** Where a laid-out element is, in CSS pixels from the page's top-left. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('The element is not laid out')
  return box
}

/** Sets the window's content size, and waits for the page to take it. */
export async function resize({ app, window }: Glade, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    },
    { width, height },
  )
  await expect.poll(() => window.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
}
