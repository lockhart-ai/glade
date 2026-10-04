/**
 * The sandbox in Settings (P15-06, #451; `docs/design/html/39-settings-sandbox.html`, `40-settings-sandbox-states.html`
 * and `41-settings-workspace-sandbox.html`): its heading, with the shield, and the Folders and Domains lists of one
 * scope, the Glade-wide ones in Settings › Agent or a workspace's in Settings › Workspace. Under them, a third list,
 * **MCP servers** (#515): the servers Glade doesn't build that the scope's agents may use, and whether they may reach
 * other agents. It has no design of its own: it's built from the other two lists' parts.
 *
 * - Each list has its name, a line on what it's for and **Add…**, over a bordered box of rows: a granted folder with
 *   its access (a select: Read-only or Read-write) and a remove button, a domain with a remove button. A workspace's
 *   Folders start with its root, tagged, read-write and fixed.
 * - **Add…** for a folder opens the macOS folder picker, then a highlighted row with the folder, its access (read-only
 *   to start), Add and Cancel. For a domain it opens a row with a field, Add and Cancel; ↵ adds and Esc cancels. What
 *   main refuses (`sandbox.addGrant`) shows under the list, with why, and the row stays open. For an MCP server it
 *   opens a row with a select of what there is to add (the servers the scope's sessions have reported, by name, then
 *   the other agents), Add and Cancel; with nothing left to add, the line under the list says so.
 * - The lists are main's: read as they open (`sandbox.listGrants`) and kept current by its broadcasts
 *   (`sandbox.grantsChanged`), so a grant made on a permission card shows while Settings is open, and a change here
 *   shows once it's saved, never before.
 * - While the sandbox is off, the lists dim and nothing in them can be changed; the grants are kept.
 * - The keyboard reaches everything: a chosen folder's Add and a new domain's field take the focus as their row
 *   opens, and Add… takes it back when the row closes or a row is removed.
 */
