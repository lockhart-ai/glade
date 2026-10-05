import { memo, useMemo } from 'react'
import type { ToolCallEvent } from '../../shared/domain'
import { modelName } from '../../shared/models'
import { useGladeStore } from '../store/react'
import { agentsOf, agentStateLine, agentTodoSelector, isRunning, todoLineVerb } from './agentsModel'
import { useElapsedNow } from './useElapsedNow'
import styles from './AgentsTab.module.css'

/**
 * A subagent's state and how long it has run ("Running · 6m", "Done · 28m"). It keeps its own clock while the subagent
 * runs, so as time passes it renders again by itself, and the line around it doesn't.
 */
function AgentState({ call }: { readonly call: ToolCallEvent }): React.JSX.Element {
  const now = useElapsedNow(isRunning(call) ? call.createdAt : null)
  return <span className={styles.state}>{agentStateLine(call, now)}</span>
}

export interface AgentLineProps {
  readonly taskId: string
  /** The subagent, by its `Agent` call's `tool_use` id. */
  readonly agentId: string
}

/**
 * The line under the strip on a subagent's tab (`docs/design/html/51-agents-subagent.html`): the todo it's working on
 * ("Working on #501 Return Retry-After on 429s", "Worked on …" once it has finished), and its state at the right. The
 * todo's title is a link: it shows the Todos tab on that todo. One subagent works on one todo: the one it was started
 * for (`subagentTodo`, #495), which for a subagent's own subagent is its parent's unless it named another. One with no
 * todo, or whose todo was deleted, has no line.
 */
export const AgentLine = memo(function AgentLine({ taskId, agentId }: AgentLineProps): React.JSX.Element | null {
  const call = useGladeStore((state) => agentsOf(state.toolEvents[taskId]).calls.get(agentId))
  const selectTodo = useMemo(() => agentTodoSelector(taskId, agentId), [taskId, agentId])
  const todo = useGladeStore(selectTodo)
  const showTodo = useGladeStore((state) => state.showTodo)
  const model = typeof call?.input.model === 'string' ? call.input.model : null
  const label = useGladeStore((state) => (model === null ? null : modelName(state.models, model)))
  const todoId = todo?.id ?? null
  if (call === undefined || (todo === null && label === null)) return null
  return (
    <div className={styles.line} data-agent-line="">
      <span className={styles.working}>
        {label !== null && (
          <span className={styles.model} title={label} data-agent-model="">
            {label}
          </span>
        )}
        {todo !== null && todoId !== null && (
          <>
            {todoLineVerb(call)}{' '}
            <button
              type="button"
              className={styles.todo}
              onClick={() => {
                showTodo(taskId, todoId)
              }}
            >
              {todo.text}
            </button>
          </>
        )}
      </span>
      <AgentState call={call} />
    </div>
  )
})
