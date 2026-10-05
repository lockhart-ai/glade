import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CommandName } from '../../shared/bridge'
import type { OpenRouterStatus } from '../../shared/openrouter'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { ToastProvider } from '../components'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, type FakeHandlers } from '../store/test-bridge'
import { ModelsSection } from './ModelsSection'
import { SettingsSection } from './sections'

const CATALOG: OpenRouterStatus = { connected: true, models: [SAMPLE_MODEL], providers: [SAMPLE_PROVIDER], choices: [] }

async function show(overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge({ tasks: [], workspaces: [], uiState: [] }, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const view = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <ModelsSection />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await settleFloating()
  return { ...fake, store, ...view }
}

it('connects a masked key, discovers a host, curates the picker and filters the catalog through main', async () => {
  const { invoke, store } = await show({
    [CommandName.OpenRouterConnect]: () => CATALOG,
    [CommandName.OpenRouterEndpoints]: () => [SAMPLE_PROVIDER],
    [CommandName.OpenRouterSelect]: ({ enabled }) => ({ ...CATALOG, choices: [{ ...SAMPLE_CHOICE, enabled }] }),
    [CommandName.OpenRouterProviderModels]: () => [SAMPLE_MODEL.id],
    [CommandName.OpenRouterRefresh]: () => ({ ...CATALOG, choices: [SAMPLE_CHOICE] }),
  })
  const key = screen.getByLabelText('OpenRouter API key')
  expect(key).toHaveAttribute('type', 'password')
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
  fireEvent.change(key, { target: { value: ' fixture-key ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Sample Flash')
  expect(invoke).toHaveBeenCalledWith(CommandName.OpenRouterConnect, { key: 'fixture-key' })
  expect(screen.queryByLabelText('OpenRouter API key')).not.toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Enable Sample Flash' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Provider for Sample Flash: Select provider' }))
  await settleFloating()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sample Host' }))
  await screen.findByRole('button', { name: 'Provider for Sample Flash: Sample Host' })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Sample Flash' }))
  await screen.findByText('1 enabled')
  expect(screen.getByRole('checkbox')).toBeChecked()
  expect(screen.getByText(/128K context/)).toHaveTextContent('$0.1 in / $0.2 out')
  fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'missing' } })
  expect(screen.queryByText('Sample Flash')).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Filter providers: All providers' }))
  await settleFloating()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sample Host' }))
  await screen.findByText('Sample Flash')
  expect(invoke).toHaveBeenCalledWith(CommandName.OpenRouterProviderModels, { provider: SAMPLE_PROVIDER.id })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('button', { name: 'Filter providers: All providers' })
  fireEvent.click(screen.getByRole('button', { name: /Manage provider credentials/ }))
  expect(invoke).toHaveBeenCalledWith(CommandName.LinksOpen, { url: 'https://openrouter.ai/settings/integrations' })
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
  expect(store.getState().settingsSection).toBe(SettingsSection.General)
  fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))
  fireEvent.change(screen.getByLabelText('OpenRouter API key'), { target: { value: 'discard' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByLabelText('OpenRouter API key')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))
  expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('')
  fireEvent.change(screen.getByLabelText('OpenRouter API key'), { target: { value: 'replacement' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  await screen.findByRole('button', { name: 'Remove' })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await screen.findByRole('button', { name: 'Connect' })
})

it('surfaces discovery and save failures and handles an empty provider list', async () => {
  const endpoints = vi
    .fn()
    .mockRejectedValueOnce(new Error('Endpoint discovery failed'))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([SAMPLE_PROVIDER])
  const select = vi.fn().mockRejectedValueOnce(new Error('Saving failed'))
  await show({
    [CommandName.OpenRouterStatus]: () => ({
      ...CATALOG,
      models: [{ ...SAMPLE_MODEL, inputs: ['text', 'image'] }],
      choices: [SAMPLE_CHOICE],
    }),
    [CommandName.OpenRouterEndpoints]: endpoints,
    [CommandName.OpenRouterSelect]: select,
    [CommandName.OpenRouterProviderModels]: () => Promise.reject(new Error('Filter failed')),
    [CommandName.OpenRouterRefresh]: () => Promise.reject(new Error('Refresh failed')),
  })
  expect(screen.getByText(/Images/)).toBeInTheDocument()
  const provider = screen.getByRole('button', { name: 'Provider for Sample Flash: Sample Host' })
  fireEvent.click(provider)
  expect(await screen.findByRole('alert')).toHaveTextContent('Endpoint discovery failed')
  fireEvent.click(provider)
  await screen.findByText('No tool-capable provider is available for this model.')
  fireEvent.click(provider)
  await settleFloating()
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sample Host' }))
  await screen.findByText('Saving failed')
  fireEvent.click(screen.getByRole('button', { name: 'Filter providers: All providers' }))
  await settleFloating()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sample Host' }))
  await screen.findByText('Filter failed')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('Refresh failed')
})

it('reports connection/status failures and ignores a status response after unmount', async () => {
  const first = await show({
    [CommandName.OpenRouterStatus]: () => Promise.reject(new Error('Status failed')),
    [CommandName.OpenRouterConnect]: () => Promise.reject(new Error('Invalid key')),
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('Status failed')
  fireEvent.change(screen.getByLabelText('OpenRouter API key'), { target: { value: 'bad' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Invalid key')
  first.unmount()
  let resolve: (status: OpenRouterStatus) => void = () => undefined
  const pending = await show({
    [CommandName.OpenRouterStatus]: () =>
      new Promise<OpenRouterStatus>((done) => {
        resolve = done
      }),
  })
  pending.unmount()
  act(() => {
    resolve(CATALOG)
  })
})
