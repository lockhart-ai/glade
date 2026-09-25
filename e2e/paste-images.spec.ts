import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { agentReceived, expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

/** A pasted file: a made-up screenshot drawn in the page, or a file of another type. */
interface PastedFile {
  readonly name: string
  readonly type: string
  /** The accent colour of the screenshot drawn for an image; a file of another type holds a few bytes instead. */
  readonly accent?: string
}

const screenshot = (name: string, accent: string): PastedFile => ({ name, type: 'image/png', accent })

/**
 * Pastes into the field as the clipboard would, without touching the real one: a `paste` event carrying the text, or
 * the files, each image a small PNG drawn in the page. Answers whether the field's own paste went ahead.
 */
async function paste(
  field: Locator,
  clipboard: { text?: string; html?: string; files?: PastedFile[] },
): Promise<boolean> {
  return field.evaluate(
    async (element, { text, html, files }) => {
      const data = new DataTransfer()
      if (text !== undefined) data.setData('text/plain', text)
      if (html !== undefined) data.setData('text/html', html)
      for (const file of files) {
        let contents: Blob = new Blob(['II*\u0000'], { type: file.type })
        if (file.accent !== undefined) {
          const canvas = document.createElement('canvas')
          canvas.width = 320
          canvas.height = 200
          const context = canvas.getContext('2d')
          if (context === null) throw new Error('No 2D canvas')
          context.fillStyle = '#14151c'
          context.fillRect(0, 0, 320, 200)
          context.fillStyle = '#5c6378'
          for (const x of [16, 30]) context.fillRect(x, 16, 8, 8)
          context.fillStyle = file.accent
          context.fillRect(16, 44, 220, 22)
          context.fillStyle = '#343850'
          context.fillRect(16, 82, 280, 14)
          context.fillRect(16, 108, 170, 14)
          context.fillRect(16, 134, 240, 14)
          contents = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob === null) reject(new Error('No PNG'))
              else resolve(blob)
            }, 'image/png')
          })
        }
        data.items.add(new File([contents], file.name, { type: file.type }))
      }
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
      return element.dispatchEvent(event)
    },
    { text: clipboard.text, html: clipboard.html, files: clipboard.files ?? [] },
  )
}

/** Each image block's type in a message's content, and its text, as the agent got it. */
function blocks(content: unknown): unknown {
  if (typeof content === 'string') return content
  return (content as { type: string; text?: string; source?: { media_type: string; data: string } }[]).map((block) =>
    block.type === 'image'
      ? { image: block.source?.media_type, bytes: (block.source?.data.length ?? 0) > 100 }
      : { text: block.text },
  )
}

