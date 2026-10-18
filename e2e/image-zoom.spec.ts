// The image zoom (#685), in both image views: the image viewer opened from a chat's pasted images, and a picture open
// in the Files tab. The trackpad's pinch zooms around the pointer, ⌘+ and ⌘− zoom (the View menu's items, which run
// for the image only while it takes the zoom keys), ⌘0 returns to fit, a click toggles fit and actual size at the
// clicked spot, zoomed in a drag pans, and another image showing starts over at its fit.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { expectImageLoaded } from './images'
import { boxOf, expectZoomItemsForImage, imageFixture, pinch } from './image-zoom'
import { chooseMenuItem } from './menu'
import { paste, screenshot } from './paste'
import { chat, filesTab, firstRun, imageViewer, inputBar, taskList, taskPanel } from './selectors'

/** The room the viewer keeps around the image, for the close button and the pager (its fit's room, #685). */
const ROOM = { width: 96, height: 160 }

test('image viewer: pinch, the View menu and a click zoom a pasted image, a drag pans, another image resets', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)

  // A small screenshot and one much larger than the window, so there's room to zoom and to pan.
  await paste(bar.field, {
    files: [
      screenshot('upload-list.png', '#e58fa8'),
      screenshot('upload-page.png', '#8fb2f5', { width: 2400, height: 1500 }),
    ],
  })
  await bar.field.fill('The upload page shows broken tiles since the switch.')
  await bar.field.press('Enter')
  const conversation = chat(window)
  await expect(conversation.agentReplies.first()).toContainText('The client retries idempotent requests')
  await expect(conversation.working).toHaveCount(0)

  const viewer = imageViewer(window)
  await conversation.thumbnails.nth(0).click()
  await expect(viewer.viewer).toBeVisible()
  await expectImageLoaded(viewer.image)
  const fit = await boxOf(viewer.image)
  expect(fit.width).toBeCloseTo(322, 0)

  // The trackpad's pinch zooms in around the pointer, and the View menu's Zoom In zooms further: while the viewer
  // shows, its zoom items are the image's, not the page's.
  await pinch(window, viewer.image)
  await expect.poll(async () => (await boxOf(viewer.image)).width).toBeGreaterThan(fit.width * 1.5)
  const pinched = await boxOf(viewer.image)
  await expectZoomItemsForImage(glade)
  await chooseMenuItem(glade, 'View', 'Zoom In')
  await expect.poll(async () => (await boxOf(viewer.image)).width).toBeCloseTo(pinched.width * 1.25, 0)

  // ⌘0, as the View menu's Actual Size, returns to fit.
  await chooseMenuItem(glade, 'View', 'Actual Size')
  await expect.poll(async () => (await boxOf(viewer.image)).width).toBeCloseTo(fit.width, 0)

  // → steps to the large image, which starts over at its own fit.
  await window.keyboard.press('ArrowRight')
  await expect(viewer.pager).toHaveText('2 of 2')
  await expectImageLoaded(viewer.image)
  const largeFit = await boxOf(viewer.image)
  expect(largeFit.height).toBeCloseTo((await window.evaluate(() => innerHeight)) - ROOM.height, 0)

  // A click on it toggles to actual size at the clicked spot — much larger than the window — and back to fit.
  await viewer.image.click()
  await expect.poll(async () => (await boxOf(viewer.image)).width).toBeCloseTo(2402, 0)
  const actual = await boxOf(viewer.image)
  expect(actual.x).toBeLessThan(0)
  await viewer.image.click()
  await expect.poll(async () => (await boxOf(viewer.image)).width).toBeCloseTo(largeFit.width, 0)

  // Zoomed in, a drag pans the image under the pointer: it follows the pointer, left and up, and no further than the
  // drag took it (the view's edge stops it first when the image's edge gets there).
  await pinch(window, viewer.image)
  const zoomed = await boxOf(viewer.image)
  await window.mouse.move(zoomed.x + zoomed.width / 2, zoomed.y + zoomed.height / 2)
  await window.mouse.down()
  await window.mouse.move(zoomed.x + zoomed.width / 2 - 60, zoomed.y + zoomed.height / 2 - 40, { steps: 4 })
  await window.mouse.up()
  const panned = await boxOf(viewer.image)
  expect(panned.x).toBeLessThan(zoomed.x)
  expect(panned.x).toBeGreaterThanOrEqual(zoomed.x - 60.5)
  expect(panned.y).toBeLessThan(zoomed.y)
  expect(panned.y).toBeGreaterThanOrEqual(zoomed.y - 40.5)

  // ← steps back, and the zoom starts over at that image's fit.
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.pager).toHaveText('1 of 2')
  await expect.poll(async () => (await boxOf(viewer.image)).width).toBeCloseTo(fit.width, 0)

  await window.keyboard.press('Escape')
  await expect(viewer.viewer).toHaveCount(0)
})

test('files: a picture open in the tab zooms by pinch, the View menu and a click, in place', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', 'logo.png'), imageFixture('nav-tree.png'))
  const glade = await launch({ agentScript: 'shows-an-image', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Show me the current logo.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)

  const files = filesTab(window)
  await expect(taskPanel(window).tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  const picture = files.image('logo.png')
  await expectImageLoaded(picture)
  const fit = await boxOf(picture)
  expect(fit.width).toBeLessThan(800) // fit to the panel, never scaled past the image's own 800

  // The pinch zooms in around the pointer, and the View menu's Zoom In zooms the picture too: while the Files tab's
  // picture has the zoom (the focus is on it — the picture is its own control), the menu's items are its. ⌘0, as
  // Actual Size, returns to fit.
  await files.zoom('logo.png').focus()
  await pinch(window, picture)
  await expect.poll(async () => (await boxOf(picture)).width).toBeGreaterThan(fit.width * 1.5)
  await expectZoomItemsForImage(glade)
  await chooseMenuItem(glade, 'View', 'Zoom In')
  await expect.poll(async () => (await boxOf(picture)).width).toBeGreaterThan(fit.width * 2)
  await chooseMenuItem(glade, 'View', 'Actual Size')
  await expect.poll(async () => (await boxOf(picture)).width).toBeCloseTo(fit.width, 0)

  // A click toggles to actual size at the clicked spot, and back to fit.
  await files.zoom('logo.png').click()
  await expect.poll(async () => (await boxOf(picture)).width).toBeCloseTo(800, 0)
  await files.zoom('logo.png').click()
  await expect.poll(async () => (await boxOf(picture)).width).toBeCloseTo(fit.width, 0)
})
