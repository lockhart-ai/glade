import { memo } from 'react'
import type { ToolCallEvent } from '../../shared/domain'
import { useGladeStore } from '../store/react'
import { agentsOf, agentStateLine, agentTodo, isRunning, todoLineVerb } from './agentsModel'
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
 * todo's title is a link: it shows the Todos tab on that todo. One subagent works on one todo; one with no todo, or
 * whose todo was deleted, has no line.
 */
export const AgentLine = memo(function AgentLine({ taskId, agentId }: AgentLineProps): React.JSX.Element | null {
  const call = useGladeStore((state) => agentsOf(state.toolEvents[taskId]).calls.get(agentId))
  const todo = useGladeStore((state) => agentTodo(state.filings[taskId], state.todos[taskId]?.items, agentId))
  const showTodo = useGladeStore((state) => state.showTodo)
  const todoId = todo?.id ?? null
  if (call === undefined || todo === null || todoId === null) return null
  return (
    <div className={styles.line} data-agent-line="">
      <span className={styles.working}>
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
      </span>
      <AgentState call={call} />
    </div>
  )
})
