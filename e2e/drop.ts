// Dropping and pasting files from disk, as Finder hands them over, without driving the real OS: synthetic drag and
// paste events in the hidden window, carrying `File`s backed by files on disk, so Electron knows their paths.
import type { JSHandle, Locator, Page } from '@playwright/test'

const PICKER_ID = 'e2e-files-on-disk'

/**
 * Files on disk as the page gets them from Finder: set on a hidden file input (which Playwright fills from disk), then
 * taken off it, so each `File` is the file at its path and `webUtils.getPathForFile` names it. Each path must be a file
 * as it's picked up (a file input takes no folders); what's at the path by the time it's dropped is what main finds.
 */
export async function filesOnDisk(page: Page, paths: readonly string[]): Promise<JSHandle<File[]>> {
  await page.evaluate((id) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = id
    input.hidden = true
    document.body.append(input)
  }, PICKER_ID)
  await page.locator(`#${PICKER_ID}`).setInputFiles([...paths])
  return page.evaluateHandle((id) => {
    const input = document.getElementById(id)
    if (!(input instanceof HTMLInputElement)) throw new Error('No file input')
    const files = Array.from(input.files ?? [])
    input.remove()
    return files
  }, PICKER_ID)
}

/**
 * Drags files picked up from disk (`filesOnDisk`) onto an element and drops them there: `dragenter`, `dragover` and
 * `drop`, each carrying them. Answers whether the page took the drop (cancelled its default).
 */
export async function dropPicked(target: Locator, files: JSHandle<File[]>): Promise<boolean> {
  return target.evaluate((element, dropped) => {
    const data = new DataTransfer()
    for (const file of dropped) data.items.add(file)
    let taken = false
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true })
      const allowed = element.dispatchEvent(event)
      if (type === 'drop') taken = !allowed
    }
    return taken
  }, files)
}

/** Drags files from disk onto an element and drops them there. Answers whether the page took the drop. */
export async function dropFiles(target: Locator, paths: readonly string[]): Promise<boolean> {
  return dropPicked(target, await filesOnDisk(target.page(), paths))
}

/**
 * Pastes files copied in Finder into a field, as ⌘V does: the files, with their names beside them as text, as Finder
 * puts them on the clipboard. Answers whether the field's own paste went ahead.
 */
export async function pasteFiles(field: Locator, paths: readonly string[]): Promise<boolean> {
  const files = await filesOnDisk(field.page(), paths)
  return field.evaluate((element, pasted) => {
    const data = new DataTransfer()
    data.setData('text/plain', pasted.map(({ name }) => name).join('\n'))
    for (const file of pasted) data.items.add(file)
    return element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, files)
}
