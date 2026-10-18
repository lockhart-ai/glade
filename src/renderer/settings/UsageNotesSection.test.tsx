// Settings › Usage notes: the step each kind of note is sent at, changed at once, and off.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import type { SettingsPatch } from '../../shared/settings'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, type FakeBridge, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { SettingsDialog } from './SettingsDialog'
import { SettingsSection } from './sections'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain
  /** Every settings patch the section asked main for, in order. */
  readonly patches: SettingsPatch[]
}

async function renderUsageNotes(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const patches: SettingsPatch[] = []
  const fullMain: FakeMain = { workspaces: [], tasks: [], uiState: [], copied: [] }
  const fake = fakeBridge(fullMain, {
    [CommandName.SettingsUpdate]: (request: { patch: SettingsPatch }) => {
      patches.push(request.patch)
      return { settings: { ...DEFAULT_SETTINGS, ...request.patch } }
    },
    ...overrides,
  })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <SettingsDialog />
    </GladeStoreProvider>,
  )
  act(() => {
    store.getState().openSettings(SettingsSection.UsageNotes)
  })
  await settleFloating()
  return { ...fake, store, main: fullMain, patches }
}

function plan(): HTMLElement {
  return screen.getByRole('button', { name: 'Plan usage: Every 10%' })
}

function spend(): HTMLElement {
  return screen.getByRole('button', { name: 'OpenRouter spend: Every $10' })
}

function choose(select: HTMLElement, option: string): void {
  fireEvent.click(select)
  const menu = screen.getByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: option }))
}

describe('Settings › Usage notes', () => {
  it('offers both steps at their defaults, with what they do', async () => {
    await renderUsageNotes()

    expect(screen.getByRole('heading', { name: 'Usage notes' })).toBeInTheDocument()
    expect(screen.getByText('Plan usage')).toBeInTheDocument()
    expect(
      screen.getByText('Tell the agent each time the session or the week has used this much more.'),
    ).toBeInTheDocument()
    expect(plan()).toBeInTheDocument()
    expect(spend()).toBeInTheDocument()
  })

  it('changes a step at once', async () => {
    const { patches } = await renderUsageNotes()

    choose(plan(), 'Every 20%')
    expect(patches).toEqual([{ usageNoteStepPercent: 20 }])
    expect(screen.getByRole('button', { name: 'Plan usage: Every 20%' })).toBeInTheDocument()

    choose(spend(), 'Every $25')
    expect(patches).toEqual([{ usageNoteStepPercent: 20 }, { usageNoteStepDollars: 25 }])
  })

  it('turns a step off', async () => {
    const { patches } = await renderUsageNotes()

    choose(plan(), 'Off')
    choose(spend(), 'Off')
    expect(patches).toEqual([{ usageNoteStepPercent: null }, { usageNoteStepDollars: null }])
    expect(screen.getByRole('button', { name: 'Plan usage: Off' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OpenRouter spend: Off' })).toBeInTheDocument()
  })

  it('shows a stored step that is no longer offered as it is', async () => {
    await renderUsageNotes({
      [CommandName.SettingsGet]: () => ({
        settings: { ...DEFAULT_SETTINGS, usageNoteStepPercent: 7, usageNoteStepDollars: 3 },
      }),
    })

    expect(screen.getByRole('button', { name: 'Plan usage: 7' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OpenRouter spend: 3' })).toBeInTheDocument()
  })
})
