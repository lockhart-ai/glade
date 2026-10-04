/**
 * Permission requests (`docs/decisions.md`, "Per-call permission review"), from the tool call that waits on one to
 * the answer it gets. Built like the agent's questions (`../questions/questions`):
 *
 * - **Requesting** saves an open request for the task (so it outlives the app), tells the windows (`permission.opened`)
 *   and waits, however long it takes, until it's answered or withdrawn. The task's agent is waiting on you while it
 *   does, though its turn is still running: its activity is waiting, and `task.awaitingPermission` is true. A request
 *   in a task you aren't viewing marks it unread and is notified, as a final reply is (`../tasks/attention`): the
 *   notification says the tool and its command or file. Parallel calls each get a request of their own.
 * - **Answering** closes it, allowed or denied (`permission.answered`), and the call that waits on it gets the decision.
 *   Whoever made the call (the agent runner) puts the task back to work. Allow for this task also grants the task the
 *   request's rule (`taskPermissionRule`), saved with the answer, for the task's sessions to start with from then on.
 * - **Withdrawing** closes it without one (`permission.withdrawn`): the turn that made the call was stopped, failed or
 *   ended, its session closed, or the SDK cancelled the call (`signal`). The call that waits on it gets nothing.
 * - **A sandbox request** (`PermissionRequest.sandbox`, #450) asks for a folder or a domain, or to run a command
 *   outside the sandbox. A folder or domain is allowed for the task or for its workspace, never once: the answer saves
 *   the grant with it (`../sandbox/grants`), and whoever made the call applies it to the running sessions before the
 *   call goes on. Running outside the sandbox is allowed once, or denied, and nothing is remembered.
 *
 * Only this process's calls wait: a request still open from before the app quit has nothing waiting on it
 * (`isWaiting` is false). Answering one just closes it; the agent runner hands the decision to the agent another way.
 */
import { BridgeErrorCode } from '../../shared/bridge'
import {
  PermissionDecisionKind,
  PermissionRequestState,
  TaskActivity,
  type PermissionDecision,
  type PermissionRequest,
} from '../../shared/domain'
import { permissionSummary, taskPermissionRule } from '../../shared/permissions'
import {
  grantFor,
  SandboxAskKind,
  sandboxAskPhrase,
  SandboxGrantScope,
  type CardGrantScope,
  type SandboxGrantAsk,
  type SandboxGrantTarget,
} from '../../shared/sandbox'
import { CommandFailure } from '../bridge/errors'
import { emitPermissionRequest, emitTaskUpdated } from '../bridge/events'
import {
  appendPermissionRequest,
  closePermissionRequest,
  getPermissionRequest,
  listOpenPermissionRequests,
  type NewPermissionRequest,
  type PermissionRequestClosing,
} from '../db/repositories/permission-requests'
import { addTaskPermissionRule } from '../db/repositories/task-permission-rules'
import { getTask } from '../db/repositories/tasks'
import type { NotifyReply } from '../notifications/notifications'
import { broadcastGrants, saveSandboxGrant } from '../sandbox/grants'
import { noteAgentReply } from '../tasks/attention'
import { updateTaskFromRunner, type TaskServiceContext } from '../tasks/service'

/** An open request, and the decision its call waits on: null once it's withdrawn. */
export interface PendingPermission {
  readonly request: PermissionRequest
  readonly decision: Promise<PermissionDecision | null>
}

export interface PermissionBroker {
  /**
   * Opens a permission request for a tool call and waits on it: `decision` resolves with your decision once it's
   * answered, or null once it's withdrawn, or `signal` aborts (the SDK cancelled the call), which withdraws it.
   */
  request(input: NewPermissionRequest, signal?: AbortSignal): PendingPermission
  /** Whether a call in this process is waiting on the request. */
  isWaiting(id: string): boolean
  /**
   * Answers an open request with your decision, which the call waiting on it gets. Answers with the request as it now
   * is. Throws a `CommandFailure`: `not_found` for no such request, `invalid_transition` for one that isn't open, and
   * `invalid_request` for an answer the request isn't offered: Allow for this task where it would grant nothing, Allow
   * once on a folder or domain, anything that remembers on a request to run outside the sandbox, or Allow for this
   * workspace on anything but a folder or domain.
   */
  answer(id: string, decision: PermissionDecision): PermissionRequest
  /** Withdraws a request, if it's open. */
  withdraw(id: string): void
  /** Withdraws every open request of the task's. */
  withdrawAll(taskId: string): void
  /**
   * Lets go of the calls waiting, as the app quits: their requests stay open, for the next launch to find, even as the
   * sessions closing cancel the calls.
   */
  close(): void
}

/** What a request asks a grant for: its folder or domain; null for any other request. */
function grantAsk(request: Pick<PermissionRequest, 'sandbox'>): SandboxGrantAsk | null {
  const { sandbox } = request
  return sandbox === null || sandbox.kind === SandboxAskKind.Outside ? null : sandbox
}

/** The tasks a card's grant covers: the request's task, or every task in that task's workspace. */
export function cardGrantTarget(scope: CardGrantScope, task: { id: string; workspaceId: string }): SandboxGrantTarget {
  switch (scope) {
    case SandboxGrantScope.Task:
      return { scope, taskId: task.id }
    case SandboxGrantScope.Workspace:
      return { scope, workspaceId: task.workspaceId }
  }
}

/** How a request's notification puts it: a sandbox request by what it's about, any other by its tool and subject. */
function requestSummary(input: NewPermissionRequest): string {
  const sandbox = input.sandbox ?? null
  return sandbox === null ? permissionSummary(input.toolName, input.input) : `Wants to ${sandboxAskPhrase(sandbox)}`
}