test('pasting: text goes into the field, images attach as thumbnails and reach the agent, and the chat keeps them', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)
  await bar.field.focus()

  // Text is left to the field, which pastes it as plain text: nothing is attached.
  expect(await paste(bar.field, { text: 'Why does the upload page', html: '<b>Why does the upload page</b>' })).toBe(
    true,
  )
  await expect(bar.attachedImages).toHaveCount(0)
  await bar.field.fill('Why does the upload page look like this?')

  // Pasting images attaches each as a thumbnail with a remove button; a file of another type is refused, saying why.
  expect(
    await paste(bar.field, {
      files: [
        screenshot('upload-page.png', '#e58fa8'),
        { name: 'scan.tiff', type: 'image/tiff' },
        screenshot('settings.png', '#8fb2f5'),
      ],
    }),
  ).toBe(false)
  await expect(bar.attachedImages).toHaveCount(2)
  await expect(bar.refusals).toHaveText(['scan.tiff can’t be attached: only PNG, JPEG, GIF and WebP images can.'])
  await expect(bar.field).toHaveValue('Why does the upload page look like this?')

  // Several at once, then remove one of them.
  await paste(bar.field, { files: [screenshot('before.png', '#7fd1c7'), screenshot('after.png', '#c8b2ff')] })
  await expect(bar.attachedImages).toHaveCount(4)
  await expect(bar.refusals).toHaveCount(0)
  await bar.removeImage(2).click()
  await expect(bar.attachedImages).toHaveCount(3)

  // Send: the text and the three images go together, and the bar empties.
  await bar.field.press('Enter')
  const conversation = chat(glade.window)
  await expect(conversation.userMessages).toHaveCount(1)
  const sent = conversation.userMessages.first()
  await expect(sent).toContainText('Why does the upload page look like this?')
  await expect(sent.getByRole('img', { name: 'Pasted image' })).toHaveCount(3)
  for (const image of await sent.getByRole('img', { name: 'Pasted image' }).all()) {
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/)
  }
  await expect(bar.attachedImages).toHaveCount(0)
  await expect(bar.field).toHaveValue('')
  await expect(conversation.agentReplies.first()).toContainText('The client retries idempotent requests')

  // The agent got the images as image content blocks, in order, before the text.
  expect((await agentReceived(glade)).map(blocks)).toEqual([
    [
      { image: 'image/png', bytes: true },
      { image: 'image/png', bytes: true },
      { image: 'image/png', bytes: true },
      { text: 'Why does the upload page look like this?' },
    ],
  ])

  // An image on its own is a message too.
  await paste(bar.field, { files: [screenshot('one-more.png', '#e58fa8')] })
  await expect(bar.attachedImages).toHaveCount(1)
  await bar.send.click()
  await expect(conversation.userMessages).toHaveCount(2)
  await expect(conversation.userMessages.nth(1).getByRole('img', { name: 'Pasted image' })).toHaveCount(1)
  await expect
    .poll(async () => (await agentReceived(glade)).map(blocks).at(-1))
    .toEqual([{ image: 'image/png', bytes: true }])
  await expect(conversation.agentReplies).toHaveCount(2)

  // After a relaunch the chat still shows them.
  await glade.close()
  const relaunched = chat((await launch()).window)
  await expect(relaunched.userMessages).toHaveCount(2)
  await expect(relaunched.userMessages.first().getByRole('img', { name: 'Pasted image' })).toHaveCount(3)
  await expect(relaunched.userMessages.first().getByRole('img', { name: 'Pasted image' }).first()).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/,
  )
  await expect(relaunched.userMessages.nth(1).getByRole('img', { name: 'Pasted image' })).toHaveCount(1)
})

test('pasting: a message queued while the agent works keeps its images until the agent gets them', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)

  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()

  // While it works, the message and its image wait in the queue, the image as a thumbnail in its row.
  await paste(bar.field, { files: [screenshot('failing-test.png', '#e58fa8')] })
  await expect(bar.attachedImages).toHaveCount(1)
  await bar.field.fill('This is the test that fails.')
  await bar.queue.click()
  await expect(bar.queuedRows).toHaveText(['1This is the test that fails.'])
  await expect(bar.queuedImages(1)).toHaveCount(1)
  await expect(bar.queuedImages(1)).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(bar.attachedImages).toHaveCount(0)

  // Stopped, the turn leaves the queue alone; the next message takes it to the agent first, image and all.
  await bar.stop.click()
  await expect(bar.stop).toHaveCount(0)
  await expect(bar.queuedImages(1)).toHaveCount(1)
  await bar.field.fill('Only run the unit tests.')
  await bar.field.press('Enter')

  const conversation = chat(glade.window)
  await expect(conversation.userMessages).toHaveCount(3)
  await expect(conversation.userMessages.nth(1)).toContainText('This is the test that fails.')
  await expect(conversation.userMessages.nth(1).getByRole('img', { name: 'Pasted image' })).toHaveCount(1)
  await expect(bar.queued).toHaveCount(0)
  await expect
    .poll(async () => (await agentReceived(glade)).map(blocks))
    .toEqual([
      'Run the e2e suite.',
      [{ image: 'image/png', bytes: true }, { text: 'This is the test that fails.' }],
      'Only run the unit tests.',
    ])
})
