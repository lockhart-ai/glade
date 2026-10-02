// A sample-data fixture for a task with a very long history (#413), built in code rather than kept as a JSON file in
// e2e/seeds: about 500 chat messages (Markdown, code and links), 1,300 tool events, 90 subagents, 45 artifacts and 40
// todos, all made up. `writeLongHistorySeed` writes it beside a small task's, for a spec to compare the two.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How big the long task is: the scale of a supervisor task that has run for days. */
export interface HistoryScale {
  /** Chat messages, half yours and half the agent's replies. */
  readonly messages: number
  /** Tool log events in all: the agent's own calls and notes, its subagents' calls, its todo calls and its dividers. */
  readonly toolEvents: number
  readonly subagents: number
  readonly artifacts: number
  readonly todos: number
}

export const LONG_HISTORY: HistoryScale = { messages: 500, toolEvents: 1300, subagents: 90, artifacts: 45, todos: 40 }

/** The small task's: a few turns. */
export const SHORT_HISTORY: HistoryScale = { messages: 6, toolEvents: 12, subagents: 1, artifacts: 1, todos: 2 }

/** How many of a task's subagents are still running. */
const RUNNING_SUBAGENTS = 2

export const LONG_TASK_TITLE = 'Supervise the 2.x release'
export const SHORT_TASK_TITLE = 'Fix the date picker'

interface SeedMessage {
  readonly role: 'user' | 'agent'
  readonly body: string
  readonly turn: number
  readonly minutesAgo: number
}

type SeedToolEvent =
  | { readonly kind: 'divider'; readonly dividerKind: 'turn'; readonly turn: number; readonly minutesAgo: number }
  | { readonly kind: 'narration'; readonly text: string; readonly turn: number; readonly minutesAgo: number }
  | {
      readonly kind: 'tool_call'
      readonly name: string
      readonly input: Readonly<Record<string, unknown>>
      /** Still running without one. */
      readonly output?: string
      readonly toolUseId?: string
      readonly parentToolUseId?: string
      readonly turn: number
      readonly minutesAgo: number
    }

interface SeedArtifact {
  readonly path: string
  readonly title: string
  readonly minutesAgo: number
}

interface SeedTask {
  readonly title: string
  readonly objective: string
  readonly status: string
  readonly minutesAgo: number
  readonly startedMinutesAgo: number
  readonly selected?: boolean
  readonly contextUsedTokens: number
  readonly messages: readonly SeedMessage[]
  readonly toolEvents: readonly SeedToolEvent[]
  readonly artifacts: readonly SeedArtifact[]
}

const AREAS = ['billing', 'search', 'uploads', 'auth', 'dashboard', 'webhooks', 'exports', 'notifications'] as const

function area(index: number): string {
  return AREAS[index % AREAS.length] ?? 'api'
}

/** Your message for turn `turn`. */
function userBody(turn: number): string {
  return turn % 3 === 0
    ? `Look at the ${area(turn)} tests next. The flaky one is in \`tests/${area(turn)}/test_api.py\`, see https://example.com/acme/api/issues/${String(100 + turn)}.`
    : `Sounds good. Go ahead with ${area(turn)} and tell me when the PR is up.`
}

/** The agent's reply ending turn `turn`: Markdown with a heading, a list, inline code, a link and a code block. */
function agentBody(turn: number): string {
  const name = area(turn)
  return [
    `### ${name[0]?.toUpperCase() ?? ''}${name.slice(1)}: turn ${String(turn)}`,
    '',
    `I reviewed **PR #${String(200 + turn)}** for \`${name}\` and merged it once CI went green.`,
    '',
    `- Moved the retry logic into \`${name}/client.py\``,
    `- Added a regression test, \`test_${name}_retries\``,
    `- Details are in [the PR](https://example.com/acme/api/pull/${String(200 + turn)}) and https://example.com/acme/api/actions`,
    '',
    '```python',
    `def retry_${name}(request, attempts=3):`,
    '    for attempt in range(attempts):',
    '        response = send(request)',
    '        if response.ok:',
    '            return response',
    '    raise RetryError(request)',
    '```',
    '',
    'Next up: the release notes. Want me to start on them?',
  ].join('\n')
}

/** Spreads `count` items over `turns` turns, as evenly as it can: how many land in turn `turn` (from 1). */
function share(count: number, turns: number, turn: number): number {
  return Math.floor((count * turn) / turns) - Math.floor((count * (turn - 1)) / turns)
}

