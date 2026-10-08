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

const CATALOG: OpenRouterStatus = {
  connected: true,
  managementConnected: false,
  models: [SAMPLE_MODEL],
  providers: [SAMPLE_PROVIDER],
  choices: [],
}

it('keeps the catalog rows out of search and replacement-key keystrokes when their own props did not change', async () => {
  const rendered = vi.fn(() => SAMPLE_MODEL.inputPrice)
  const models = Array.from({ length: 200 }, (_, index) => ({
    ...SAMPLE_MODEL,
    id: `sample/flash-${String(index)}`,
    get inputPrice() {
      return rendered()
    },
  }))
  await show({ [CommandName.OpenRouterStatus]: () => ({ ...CATALOG, models }) })
  const initial = rendered.mock.calls.length
  expect(initial).toBe(200)
  for (const value of ['s', 'sa', 'sam', 'sample'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Replace key' }))
  for (const value of ['f', 'fi', 'fix', 'fixture'])
    fireEvent.change(screen.getByLabelText('OpenRouter API key'), { target: { value } })
  expect(rendered).toHaveBeenCalledTimes(initial)
})

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
  await screen.findByText('Selected · 1')
  expect(screen.getByRole('checkbox')).toBeChecked()
  expect(screen.getByText(/128K context/)).toHaveTextContent('$0.1 in / $0.2 out')
  fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'missing' } })
  // The selected model keeps its place above the catalog, which reports no matches.
  expect(screen.getByText('Sample Flash')).toBeInTheDocument()
  expect(await screen.findByText(/^0 matching models/)).toBeInTheDocument()
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
  // The fake's own management-key commands, which a store reaches without the section.
  await expect(store.getState().openrouter.connectManagementKey('k')).resolves.toMatchObject({
    managementConnected: true,
  })
  await expect(store.getState().openrouter.removeManagementKey()).resolves.toMatchObject({
    managementConnected: false,
  })
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
      choices: [{ ...SAMPLE_CHOICE, model: { ...SAMPLE_MODEL, inputs: ['text', 'image'] } }],
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

it('searches with every word across id, name and description, lists the Selected models first, and alphabetises the provider menus (#566)', async () => {
  const kim = { ...SAMPLE_MODEL, id: 'moonshot/kimi', name: 'Kimi Café', description: 'For routine work' }
  const glm = { ...SAMPLE_MODEL, id: 'zai/glm', name: 'GLM 5.3', description: 'Fast and cheap' }
  const grok = { ...SAMPLE_MODEL, id: 'xai/grok', name: 'Grok 5', description: 'Fast and cheap' }
  await show({
    [CommandName.OpenRouterStatus]: () => ({
      connected: true,
      managementConnected: false,
      models: [glm, kim, grok],
      providers: [
        { id: 'z-host', name: 'Z.ai' },
        { id: 'a-host', name: 'AkashML' },
        { id: 'n-host', name: 'Novita' },
      ],
      choices: [{ ...SAMPLE_CHOICE, model: glm, provider: { id: 'z-host', name: 'Z.ai' }, enabled: true }],
    }),
  })
  // The Selected model leads, named, with the catalog below it, and the filter options are alphabetised.
  expect(screen.getByText('Selected · 1')).toBeInTheDocument()
  expect(screen.getAllByText('GLM 5.3').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Filter providers: All providers' }))
  await settleFloating()
  expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
    'All providers',
    'AkashML',
    'Novita',
    'Z.ai',
  ])
  // The filter menu's own search filters its list too.
  fireEvent.change(screen.getByRole('textbox', { name: 'Search providers…' }), { target: { value: 'aka' } })
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'AkashML' }))
  await screen.findByText(/Discovering models for this provider/)
  // Back to every provider, for the search below.
  fireEvent.click(screen.getByRole('button', { name: 'Filter providers: AkashML' }))
  await settleFloating()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'All providers' }))
  // Every word of the query must appear across the model's id, name or description, diacritics folded.
  const search = screen.getByRole('textbox', { name: 'Search models' })
  fireEvent.change(search, { target: { value: 'kimi routine' } })
  expect(screen.getByText('Kimi Café')).toBeInTheDocument()
  expect(await screen.findByText(/^1 matching models/)).toBeInTheDocument()
  fireEvent.change(search, { target: { value: 'cafe' } })
  expect(await screen.findByText(/^1 matching models/)).toBeInTheDocument()
  fireEvent.change(search, { target: { value: 'kimi cheap' } })
  expect(await screen.findByText(/^0 matching models/)).toBeInTheDocument()
  // Runs of whitespace count as one break; both words land in the description.
  fireEvent.change(search, { target: { value: '  fast   cheap  ' } })
  expect(screen.getByText('Grok 5')).toBeInTheDocument()
  expect(await screen.findByText(/^1 matching models/)).toBeInTheDocument()
})

