import { config, type IconDefinition } from '@fortawesome/fontawesome-svg-core'
import '@fortawesome/fontawesome-svg-core/styles.css'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { classNames } from '../classNames'
import styles from './Icon.module.css'

// The stylesheet is bundled above, so Font Awesome needn't inject its own <style> at runtime.
config.autoAddCss = false

export enum IconSize {
  /** 12px, e.g. a dropdown chevron. */
  Small = 'small',
  /** 14px, e.g. an icon beside a button's label. */
  Medium = 'medium',
  /** 16px, e.g. an icon-only button. */
  Large = 'large',
}

export interface IconProps {
  /**
   * A Font Awesome icon, imported by name so the bundle keeps only the icons used. Prefer the regular set
   * (`@fortawesome/free-regular-svg-icons`) where it has the icon; it matches the designs' thin strokes.
   */
  icon: IconDefinition
  size?: IconSize
  className?: string
}

/** A decorative Font Awesome SVG icon in the current text colour. The control around it carries the name. */
export function Icon({ icon, size = IconSize.Medium, className }: IconProps): React.JSX.Element {
  return <FontAwesomeIcon icon={icon} className={classNames(styles.icon, styles[size], className)} aria-hidden />
}
