import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import type { OpenRouterUsageStatus } from '../../shared/openrouter'
import { SAMPLE_USAGE } from '../../shared/test-openrouter'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, type FakeHandlers } from '../store/test-bridge'
import { UsageMeter } from './UsageMeter'
import { openRouterUsageFraction } from './OpenRouterUsageMeter'

async function show(status: OpenRouterUsageStatus, overrides: Partial<FakeHandlers> = {}, apiAccount = false) {
  const fake = fakeBridge(
    {
      tasks: [],
      workspaces: [],
      uiState: [],
      openrouterUsage: status,
      ...(apiAccount
        ? {
            accountStatus: {
              account: {
                email: null,
                organization: null,
                subscriptionType: null,
                tokenSource: null,
                apiKeySource: 'ANTHROPIC_API_KEY',
                apiProvider: 'firstParty',
                readAt: 1,
              },
              usage: [],
            },
          }
        : {}),
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <UsageMeter />
    </GladeStoreProvider>,
  )
  return { ...fake, store }
}
const STATUS: OpenRouterUsageStatus = { connected: true, reading: { ...SAMPLE_USAGE, readAt: Date.now() }, error: null }
async function open(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'OpenRouter usage' }))
  await settleFloating()
  return screen.getByRole('dialog', { name: 'OpenRouter usage' })
}

it('keeps OpenRouter beside Claude and shows all key spend, its actual allowance and BYOK in a separate popover', async () => {
  const { invoke } = await show(STATUS)
  expect(screen.getByRole('button', { name: 'Usage' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'OpenRouter usage' })).toHaveTextContent('OpenRouter$8.00left')
  const dialog = await open()
  expect(within(dialog).getByRole('group', { name: 'Today · UTC' })).toHaveTextContent('$0.25')
  expect(within(dialog).getByRole('group', { name: 'This week · UTC' })).toHaveTextContent('$1.50')
  expect(within(dialog).getByRole('group', { name: 'This month · UTC' })).toHaveTextContent('$12.00')
  expect(within(dialog).getByRole('group', { name: 'All time' })).toHaveTextContent('$12.345678')
  const limit = within(dialog).getByRole('group', { name: 'Key spending limit' })
  expect(limit).toHaveTextContent('Key limit$20.00$8.00 remaining · monthly reset')
  expect(limit.querySelector('[aria-hidden] > span')).toHaveStyle({ width: '60%' })
  expect(within(dialog).getByRole('group', { name: 'BYOK spend' })).toHaveTextContent(
    '$0.40$2.00 all time · outside key limit',
  )
  expect(dialog).toHaveTextContent('including outside Glade')
  expect(dialog).toHaveTextContent('management key')
  expect(invoke).toHaveBeenCalledWith(CommandName.OpenRouterRefreshUsage, { force: false })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }))
  await settleFloating()
  expect(invoke).toHaveBeenCalledWith(CommandName.OpenRouterRefreshUsage, { force: true })
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await settleFloating()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows an uncapped key with precise small-model spend even when Claude uses an API key', async () => {
  const reading = {
    ...SAMPLE_USAGE,
    readAt: Date.now() - 120_000,
    monthly: 0.000081,
    limit: null,
    remaining: null,
    limitReset: null,
    byokTotal: 0,
  }
  await show({ ...STATUS, reading }, {}, true)
  expect(screen.queryByRole('button', { name: 'Usage' })).toBeNull()
  expect(screen.getByRole('button', { name: 'OpenRouter usage' })).toHaveTextContent('$0.000081month')
  const dialog = await open()
  expect(within(dialog).getByRole('group', { name: 'Key spending limit' })).toHaveTextContent('No cap')
  expect(dialog.querySelector('[aria-hidden] > span')).toBeNull()
  expect(within(dialog).queryByRole('group', { name: 'BYOK spend' })).toBeNull()
  expect(dialog).toHaveTextContent('updated 2 min ago')
})

it('keeps unknown and failed readings distinct from zero and hides usage after key removal', async () => {
  const { emit } = await show(
    { connected: true, reading: null, error: null },
    {
      [CommandName.OpenRouterRefreshUsage]: () => Promise.reject(new Error('IPC failure')),
    },
  )
  expect(screen.getByRole('button', { name: 'OpenRouter usage' })).toHaveTextContent('—not yet read')
  const dialog = await open()
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not refresh')
  expect(dialog).toHaveTextContent('Usage has not been read yet')
  act(() => {
    emit({ type: EventType.OpenRouterUsageChanged, status: { ...STATUS, error: 'Showing the last reading.' } })
  })
  expect(dialog).toHaveTextContent('$12.345678')
  act(() => {
    emit({ type: EventType.OpenRouterUsageChanged, status: { connected: false, reading: null, error: null } })
  })
  expect(screen.queryByRole('button', { name: 'OpenRouter usage' })).toBeNull()
})

it('uses the API remaining allowance, handles zero and unknown caps, and shows BYOK-inclusive limits', async () => {
  expect(openRouterUsageFraction(null)).toBeNull()
  expect(openRouterUsageFraction({ ...SAMPLE_USAGE, remaining: null })).toBeNull()
  expect(openRouterUsageFraction({ ...SAMPLE_USAGE, limit: 0 })).toBe(1)
  expect(openRouterUsageFraction({ ...SAMPLE_USAGE, remaining: 30 })).toBe(0)
  const { emit } = await show({
    ...STATUS,
    reading: {
      ...SAMPLE_USAGE,
      remaining: -1,
      includesByok: true,
      limitReset: null,
      freeRequests: { used: 12, limit: 50, remaining: 38 },
    },
  })
  const row = screen.getByRole('button', { name: 'OpenRouter usage' })
  expect(row.className).toMatch(/limited/)
  const dialog = await open()
  expect(dialog).toHaveTextContent('included in key limit')
  expect(dialog).toHaveTextContent('38 remaining · UTC day')
  expect(within(dialog).getByRole('group', { name: 'Key spending limit' })).toHaveTextContent('-$1.00 remaining')
  fireEvent.click(row)
  await settleFloating()
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => {
    emit({ type: EventType.OpenRouterUsageChanged, status: { ...STATUS, reading: null, error: 'Usage unavailable.' } })
  })
  expect(await open()).toHaveTextContent('Usage unavailable.')
})

it('shows a credit-blocked uncapped key in the sidebar and retains the provider explanation in the popover', async () => {
  const message = 'OpenRouter requests are blocked: insufficient credits or the key spending limit was reached.'
  await show({ ...STATUS, reading: { ...SAMPLE_USAGE, limit: null, remaining: null }, error: message })
  expect(screen.getByRole('button', { name: 'OpenRouter usage' })).toHaveTextContent('blocked')
  const dialog = await open()
  expect(within(dialog).getByRole('alert')).toHaveTextContent(message)
})
