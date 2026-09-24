import { faBell } from '@fortawesome/free-regular-svg-icons'
import {
  faCheck,
  faChevronDown,
  faEllipsis,
  faMagnifyingGlass,
  faPlus,
  faThumbtack,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import { useState, type ReactNode } from 'react'
import { TaskIndicator } from '../../shared/taskIndicator'
import {
  Button,
  ButtonSize,
  ButtonVariant,
  Card,
  CardLevel,
  Divider,
  Dot,
  Icon,
  IconSize,
  Input,
  Kbd,
  Menu,
  MenuAnchorKind,
  MenuEntryKind,
  MenuItemVariant,
  Pill,
  Popover,
  Segmented,
  TabPanel,
  Tabs,
  Textarea,
  Toggle,
  ToastProvider,
  useToast,
  type MenuAnchor,
  type MenuEntry,
  type MenuItem,
  type SegmentedOption,
  type TabItem,
} from '../components'
import styles from './Gallery.module.css'

/**
 * Every base component in each of its states, for checking them against the designs. Dev only: main.tsx loads it
 * for `#gallery` when `import.meta.env.DEV`, so production builds leave it out. Hover states are live.
 */
export function Gallery(): React.JSX.Element {
  return (
    <ToastProvider>
      <GalleryPage />
    </ToastProvider>
  )
}

function GalleryPage(): React.JSX.Element {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Components</h1>
        <p className={styles.intro}>Every base control in each of its states. Hover and focus are live.</p>
      </header>
      <div className={styles.grid}>
        <ButtonSection />
        <StatusSection />
        <CardSection />
        <FieldSection />
        <ToggleSection />
        <SegmentedSection />
        <TabsSection />
        <MenuSection />
        <OverlaySection />
      </div>
    </main>
  )
}

interface SectionProps {
  title: string
  children: ReactNode
}

function Section({ title, children }: SectionProps): React.JSX.Element {
  return (
    <Card className={styles.section} role="region" aria-label={title}>
      <h2 className={styles.label}>{title}</h2>
      {children}
    </Card>
  )
}

interface RowProps {
  name: string
  children: ReactNode
}

function Row({ name, children }: RowProps): React.JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.rowName}>{name}</span>
      <span className={styles.samples}>{children}</span>
    </div>
  )
}

function ButtonSection(): React.JSX.Element {
  const [pinned, setPinned] = useState(false)

  return (
    <Section title="Button">
      <Row name="Primary">
        <Button variant={ButtonVariant.Primary}>Start task</Button>
        <Button variant={ButtonVariant.Primary} disabled>
          Disabled
        </Button>
      </Row>
      <Row name="Dark">
        <Button>Open task</Button>
        <Button>
          [MODEL NAME]
          <Icon icon={faChevronDown} size={IconSize.Small} />
        </Button>
        <Button disabled>Disabled</Button>
      </Row>
      <Row name="Ghost">
        <Button variant={ButtonVariant.Ghost} icon={faCheck}>
          Mark done
        </Button>
        <Button variant={ButtonVariant.Ghost} disabled>
          Disabled
        </Button>
      </Row>
      <Row name="Icon">
        <Button
          variant={ButtonVariant.Icon}
          aria-label={pinned ? 'Unpin task' : 'Pin task'}
          aria-pressed={pinned}
          icon={faThumbtack}
          onClick={() => {
            setPinned(!pinned)
          }}
        />
        <Button variant={ButtonVariant.Icon} aria-label="Pinned" aria-pressed icon={faThumbtack} />
        <Button variant={ButtonVariant.Icon} aria-label="New task" icon={faPlus} />
        <Button variant={ButtonVariant.Icon} aria-label="Close settings" icon={faXmark} />
        <Button variant={ButtonVariant.Icon} aria-label="Disabled" icon={faPlus} disabled />
      </Row>
      <Row name="Sizes">
        <Button size={ButtonSize.Small}>Small</Button>
        <Button size={ButtonSize.Medium}>Medium</Button>
        <Button size={ButtonSize.Large} variant={ButtonVariant.Primary}>
          Large
        </Button>
      </Row>
    </Section>
  )
}

const INDICATORS: readonly { indicator: TaskIndicator; label: string }[] = [
  { indicator: TaskIndicator.Working, label: 'Active · working' },
  { indicator: TaskIndicator.Waiting, label: 'Active · waiting on you' },
  { indicator: TaskIndicator.Done, label: 'Done' },
  { indicator: TaskIndicator.Error, label: 'Active · error' },
]