import { faFolder } from '@fortawesome/free-regular-svg-icons'
import { faCloud, faComments, faGlobe, faPlug, faShield, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { BridgeErrorCode, isBridgeError } from '../../shared/bridge'
import { MCP_TOOL_PREFIX, mcpServerLabel, type ReportedMcpServer } from '../../shared/mcpServers'
import {
  FOLDER_ACCESS_LABELS,
  FolderAccess,
  OTHER_AGENTS_LABELS,
  OTHER_AGENTS_TOOLS,
  OtherAgents,
  SandboxGrantKind,
  SandboxGrantScope,
  settingsGrantScopeKey,
  type AgentsGrant,
  type DomainGrant,
  type FolderGrant,
  type Grant,
  type GrantKey,
  type McpServerGrant,
  type SettingsGrantTarget,
} from '../../shared/sandbox'
import { Button, ButtonSize, ButtonVariant, Icon, IconSize, Input } from '../components'
import { classNames } from '../components/classNames'
import { shortenHomePath } from '../paths'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { SettingSelect, type SettingSelectOption } from './SettingSelect'
import styles from './SettingsDialog.module.css'

/** What main puts before the words of a refusal from a `sandbox.*` command, which the line under a list leaves out. */
const REFUSAL_PREFIX = /^sandbox\.\w+: /

/**
 * What the line under a list says when a change didn't happen: main's own words when it refused the folder or domain
 * (not one the sandbox can take, already in the list, inside the workspace), else what went wrong.
 */
export function grantFailureMessage(error: unknown): string {
  if (isBridgeError(error) && error.code === BridgeErrorCode.InvalidRequest) {
    return error.message.replace(REFUSAL_PREFIX, '')
  }
  return describeFailure(error)
}

/** What Add says of a blank domain field, without asking main. */
export const BLANK_DOMAIN = 'Enter a domain, like example.com or *.example.com.'

const ACCESS_OPTIONS: readonly SettingSelectOption<FolderAccess>[] = [
  { value: FolderAccess.Read, label: FOLDER_ACCESS_LABELS[FolderAccess.Read] },
  { value: FolderAccess.ReadWrite, label: FOLDER_ACCESS_LABELS[FolderAccess.ReadWrite] },
]

/** The words of one list: what it's for, and what its controls are named. */
interface ListText {
  /** A line on what the list is for, under its name. */
  readonly description: string
  /** The accessible name of its Add… button. */
  readonly add: string
  /** The accessible name of the list. */
  readonly list: string
}

/** What Add says when a scope's MCP servers list has nothing left to add. */
export const NOTHING_TO_ADD: Readonly<Record<SettingsGrantTarget['scope'], string>> = {
  [SandboxGrantScope.Glade]:
    'Nothing to add: no task has used an MCP server that isn’t listed yet. A server shows here once a task’s session reports it.',
  [SandboxGrantScope.Workspace]:
    'Nothing to add: this workspace’s tasks haven’t used an MCP server that isn’t listed yet. A server shows here once a task’s session reports it.',
}

/** The words of a scope's lists and notes. */
interface ScopeText {
  readonly folders: ListText
  readonly domains: ListText
  readonly servers: ListText
  /** The line under the lists while the sandbox is on; none for a workspace's. */
  readonly note: string | null
  /** The line under them while it's off. */
  readonly offNote: string
}

const SCOPE_TEXT: Readonly<Record<SettingsGrantTarget['scope'], ScopeText>> = {
  [SandboxGrantScope.Glade]: {
    folders: {
      description: 'Folders the agents in every workspace can use, like a toolchain they all need.',
      add: 'Add a Glade-wide folder',
      list: 'Glade-wide folders',
    },
    domains: {
      description: 'Domains the agents in every workspace can reach, from their commands and web fetches.',
      add: 'Add a Glade-wide domain',
      list: 'Glade-wide domains',
    },
    servers: {
      description: 'MCP servers the agents in every workspace can use, and the other agents they can reach.',
      add: 'Add a Glade-wide MCP server',
      list: 'Glade-wide MCP servers',
    },
    note: 'Each workspace has its own folders, domains and MCP servers too, in its settings under Workspace.',
    offNote:
      'While the sandbox is off, agents can use any folder and MCP server and reach any domain, as before. These lists apply again when it’s back on.',
  },
  [SandboxGrantScope.Workspace]: {
    folders: {
      description: 'The workspace root, then the folders you’ve allowed.',
      add: 'Add a folder',
      list: 'Folders',
    },
    domains: { description: 'The domains you’ve allowed.', add: 'Add a domain', list: 'Domains' },
    servers: {
      description: 'The MCP servers you’ve allowed, and the other agents its agents can reach.',
      add: 'Add an MCP server',
      list: 'MCP servers',
    },
    note: null,
    offNote: 'The sandbox is off in Agent, so these are dimmed too. They apply again when it’s back on.',
  },
}

export interface SandboxHeadingProps {
  /** The heading's id, for the group it names. */
  id: string
}

/** The Sandbox group's heading: the shield, always filled, in the heading's own grey (a heading has no state). */
export function SandboxHeading({ id }: SandboxHeadingProps): React.JSX.Element {
  return (
    <h3 id={id} className={classNames(styles.groupHeading, styles.sandboxHeading)}>
      <Icon icon={faShield} size={IconSize.Small} />
      Sandbox
    </h3>
  )
}

/** Why a list's last change didn't happen (null for nothing to say), and what runs a change and keeps why it failed. */
interface Attempts {
  readonly error: string | null
  readonly setError: (error: string | null) => void
  /** Runs a change, keeping why if main refuses it. Resolves with whether it went through. */
  readonly attempt: (change: () => Promise<void>) => Promise<boolean>
}

/** A list's changes, each one clearing the last one's failure and keeping its own. */
function useAttempts(): Attempts {
  const [error, setError] = useState<string | null>(null)
  const attempt = useCallback(async (change: () => Promise<void>): Promise<boolean> => {
    setError(null)
    try {
      await change()
      return true
    } catch (failure) {
      setError(grantFailureMessage(failure))
      return false
    }
  }, [])
  return { error, setError, attempt }
}

interface ListHeaderProps {
  name: string
  text: ListText
  disabled: boolean
  /** The Add… button, to give the focus back to once a row is added, cancelled or removed. */
  addButton: Ref<HTMLButtonElement>
  onAdd: () => void
}

/** A list's name and what it's for, with Add… on the right. */
function ListHeader({ name, text, disabled, addButton, onAdd }: ListHeaderProps): React.JSX.Element {
  return (
    <div className={classNames(styles.grantListHeader, disabled && styles.dimmed)}>
      <div className={styles.rowText}>
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowDescription}>{text.description}</span>
      </div>
      <Button ref={addButton} size={ButtonSize.Small} aria-label={text.add} disabled={disabled} onClick={onAdd}>
        Add…
      </Button>
    </div>
  )
}

