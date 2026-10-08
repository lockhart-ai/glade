import { faChevronDown, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { accountKind, AccountKind } from '../../shared/account'
import { matchesWords } from '../../shared/textMatch'
import type {
  OpenRouterActions,
  OpenRouterChoice,
  OpenRouterModel,
  OpenRouterProvider,
  OpenRouterStatus,
  OpenRouterSelection,
} from '../../shared/openrouter'
import {
  Button,
  ButtonSize,
  ButtonVariant,
  Icon,
  IconSize,
  Input,
  Menu,
  MenuAnchorKind,
  MenuEntryKind,
  Placement,
  type MenuEntry,
} from '../components'
import { describeFailure } from '../store/hydrate'
import { classNames } from '../components/classNames'
import { useGladeStore } from '../store/react'
import { Intro, SettingRow } from './SettingsSections'
import { SettingSelect } from './SettingSelect'
import { SettingsSection } from './sections'
import styles from './ModelsSection.module.css'

const EMPTY: OpenRouterStatus = { connected: false, models: [], providers: [], choices: [] }

/** Key entry and model curation in the existing Settings surface, designs 56–57. */
export function ModelsSection(): React.JSX.Element {
  const actions = useGladeStore((state) => state.openrouter)
  const account = useGladeStore((state) => state.accountStatus.account)
  const openSettings = useGladeStore((state) => state.openSettings)
  const openLink = useGladeStore((state) => state.openLink)
  const [status, setStatus] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [key, setKey] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [filteredIds, setFilteredIds] = useState<readonly string[] | null>(null)
  const onSelectionSaved = useCallback((selection: OpenRouterSelection) => {
    setStatus((previous) => ({ ...previous, choices: selection.choices }))
  }, [])

  useEffect(() => {
    let active = true
    void actions.status().then(
      (value) => {
        if (active) {
          setStatus(value)
          setLoading(false)
        }
      },
      (failure: unknown) => {
        if (active) {
          setError(describeFailure(failure))
          setLoading(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [actions])

  const run = (operation: () => Promise<OpenRouterStatus>): void => {
    setBusy(true)
    setError(null)
    void operation()
      .then(
        (value) => {
          setStatus(value)
          setKey('')
          setEditing(false)
          setFilter('')
          setFilteredIds(null)
        },
        (failure: unknown) => {
          setError(describeFailure(failure))
        },
      )
      .finally(() => {
        setBusy(false)
      })
  }

  useEffect(() => {
    if (filter === '') return
    let active = true
    void actions.providerModels(filter).then(
      (ids) => {
        if (active) setFilteredIds(ids)
      },
      (failure: unknown) => {
        if (active) setError(describeFailure(failure))
      },
    )
    return () => {
      active = false
    }
  }, [actions, filter])

  // The models whose box is checked: they lead in their own Selected section (design 60), named alphabetically.
  const selected = useMemo(
    () =>
      status.choices
        .filter(({ enabled }) => enabled)
        .map(({ model }) => model)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [status.choices],
  )
  const enabledIds = useMemo(() => new Set(selected.map(({ id }) => id)), [selected])
  // The catalog, without the models that are selected, to the search's every word and the provider filter.
  const models = status.models.filter(
    (model) =>
      !enabledIds.has(model.id) &&
      matchesWords(search, model.id, model.name, model.description) &&
      (filter === '' || filteredIds?.includes(model.id)),
  )
  // The filter's providers, alphabetised (design 62), whatever order the catalog keeps them in.
  const providers = useMemo(
    () => [...status.providers].sort((a, b) => a.name.localeCompare(b.name)),
    [status.providers],
  )
  const enabled = selected.length
  return (
    <>
      <Intro>Choose which models appear in tasks. Changes save automatically.</Intro>
      <SettingRow name="Anthropic" description="Uses your Claude Code account.">
        <span
          className={account !== null && accountKind(account) !== AccountKind.NotSignedIn ? styles.status : styles.note}
        >
          {account === null
            ? 'Not yet read'
            : accountKind(account) === AccountKind.NotSignedIn
              ? 'Not signed in'
              : 'Connected'}
        </span>
        <Button
          size={ButtonSize.Small}
          variant={ButtonVariant.Ghost}
          onClick={() => {
            openSettings(SettingsSection.General)
          }}
        >
          Manage
        </Button>
      </SettingRow>
      <SettingRow name="OpenRouter" description="Use an API key for models billed through OpenRouter.">
        {loading ? (
          <span className={styles.note}>Loading models…</span>
        ) : status.connected && !editing ? (
          <div className={styles.actions}>
            <span className={styles.status}>Connected</span>
            <Button
              size={ButtonSize.Small}
              disabled={busy}
              onClick={() => {
                setEditing(true)
              }}
            >
              Replace key
            </Button>
            <Button
              size={ButtonSize.Small}
              variant={ButtonVariant.Ghost}
              disabled={busy}
              onClick={() => {
                run(() => actions.remove())
              }}
            >
              Remove
            </Button>
          </div>
        ) : (
          <form
            className={styles.actions}
            onSubmit={(event) => {
              event.preventDefault()
              run(() => actions.connect(key.trim()))
            }}
          >
            <Input
              className={styles.key}
              label="OpenRouter API key"
              type="password"
              placeholder="API key"
              autoComplete="off"
              value={key}
              onChange={(event) => {
                setKey(event.target.value)
              }}
              disabled={busy}
            />
            <Button
              type="submit"
              size={ButtonSize.Small}
              variant={ButtonVariant.Primary}
              disabled={busy || key.trim() === ''}
            >
              {busy ? 'Connecting…' : status.connected ? 'Save key' : 'Connect'}
            </Button>
            {editing && (
              <Button
                size={ButtonSize.Small}
                variant={ButtonVariant.Ghost}
                disabled={busy}
                onClick={() => {
                  setKey('')
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
            )}
          </form>
        )}
      </SettingRow>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!status.connected ? (
        <p className={styles.note}>
          Connect a key to discover available providers and models. Your Claude account stays active.
        </p>
      ) : (
        <>
          <div className={classNames(styles.group, styles.groupBar)}>
            <span>Selected · {String(enabled)}</span>
            <Button
              size={ButtonSize.Small}
              variant={ButtonVariant.Ghost}
              disabled={busy}
              onClick={() => {
                run(() => actions.refresh())
              }}
            >
              Refresh
            </Button>
          </div>
          {selected.length > 0 && (
            <div className={styles.models}>
              {selected.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  choices={status.choices}
                  actions={actions}
                  disabled={busy}
                  onSaved={onSelectionSaved}
                  compact
                />
              ))}
            </div>
          )}
          <div className={styles.group}>Catalog</div>
          <p className={styles.note}>
            The catalog follows your OpenRouter preferences. Detected providers are hosting options; configured provider
            credentials are managed in OpenRouter.
          </p>
          <div className={styles.search}>
            <Input
              label="Search models"
              placeholder="Search models"
              icon={faMagnifyingGlass}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
            />
            <SettingSelect
              name="Filter providers"
              menuLabel="Filter providers"
              options={[
                { value: '', label: 'All providers' },
                ...providers.map(({ id, name }) => ({ value: id, label: name })),
              ]}
              value={filter}
              searchPlaceholder="Search providers…"
              scrollable
              onChoose={(value) => {
                setFilter(value)
                setFilteredIds(null)
                setError(null)
              }}
            />
          </div>
          <div className={styles.columns}>
            <span>Model · USD per 1M tokens</span>
            <span>Provider</span>
          </div>
          <div className={styles.models}>
            {models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                choices={status.choices}
                actions={actions}
                disabled={busy}
                onSaved={onSelectionSaved}
              />
            ))}
          </div>
          <p className={styles.note}>
            {filter !== '' && filteredIds === null
              ? 'Discovering models for this provider…'
              : `${String(models.length)} matching models`}
            <br />
            Tasks use the provider selected here.{' '}
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                void openLink('https://openrouter.ai/settings/integrations')
              }}
            >
              Manage provider credentials in OpenRouter ↗
            </button>
          </p>
        </>
      )}
    </>
  )
}

interface ModelRowProps {
  readonly model: OpenRouterModel
  readonly choices: readonly OpenRouterChoice[]
  readonly actions: OpenRouterActions
  readonly disabled: boolean
  readonly onSaved: (selection: OpenRouterSelection) => void
  /** The compact row of the Selected section (design 60). */
  readonly compact?: boolean
}

const ModelRow = memo(function ModelRow({
  model,
  choices,
  actions,
  disabled,
  onSaved,
  compact = false,
}: ModelRowProps): React.JSX.Element {
  const saved =
    choices.find((choice) => choice.model.id === model.id && choice.enabled) ??
    choices.find((choice) => choice.model.id === model.id)
  const [provider, setProvider] = useState<OpenRouterProvider | null>(null)
  const selected = provider ?? saved?.provider ?? null
  const metadata = saved !== undefined && saved.provider.id === selected?.id ? saved.model : model
  const checked = choices.some(
    (choice) => choice.model.id === model.id && choice.provider.id === selected?.id && choice.enabled,
  )
  const [providers, setProviders] = useState<readonly OpenRouterProvider[]>([])
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onError = (failure: unknown): void => {
    setError(describeFailure(failure))
  }
  const change = (next: OpenRouterProvider, enabled: boolean): void => {
    setBusy(true)
    setError(null)
    void actions
      .select({ model: model.id, provider: next.id, enabled })
      .then((value) => {
        setProvider(next)
        onSaved(value)
      }, onError)
      .finally(() => {
        setBusy(false)
      })
  }
  const menu: MenuEntry[] = providers.map((next) => ({
    kind: MenuEntryKind.Item,
    label: next.name,
    checked: selected?.id === next.id,
    onSelect: () => {
      change(next, checked)
    },
  }))
  return (
    <div className={classNames(styles.model, compact && styles.compact)}>
      <input
        type="checkbox"
        aria-label={`Enable ${model.name}`}
        checked={checked}
        disabled={disabled || busy || selected === null}
        onChange={(event) => {
          if (selected !== null) change(selected, event.target.checked)
        }}
      />
      <div className={styles.copy}>
        <span>{model.name}</span>
        <small>
          {Math.round(metadata.contextLength / 1000)}K context · ${price(metadata.inputPrice)} in / $
          {price(metadata.outputPrice)} out{model.inputs.includes('image') ? ' · Images' : ''}
        </small>
        {error !== null && (
          <span role="alert" className={styles.error}>
            {error}
          </span>
        )}
      </div>
      <button
        type="button"
        className={styles.provider}
        aria-label={`Provider for ${model.name}: ${selected?.name ?? 'Select provider'}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        disabled={disabled || busy}
        onClick={(event) => {
          const element = event.currentTarget
          setBusy(true)
          setError(null)
          void actions
            .endpoints(model.id)
            .then((value) => {
              setProviders(value)
              if (value.length === 0) onError(new Error('No tool-capable provider is available for this model.'))
              else setAnchor(element)
            }, onError)
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        {selected?.name ?? (busy ? 'Discovering…' : 'Select provider')}
        <Icon icon={faChevronDown} size={IconSize.Small} />
      </button>
      {anchor !== null && (
        <Menu
          label={`Provider for ${model.name}`}
          entries={menu}
          anchor={{ kind: MenuAnchorKind.Element, element: anchor, placement: Placement.BottomEnd }}
          open
          searchPlaceholder="Search providers…"
          scrollable
          onClose={() => {
            setAnchor(null)
          }}
        />
      )}
    </div>
  )
})

function price(value: string): string {
  return (Number(value) * 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 3 })
}