function StatusSection(): React.JSX.Element {
  return (
    <Section title="Pill · Dot · Kbd · Icon">
      <Row name="Pill">
        <span className={styles.wrap}>
          {INDICATORS.map(({ indicator, label }) => (
            <Pill key={indicator} indicator={indicator}>
              {label}
            </Pill>
          ))}
        </span>
      </Row>
      <Row name="Dot">
        {INDICATORS.map(({ indicator }) => (
          <span key={indicator} className={styles.dotSample}>
            <Dot state={indicator} label={indicator} />
            <span aria-hidden="true">{indicator}</span>
          </span>
        ))}
      </Row>
      <Row name="Kbd">
        <Kbd>⌘N</Kbd>
        <Kbd>⌘⇧P</Kbd>
        <Kbd>⌥↓</Kbd>
        <Kbd>⌥↑</Kbd>
        <Kbd>Esc</Kbd>
        <Kbd>↵</Kbd>
      </Row>
      <Row name="Icon">
        {Object.values(IconSize).map((size) => (
          <span key={size} className={styles.iconSample}>
            <Icon icon={faBell} size={size} />
            <Icon icon={faCheck} size={size} />
            {size}
          </span>
        ))}
      </Row>
    </Section>
  )
}

function CardSection(): React.JSX.Element {
  return (
    <Section title="Card · Divider">
      <p className={styles.note}>This section is a top-level card. Below: a nested card with a divider.</p>
      <Card level={CardLevel.Nested} className={styles.nested}>
        <strong>Nested card</strong>
        <Divider />
        <span className={styles.note}>Header and right panel float inside the task card like this.</span>
      </Card>
    </Section>
  )
}

function FieldSection(): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [reply, setReply] = useState('')

  return (
    <Section title="Input · Textarea">
      <Input
        label="Search tasks"
        type="search"
        placeholder="Search"
        icon={faMagnifyingGlass}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value)
        }}
      />
      <Input label="Workspace name" defaultValue="Acme API" />
      <Input label="Disabled field" placeholder="Disabled" disabled />
      <Textarea
        label="Message the agent"
        placeholder="Reply…"
        value={reply}
        onChange={(event) => {
          setReply(event.target.value)
        }}
      />
      <Textarea label="Objective" defaultValue="Add per-key rate limiting to the public API." />
      <Textarea label="Disabled text area" placeholder="Disabled" disabled />
    </Section>
  )
}

function ToggleSection(): React.JSX.Element {
  const [statusSummary, setStatusSummary] = useState(true)
  const [taskTitles, setTaskTitles] = useState(false)

  return (
    <Section title="Toggle">
      <Row name="On">
        <Toggle label="Status summary" checked={statusSummary} onChange={setStatusSummary} />
      </Row>
      <Row name="Off">
        <Toggle label="Task titles" checked={taskTitles} onChange={setTaskTitles} />
      </Row>
      <Row name="Disabled">
        <Toggle label="Disabled on" checked disabled onChange={setStatusSummary} />
        <Toggle label="Disabled off" checked={false} disabled onChange={setStatusSummary} />
      </Row>
    </Section>
  )
}

enum Effort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Max = 'max',
}

enum Permissions {
  AskFirst = 'ask-first',
  AllowEdits = 'allow-edits',
  AllowAll = 'allow-all',
}

const EFFORT: readonly SegmentedOption<Effort>[] = [
  { value: Effort.Low, label: 'Low' },
  { value: Effort.Medium, label: 'Medium' },
  { value: Effort.High, label: 'High' },
  { value: Effort.Max, label: 'Max' },
]

const PERMISSIONS: readonly SegmentedOption<Permissions>[] = [
  { value: Permissions.AskFirst, label: 'Ask first' },
  { value: Permissions.AllowEdits, label: 'Allow edits' },
  { value: Permissions.AllowAll, label: 'Allow all' },
]

function SegmentedSection(): React.JSX.Element {
  const [effort, setEffort] = useState(Effort.High)
  const [permissions, setPermissions] = useState(Permissions.AllowAll)

  return (
    <Section title="Segmented">
      <Row name="Effort">
        <Segmented label="Effort" options={EFFORT} value={effort} onChange={setEffort} />
      </Row>
      <Row name="Permissions">
        <Segmented label="Permissions" options={PERMISSIONS} value={permissions} onChange={setPermissions} />
      </Row>
      <Row name="Disabled">
        <Segmented label="Disabled" options={EFFORT} value={Effort.Low} onChange={setEffort} disabled />
      </Row>
    </Section>
  )
}

enum SidePanel {
  ToolCalls = 'tool-calls',
  Files = 'files',
  Todos = 'todos',
  Artifacts = 'artifacts',
  Subagents = 'subagents',
}