interface GrantRowProps {
  /** What names the row: the folder or domain as shown, or what's being added. */
  label: string
  icon: IconDefinition
  /** The row being added, highlighted, rather than one of the list's. */
  pending?: boolean
  /** What follows the icon: the value, then its access, its remove button, or Add and Cancel. */
  children: ReactNode
}

/** One row of a list: its icon, then the folder or domain and its controls. */
function GrantRow({ label, icon, pending = false, children }: GrantRowProps): React.JSX.Element {
  return (
    <div role="listitem" aria-label={label} className={classNames(styles.grantRow, pending && styles.grantPending)}>
      <span className={styles.grantIcon} aria-hidden="true">
        <Icon icon={icon} />
      </span>
      {children}
    </div>
  )
}

interface GrantValueProps {
  /** The folder or domain as shown: a folder under the home folder starts with `~`. */
  shown: string
  /** The whole value, shown on hover when the row cuts it short. */
  value: string
  /** Whether it's a name in words rather than a path or a host: set as the rest of Settings is, not in mono. */
  words?: boolean
}

/** A row's folder or domain, in mono, cut short with an ellipsis when it's longer than the row. */
function GrantValue({ shown, value, words = false }: GrantValueProps): React.JSX.Element {
  return (
    <span className={classNames(styles.grantValue, words && styles.grantWords)} title={value}>
      {shown}
    </span>
  )
}

interface FolderRowProps {
  path: string
  access: FolderAccess
  disabled: boolean
  onAccess: (path: string, access: FolderAccess) => void
  onRemove: (path: string) => void
}

/**
 * A granted folder: its path, its access in a select, and its remove button. Memoised on the folder and its access,
 * so a change to one row of a long list draws that row alone.
 */
const FolderRow = memo(function FolderRow({ path, access, disabled, onAccess, onRemove }: FolderRowProps) {
  const shown = shortenHomePath(path)
  return (
    <GrantRow label={shown} icon={faFolder}>
      <GrantValue shown={shown} value={path} />
      <SettingSelect
        name={`Access to ${shown}`}
        menuLabel="Access"
        options={ACCESS_OPTIONS}
        value={access}
        disabled={disabled}
        onChoose={(chosen) => {
          onAccess(path, chosen)
        }}
      />
      <Button
        variant={ButtonVariant.Icon}
        icon={faXmark}
        aria-label={`Remove ${shown}`}
        title={`Remove ${shown}`}
        disabled={disabled}
        onClick={() => {
          onRemove(path)
        }}
      />
    </GrantRow>
  )
})

interface DomainRowProps {
  domain: string
  disabled: boolean
  onRemove: (domain: string) => void
}

/** A granted domain, and its remove button. Memoised on the domain, as a folder's row is. */
const DomainRow = memo(function DomainRow({ domain, disabled, onRemove }: DomainRowProps) {
  return (
    <GrantRow label={domain} icon={faGlobe}>
      <GrantValue shown={domain} value={domain} />
      <Button
        variant={ButtonVariant.Icon}
        icon={faXmark}
        aria-label={`Remove ${domain}`}
        title={`Remove ${domain}`}
        disabled={disabled}
        onClick={() => {
          onRemove(domain)
        }}
      />
    </GrantRow>
  )
})

interface RootRowProps {
  /** The workspace's root folder. */
  root: string
}

