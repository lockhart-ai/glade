/**
 * Showing a subagent in the todo hub, when something asks for one (a plugin's `openTask` with a subagent: a Nekomata
 * kitten clicked; #499): its todo opens on the Subagents filter, and the focus goes to its tile, scrolled into view.
 * With the hub off, the Subagents tab answers the same request by opening the subagent's log (`SubagentsTab`).
 */
import { useEffect, useMemo, type RefObject } from 'react'
import { ChildFilter, ChildKind, refKey, type ChildRef, type GroupedChildren, type TodoId } from '../../shared/todoHub'
import { useGladeStore } from '../store/react'
import type { TodoPanels } from '../store/state'
import type { SubagentShown } from '../subagents'

/** The attribute on each tile's list item that says which child it is (`refKey`): what a request to show one finds. */
export const CHILD_ATTRIBUTE = 'data-child'

/** The todo a child is under, or the placeholder group; undefined for a child the task hasn't got (yet). */
export function todoOfChild(grouped: GroupedChildren, { kind, key }: ChildRef): TodoId | undefined {
  return [...grouped.todos, grouped.unfiled].find(({ children }) =>
    children.some((child) => child.kind === kind && child.key === key),
  )?.todoId
}

export interface ShownSubagent {
  /** The hub's own element, which the subagent's tile is looked for in. */
  readonly hub: RefObject<HTMLElement | null>
  readonly taskId: string
  /** The task's children by todo; null until its filings are read. */
  readonly grouped: GroupedChildren | null
  /** How each todo's panel was left. */
  readonly panels: TodoPanels
  /** The subagent to show; null or undefined when none is asked for. */
  readonly focus: SubagentShown | null | undefined
  /** Called once the hub has shown `focus`, so its owner can clear it. */
  readonly onShown: (() => void) | undefined
}

/**
 * Acts on a request to show a subagent: opens its todo (or the placeholder group) on the Subagents filter, as clicking
 * the todo's subagent icon does, which the task remembers; then, once its tile is there, gives it the focus and
 * scrolls it into view, and says it's shown. Until the subagent is in the hub (the task's log or filings still
 * loading), the request waits.
 */
export function useShownSubagent({ hub, taskId, grouped, panels, focus, onShown }: ShownSubagent): void {
  const setTodoPanel = useGladeStore((state) => state.setTodoPanel)
  const subagentId = focus?.subagentId
  const request = focus?.request
  const todoId = useMemo(
    () =>
      subagentId === undefined || grouped === null
        ? undefined
        : todoOfChild(grouped, { kind: ChildKind.Subagent, key: subagentId }),
    [grouped, subagentId],
  )
  const panel = todoId === undefined ? undefined : panels[todoId]
  const showing = panel?.open === true && panel.filter === ChildFilter.Subagents

  useEffect(() => {
    if (subagentId === undefined || todoId === undefined) return
    if (!showing) {
      // It shows at once; one main couldn't remember is only forgotten on the next launch.
      setTodoPanel({ taskId, todoId, open: true, filter: ChildFilter.Subagents }).catch(() => undefined)
      return
    }
    const child = refKey({ kind: ChildKind.Subagent, key: subagentId })
    const item = [...(hub.current?.querySelectorAll<HTMLElement>(`[${CHILD_ATTRIBUTE}]`) ?? [])].find(
      (element) => element.getAttribute(CHILD_ATTRIBUTE) === child,
    )
    const tile = item?.querySelector<HTMLElement>('[role="group"]')
    // The ring shows though a click asked for it: it's what says which tile was meant.
    tile?.focus({ focusVisible: true })
    tile?.scrollIntoView({ block: 'nearest' })
    onShown?.()
  }, [hub, taskId, subagentId, request, todoId, showing, setTodoPanel, onShown])
}
