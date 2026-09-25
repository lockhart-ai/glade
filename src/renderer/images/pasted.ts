// Reading what's pasted into the input bar: which files an image paste carries, and their bytes.
import { checkPastedFile, pastedFileName, type ImageData } from '../../shared/images'

/** What a paste carries that the input bar reads: its plain text and its files. */
export interface PastedData {
  readonly getData: (format: string) => string
  readonly files: ArrayLike<File>
}

/**
 * The files to attach from a paste, or none when it's text. A paste that carries text is text, even with files
 * alongside (an app often puts a picture of copied text on the clipboard too): the field takes it as it always has.
 */
export function pastedFiles(data: PastedData): File[] {
  if (data.getData('text/plain') !== '') return []
  return Array.from(data.files)
}

/** A file's bytes, as base64. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      // A data URL, `data:<type>;base64,<data>`: the bytes are what follows the comma.
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('Couldn’t read the pasted file'))
    }
    reader.readAsDataURL(file)
  })
}

/** What pasting some files came to: the images to attach, in order, and why any others weren't. */
export interface PasteResult {
  readonly images: readonly ImageData[]
  readonly refusals: readonly string[]
}

/** Checks each pasted file (`checkPastedFile`) and reads the ones that can be attached. */
export async function readPastedFiles(files: readonly File[]): Promise<PasteResult> {
  const read = await Promise.all(
    files.map(async (file): Promise<ImageData | string> => {
      const check = checkPastedFile(file)
      if (!check.ok) return check.reason
      try {
        return { mediaType: check.mediaType, data: await readBase64(file) }
      } catch {
        return `${pastedFileName(file.name)} couldn’t be read.`
      }
    }),
  )
  return {
    images: read.filter((item): item is ImageData => typeof item !== 'string'),
    refusals: read.filter((item): item is string => typeof item === 'string'),
  }
}