/** A workspace's root, first in its Folders: tagged, read-write, and with nothing to change or remove. */
function RootRow({ root }: RootRowProps): React.JSX.Element {
  const shown = shortenHomePath(root)
  return (
    <GrantRow label={shown} icon={faFolder}>
      <GrantValue shown={shown} value={root} />
      <span className={styles.rootTag}>Workspace root</span>
      <span className={styles.rootAccess}>{FOLDER_ACCESS_LABELS[FolderAccess.ReadWrite]}</span>
      <span className={styles.rootSpacer} aria-hidden="true" />
    </GrantRow>
  )
}

interface EmptyRowProps {
  /** What the list says of having nothing; null while its grants aren't read yet, when it says nothing. */
  children: string | null
}

/** The one row of a list with nothing in it. */
function EmptyRow({ children }: EmptyRowProps): React.JSX.Element {
  return (
    <div className={styles.grantRow}>
      <span className={styles.grantEmpty}>{children}</span>
    </div>
  )
}

interface GrantErrorProps {
  /** Why the last change didn't happen; null for nothing to say. */
  message: string | null
}

/** Why a list's last change didn't happen, under the list. */
function GrantError({ message }: GrantErrorProps): React.JSX.Element | null {
  if (message === null) return null
  return (
    <p role="alert" className={styles.grantError}>
      {message}
    </p>
  )
}

interface GrantListProps<Kind extends Grant> {
  target: SettingsGrantTarget
  /** The scope's grants of this list's kind; null until they're read. */
  grants: readonly Kind[] | null
  /** Whether the sandbox is off: the list dims and nothing in it can be changed. */
  disabled: boolean
  text: ListText
}

/** A folder chosen in the folder picker, waiting on Add: the row under the list's. */
interface PendingFolder {
  readonly path: string
  readonly access: FolderAccess
}

interface FolderListProps extends GrantListProps<FolderGrant> {
  /** The workspace's root, listed first; null for the Glade-wide list. */
  root: string | null
}

/** A scope's Folders: the workspace root, the granted folders, and the folder being added. */
function FolderList({ target, grants, disabled, text, root }: FolderListProps): React.JSX.Element {
  const chooseFolder = useGladeStore((state) => state.chooseFolder)
  const addGrant = useGladeStore((state) => state.addSandboxGrant)
  const setAccess = useGladeStore((state) => state.setSandboxFolderAccess)
  const removeGrant = useGladeStore((state) => state.removeSandboxGrant)
  const [pending, setPending] = useState<PendingFolder | null>(null)
  const { error, setError, attempt } = useAttempts()
  const addButton = useRef<HTMLButtonElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  // The row waits out of sight while the sandbox is off.
  const adding = disabled ? null : pending
  const addingPath = adding?.path ?? null

  // A folder just chosen: Add has the focus, so ↵ adds it.
  useEffect(() => {
    if (addingPath !== null) confirmButton.current?.focus()
  }, [addingPath])

  const pick = (): void => {
    void attempt(async () => {
      const path = await chooseFolder()
      if (path !== null) setPending({ path, access: FolderAccess.Read })
    })
  }

  const close = (): void => {
    setPending(null)
    setError(null)
    addButton.current?.focus()
  }

  const confirm = async (folder: PendingFolder): Promise<void> => {
    if (await attempt(() => addGrant(target, { kind: SandboxGrantKind.Folder, ...folder }))) close()
  }

  const changeAccess = useCallback(
    (path: string, access: FolderAccess): void => {
      void attempt(() => setAccess(target, path, access))
    },
    [attempt, setAccess, target],
  )

  const remove = useCallback(
    (path: string): void => {
      // The row's own button goes with it, so Add… takes the focus.
      addButton.current?.focus()
      void attempt(() => removeGrant(target, { kind: SandboxGrantKind.Folder, path }))
    },
    [attempt, removeGrant, target],
  )

  const empty = root === null && adding === null && (grants === null || grants.length === 0)
  return (
    <>
      <ListHeader name="Folders" text={text} disabled={disabled} addButton={addButton} onAdd={pick} />
      <div
        role="list"
        aria-label={text.list}
        aria-busy={grants === null}
        className={classNames(styles.grantList, disabled && styles.dimmed)}
      >
        {root !== null && <RootRow root={root} />}
        {grants?.map((grant) => (
          <FolderRow
            key={grant.path}
            path={grant.path}
            access={grant.access}
            disabled={disabled}
            onAccess={changeAccess}
            onRemove={remove}
          />
        ))}
        {empty && <EmptyRow>{grants === null ? null : 'No folders yet.'}</EmptyRow>}
        {adding !== null && (
          <GrantRow key={adding.path} label={`New folder ${shortenHomePath(adding.path)}`} icon={faFolder} pending>
            <GrantValue shown={shortenHomePath(adding.path)} value={adding.path} />
            <SettingSelect
              name={`Access to ${shortenHomePath(adding.path)}`}
              menuLabel="Access"
              options={ACCESS_OPTIONS}
              value={adding.access}
              onChoose={(access) => {
                setPending({ path: adding.path, access })
              }}
            />
            <Button
              ref={confirmButton}
              variant={ButtonVariant.Primary}
              size={ButtonSize.Small}
              onClick={() => void confirm(adding)}
            >
              Add
            </Button>
            <Button variant={ButtonVariant.Ghost} size={ButtonSize.Small} onClick={close}>
              Cancel
            </Button>
          </GrantRow>
        )}
      </div>
      {!disabled && <GrantError message={error} />}
    </>
  )
}

