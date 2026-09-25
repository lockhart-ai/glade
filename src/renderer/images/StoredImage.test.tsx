import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { imageDataUrl, ImageMediaType } from '../../shared/images'
import { GIF, PNG } from '../../shared/test-images'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, type FakeBridge } from '../store/test-bridge'
import { IMAGE_LABEL, MISSING_IMAGE_LABEL, StoredImage } from './StoredImage'

function setup(): { fake: FakeBridge; show: (id: string) => void } {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [], images: { gif: GIF, png: PNG } })
  const store = createGladeStore(fake.bridge)
  const ui = (id: string) => (
    <GladeStoreProvider store={store}>
      <StoredImage image={{ id, mediaType: ImageMediaType.Png }} className="thumb" />
    </GladeStoreProvider>
  )
  const { rerender } = render(ui('gif'))
  return {
    fake,
    show: (id) => {
      rerender(ui(id))
    },
  }
}

describe('StoredImage', () => {
  it('stands in an empty box while the image loads, then shows it', async () => {
    const { fake } = setup()

    const box = screen.getByRole('img', { name: IMAGE_LABEL })
    expect(box.tagName).toBe('SPAN')
    expect(box).toHaveClass('thumb')

    await act(() => Promise.resolve())
    const image = screen.getByRole('img', { name: IMAGE_LABEL })
    expect(image.tagName).toBe('IMG')
    expect(image).toHaveAttribute('src', imageDataUrl(GIF))
    expect(image).toHaveClass('thumb')
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.ImagesGet, { id: 'gif' })
  })

  it('says an image that can’t be loaded isn’t available', async () => {
    const { show } = setup()
    show('missing')

    expect(await screen.findByRole('img', { name: MISSING_IMAGE_LABEL })).toHaveClass('thumb')
  })

  it('shows the new image when it changes, not the last one', async () => {
    const { show } = setup()
    await act(() => Promise.resolve())
    show('png')

    await act(() => Promise.resolve())
    expect(screen.getByRole('img', { name: IMAGE_LABEL })).toHaveAttribute('src', imageDataUrl(PNG))
  })

  it('ignores an image that loads after it has gone', async () => {
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
    const store = createGladeStore(fake.bridge)
    const { unmount } = render(
      <GladeStoreProvider store={store}>
        <StoredImage image={{ id: 'slow', mediaType: ImageMediaType.Png }} />
      </GladeStoreProvider>,
    )
    unmount()
    await act(async () => {
      answer?.()
      await Promise.resolve()
    })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('ignores a failure that arrives after it has gone', async () => {
    let fail: (() => void) | undefined
    const fake = fakeBridge(
      { workspaces: [], tasks: [], uiState: [] },
      {
        [CommandName.ImagesGet]: () =>
          new Promise((_resolve, reject) => {
            fail = () => {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              reject(bridgeError(BridgeErrorCode.NotFound, 'gone'))
            }
          }),
      },
    )
    const store = createGladeStore(fake.bridge)
    const { unmount } = render(
      <GladeStoreProvider store={store}>
        <StoredImage image={{ id: 'slow', mediaType: ImageMediaType.Png }} />
      </GladeStoreProvider>,
    )
    unmount()
    await act(async () => {
      fail?.()
      await Promise.resolve()
    })
    expect(screen.queryByRole('img')).toBeNull()
  })
})
