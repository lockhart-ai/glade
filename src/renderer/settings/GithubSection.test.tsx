import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, type FakeBridge, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { INTERVAL_PROBLEM } from './GithubSection'
import { SettingsSection } from './sections'
import { SettingsDialog } from './SettingsDialog'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
}

async function renderGithub(main: Partial<FakeMain> = {}, overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fullMain: FakeMain = { workspaces: [], tasks: [], uiState: [], ...main }
  const fake = fakeBridge(fullMain, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <SettingsDialog />
    </GladeStoreProvider>,
  )
  act(() => {
    store.getState().openSettings(SettingsSection.Github)
  })
  await settleFloating()
  return { ...fake, store }
}

function interval(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Poll interval, in seconds' })
}

function toggle(name: string): HTMLElement {
  return screen.getByRole('switch', { name })
}

describe('Settings › GitHub watching', () => {
  it('is listed after Control, with the interval and every toggle on by default', async () => {
    await renderGithub()

    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const labels = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels.slice(-2)).toEqual(['Control', 'GitHub watching'])
    expect(screen.getByRole('heading', { name: 'GitHub watching' })).toBeInTheDocument()
    expect(interval()).toHaveValue(String(DEFAULT_SETTINGS.githubWatchPollSeconds))
    expect(toggle('State changes')).toBeChecked()
    expect(toggle('CI finishing')).toBeChecked()
    expect(toggle('Reviews and comments')).toBeChecked()
    expect(toggle('New commits')).toBeChecked()
  })

  it('saves a new poll interval on Return', async () => {
    const { invoke } = await renderGithub()

    fireEvent.change(interval(), { target: { value: ' 120 ' } })
    fireEvent.keyDown(interval(), { key: 'Enter' })

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { githubWatchPollSeconds: 120 } })
    })
    expect(interval()).toHaveValue('120')
  })

  it('saves a new poll interval when the field loses focus, and not when it is unchanged', async () => {
    const { invoke } = await renderGithub()

    fireEvent.blur(interval())
    fireEvent.change(interval(), { target: { value: '90' } })
    fireEvent.keyDown(interval(), { key: 'a' })
    fireEvent.blur(interval())

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { githubWatchPollSeconds: 90 } })
    })
    const updates = invoke.mock.calls.filter(([name]) => name === CommandName.SettingsUpdate)
    expect(updates).toHaveLength(1)
  })

  it.each([['14'], ['-5'], ['30.5'], ['never'], ['']])(
    'refuses %j as a poll interval, saying why, and goes back to the one it had',
    async (typed) => {
      const { invoke } = await renderGithub()

      fireEvent.change(interval(), { target: { value: typed } })
      fireEvent.blur(interval())

      expect(await screen.findByRole('alert')).toHaveTextContent(INTERVAL_PROBLEM)
      expect(interval()).toHaveValue(String(DEFAULT_SETTINGS.githubWatchPollSeconds))
      expect(invoke).not.toHaveBeenCalledWith(CommandName.SettingsUpdate, expect.anything())

      fireEvent.change(interval(), { target: { value: '45' } })
      fireEvent.blur(interval())
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
    },
  )

  it('turns each wake toggle off and back on, saving every change', async () => {
    const { invoke } = await renderGithub()

    fireEvent.click(toggle('State changes'))
    fireEvent.click(toggle('CI finishing'))
    fireEvent.click(toggle('Reviews and comments'))
    fireEvent.click(toggle('New commits'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(toggle('State changes')).not.toBeChecked()
    expect(toggle('CI finishing')).not.toBeChecked()
    expect(toggle('Reviews and comments')).not.toBeChecked()
    expect(toggle('New commits')).not.toBeChecked()
    expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { githubWatchOnStateChange: false } })
    expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { githubWatchOnChecksFinished: false } })
    expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, {
      patch: { githubWatchOnReviewsComments: false },
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { githubWatchOnNewCommits: false } })
  })
})