/** A scope's Domains: the granted domains, and the one being typed in. */
function DomainList({ target, grants, disabled, text }: GrantListProps<DomainGrant>): React.JSX.Element {
  const addGrant = useGladeStore((state) => state.addSandboxGrant)
  const removeGrant = useGladeStore((state) => state.removeSandboxGrant)
  /** What's typed in the new domain's field; null while there's no such row. */
  const [draft, setDraft] = useState<string | null>(null)
  const { error, setError, attempt } = useAttempts()
  const addButton = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  // The row waits out of sight while the sandbox is off.
  const adding = disabled ? null : draft
  const open = adding !== null

  // The row just opened: its field has the focus.
  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  const close = (): void => {
    setDraft(null)
    setError(null)
    addButton.current?.focus()
  }

  const confirm = async (domain: string): Promise<void> => {
    if (domain.trim() === '') {
      setError(BLANK_DOMAIN)
    } else if (await attempt(() => addGrant(target, { kind: SandboxGrantKind.Domain, domain }))) {
      close()
      return
    }
    // Refused: back to the field, to put it right.
    field.current?.focus()
  }

  const remove = useCallback(
    (domain: string): void => {
      // The row's own button goes with it, so Add… takes the focus.
      addButton.current?.focus()
      void attempt(() => removeGrant(target, { kind: SandboxGrantKind.Domain, domain }))
    },
    [attempt, removeGrant, target],
  )

  return (
    <>
      <ListHeader
        name="Domains"
        text={text}
        disabled={disabled}
        addButton={addButton}
        onAdd={() => {
          // Open already, Add… goes back to its field.
          if (draft === null) setDraft('')
          else field.current?.focus()
        }}
      />
      <div
        role="list"
        aria-label={text.list}
        aria-busy={grants === null}
        className={classNames(styles.grantList, disabled && styles.dimmed)}
      >
        {grants?.map((grant) => (
          <DomainRow key={grant.domain} domain={grant.domain} disabled={disabled} onRemove={remove} />
        ))}
        {adding === null && (grants === null || grants.length === 0) && (
          <EmptyRow>{grants === null ? null : 'No domains yet.'}</EmptyRow>
        )}
        {adding !== null && (
          <GrantRow label="New domain" icon={faGlobe} pending>
            <Input
              ref={field}
              label="Domain"
              placeholder="example.com"
              className={styles.domainField}
              value={adding}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => {
                setDraft(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void confirm(adding)
                if (event.key !== 'Escape') return
                // Esc closes the row, not Settings.
                event.preventDefault()
                event.stopPropagation()
                close()
              }}
            />
            <Button variant={ButtonVariant.Primary} size={ButtonSize.Small} onClick={() => void confirm(adding)}>
              Add
            </Button>
            <Button variant={ButtonVariant.Ghost} size={ButtonSize.Small} onClick={close}>
              Cancel
            </Button>
          </GrantRow>
        )}
      </div>
      {!disabled && <GrantError message={error} />}
    </>
  )
}

