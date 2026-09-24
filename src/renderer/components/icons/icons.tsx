import type { ReactNode } from 'react'

/** Props every icon takes. Icons are decorative: the control they sit in carries the accessible name. */
export interface IconProps {
  /** Width and height in px. */
  size?: number
  /** Stroke width in viewBox units (the viewBox is 24 wide). */
  strokeWidth?: number
  className?: string
}

interface StrokeIconProps extends IconProps {
  children: ReactNode
}

/** A 24-unit stroke icon drawn in the current text colour, like the icons in the design markup. */
function StrokeIcon({ size = 16, strokeWidth = 2, className, children }: StrokeIconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  )
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return (
    <StrokeIcon strokeWidth={2.2} {...props}>
      <path d="M5 12.5 10 17 19 7" />
    </StrokeIcon>
  )
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <StrokeIcon strokeWidth={2.2} {...props}>
      <path d="M12 5v14M5 12h14" />
    </StrokeIcon>
  )
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return (
    <StrokeIcon size={12} strokeWidth={2.2} {...props}>
      <path d="m6 9 6 6 6-6" />
    </StrokeIcon>
  )
}

export function PinIcon(props: IconProps): React.JSX.Element {
  return (
    <StrokeIcon size={15} {...props}>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z" />
    </StrokeIcon>
  )
}

export function SearchIcon(props: IconProps): React.JSX.Element {
  return (
    <StrokeIcon size={15} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </StrokeIcon>
  )
}
