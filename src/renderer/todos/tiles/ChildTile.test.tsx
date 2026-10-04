import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChildKind, commitChildKey, type ProducedKind } from '../../../shared/todoHub'
import type { StoreWrapper } from '../../store/test-wrapper'
import { HUB_NOW, hubCommit, hubStore, type HubTask } from '../test-hub'
import { ChildTile } from './ChildTile'
import styles from './Tile.module.css'

async function renderTile(task: HubTask, kind: ProducedKind, childKey: string): Promise<StoreWrapper> {
  const wrapper = await hubStore(task)
  render(<ChildTile taskId="t1" kind={kind} childKey={childKey} />, { wrapper: wrapper.wrapper })
  return wrapper
}

function tile(): HTMLElement {
  return screen.getByRole('group')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

// A file's and a link's tile are in `ArtifactTiles.test.tsx` (#498).

describe('a commit’s tile', () => {
  it('shows its short hash, its subject, the lines it added and removed, and its age', async () => {
    const commit = hubCommit('0c4d2e1f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d', 'Test the header under burst traffic', 8, {
      additions: 1204,
      deletions: 0,
    })
    await renderTile({ commits: [commit] }, ChildKind.Commit, commitChildKey(commit))

    expect(screen.getByRole('group', { name: 'Change: Test the header under burst traffic' })).toHaveTextContent(
      /^0c4d2e1Test the header under burst traffic\+1,204 −0 · 8m$/,
    )
    expect(screen.getByText('+1,204')).toHaveClass(styles.added ?? '')
    expect(screen.getByText('−0')).toHaveClass(styles.removed ?? '')
    expect(tile()).not.toHaveAttribute('data-live')
  })

  it('shows nothing for a commit the task hasn’t got', async () => {
    await renderTile({ commits: [] }, ChildKind.Commit, 'abc /code/api')
    expect(screen.queryByRole('group')).toBeNull()
  })
})