/** What a scope's MCP servers list holds: the servers granted, and the other agents. */
type OutsideGrant = McpServerGrant | AgentsGrant

/** What tells one of them from the others, in the list and in Add…'s select. */
function outsideKey(grant: OutsideGrant): string {
  switch (grant.kind) {
    case SandboxGrantKind.McpServer:
      return `${grant.kind}:${grant.server}`
    case SandboxGrantKind.Agents:
      return `${grant.kind}:${grant.agents}`
  }
}

/** How a row names it: the server as reported, or what the agents are. */
function outsideLabel(grant: OutsideGrant): string {
  switch (grant.kind) {
    case SandboxGrantKind.McpServer:
      return mcpServerLabel(grant.name, grant.server)
    case SandboxGrantKind.Agents:
      return OTHER_AGENTS_LABELS[grant.agents]
  }
}

/** What its row shows on hover: the server as its tools' names carry it, or the tool that reaches the agents. */
function outsideTitle(grant: OutsideGrant): string {
  switch (grant.kind) {
    case SandboxGrantKind.McpServer:
      return `${MCP_TOOL_PREFIX}${grant.server}`
    case SandboxGrantKind.Agents:
      return OTHER_AGENTS_TOOLS[grant.agents]
  }
}

const AGENTS_ICONS: Readonly<Record<OtherAgents, IconDefinition>> = {
  [OtherAgents.Sessions]: faComments,
  [OtherAgents.Cloud]: faCloud,
}

function outsideIcon(grant: OutsideGrant): IconDefinition {
  switch (grant.kind) {
    case SandboxGrantKind.McpServer:
      return faPlug
    case SandboxGrantKind.Agents:
      return AGENTS_ICONS[grant.agents]
  }
}

/**
 * What Add… offers a scope: each server its sessions have reported, by name, then the other agents, leaving out what
 * the scope already has.
 */
export function addableGrants(
  reported: readonly ReportedMcpServer[],
  granted: readonly OutsideGrant[],
): OutsideGrant[] {
  const have = new Set(granted.map(outsideKey))
  const offered: OutsideGrant[] = [
    ...reported.map(({ server, name }) => ({ kind: SandboxGrantKind.McpServer, server, name }) as const),
    ...Object.values(OtherAgents).map((agents) => ({ kind: SandboxGrantKind.Agents, agents }) as const),
  ]
  return offered.filter((grant) => !have.has(outsideKey(grant)))
}

interface OutsideRowProps<Value extends string> {
  grant: OutsideGrant
  /** What the grant is taken back by: the server's key, or which other agents. */
  value: Value
  disabled: boolean
  onRemove: (value: Value) => void
}

/** What both kinds of row show: the icon, the name (a server's in mono, the agents' in words) and the remove button. */
function OutsideRow<Value extends string>({
  grant,
  value,
  disabled,
  onRemove,
}: OutsideRowProps<Value>): React.JSX.Element {
  const label = outsideLabel(grant)
  return (
    <GrantRow label={label} icon={outsideIcon(grant)}>
      <GrantValue shown={label} value={outsideTitle(grant)} words={grant.kind === SandboxGrantKind.Agents} />
      <Button
        variant={ButtonVariant.Icon}
        icon={faXmark}
        aria-label={`Remove ${label}`}
        title={`Remove ${label}`}
        disabled={disabled}
        onClick={() => {
          onRemove(value)
        }}
      />
    </GrantRow>
  )
}

interface ServerRowProps {
  /** The server's key, which its grant is kept and taken back by. */
  server: string
  /** Its name as reported, which the row shows. */
  name: string
  disabled: boolean
  onRemove: (server: string) => void
}

