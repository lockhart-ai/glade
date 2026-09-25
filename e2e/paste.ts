// Pasting into a field as the clipboard would, without touching the real one.
import type { Locator } from '@playwright/test'

/** A pasted file: a made-up screenshot drawn in the page, or a file of another type. */
export interface PastedFile {
  readonly name: string
  readonly type: string
  /** The accent colour of the screenshot drawn for an image; a file of another type holds a few bytes instead. */
  readonly accent?: string
}

export const screenshot = (name: string, accent: string): PastedFile => ({ name, type: 'image/png', accent })

/**
 * Pastes into the field as the clipboard would, without touching the real one: a `paste` event carrying the text, or
 * the files, each image a small PNG drawn in the page. Answers whether the field's own paste went ahead.
 */
export async function paste(
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
