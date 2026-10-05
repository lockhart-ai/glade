import { faChevronUp } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import { accountKind, AccountKind, UsageLevel, usageLimitKey, type UsageReading } from '../../shared/account'
import type { EpochMs } from '../../shared/domain'
import { Icon, IconSize, Placement, Popover } from '../components'
import { classNames } from '../components/classNames'
import { MeterRing } from '../context-meter'
import { useGladeStore } from '../store/react'
import { useNow } from '../task-list/useNow'
import styles from './UsageMeter.module.css'
import { OpenRouterUsageMeter } from './OpenRouterUsageMeter'
import {
  currentReadings,
  usageBar,
  usageFraction,
  UsageMeterKind,
  usageMeterState,
  usageLimitLabel,
  usageLimitReachedLabel,
  usagePercent,
  usageResets,
  usageResetsAt,
  usageSpend,
  usageUpdated,
  type UsageMeterState,
} from './usageMeterModel'

interface UsageRowProps {
  readonly state: Exclude<UsageMeterState, { readonly kind: UsageMeterKind.Hidden }>
  readonly now: EpochMs
}

/** The row's ring and words, by its state (`docs/design/html/32-usage-meter.html`). */
function UsageRow({ state, now }: UsageRowProps): React.JSX.Element {
  switch (state.kind) {
    case UsageMeterKind.Unknown:
      return (
        <>
          <MeterRing fraction={null} />
          <span className={styles.name}>Usage</span>
          <span className={styles.spacer} />
          <span className={styles.detail}>within limits</span>
        </>
      )
    case UsageMeterKind.Normal:
    case UsageMeterKind.Warning: {
      const { reading } = state
      return (
        <>
          <MeterRing fraction={usageFraction(reading)} near={state.kind === UsageMeterKind.Warning} />
          <span className={styles.name}>{usageLimitLabel(reading.limit)}</span>
          <span className={styles.percent}>{usagePercent(reading)}</span>
          <span className={styles.spacer} />
          <span className={styles.detail}>{usageResets(reading, now)}</span>
        </>
      )
    }
    case UsageMeterKind.ExtraUsage: {
      // Running on extra usage: the money spent, set against its cap when it has one; the ring is how much of the cap.
      const { reading } = state
      const spend = usageSpend(reading)
      return (
        <>
          <MeterRing fraction={usageBar(reading)} near={reading.level === UsageLevel.Warning} />
          <span className={styles.name}>{usageLimitLabel(reading.limit)}</span>
          <span className={styles.percent}>{spend === null ? usagePercent(reading) : spend.amount}</span>
          <span className={styles.spacer} />
          {spend !== null && <span className={styles.detail}>{spend.rest}</span>}
        </>
      )
    }
    case UsageMeterKind.Limited: {
      const { reading } = state
      return (
        <>
          <MeterRing fraction={1} near />
          <span className={styles.name}>{usageLimitReachedLabel(reading.limit)}</span>
          <span className={styles.spacer} />
          <span className={styles.detail}>{usageResetsAt(reading, now)}</span>
        </>
      )
    }
  }
}

export interface UsageDetailsProps {
  /** The plan's name, e.g. `Claude Max`; none when Claude Code didn't say. */
  readonly plan: string | null
  /** The limits still standing, in the meter's order. */
  readonly readings: readonly UsageReading[]
  readonly now: EpochMs
}

/**
 * The meter's popover: every limit Claude Code has told of, each with a bar, how much is used and when it resets, under
 * the plan's name, and how long ago it was read. Extra usage says the money spent instead of a percentage, when the
 * usage call gave it (`usageSpend`), and has no bar while it has no cap (`usageBar`).
 */
export function UsageDetails({ plan, readings, now }: UsageDetailsProps): React.JSX.Element {
  const updated = usageUpdated(readings, now)
  return (
    <div className={styles.details}>
      <div className={styles.header}>
        <span className={styles.title}>Usage</span>
        {plan !== null && <span className={styles.plan}>{plan}</span>}
      </div>
      {readings.length === 0 && (
        <p className={styles.empty}>Claude Code says how much of your plan is used as tasks run.</p>
      )}
      {readings.map((reading) => {
        const label = usageLimitLabel(reading.limit)
        const resets = usageResets(reading, now)
        const spend = usageSpend(reading)
        const bar = usageBar(reading)
        return (
          <div
            key={usageLimitKey(reading.limit)}
            role="group"
            aria-label={label}
            className={classNames(styles.limit, reading.level !== UsageLevel.Within && styles.near)}
          >
            <span className={styles.limitHead}>
              <span className={styles.limitName}>{label}</span>
              <span className={styles.limitPercent}>
                {spend === null ? usagePercent(reading) : `${spend.amount} ${spend.rest}`}
              </span>
            </span>
            {bar !== null && (
              <span className={styles.bar} aria-hidden>
                <span className={styles.fill} style={{ width: `${String(bar * 100)}%` }} />
              </span>
            )}
            {resets !== null && <span className={styles.resets}>{resets}</span>}
          </div>
        )
      })}
      {updated !== null && <div className={styles.foot}>From Claude Code · {updated}</div>}
    </div>
  )
}

/**
 * The usage meter at the foot of the sidebar (`docs/design/html/32-usage-meter.html`): one row with the limit closest
 * to running out, or with extra usage and the money spent on it while the account runs on that, which opens a popover
 * with every limit. Hidden for an account plan limits don't apply to.
 */
function ClaudeUsageMeter(): React.JSX.Element | null {
  const account = useGladeStore((state) => state.accountStatus.account)
  const readings = useGladeStore((state) => state.accountStatus.usage)
  const now = useNow()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const state = usageMeterState(account, readings, now)
  if (state.kind === UsageMeterKind.Hidden) return null
  // Purple from 70%, of a plan limit or of extra usage's cap.
  const warning =
    state.kind === UsageMeterKind.Warning ||
    (state.kind === UsageMeterKind.ExtraUsage && state.reading.level === UsageLevel.Warning)
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={classNames(
          styles.row,
          warning && styles.warning,
          state.kind === UsageMeterKind.Limited && styles.limited,
        )}
        aria-label="Usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={state.kind}
        onClick={() => {
          setOpen((isOpen) => !isOpen)
        }}
      >
        <UsageRow state={state} now={now} />
        <span className={styles.chevron}>
          <Icon icon={faChevronUp} size={IconSize.Small} />
        </span>
      </button>
      <Popover
        label="Usage"
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        placement={Placement.TopStart}
        matchAnchorWidth
        className={styles.popover}
      >
        <UsageDetails plan={account?.subscriptionType ?? null} readings={currentReadings(readings, now)} now={now} />
      </Popover>
    </>
  )
}

export function UsageMeter(): React.JSX.Element | null {
  const account = useGladeStore((state) => state.accountStatus.account)
  const connected = useGladeStore((state) => state.openrouterUsage.connected)
  const kind = account === null ? null : accountKind(account)
  if (!connected && (kind === AccountKind.ApiKey || kind === AccountKind.CloudProvider)) return null
  return (
    <div className={styles.footer}>
      <ClaudeUsageMeter />
      <OpenRouterUsageMeter />
    </div>
  )
}
