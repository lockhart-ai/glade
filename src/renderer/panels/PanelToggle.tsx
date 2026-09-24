import { useBinding } from '../commands/hooks'
import { Button, ButtonVariant } from '../components'
import { panelDefinition, toggleTitle, type Panel } from './panels'
import { usePanel } from './usePanel'

export interface PanelToggleProps {
  readonly panel: Panel
  readonly className?: string
}

/**
 * The icon button that collapses a panel while it's open and shows it again while it's collapsed, named for what it
 * does and with its shortcut's current keys in its tooltip (`Collapse task list (⌘B)`). Must be used under a `GladeStoreProvider`.
 */
export function PanelToggle({ panel, className }: PanelToggleProps): React.JSX.Element {
  const { collapsed, setCollapsed } = usePanel(panel)
  const { collapseLabel, showLabel, command, icon } = panelDefinition(panel)
  const shortcut = useBinding(command).label
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
