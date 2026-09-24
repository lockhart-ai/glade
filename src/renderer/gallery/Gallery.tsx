import { faBell } from '@fortawesome/free-regular-svg-icons'
import {
  faCheck,
  faChevronDown,
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
  Pill,
  Segmented,
  Textarea,
  Toggle,
  type SegmentedOption,
} from '../components'
import styles from './Gallery.module.css'

/**
 * Every base component in each of its states, for checking them against the designs. Dev only: main.tsx loads it
 * for `#gallery` when `import.meta.env.DEV`, so production builds leave it out. Hover states are live.
 */
export function Gallery(): React.JSX.Element {
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
