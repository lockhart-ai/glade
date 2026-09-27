import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { imageDataUrl, ImageMediaType, type ImageRef } from '../../shared/images'
import { GIF, PNG, WEBP } from '../../shared/test-images'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge } from '../store/test-bridge'
import { ImageThumbnails, thumbnailLabel } from './ImageThumbnails'
import { imagePosition, steppedIndex, VIEWER_LABEL } from './ImageViewer'
import { IMAGE_LABEL, MISSING_IMAGE_LABEL } from './StoredImage'

const REFS: readonly ImageRef[] = [
  { id: 'png', mediaType: ImageMediaType.Png },
  { id: 'gif', mediaType: ImageMediaType.Gif },
  { id: 'webp', mediaType: ImageMediaType.Webp },
]

interface Rendered {
  /** Renders the thumbnails again, with other images. */
  readonly show: (images: readonly ImageRef[]) => void
}

/** Thumbnails of `images`, with a button after them to move the focus to, and the fake main's stored images. */
async function renderThumbnails(images: readonly ImageRef[] = REFS): Promise<Rendered> {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [], images: { png: PNG, gif: GIF, webp: WEBP } })
  const store = createGladeStore(fake.bridge)
  const ui = (shown: readonly ImageRef[]) => (
    <GladeStoreProvider store={store}>
      <ImageThumbnails images={shown} className="thumb" />
      <button type="button">Elsewhere</button>
    </GladeStoreProvider>
  )
  const { rerender } = render(ui(images))
  await act(() => Promise.resolve())
  return {
    show: (shown) => {
      rerender(ui(shown))
    },
  }
}

function thumbnail(index: number, count = REFS.length): HTMLElement {
  return screen.getByRole('button', { name: thumbnailLabel(index, count) })
}

/** Clicks a thumbnail as a pointer does: it takes the focus, then the click. */
async function open(index: number, count = REFS.length): Promise<HTMLElement> {
  const button = thumbnail(index, count)
  button.focus()
  fireEvent.click(button)
  await settleFloating()
  return screen.getByRole('dialog', { name: VIEWER_LABEL })
}

/** The source of the image the viewer shows. */
function shown(): string | null {
  return within(screen.getByRole('dialog')).getByRole('img', { name: IMAGE_LABEL }).getAttribute('src')
}

function position(): string | null {
  return within(screen.getByRole('group', { name: 'Images' })).getByText(/ of /).textContent
}

describe('imagePosition and steppedIndex', () => {
  it('count from 1, and step round from the last image to the first and back', () => {
    expect(imagePosition(1, 3)).toBe('2 of 3')
    expect(steppedIndex(0, 1, 3)).toBe(1)
    expect(steppedIndex(2, 1, 3)).toBe(0)
    expect(steppedIndex(0, -1, 3)).toBe(2)
    expect(steppedIndex(0, 1, 1)).toBe(0)
  })
})

