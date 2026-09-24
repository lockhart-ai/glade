import { Button, ButtonVariant } from '../components'
import { panelDefinition, toggleTitle, type Panel } from './panels'
import { usePanel } from './usePanel'

export interface PanelToggleProps {
  readonly panel: Panel
  readonly className?: string
}

/**
 * The icon button that collapses a panel while it's open and shows it again while it's collapsed, named for what it
 * does and with the shortcut in its tooltip (`Collapse task list (⌘B)`). Must be used under a `GladeStoreProvider`.
 */
export function PanelToggle({ panel, className }: PanelToggleProps): React.JSX.Element {
  const { collapsed, setCollapsed } = usePanel(panel)
  const { collapseLabel, showLabel, shortcut, icon } = panelDefinition(panel)
  const label = collapsed ? showLabel : collapseLabel
  return (
    <Button
      variant={ButtonVariant.Icon}
      icon={icon}
      aria-label={label}
      title={toggleTitle(label, shortcut)}
      className={className}
      onClick={() => {
        setCollapsed(!collapsed)
      }}
    />
  )
}
