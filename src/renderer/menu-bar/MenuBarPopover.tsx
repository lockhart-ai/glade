import { Fragment, type Ref } from 'react'
import { Dot } from '../components'
import { TaskIndicator } from '../../shared/taskIndicator'
import { RowTodos } from '../task-list/RowTodos'
import {
  MenuBarSectionKind,
  NOTHING_IN_FLIGHT,
  SECTION_TITLES,
  type MenuBarSection,
  type NeedsYouRow,
  type RecentRow,
  type WorkingRow,
} from './menuBarModel'
import styles from './MenuBar.module.css'

/** The popover's footer buttons. */
export const OPEN_GLADE = 'Open Glade'
export const QUIT = 'Quit'

export interface MenuBarPopoverProps {
  /** Its sections, in order, each with something in it (`menuBarSections`): none shows that nothing's in flight. */
  sections: readonly MenuBarSection[]
  onOpenTask: (taskId: string) => void
  onOpenGlade: () => void
  onQuit: () => void
  /** The element holding everything it shows, at its natural height, for its window to be sized to. */
  contentRef?: Ref<HTMLDivElement>
}

interface RowProps<T> {
  row: T
  onOpen: (taskId: string) => void
}

function NeedsYouButton({ row, onOpen }: RowProps<NeedsYouRow>): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.row}
      onClick={() => {
        onOpen(row.taskId)
      }}
    >
      <span className={styles.line}>
        <Dot state={row.indicator} />
        <span className={styles.title}>{row.title}</span>
        <span className={styles.meta}>{row.workspaceName}</span>
      </span>
      <span className={styles.subLine}>
        <span className={styles.secondary}>{row.reason}</span>
      </span>
    </button>
  )
}

function WorkingButton({ row, onOpen }: RowProps<WorkingRow>): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.row}
      onClick={() => {
        onOpen(row.taskId)
      }}
    >
      <span className={styles.line}>
        <Dot state={TaskIndicator.Working} />
        <span className={styles.title}>{row.title}</span>
        {row.elapsed !== null && <span className={styles.meta}>{row.elapsed}</span>}
      </span>
      <span className={styles.subLine}>
        <span className={styles.secondary}>{row.status}</span>
        {row.todos !== null && <RowTodos todos={row.todos} />}
      </span>
      {row.progress !== null && (
        <span className={styles.bar} aria-hidden="true">
          <span className={styles.track}>
            <span className={styles.fill} style={{ width: `${(row.progress * 100).toFixed(1)}%` }} />
          </span>
        </span>
      )}
    </button>
  )
}

function RecentButton({ row, onOpen }: RowProps<RecentRow>): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.row}
      onClick={() => {
        onOpen(row.taskId)
      }}
    >
      <span className={styles.subLine}>
        <span className={styles.title}>{row.title}</span>
        <span className={styles.meta}>{row.age}</span>
      </span>
      <span className={styles.subLine}>
        <span className={styles.secondary}>{row.body}</span>
      </span>
    </button>
  )
}

interface SectionProps {
  section: MenuBarSection
  onOpen: (taskId: string) => void
}

/** A section: its heading (with how many it lists, but for Recent), then its rows. */
function Section({ section, onOpen }: SectionProps): React.JSX.Element {
  const title = SECTION_TITLES[section.kind]
  const rows = ((): React.JSX.Element[] => {
    switch (section.kind) {
      case MenuBarSectionKind.NeedsYou:
        return section.rows.map((row) => <NeedsYouButton key={row.taskId} row={row} onOpen={onOpen} />)
      case MenuBarSectionKind.Working:
        return section.rows.map((row) => <WorkingButton key={row.taskId} row={row} onOpen={onOpen} />)
      case MenuBarSectionKind.Recent:
        return section.rows.map((row) => <RecentButton key={row.key} row={row} onOpen={onOpen} />)
    }
  })()
  return (
    <section aria-label={title}>
      <div className={styles.heading} aria-hidden="true">
        <span>{title}</span>
        {section.kind !== MenuBarSectionKind.Recent && <span>{section.rows.length}</span>}
      </div>
      {rows}
    </section>
  )
}

/**
 * The popover under Glade's icon in the menu bar (`docs/design/html/29-menu-bar.html`): what needs you, what's working
 * and the latest notifications, each section hidden while it's empty, or "Nothing in flight"; then Open Glade and Quit.
 * Clicking a row opens Glade on its task.
 */
export function MenuBarPopover({
  sections,
  onOpenTask,
  onOpenGlade,
  onQuit,
  contentRef,
}: MenuBarPopoverProps): React.JSX.Element {
  return (
    <div className={styles.popover} role="dialog" aria-label="Glade">
      <div className={styles.content} ref={contentRef}>
        {sections.length === 0 ? (
          <p className={styles.empty}>{NOTHING_IN_FLIGHT}</p>
        ) : (
          sections.map((section, index) => (
            <Fragment key={section.kind}>
              {index > 0 && <div role="separator" className={styles.separator} />}
              <Section section={section} onOpen={onOpenTask} />
            </Fragment>
          ))
        )}
        <div role="separator" className={styles.separator} />
        <div className={styles.footer}>
          <button type="button" className={styles.footerButton} onClick={onOpenGlade}>
            {OPEN_GLADE}
          </button>
          <button type="button" className={styles.footerButton} onClick={onQuit}>
            {QUIT}
          </button>
        </div>
      </div>
    </div>
  )
}
