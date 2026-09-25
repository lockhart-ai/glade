import { faPuzzlePiece } from '@fortawesome/free-solid-svg-icons'
import { useRef } from 'react'
import type { ValidPlugin } from '../../shared/plugins'
import { NATIVE_VIEW_SLOT_ATTRIBUTE } from '../../shared/ready'
import { Card, Icon, IconSize } from '../components'
import { classNames } from '../components/classNames'
import styles from './PluginCard.module.css'
import { useViewSlot, type PlaceView } from './useViewSlot'

export interface PluginCardProps {
  plugin: ValidPlugin
  /** The status the plugin set for its header; nothing shows when it's empty. */
  status: string
  /** Whether the card shows only its header: the bottom bar is collapsed to its tab row. */
  collapsed?: boolean
  /** Whether its body is where the view should be: not while the bar is collapsed or sliding. */
  showing: boolean
  /** Puts the plugin's view over the card's body, or hides it. */
  place: PlaceView
}

/**
 * The shown plugin's card beside the terminal (the Nekomata card in `docs/design/screens/task-workspace.png`): a header
 * with its icon, name, a PLUGIN badge and the status it sets, over a body the plugin's own view is drawn on. The view
 * is native, above the page, so the body is only a slot whose box main keeps it over.
 */
export function PluginCard({ plugin, status, collapsed = false, showing, place }: PluginCardProps): React.JSX.Element {
  const slot = useRef<HTMLDivElement>(null)
  useViewSlot(slot, showing && !collapsed, place)
  const { name } = plugin.manifest
  return (
    <Card role="region" aria-label={name} className={styles.card} data-testid="plugin-card">
      <div className={classNames(styles.header, collapsed && styles.alone)}>
        <span className={styles.icon} aria-hidden="true">
          {plugin.iconUrl === null ? (
            <Icon icon={faPuzzlePiece} size={IconSize.Medium} />
          ) : (
            <img className={styles.iconImage} src={plugin.iconUrl} alt="" />
          )}
        </span>
        <span className={styles.name}>{name}</span>
        <span className={styles.badge}>Plugin</span>
        <span className={styles.spacer} />
        {status !== '' && (
          <span className={styles.status} data-testid="plugin-status">
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.statusText}>{status}</span>
          </span>
        )}
      </div>
      <div
        ref={slot}
        className={styles.body}
        hidden={collapsed}
        data-testid="plugin-view-slot"
        {...{ [NATIVE_VIEW_SLOT_ATTRIBUTE]: '' }}
      />
    </Card>
  )
}