it('lists the Selected models alphabetically, however the choices were saved (#566)', async () => {
  const zai = { ...SAMPLE_MODEL, id: 'zai/glm', name: 'Z.ai GLM' }
  const akai = { ...SAMPLE_MODEL, id: 'akai/qwen', name: 'Akai Qwen' }
  await show({
    [CommandName.OpenRouterStatus]: () => ({
      connected: true,
      managementConnected: false,
      models: [zai, akai],
      providers: [SAMPLE_PROVIDER],
      choices: [
        { ...SAMPLE_CHOICE, id: 'zai', model: zai, enabled: true },
        { ...SAMPLE_CHOICE, id: 'akai', model: akai, enabled: true },
      ],
    }),
  })
  expect(screen.getByText('Selected · 2')).toBeInTheDocument()
  expect(
    screen
      .getAllByText(/^(Z\.ai GLM|Akai Qwen)$/)
      .map((element) => element.textContent)
      .filter((name, index, all) => all.indexOf(name) === index),
  ).toEqual(['Akai Qwen', 'Z.ai GLM'])
})

it('connects the optional management key, shows it connected and removes it, surfacing what main refuses (#566)', async () => {
  const { invoke } = await show({
    [CommandName.OpenRouterStatus]: () => CATALOG,
    [CommandName.OpenRouterConnectManagementKey]: ({ key }: { key: string }) =>
      key === 'bad'
        ? Promise.reject(new Error('OpenRouter returned 401. Check the management key.'))
        : { ...CATALOG, managementConnected: true },
    [CommandName.OpenRouterRemoveManagementKey]: () => CATALOG,
  })
  await screen.findByText('Selected · 0')
  // The optional management key sits nested under the OpenRouter key, with its own field. Its row's buttons sit
  // after the OpenRouter row's, which has a Replace key and a Remove of its own.
  expect(screen.getByText('Management key')).toBeInTheDocument()
  expect(screen.getByText('Optional')).toBeInTheDocument()
  expect(screen.getByText(/Reads your guardrails/)).toBeInTheDocument()
  const field = screen.getByLabelText('OpenRouter management key')
  expect(field).toHaveAttribute('type', 'password')
  fireEvent.change(field, { target: { value: 'bad' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('OpenRouter returned 401. Check the management key.')
  expect(invoke).toHaveBeenCalledWith(CommandName.OpenRouterConnectManagementKey, { key: 'bad' })
  expect(screen.getByText('Management key')).toBeInTheDocument()

  fireEvent.change(field, { target: { value: ' good-key ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByText('Connected')
  expect(invoke).toHaveBeenCalledWith(CommandName.OpenRouterConnectManagementKey, { key: 'good-key' })
  expect(screen.queryByLabelText('OpenRouter management key')).not.toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Replace key' })).toHaveLength(2)

  const replaceKey = screen.getAllByRole('button', { name: 'Replace key' }).at(-1) as HTMLButtonElement
  fireEvent.click(replaceKey)
  expect(screen.getByLabelText('OpenRouter management key')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByLabelText('OpenRouter management key')).not.toBeInTheDocument()
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove' }).at(-1) as HTMLButtonElement)
  await screen.findByRole('button', { name: 'Connect' })
  expect(invoke).toHaveBeenCalledWith(CommandName.OpenRouterRemoveManagementKey, {})
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
  expect(screen.getByText('Loading models…')).toBeInTheDocument()
  expect(screen.queryByLabelText('OpenRouter API key')).not.toBeInTheDocument()
  pending.unmount()
  act(() => {
    resolve(CATALOG)
  })
})
