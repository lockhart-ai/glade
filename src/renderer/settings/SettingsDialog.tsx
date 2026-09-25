import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { faXmark } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useId, useRef } from 'react'
import { Button, ButtonVariant, useOverlayRef } from '../components'
import { selectSelectedWorkspace } from '../store/state'
import { useGladeStore } from '../store/react'
import { APP_SECTIONS, SECTION_TITLES, SettingsSection } from './sections'
import {
  AgentSection,
  AppearanceSection,
  GeneralSection,
  NotificationsSection,
  PluginsSection,
  WorkspaceSection,
} from './SettingsSections'
import { KeyboardSection } from './KeyboardSection'
import { ControlSection } from './ControlSection'
import styles from './SettingsDialog.module.css'

interface NavItemProps {
  label: string
  current: boolean
  onSelect: () => void
  buttonRef?: React.Ref<HTMLButtonElement>
}

function NavItem({ label, current, onSelect, buttonRef }: NavItemProps): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-current={current ? 'page' : undefined}
      className={styles.navItem}
      onClick={onSelect}
    >
      {label}
    </button>
  )
}

/**
 * The Settings modal (⌘,; `docs/design/screens/21-settings.png`): the sections down the left, the app's first and then
 * the workspace you're in under its own heading, and the chosen one on the right. Every change saves as it's made, so
 * there's no Save button: Esc, a click outside or the close button closes it. It shows while the store has a section
 * open (`settingsSection`), taking the focus and giving it back when it closes.
 */
export function SettingsDialog(): React.JSX.Element {
  const section = useGladeStore((state) => state.settingsSection)
  const openSettings = useGladeStore((state) => state.openSettings)
  const closeSettings = useGladeStore((state) => state.closeSettings)
  const workspace = useGladeStore(selectSelectedWorkspace)
  const headingId = useId()
  const currentRef = useRef<HTMLButtonElement>(null)
  const overlay = useOverlayRef()
  const open = section !== null
  const { refs, context } = useFloating({
    open,
    onOpenChange: (next) => {
      if (!next) closeSettings()
    },
  })
  const setFloating = useCallback(
    (node: HTMLElement | null) => {
      refs.setFloating(node)
    },
    [refs],
  )
  const { getFloatingProps } = useInteractions([
    useDismiss(context, { outsidePressEvent: 'mousedown' }),
    useRole(context, { role: 'dialog' }),
  ])

  if (section === null) return <></>
  // With no workspace open, there's no Workspace section to show: the modal falls back to where ⌘, opens it.
  const shown = section === SettingsSection.Workspace && workspace === undefined ? SettingsSection.Agent : section

  const title = shown === SettingsSection.Workspace ? (workspace?.name ?? '') : SECTION_TITLES[shown]

  return (
    <FloatingPortal>
      <FloatingOverlay ref={overlay} className={styles.backdrop} lockScroll>
        <FloatingFocusManager context={context} initialFocus={currentRef}>
          <div ref={setFloating} className={styles.dialog} aria-label="Settings" {...getFloatingProps()}>
            <nav className={styles.nav} aria-label="Settings sections">
              <div className={styles.navTitle}>Settings</div>
              {APP_SECTIONS.map((item) => (
                <NavItem
                  key={item}
                  label={SECTION_TITLES[item]}
                  current={item === shown}
                  buttonRef={item === shown ? currentRef : undefined}
                  onSelect={() => {
                    openSettings(item)
                  }}
                />
              ))}
              {workspace !== undefined && (
                <>
                  <div className={styles.navHeading}>Workspace</div>
                  <NavItem
                    label={workspace.name}
                    current={shown === SettingsSection.Workspace}
                    buttonRef={shown === SettingsSection.Workspace ? currentRef : undefined}
                    onSelect={() => {
                      openSettings(SettingsSection.Workspace)
                    }}
                  />
                </>
              )}
            </nav>
            <section className={styles.content} aria-labelledby={headingId}>
              <div className={styles.header}>
                <h2 id={headingId} className={styles.title}>
                  {title}
                </h2>
                <Button
                  variant={ButtonVariant.Icon}
                  icon={faXmark}
                  aria-label="Close settings"
                  title="Close settings"
                  onClick={closeSettings}
                />
              </div>
              <div className={styles.body}>
                <SectionBody section={shown} />
              </div>
            </section>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  )
}

interface SectionBodyProps {
  section: SettingsSection
}

function SectionBody({ section }: SectionBodyProps): React.JSX.Element {
  switch (section) {
    case SettingsSection.General:
      return <GeneralSection />
    case SettingsSection.Agent:
      return <AgentSection />
    case SettingsSection.Notifications:
      return <NotificationsSection />
    case SettingsSection.Appearance:
      return <AppearanceSection />
    case SettingsSection.Keyboard:
      return <KeyboardSection />
    case SettingsSection.Plugins:
      return <PluginsSection />
    case SettingsSection.Control:
      return <ControlSection />
    case SettingsSection.Workspace:
      return <WorkspaceSection />
  }
}