/**
 * A granted MCP server, and its remove button. Memoised on the server's key and name, as a folder's row is on its
 * path and access, so a change to one row of a long list draws that row alone.
 */
const ServerRow = memo(function ServerRow({ server, name, disabled, onRemove }: ServerRowProps) {
  const grant = { kind: SandboxGrantKind.McpServer, server, name } as const
  return <OutsideRow grant={grant} value={server} disabled={disabled} onRemove={onRemove} />
})

interface AgentsRowProps {
  agents: OtherAgents
  disabled: boolean
  onRemove: (agents: OtherAgents) => void
}

/** Other agents the scope may reach, and their remove button. Memoised on which they are. */
const AgentsRow = memo(function AgentsRow({ agents, disabled, onRemove }: AgentsRowProps) {
  const grant = { kind: SandboxGrantKind.Agents, agents } as const
  return <OutsideRow grant={grant} value={agents} disabled={disabled} onRemove={onRemove} />
})

/** What Add… is offering, and which of them is chosen: the row under the list's. */
interface PendingOutside {
  readonly offered: readonly OutsideGrant[]
  readonly chosen: OutsideGrant
}

/**
 * A scope's MCP servers (#515): the servers granted, the other agents granted, and the one being added. Built from the
 * Folders and Domains lists' parts.
 */
function ServerList({ target, grants, disabled, text }: GrantListProps<OutsideGrant>): React.JSX.Element {
  const addGrant = useGladeStore((state) => state.addSandboxGrant)
  const removeGrant = useGladeStore((state) => state.removeSandboxGrant)
  const listReported = useGladeStore((state) => state.listReportedServers)
  const [pending, setPending] = useState<PendingOutside | null>(null)
  const { error, setError, attempt } = useAttempts()
  const addButton = useRef<HTMLButtonElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  // The row waits out of sight while the sandbox is off.
  const adding = disabled ? null : pending
  const open = adding !== null

  // The row just opened: Add has the focus, so ↵ adds what's chosen.
  useEffect(() => {
    if (open) confirmButton.current?.focus()
  }, [open])

  const offer = (): void => {
    void attempt(async () => {
      const offered = addableGrants(await listReported(target), grants ?? [])
      const [first] = offered
      if (first === undefined) setError(NOTHING_TO_ADD[target.scope])
      else setPending({ offered, chosen: first })
    })
  }

  const close = (): void => {
    setPending(null)
    setError(null)
    addButton.current?.focus()
  }

  const confirm = async (grant: OutsideGrant): Promise<void> => {
    if (await attempt(() => addGrant(target, grant))) close()
  }

  const remove = useCallback(
    (key: GrantKey): void => {
      // The row's own button goes with it, so Add… takes the focus.
      addButton.current?.focus()
      void attempt(() => removeGrant(target, key))
    },
    [attempt, removeGrant, target],
  )
  // A server is taken back by its key alone, other agents as they were granted.
  const removeServer = useCallback(
    (server: string): void => {
      remove({ kind: SandboxGrantKind.McpServer, server })
    },
    [remove],
  )
  const removeAgents = useCallback(
    (agents: OtherAgents): void => {
      remove({ kind: SandboxGrantKind.Agents, agents })
    },
    [remove],
  )

  return (
    <>
      <ListHeader name="MCP servers" text={text} disabled={disabled} addButton={addButton} onAdd={offer} />
      <div
        role="list"
        aria-label={text.list}
        aria-busy={grants === null}
        className={classNames(styles.grantList, disabled && styles.dimmed)}
      >
        {grants?.map((grant) =>
          grant.kind === SandboxGrantKind.McpServer ? (
            <ServerRow
              key={outsideKey(grant)}
              server={grant.server}
              name={grant.name}
              disabled={disabled}
              onRemove={removeServer}
            />
          ) : (
            <AgentsRow key={outsideKey(grant)} agents={grant.agents} disabled={disabled} onRemove={removeAgents} />
          ),
        )}
        {adding === null && (grants === null || grants.length === 0) && (
          <EmptyRow>{grants === null ? null : 'No MCP servers yet.'}</EmptyRow>
        )}
        {adding !== null && (
          <GrantRow label="New MCP server" icon={outsideIcon(adding.chosen)} pending>
            <SettingSelect
              name="MCP server to add"
              menuLabel="MCP servers"
              options={adding.offered.map((grant) => ({ value: outsideKey(grant), label: outsideLabel(grant) }))}
              value={outsideKey(adding.chosen)}
              onChoose={(key) => {
                const chosen = adding.offered.find((grant) => outsideKey(grant) === key)
                if (chosen !== undefined) setPending({ offered: adding.offered, chosen })
              }}
            />
            <span className={styles.grantSpacer} aria-hidden="true" />
            <Button
              ref={confirmButton}
              variant={ButtonVariant.Primary}
              size={ButtonSize.Small}
              onClick={() => void confirm(adding.chosen)}
            >
              Add
            </Button>
            <Button variant={ButtonVariant.Ghost} size={ButtonSize.Small} onClick={close}>
              Cancel
            </Button>
          </GrantRow>
        )}
      </div>
      {!disabled && <GrantError message={error} />}
    </>
  )
}

