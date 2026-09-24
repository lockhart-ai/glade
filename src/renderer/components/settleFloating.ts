import { act } from '@testing-library/react'

/** Lets Floating UI finish positioning an overlay and moving focus, which it does on animation frames. For tests. */
export async function settleFloating(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}
