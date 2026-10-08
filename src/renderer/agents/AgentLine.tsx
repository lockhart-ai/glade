import { memo, useMemo } from 'react'
import { TaskActivity, TaskState, type ToolCallEvent } from '../../shared/domain'
import { modelName } from '../../shared/models'
import { useGladeStore } from '../store/react'
import {
  agentsOf,
  agentStateLine,
  agentTodoSelector,
  agentTokensLine,
  isRunning,
  mainAgentStateLine,
  mainAgentText,
  selectAgentTokens,
  selectMainCurrentCall,
  todoLineVerb,
} from './agentsModel'
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
  /**
   * The agent, by its `Agent` call's `tool_use` id; null for Main, the task's own agent, whose line names the model it
   * runs on and the task's status (#566, design 64).
   */
  readonly agentId: string | null
  /** The workspace root, so the current tool call's file arguments show relative to it. */
  readonly rootPath: string | undefined
}

/**
 * The line under the strip on an agent's tab (`docs/design/html/51-agents-subagent.html`, `64-agents-main-line.html`,
 * `65-agents-subagent-tokens.html`): over the agent's own line, the model and provider it runs on with its input and
 * output token totals at the right ("1.2M in · 45K out"), the totals main keeps per agent in SQLite so they survive a
 * relaunch (#566).
 *
 * On a subagent's tab the line under that is the todo it's working on ("Working on #501 Return Retry-After on 429s",
 * "Worked on …" once it has finished), and its state at the right. The todo's title is a link: it shows the Todos tab
 * on that todo. One subagent works on one todo: the one it was started for (`subagentTodo`, #495), which for a
 * subagent's own subagent is its parent's unless it named another. One with no todo, or whose todo was deleted, has no
 * line.
 *
 * On Main's tab it's the task's status summary, or, until the agent has set one, the tool call it's working on now;
 * and "Running · 42m" by the task's age while it works, nothing otherwise.
 */
export const AgentLine = memo(function AgentLine({
  taskId,
  agentId,
  rootPath,
}: AgentLineProps): React.JSX.Element | null {
  const call = useGladeStore((state) =>
    agentId === null ? undefined : agentsOf(state.toolEvents[taskId]).calls.get(agentId),
  )
  const selectTodo = useMemo(
    () => (agentId === null ? (): null => null : agentTodoSelector(taskId, agentId)),
    [taskId, agentId],
  )
  const todo = useGladeStore(selectTodo)
  const showTodo = useGladeStore((state) => state.showTodo)
  const modelId = useGladeStore((state) => {
    if (agentId === null) return state.tasks[taskId]?.model ?? null
    const started = agentsOf(state.toolEvents[taskId]).calls.get(agentId)
    return typeof started?.input.model === 'string' ? started.input.model : null
  })
  const label = useGladeStore((state) => (modelId === null ? null : modelName(state.models, modelId)))
  const tokens = useGladeStore(selectAgentTokens(taskId, agentId))
  // Main's own line: its status summary, or what it's working on now, and its state while it works.
  const status = useGladeStore((state) => state.tasks[taskId]?.status ?? null)
  const selectMainCall = useMemo(() => selectMainCurrentCall(taskId), [taskId])
  const currentCall = useGladeStore(selectMainCall)
  const mainWorking = useGladeStore((state) => {
    const task = state.tasks[taskId]
    return task?.state === TaskState.Active && task.activity === TaskActivity.Working
  })
  const createdAt = useGladeStore((state) => state.tasks[taskId]?.createdAt ?? null)
  const now = useElapsedNow(mainWorking ? createdAt : null)
  const mainText = agentId === null ? mainAgentText({ status: status ?? '' }, currentCall, rootPath) : null
  const mainState = agentId === null && createdAt !== null ? mainAgentStateLine(mainWorking, createdAt, now) : null
  const todoId = todo?.id ?? null
  if (agentId === null) {
    if (mainText === null && label === null) return null
    return (
      <div className={styles.line} data-agent-line="">
        {label !== null && (
          <div className={styles.head}>
            <span className={styles.model} title={label} data-agent-model="">
              {label}
            </span>
            {tokens !== null && (
              <span className={styles.tokens} data-agent-tokens="">
                {agentTokensLine(tokens)}
              </span>
            )}
          </div>
        )}
        {mainText !== null && (
          <div className={styles.head}>
            <span className={styles.working} title={mainText}>
              {mainText}
            </span>
            {mainState !== null && <span className={styles.state}>{mainState}</span>}
          </div>
        )}
      </div>
    )
  }
  if (call === undefined || (todo === null && label === null)) return null
  return (
    <div className={styles.line} data-agent-line="">
      {(label !== null || tokens !== null) && (
        <div className={styles.head}>
          {label !== null && (
            <span className={styles.model} title={label} data-agent-model="">
              {label}
            </span>
          )}
          {tokens !== null && (
            <span className={styles.tokens} data-agent-tokens="">
              {agentTokensLine(tokens)}
            </span>
          )}
        </div>
      )}
      <div className={styles.head}>
        <span className={styles.working}>
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
    </div>
  )
})