const SIDE_PANELS: readonly TabItem<SidePanel>[] = [
  { value: SidePanel.ToolCalls, label: 'Tool calls', count: 7 },
  { value: SidePanel.Files, label: 'Files' },
  { value: SidePanel.Todos, label: 'Todos', count: '3/4' },
  { value: SidePanel.Artifacts, label: 'Artifacts' },
  { value: SidePanel.Subagents, label: 'Subagents' },
]

function TabsSection(): React.JSX.Element {
  const [panel, setPanel] = useState(SidePanel.ToolCalls)
  const label = SIDE_PANELS.find((tab) => tab.value === panel)?.label

  return (
    <Section title="Tabs">
      <Tabs id="gallery-side" label="Task panels" tabs={SIDE_PANELS} value={panel} onChange={setPanel} />
      <TabPanel tabsId="gallery-side" value={panel} className={styles.note}>
        The {label} panel. Arrow keys move between tabs.
      </TabPanel>
    </Section>
  )
}

/** Sample actions for the menus: the task (active) context menu from the designs. */
function taskMenu(onChoose: (label: string) => void): MenuEntry[] {
  const item = (label: string, shortcut?: string, variant?: MenuItemVariant): MenuItem => ({
    kind: MenuEntryKind.Item,
    label,
    shortcut,
    variant,
    onSelect: () => {
      onChoose(label)
    },
  })
  return [
    item('Open', '↵'),
    { kind: MenuEntryKind.Separator },
    { ...item('Pin to top', '⌘⇧P'), icon: faThumbtack },
    item('Rename…', 'F2'),
    item('Mark as unread', '⌘⇧U'),
    { kind: MenuEntryKind.Separator },
    { ...item('Mark done', '⌘⇧D'), icon: faCheck },
    { kind: MenuEntryKind.Separator },
    item('Copy link to task'),
    item('Reveal folder in Finder'),
    { kind: MenuEntryKind.Separator },
    item('Delete task…', undefined, MenuItemVariant.Destructive),
  ]
}

function MenuSection(): React.JSX.Element {
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [chosen, setChosen] = useState('Nothing yet')

  return (
    <Section title="Menu">
      <Row name="Dropdown">
        <Button
          ref={setTrigger}
          icon={faEllipsis}
          aria-haspopup="menu"
          aria-expanded={anchor?.kind === MenuAnchorKind.Element}
          onClick={() => {
            setAnchor({ kind: MenuAnchorKind.Element, element: trigger })
          }}
        >
          Task actions
        </Button>
      </Row>
      <Row name="Context">
        <div
          className={styles.contextTarget}
          onContextMenu={(event) => {
            event.preventDefault()
            setAnchor({ kind: MenuAnchorKind.Point, x: event.clientX, y: event.clientY })
          }}
        >
          Right-click here
        </div>
      </Row>
      <Row name="Chosen">
        <span className={styles.note}>{chosen}</span>
      </Row>
      <Menu
        label="Task actions"
        entries={taskMenu(setChosen)}
        anchor={anchor ?? { kind: MenuAnchorKind.Point, x: 0, y: 0 }}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
      />
    </Section>
  )
}

function OverlaySection(): React.JSX.Element {
  const toast = useToast()
  const [meter, setMeter] = useState<HTMLButtonElement | null>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  return (
    <Section title="Popover · Toast">
      <Row name="Popover">
        <Button
          ref={setMeter}
          aria-expanded={popoverOpen}
          onClick={() => {
            setPopoverOpen(!popoverOpen)
          }}
        >
          Context 97%
        </Button>
      </Row>
      <Row name="Toast">
        <Button
          onClick={() => {
            toast.show({
              message: 'Marked done. The latest status is kept as the outcome.',
              icon: faCheck,
              action: { label: 'Undo', onAction: () => toast.show({ message: 'Reopened.' }) },
            })
          }}
        >
          Show toast
        </Button>
        <Button
          variant={ButtonVariant.Ghost}
          onClick={() => {
            toast.show({ message: 'Copied link to task.' })
          }}
        >
          Plain toast
        </Button>
      </Row>
      <Popover
        label="Context"
        anchor={meter}
        open={popoverOpen}
        onClose={() => {
          setPopoverOpen(false)
        }}
        className={styles.contextPopover}
      >
        <div className={styles.popoverHeader}>
          <strong>Context</strong>
          <span className={styles.popoverUsage}>97% · 194k / 200k</span>
        </div>
        <p className={styles.note}>
          Compacts automatically at 99%. Compacting replaces older turns with a summary for the agent; the full chat and
          tool log stay here.
        </p>
        <div className={styles.popoverActions}>
          <Button>Compact now</Button>
          <Kbd>⌘⇧K</Kbd>
        </div>
      </Popover>
    </Section>
  )
}