/** A scope's folders, from its grants. */
function foldersOf(grants: readonly Grant[]): FolderGrant[] {
  return grants.filter((grant) => grant.kind === SandboxGrantKind.Folder)
}

/** A scope's domains, from its grants. */
function domainsOf(grants: readonly Grant[]): DomainGrant[] {
  return grants.filter((grant) => grant.kind === SandboxGrantKind.Domain)
}

/** A scope's MCP servers and other agents, from its grants. */
function outsideOf(grants: readonly Grant[]): OutsideGrant[] {
  return grants.filter((grant) => grant.kind === SandboxGrantKind.McpServer || grant.kind === SandboxGrantKind.Agents)
}

export interface SandboxListsProps {
  /** The workspace whose lists these are; null for the Glade-wide ones. */
  workspaceId: string | null
  /** That workspace's root folder, listed first in its Folders; null for the Glade-wide lists. */
  root: string | null
}

/**
 * A scope's Folders, Domains and MCP servers lists, with the line under them: read from main as they open, and kept
 * current by its broadcasts. Dimmed and disabled while the sandbox is off.
 */
export function SandboxLists({ workspaceId, root }: SandboxListsProps): React.JSX.Element {
  const target = useMemo(
    (): SettingsGrantTarget =>
      workspaceId === null ? { scope: SandboxGrantScope.Glade } : { scope: SandboxGrantScope.Workspace, workspaceId },
    [workspaceId],
  )
  // Undefined until main has answered: the lists stay blank rather than say nothing is granted.
  const grants = useGladeStore((state) => state.sandboxGrants[settingsGrantScopeKey(target)])
  const enabled = useGladeStore((state) => state.settings.sandboxEnabled)
  const loadGrants = useGladeStore((state) => state.loadSandboxGrants)
  const [error, setError] = useState<string | null>(null)
  const folders = useMemo(() => (grants === undefined ? null : foldersOf(grants)), [grants])
  const domains = useMemo(() => (grants === undefined ? null : domainsOf(grants)), [grants])
  const servers = useMemo(() => (grants === undefined ? null : outsideOf(grants)), [grants])

  useEffect(() => {
    // Aborted when the section closes before main has answered.
    const closed = new AbortController()
    loadGrants(target).catch((failure: unknown) => {
      if (!closed.signal.aborted) setError(describeFailure(failure))
    })
    return () => {
      closed.abort()
    }
  }, [loadGrants, target])

  const text = SCOPE_TEXT[target.scope]
  const note = enabled ? text.note : text.offNote
  return (
    <>
      <FolderList target={target} grants={folders} disabled={!enabled} text={text.folders} root={root} />
      <DomainList target={target} grants={domains} disabled={!enabled} text={text.domains} />
      <ServerList target={target} grants={servers} disabled={!enabled} text={text.servers} />
      <GrantError message={error} />
      {note !== null && <p className={styles.sandboxNote}>{note}</p>}
    </>
  )
}