/**
 * How a decision closes its request: Allow for this task with the rule it grants, or, on a folder or domain, with the
 * scope the grant is for.
 */
function closingFor(decision: PermissionDecision, request: PermissionRequest): PermissionRequestClosing {
  const { sandbox } = request
  switch (decision.kind) {
    case PermissionDecisionKind.AllowOnce:
      if (grantAsk(request) !== null) {
        throw new CommandFailure(
          BridgeErrorCode.InvalidRequest,
          'A folder or domain is allowed for the task or the workspace, not once',
        )
      }
      return { state: PermissionRequestState.Allowed }
    case PermissionDecisionKind.AllowForTask: {
      if (grantAsk(request) !== null)
        return { state: PermissionRequestState.Allowed, grantedScope: SandboxGrantScope.Task }
      const rule = sandbox === null ? taskPermissionRule(request) : null
      if (rule === null) {
        throw new CommandFailure(BridgeErrorCode.InvalidRequest, 'This tool call can’t be allowed for the task')
      }
      return { state: PermissionRequestState.Allowed, grantedRule: rule }
    }
    case PermissionDecisionKind.AllowForWorkspace:
      if (grantAsk(request) === null) {
        throw new CommandFailure(BridgeErrorCode.InvalidRequest, 'This tool call can’t be allowed for the workspace')
      }
      return { state: PermissionRequestState.Allowed, grantedScope: SandboxGrantScope.Workspace }
    case PermissionDecisionKind.Deny: {
      const note = decision.note?.trim() ?? ''
      return { state: PermissionRequestState.Denied, note: note === '' ? null : note }
    }
  }
}

/**
 * The broker for a task service. `notify` notifies a request made in a task you aren't viewing, as the runner's
 * `notifyReply` does a reply; nothing by default.
 */
export function createPermissionBroker(
  context: TaskServiceContext,
  notify: NotifyReply = () => undefined,
): PermissionBroker {
  const { db, emit } = context
  /** The calls waiting on their requests, by request id. */
  const waiting = new Map<string, (decision: PermissionDecision | null) => void>()

  /** The task's `awaitingPermission` changed, and nothing else: tells the windows, without stamping it as changed. */
  const awaitingChanged = (taskId: string): void => {
    const task = getTask(db, taskId)
    if (task !== undefined) emitTaskUpdated(emit, task)
  }

  /** Closes an open request, tells the windows, and lets the call waiting on it go. Undefined when it isn't open. */
  const close = (
    id: string,
    closing: PermissionRequestClosing,
    decision: PermissionDecision | null,
  ): PermissionRequest | undefined => {
    // The answer and what it grants (a rule, or a folder or domain) are saved together, so nothing is granted without
    // its answer, or lost. A grant that can't be saved leaves the request open.
    const closed = db.transaction(() => {
      const request = closePermissionRequest(db, id, closing)
      if (request === undefined || closing.state !== PermissionRequestState.Allowed) return request
      if (closing.grantedRule !== undefined) {
        addTaskPermissionRule(db, { taskId: request.taskId, rule: closing.grantedRule })
      }
      const ask = grantAsk(request)
      const task = getTask(db, request.taskId)
      if (closing.grantedScope !== undefined && ask !== null && task !== undefined) {
        saveSandboxGrant(db, { target: cardGrantTarget(closing.grantedScope, task), grant: grantFor(ask) })
      }
      return request
    })()
    if (closed === undefined) return undefined
    // A workspace's grants show in Settings, which hears of the card's at once.
    const granted = getTask(db, closed.taskId)
    if (closed.grantedScope !== null && granted !== undefined) {
      broadcastGrants(context, cardGrantTarget(closed.grantedScope, granted))
    }
    emitPermissionRequest(emit, closed)
    awaitingChanged(closed.taskId)
    const resolve = waiting.get(id)
    waiting.delete(id)
    resolve?.(decision)
    return closed
  }

  const withdraw = (id: string): void => {
    close(id, { state: PermissionRequestState.Withdrawn }, null)
  }

  return {
    request(input, signal) {
      const request = appendPermissionRequest(db, input)
      emitPermissionRequest(emit, request)
      const task = getTask(db, input.taskId)
      if (task?.activity === TaskActivity.Waiting) awaitingChanged(input.taskId)
      else updateTaskFromRunner(context, input.taskId, { activity: TaskActivity.Waiting })
      if (noteAgentReply(context, input.taskId)) notify(input.taskId, requestSummary(input))
      const decision = new Promise<PermissionDecision | null>((resolve) => {
        waiting.set(request.id, resolve)
        const cancel = (): void => {
          if (waiting.has(request.id)) withdraw(request.id)
        }
        if (signal?.aborted === true) cancel()
        else signal?.addEventListener('abort', cancel, { once: true })
      })
      return { request, decision }
    },

    isWaiting(id) {
      return waiting.has(id)
    },

    answer(id, decision) {
      const request = getPermissionRequest(db, id)
      if (request === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No permission request ${id}`)
      const answered =
        request.state === PermissionRequestState.Open ? close(id, closingFor(decision, request), decision) : undefined
      if (answered === undefined) {
        throw new CommandFailure(BridgeErrorCode.InvalidTransition, 'The permission request is not open any more')
      }
      return answered
    },

    withdraw,

    withdrawAll(taskId) {
      for (const request of listOpenPermissionRequests(db, taskId)) withdraw(request.id)
    },

    close() {
      waiting.clear()
    },
  }
}