/** A task's sample history at `scale`, with its turns ending `minutesAgo` minutes before the capture. */
function historyTask(title: string, scale: HistoryScale, selected: boolean): SeedTask {
  const turns = Math.max(1, Math.floor(scale.messages / 2))
  // One minute per turn, oldest first.
  const at = (turn: number): number => turns - turn + 1
  const messages: SeedMessage[] = []
  const toolEvents: SeedToolEvent[] = []
  // Each turn has a divider (after the first), a note and its todo and subagent calls; ordinary calls fill the rest.
  const subagentCalls = 3
  const fixed =
    turns - 1 + turns + scale.todos + scale.subagents * (1 + subagentCalls) + Math.floor(scale.todos / 2)
  const plain = Math.max(0, scale.toolEvents - fixed)
  let subagent = 0
  let todo = 0
  let call = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    const minutesAgo = at(turn)
    messages.push({ role: 'user', body: userBody(turn), turn, minutesAgo })
    if (turn > 1) toolEvents.push({ kind: 'divider', dividerKind: 'turn', turn, minutesAgo })
    toolEvents.push({ kind: 'narration', text: `Checking \`${area(turn)}\` before the next PR.`, turn, minutesAgo })
    for (let index = 0; index < share(scale.todos, turns, turn); index += 1) {
      todo += 1
      const subject = `Ship the ${area(todo)} fix (${String(todo)})`
      toolEvents.push({
        kind: 'tool_call',
        name: 'TaskCreate',
        input: { subject, description: subject, activeForm: `Shipping the ${area(todo)} fix` },
        output: `Task #${String(todo)} created successfully: ${subject}`,
        turn,
        minutesAgo,
      })
      // Every other one is done by now.
      if (todo % 2 === 0) {
        toolEvents.push({
          kind: 'tool_call',
          name: 'TaskUpdate',
          input: { taskId: String(todo), status: 'completed' },
          output: `Updated task #${String(todo)} status`,
          turn,
          minutesAgo,
        })
      }
    }
    for (let index = 0; index < share(scale.subagents, turns, turn); index += 1) {
      subagent += 1
      const toolUseId = `agent-${String(subagent)}`
      // The last two still run in the background, as a supervisor's reviewers do while it waits on them.
      const running = subagent > scale.subagents - RUNNING_SUBAGENTS
      toolEvents.push({
        kind: 'tool_call',
        name: 'Agent',
        input: { description: `Review the ${area(subagent)} PR ${String(subagent)}`, prompt: 'Review the PR.' },
        ...(running ? {} : { output: `The ${area(subagent)} PR looks good: tests pass and the diff is small.` }),
        toolUseId,
        turn,
        minutesAgo,
      })
      for (let step = 0; step < subagentCalls; step += 1) {
        toolEvents.push({
          kind: 'tool_call',
          name: step === 0 ? 'Grep' : 'Read',
          input: step === 0 ? { pattern: `retry_${area(subagent)}` } : { file_path: `${area(subagent)}/client.py` },
          output: step === 0 ? `Found 2 files\n${area(subagent)}/client.py` : '     1\timport requests\n     2\t',
          parentToolUseId: toolUseId,
          turn,
          minutesAgo,
        })
      }
    }
    for (let index = 0; index < share(plain, turns, turn); index += 1) {
      call += 1
      toolEvents.push(
        call % 2 === 0
          ? {
              kind: 'tool_call',
              name: 'Bash',
              input: { command: `pytest tests/${area(call)} -q` },
              output: `..........  [100%]\n${String(10 + (call % 20))} passed in 2.${String(call % 10)}s`,
              turn,
              minutesAgo,
            }
          : {
              kind: 'tool_call',
              name: 'Read',
              input: { file_path: `${area(call)}/views.py` },
              output: '     1\tfrom rest_framework import viewsets\n     2\t',
              turn,
              minutesAgo,
            },
      )
    }
    messages.push({ role: 'agent', body: agentBody(turn), turn, minutesAgo })
  }
  const artifacts = Array.from({ length: scale.artifacts }, (_, index) => ({
    path: `docs/reports/${area(index)}-${String(index + 1)}.md`,
    title: `The ${area(index)} report, part ${String(index + 1)}`,
    minutesAgo: scale.artifacts - index,
  }))
  return {
    title,
    objective: `${title}.`,
    status: 'Waiting on you: start the release notes?',
    minutesAgo: 0,
    startedMinutesAgo: turns + 1,
    ...(selected ? { selected } : {}),
    contextUsedTokens: 120_000,
    messages,
    toolEvents,
    artifacts,
  }
}

/** Which of the two tasks the seed selects, so the window opens on it. */
export enum SelectedHistory {
  Long = 'long',
  Short = 'short',
}

/**
 * Writes the fixture into `folder` and returns its path: the long task and the small one in one workspace, with
 * `selected` showing and the right panel on `panelTab`.
 */
export function writeLongHistorySeed(folder: string, selected: SelectedHistory, panelTab = 'tool-calls'): string {
  const seed = {
    workspace: { name: 'Acme API', rootPath: '/Users/sample/code/api' },
    panelTab,
    tasks: [
      historyTask(SHORT_TASK_TITLE, SHORT_HISTORY, selected === SelectedHistory.Short),
      historyTask(LONG_TASK_TITLE, LONG_HISTORY, selected === SelectedHistory.Long),
    ],
  }
  const path = join(folder, 'long-history.json')
  writeFileSync(path, JSON.stringify(seed))
  return path
}
