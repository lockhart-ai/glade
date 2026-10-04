import type { EpochMs } from '../../../shared/domain'
import { formatFullDate } from '../../task-header/headerModel'
import { formatRelativeTime } from '../../task-list/relativeTime'
import { useNow } from '../../task-list/useNow'

export interface AgeProps {
  /** When it last changed. */
  readonly at: EpochMs
}

/**
 * How long ago something last changed, as a tile says it (`now`, `7m`, `3d`), with the exact time on hover. It keeps
 * its own clock, so as time passes it renders again by itself and nothing around it does.
 */
export function Age({ at }: AgeProps): React.JSX.Element {
  const now = useNow()
  return (
    <time dateTime={new Date(at).toISOString()} title={formatFullDate(at)}>
      {formatRelativeTime(at, now)}
    </time>
  )
}
