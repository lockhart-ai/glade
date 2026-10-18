// Shared by the image zoom's specs (#685): an 800×500 sample image of the fixtures' Acme workspaces, for a picture
// with room to zoom, a box reader for the zoomed image's place, and the gestures a trackpad makes, as the page sees
// them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { Glade } from './fixtures'
import { findMenuItem } from './menu'

/** The fixtures' sample screenshots, which a spec copies into a workspace to have an image to open. */
export function imageFixture(name: 'nav-tree.png' | 'landing-dark.png' | 'landing-light.png'): Buffer {
  return readFileSync(resolve(__dirname, '..', 'scripts', 'fixtures', 'artifacts-workspace', 'screens', name))
}

/** The image's box, once it has loaded and so has its size; an element with no box throws. */
export async function boxOf(image: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await image.boundingBox()
  if (found === null) throw new Error('The image has no box')
  return found
}

/**
 * A trackpad pinch over `image`: Chromium delivers a pinch as wheel events with ctrl held, which is how the zoom
 * takes them, so the spec holds Control over the wheel. (Roughly e^1 of zoom per hundred of wheel.)
 */
export async function pinch(page: Page, image: Locator, deltaY = -100): Promise<void> {
  await image.hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, deltaY)
  await page.keyboard.up('Control')
}

/**
 * Waits until the View menu's zoom items have become the image's (`app.zoom*`, which main sends only while an image
 * view takes the zoom keys), rather than the page-zoom roles they are the rest of the time: choosing too early, on a
 * menu not rebuilt yet, would page-zoom instead.
 */
export async function expectZoomItemsForImage(glade: Glade): Promise<void> {
  await expect
    .poll(async () => (await findMenuItem(glade, ['View', 'Zoom In']))?.id ?? null, {
      message: 'The View menu’s Zoom In never became the image’s',
    })
    .toBe('app.zoomIn')
}
