import { afterEach, describe, expect, it, vi } from 'vitest'
import { GIF, PNG } from '../../shared/test-images'
import { pastedFiles, readBase64, readPastedFiles } from './pasted'

afterEach(() => {
  vi.restoreAllMocks()
})

const file = (data: string, name: string, type: string): File => new File([Buffer.from(data, 'base64')], name, { type })

/** Makes every FileReader fail, as reading a file that's gone would. */
function failReads(error: DOMException | null): void {
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
    vi.spyOn(this, 'error', 'get').mockReturnValue(error)
    queueMicrotask(() => {
      this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>)
    })
  })
}

describe('pastedFiles', () => {
  const data = (text: string, files: File[]) => ({
    getData: (format: string) => (format === 'text/plain' ? text : ''),
    files,
  })

  it('is the files of a paste without text, in order', () => {
    const files = [file(PNG.data, 'a.png', PNG.mediaType), file(GIF.data, 'b.gif', GIF.mediaType)]
    expect(pastedFiles(data('', files))).toEqual(files)
  })

  it('is nothing for a paste of text, even with files alongside', () => {
    expect(pastedFiles(data('Q3 totals', [file(PNG.data, 'a.png', PNG.mediaType)]))).toEqual([])
    expect(pastedFiles(data('', []))).toEqual([])
  })
})

describe('readBase64', () => {
  it('reads a file’s bytes as base64', async () => {
    expect(await readBase64(file(PNG.data, 'a.png', PNG.mediaType))).toBe(PNG.data)
    expect(await readBase64(new Blob([]))).toBe('')
  })

  it('fails when the file can’t be read', async () => {
    const error = new DOMException('gone', 'NotReadableError')
    failReads(error)
    await expect(readBase64(new Blob(['x']))).rejects.toBe(error)
  })

  it('fails with an error of its own when the reader gives none', async () => {
    failReads(null)
    await expect(readBase64(new Blob(['x']))).rejects.toThrow('Couldn’t read the pasted file')
  })
})

describe('readPastedFiles', () => {
  it('reads the images, in order, and says why it refused the rest', async () => {
    const result = await readPastedFiles([
      file(PNG.data, 'a.png', PNG.mediaType),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
      file(GIF.data, 'b.gif', GIF.mediaType),
    ])

    expect(result).toEqual({
      images: [PNG, GIF],
      refusals: ['notes.txt can’t be attached: only PNG, JPEG, GIF and WebP images can.'],
    })
  })

  it('refuses an image it can’t read, by name', async () => {
    failReads(new DOMException('gone', 'NotReadableError'))

    expect(await readPastedFiles([file(PNG.data, '', PNG.mediaType)])).toEqual({
      images: [],
      refusals: ['The pasted file couldn’t be read.'],
    })
  })
})
