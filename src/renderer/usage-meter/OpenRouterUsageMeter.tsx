import { faChevronUp } from '@fortawesome/free-solid-svg-icons'
import { useState } from 'react'
import type { OpenRouterUsageReading } from '../../shared/openrouter'
import { Button, ButtonSize, ButtonVariant, Icon, IconSize, Placement, Popover } from '../components'
import { classNames } from '../components/classNames'
import { MeterRing } from '../context-meter'
import { useGladeStore } from '../store/react'
import { useNow } from '../task-list/useNow'
import styles from './UsageMeter.module.css'

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
})

export function openRouterUsageFraction(reading: OpenRouterUsageReading | null): number | null {
  if (reading?.limit == null || reading.remaining === null) return null
  return reading.limit === 0 ? 1 : Math.max(0, Math.min(1, 1 - reading.remaining / reading.limit))
}

/** OpenRouter's key totals stay separate from Claude's subscription windows and resume scheduler. */
export function OpenRouterUsageMeter(): React.JSX.Element | null {
  const status = useGladeStore((state) => state.openrouterUsage)
  const refresh = useGladeStore((state) => state.openrouter.refreshUsage)
  const now = useNow()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!status.connected) return null
  const { reading } = status
  const fraction = openRouterUsageFraction(reading)
  const limited = fraction === 1
  const warning = fraction !== null && fraction >= 0.7
  const remaining = reading?.limit != null && reading.remaining !== null ? reading.remaining : null
  const run = (force: boolean): void => {
    setBusy(true)
    setError(null)
    void refresh(force)
      .catch(() => {
        setError('Could not refresh OpenRouter usage.')
      })
      .finally(() => {
        setBusy(false)
      })
  }
  const spend =
    reading === null
      ? []
      : [
          { name: 'Today · UTC', value: reading.daily },
          { name: 'This week · UTC', value: reading.weekly },
          { name: 'This month · UTC', value: reading.monthly },
          { name: 'All time', value: reading.total },
        ]
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={classNames(styles.row, warning && styles.warning, limited && styles.limited)}
        aria-label="OpenRouter usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          if (!open) run(false)
        }}
      >
        <MeterRing fraction={fraction} near={warning} />
        <span className={styles.name}>OpenRouter</span>
        <span className={styles.percent}>{reading === null ? '—' : usd.format(remaining ?? reading.monthly)}</span>
        <span className={styles.spacer} />
        <span className={styles.detail}>
          {reading === null ? 'not yet read' : remaining === null ? 'month' : 'left'}
        </span>
        <span className={styles.chevron}>
          <Icon icon={faChevronUp} size={IconSize.Small} />
        </span>
      </button>
      <Popover
        label="OpenRouter usage"
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false)
        }}
        placement={Placement.TopStart}
        matchAnchorWidth
        className={styles.popover}
      >
        <div className={styles.details}>
          <div className={styles.header}>
            <span className={styles.title}>OpenRouter · USD</span>
            <Button
              size={ButtonSize.Small}
              variant={ButtonVariant.Ghost}
              disabled={busy}
              onClick={() => {
                run(true)
              }}
            >
              {busy ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
          {(error ?? status.error) !== null && (
            <p className={styles.empty} role="alert">
              {error ?? status.error}
            </p>
          )}
          {reading === null ? (
            <p className={styles.empty}>Usage has not been read yet.</p>
          ) : (
            <>
              {spend.map(({ name, value }) => (
                <div key={name} className={styles.limit} role="group" aria-label={name}>
                  <span className={styles.limitHead}>
                    <span className={styles.limitName}>{name}</span>
                    <span className={styles.limitPercent}>{usd.format(value)}</span>
                  </span>
                </div>
              ))}
              <div
                className={classNames(styles.limit, warning && styles.near)}
                role="group"
                aria-label="Key spending limit"
              >
                <span className={styles.limitHead}>
                  <span className={styles.limitName}>Key limit</span>
                  <span className={styles.limitPercent}>
                    {reading.limit === null ? 'No cap' : usd.format(reading.limit)}
                  </span>
                </span>
                {fraction !== null && (
                  <span className={styles.bar} aria-hidden>
                    <span className={styles.fill} style={{ width: `${String(fraction * 100)}%` }} />
                  </span>
                )}
                {remaining !== null && (
                  <span className={styles.resets}>
                    {usd.format(remaining)} remaining
                    {reading.limitReset === null ? '' : ` · ${reading.limitReset} reset`}
                  </span>
                )}
              </div>
              {reading.byokTotal > 0 && (
                <div className={styles.limit} role="group" aria-label="BYOK spend">
                  <span className={styles.limitHead}>
                    <span className={styles.limitName}>BYOK · this month</span>
                    <span className={styles.limitPercent}>{usd.format(reading.byokMonthly)}</span>
                  </span>
                  <span className={styles.resets}>
                    {usd.format(reading.byokTotal)} all time ·{' '}
                    {reading.includesByok ? 'included in key limit' : 'outside key limit'}
                  </span>
                </div>
              )}
              <p className={styles.empty}>
                All use of this key, including outside Glade. Account credit balance requires a management key.
              </p>
              <div className={styles.foot}>
                From OpenRouter ·{' '}
                {now - reading.readAt < 60_000
                  ? 'updated just now'
                  : `updated ${String(Math.floor((now - reading.readAt) / 60_000))} min ago`}
              </div>
            </>
          )}
          {reading?.freeRequests !== undefined && (
            <div className={styles.limit} role="group" aria-label="Free requests today">
              <span className={styles.limitHead}>
                <span className={styles.limitName}>Free requests · today</span>
                <span className={styles.limitPercent}>
                  {reading.freeRequests.used} / {reading.freeRequests.limit}
                </span>
              </span>
              <span className={styles.resets}>{reading.freeRequests.remaining} remaining · UTC day</span>
            </div>
          )}
        </div>
      </Popover>
    </>
  )
}