describe('ImageThumbnails', () => {
  it('shows each image as a button you can reach with the keyboard, named for which one it is', async () => {
    await renderThumbnails()

    const buttons = REFS.map((_, index) => thumbnail(index))
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'View pasted image 1 of 3',
      'View pasted image 2 of 3',
      'View pasted image 3 of 3',
    ])
    for (const button of buttons) {
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
      expect(button).toHaveClass('thumb')
    }
    expect(within(thumbnail(1)).getByRole('img', { name: IMAGE_LABEL })).toHaveAttribute('src', imageDataUrl(GIF))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names a lone image without counting it', async () => {
    await renderThumbnails([REFS[0] ?? { id: 'png', mediaType: ImageMediaType.Png }])

    expect(screen.getByRole('button', { name: 'View pasted image' })).toBeInTheDocument()
  })

  it('opens the clicked image in the viewer, full size, with the focus on its close button', async () => {
    await renderThumbnails()

    const viewer = await open(1)

    expect(shown()).toBe(imageDataUrl(GIF))
    expect(position()).toBe('2 of 3')
    expect(within(viewer).getByRole('button', { name: 'Close image' })).toHaveFocus()
  })

  it('closes with Esc and gives the focus back to the thumbnail', async () => {
    await renderThumbnails()
    const viewer = await open(1)

    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(thumbnail(1)).toHaveFocus()
  })

  it('closes with the close button and gives the focus back to the thumbnail', async () => {
    await renderThumbnails()
    const viewer = await open(0)

    fireEvent.click(within(viewer).getByRole('button', { name: 'Close image' }))
    await settleFloating()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(thumbnail(0)).toHaveFocus()
  })

  it('closes with a click on the backdrop, but not on the image or the pager', async () => {
    await renderThumbnails()
    const viewer = await open(2)

    fireEvent.click(within(viewer).getByRole('img', { name: IMAGE_LABEL }))
    fireEvent.click(screen.getByRole('group', { name: 'Images' }))
    expect(screen.getByRole('dialog')).toBe(viewer)

    fireEvent.click(viewer)
    await settleFloating()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(thumbnail(2)).toHaveFocus()
  })

  it('steps between the message’s images with ← and →, going round at the ends', async () => {
    await renderThumbnails()
    const viewer = await open(0)

    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(shown()).toBe(imageDataUrl(GIF))
    expect(position()).toBe('2 of 3')

    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(shown()).toBe(imageDataUrl(PNG))
    expect(position()).toBe('1 of 3')

    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    expect(shown()).toBe(imageDataUrl(WEBP))
    expect(position()).toBe('3 of 3')
  })

  it('steps with the pager’s buttons too', async () => {
    await renderThumbnails()
    await open(2)

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(position()).toBe('1 of 3')
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    expect(position()).toBe('2 of 3')
    expect(shown()).toBe(imageDataUrl(GIF))
  })

  it('leaves arrows with a modifier alone, and keys it doesn’t use', async () => {
    await renderThumbnails()
    const viewer = await open(0)

    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
      fireEvent.keyDown(viewer, { key: 'ArrowRight', [modifier]: true })
    }
    fireEvent.keyDown(viewer, { key: 'ArrowDown' })

    expect(position()).toBe('1 of 3')
    expect(screen.getByRole('dialog')).toBe(viewer)
  })

  it('gives the focus back to the thumbnail of the image it was showing when it closes', async () => {
    await renderThumbnails()
    const viewer = await open(0)

    fireEvent.keyDown(viewer, { key: 'ArrowLeft' })
    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()

    expect(thumbnail(2)).toHaveFocus()
  })

  it('shows a lone image with no pager, and the arrows do nothing', async () => {
    const [first] = REFS
    await renderThumbnails(first === undefined ? [] : [first])
    const viewer = await open(0, 1)

    expect(screen.queryByRole('group', { name: 'Images' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument()
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(shown()).toBe(imageDataUrl(PNG))
  })

  it('says an image that can’t be loaded isn’t available, in the thumbnail and the viewer, and steps past it', async () => {
    await renderThumbnails([{ id: 'gone', mediaType: ImageMediaType.Png }, ...REFS.slice(0, 1)])

    expect(within(thumbnail(0, 2)).getByRole('img', { name: MISSING_IMAGE_LABEL })).toBeInTheDocument()
    const viewer = await open(0, 2)
    expect(within(viewer).getByRole('img', { name: MISSING_IMAGE_LABEL })).toHaveTextContent(MISSING_IMAGE_LABEL)
    expect(within(viewer).queryByRole('img', { name: IMAGE_LABEL })).not.toBeInTheDocument()

    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(shown()).toBe(imageDataUrl(PNG))
    fireEvent.keyDown(viewer, { key: 'Escape' })
    await settleFloating()
    expect(thumbnail(1, 2)).toHaveFocus()
  })

  it('shows nothing in the viewer until the image has loaded', async () => {
    let answer: (() => void) | undefined
    const fake = fakeBridge(
      { workspaces: [], tasks: [], uiState: [] },
      {
        [CommandName.ImagesGet]: () =>
          new Promise((resolve) => {
            answer = () => {
              resolve({ image: PNG })
            }
          }),
      },
    )
    render(
      <GladeStoreProvider store={createGladeStore(fake.bridge)}>
        <ImageThumbnails images={[{ id: 'slow', mediaType: ImageMediaType.Png }]} />
      </GladeStoreProvider>,
    )
    const viewer = await open(0, 1)

    expect(within(viewer).queryByRole('img')).not.toBeInTheDocument()
    await act(async () => {
      answer?.()
      await Promise.resolve()
    })
    expect(within(viewer).getByRole('img', { name: IMAGE_LABEL })).toHaveAttribute('src', imageDataUrl(PNG))
  })

  it('closes when the image it shows is no longer the message’s', async () => {
    const { show } = await renderThumbnails()
    await open(2)

    show(REFS.slice(0, 2))
    await settleFloating()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    show(REFS)
    await settleFloating()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
