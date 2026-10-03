// The image viewer (#324): a thumbnail in the chat or the queue opens its image full size over the window, fitted to
// it but never scaled past its own size; ← and → step through the message's images, and Esc, the backdrop or × close
// it, putting the focus on the task's input (#415).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { expectImageLoaded } from './images'
import { paste, screenshot } from './paste'
import { chat, firstRun, imageViewer, inputBar, taskList } from './selectors'

/** The viewer leaves this much room around the image: for the close button above it and the pager below. */
const ROOM = { width: 96, height: 160 }

test('image viewer: open a chat thumbnail full size, step through the message’s images and close it each way', async ({
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

  // A small screenshot, one larger than the window, and a small one again.
  await paste(bar.field, {
    files: [
      screenshot('upload-list.png', '#e58fa8'),
      screenshot('upload-page.png', '#8fb2f5', { width: 2400, height: 1500 }),
      screenshot('console.png', '#7fd1c7', { width: 480, height: 300 }),
    ],
  })
  await expect(bar.attachedImages).toHaveCount(3)
  await bar.field.fill('The upload page shows broken tiles since the switch.')
  await bar.field.press('Enter')

  const conversation = chat(window)
  const { thumbnails } = conversation
  // Once the reply is in, so the chat stays put under the pointer.
  await expect(conversation.agentReplies.first()).toContainText('The client retries idempotent requests')
  await expect(conversation.working).toHaveCount(0)
  await expect(thumbnails).toHaveCount(3)
  await expect(thumbnails.nth(0)).toHaveAccessibleName('View pasted image 1 of 3')
  await expect(thumbnails.nth(0).getByRole('img')).toHaveAttribute('src', /^data:image\/png;base64,/)

  // A thumbnail shows it opens: a pointer, and a lighter border under it.
  const border = (): Promise<string> =>
    thumbnails.nth(0).evaluate((element) => getComputedStyle(element).borderTopColor)
  const atRest = await border()
  expect(await thumbnails.nth(0).evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer')
  await thumbnails.nth(0).hover()
  await expect.poll(border).not.toBe(atRest)

  // Click: the first image, at its own size (it's smaller than the window), with the focus on the close button.
  const viewer = imageViewer(window)
  await thumbnails.nth(0).click()
  await expect(viewer.viewer).toBeVisible()
  await expect(viewer.pager).toHaveText('1 of 3')
  await expect(viewer.close).toBeFocused()
  const box = async (): Promise<{ width: number; height: number }> => {
    const found = await viewer.image.boundingBox()
    if (found === null) throw new Error('The image has no box')
    return found
  }
  // Its box is the image and a 1px border: read once it has loaded, and so has its size (#478).
  await expectImageLoaded(viewer.image)
  expect(await box()).toMatchObject({ width: 322, height: 202 })

  // → steps to the large one, fitted to the window with its shape kept.
  await window.keyboard.press('ArrowRight')
  await expect(viewer.pager).toHaveText('2 of 3')
  const size = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await expectImageLoaded(viewer.image)
  await expect.poll(async () => Math.round((await box()).height)).toBe(size.height - ROOM.height)
  const large = await box()
  expect(large.width).toBeLessThanOrEqual(size.width - ROOM.width)
  expect((large.width - 2) / (large.height - 2)).toBeCloseTo(2400 / 1500, 2)

  // → again, to the last; → once more does nothing there, and Next disables (#463); the pager's buttons step too.
  await window.keyboard.press('ArrowRight')
  await expect(viewer.pager).toHaveText('3 of 3')
  await expect(viewer.next).toBeDisabled()
  await window.keyboard.press('ArrowRight')
  await expect(viewer.pager).toHaveText('3 of 3')
  await viewer.previous.click()
  await expect(viewer.pager).toHaveText('2 of 3')
  await expect(viewer.next).toBeEnabled()
  await viewer.next.click()
  await expect(viewer.pager).toHaveText('3 of 3')
  // Next held the focus as it disabled, and a disabled button can't keep it: the viewer takes it, rather than letting
  // it drop to the page, out of the viewer, where ← and → would step nothing.
  await expect(viewer.next).toBeDisabled()
  await expect(viewer.viewer).toBeFocused()

  // ← back to the first; ← once more does nothing there, and Previous disables (#463).
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.pager).toHaveText('2 of 3')
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.pager).toHaveText('1 of 3')
  await expect(viewer.previous).toBeDisabled()
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.pager).toHaveText('1 of 3')

  // The same from Previous, clicked back onto the first: the viewer has the focus, and → steps.
  await window.keyboard.press('ArrowRight')
  await expect(viewer.pager).toHaveText('2 of 3')
  await viewer.previous.click()
  await expect(viewer.pager).toHaveText('1 of 3')
  await expect(viewer.previous).toBeDisabled()
  await expect(viewer.viewer).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(viewer.pager).toHaveText('2 of 3')

  // Esc closes it, and the focus goes to the task's input (#415), not back to the thumbnail it opened from.
  await window.keyboard.press('Escape')
  await expect(viewer.viewer).toHaveCount(0)
  await expect(bar.field).toBeFocused()

  // ↵ on a focused thumbnail opens it; a click on the backdrop, beside the image, closes it.
  await thumbnails.nth(1).focus()
  await window.keyboard.press('Enter')
  await expect(viewer.pager).toHaveText('2 of 3')
  await viewer.image.click()
  await expect(viewer.viewer).toBeVisible()
  await viewer.viewer.click({ position: { x: 20, y: size.height / 2 } })
  await expect(viewer.viewer).toHaveCount(0)
  await expect(bar.field).toBeFocused()

  // Space opens it too, and × closes it.
  await thumbnails.nth(0).focus()
  await window.keyboard.press('Space')
  await expect(viewer.pager).toHaveText('1 of 3')
  await viewer.close.click()
  await expect(viewer.viewer).toHaveCount(0)
  await expect(bar.field).toBeFocused()
})

test('image viewer: a queued message’s thumbnail opens its image, alone, with no pager', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'long-running', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()

  await paste(bar.field, { files: [screenshot('failing-test.png', '#e58fa8')] })
  await bar.field.fill('This is the test that fails.')
  await bar.queue.click()
  const thumbnail = bar.queuedThumbnails(1)
  await expect(thumbnail).toHaveCount(1)
  await expect(thumbnail).toHaveAccessibleName('View pasted image')

  const viewer = imageViewer(window)
  await thumbnail.click()
  await expect(viewer.image).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(viewer.pager).toHaveCount(0)
  // A right-click in it is the viewer's: the queued message's menu stays shut.
  await viewer.image.click({ button: 'right' })
  await expect(window.getByRole('menu')).toHaveCount(0)

  await window.keyboard.press('Escape')
  await expect(viewer.viewer).toHaveCount(0)
  await expect(bar.field).toBeFocused()
  await expect(bar.queuedRows).toHaveText(['1This is the test that fails.'])
})
