// Waiting on images in the specs.
import type { Locator } from '@playwright/test'
import { expect } from './fixtures'

/**
 * Waits for an `<img>` to have loaded, and so to be laid out at its size. Until then its element is an empty box, and
 * neither its place nor anything measured against it is final (#478): wait for this before reading any geometry.
 */
export async function expectImageLoaded(image: Locator): Promise<void> {
  await expect(image).toHaveJSProperty('complete', true)
  await expect(image).not.toHaveJSProperty('naturalWidth', 0)
}
