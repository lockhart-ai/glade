import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  PermissionDecisionKind,
  PermissionDestination,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type PermissionRequest,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { Chat } from '../chat/Chat'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleMessage,
  samplePermissionRequest,
  sampleTask,
  sampleWorkspace,
  type FakeHandlers,
} from '../store/test-bridge'
import { TRIMMED_LINES } from './permissionCardModel'
import { moduleClass } from '../components/moduleClass'
import { APPEAR_WINDOW_MS } from '../questions/QuestionCard'
import { NOTE_PLACEHOLDER } from './PermissionCard'
import styles from './PermissionCard.module.css'

/** The sample workspace's root, which paths show relative to. */
const ROOT = '/code/w1'

function request(id: string, patch: Partial<PermissionRequest> = {}): PermissionRequest {
  return { ...samplePermissionRequest(id, 't1'), ...patch }
}

const EDIT = request('edit', {
  toolName: 'Edit',
  input: {
    file_path: `${ROOT}/docs/upgrade.md`,
    old_string: '## Upgrading\n\nNo changes are needed.',
    new_string: '## Upgrading\n\nSearch is limited to 10 requests a second.',
  },
  displayName: 'Edit',
  description: 'upgrade.md',
  // As Claude Code suggests for an edit: only a switch to acceptEdits, so Allow for this task grants the whole tool.
  suggestions: [
    { type: PermissionUpdateType.SetMode, mode: 'acceptEdits', destination: PermissionDestination.Session },
  ],
})

const WRITE = request('write', {
  toolName: 'Write',
  input: { file_path: `${ROOT}/out/announcement.txt`, content: 'Acme API 2.4 is out.\nUpgrade today.' },
  suggestions: [],
})

const UNKNOWN = request('unknown', {
  toolName: 'mcp__deploy__release',
  input: { service: 'api', version: '2.4.0' },
  suggestions: [],
})

function agentCall(toolUseId: string, input: Record<string, unknown>): ToolCallEvent {
  return {
    kind: ToolEventKind.ToolCall,
    id: `e-${toolUseId}`,
    taskId: 't1',
    turn: 1,
    name: 'Agent',
    input,
    output: null,
    state: ToolCallState.Running,
    finishedAt: null,
    toolUseId,
    parentToolUseId: null,
    progressSummary: null,
    createdAt: 2_500,
  }
}

function subagentCall(toolUseId: string, parentToolUseId: string): ToolCallEvent {
  return { ...agentCall(toolUseId, {}), id: `e-${toolUseId}`, name: 'Write', parentToolUseId }
}

interface Rendered {
  readonly fake: ReturnType<typeof fakeBridge>
  readonly requests: PermissionRequest[]
}

async function renderChat(
  requests: PermissionRequest[],
  toolEvents: ToolEvent[] = [],
  overrides: Partial<FakeHandlers> = {},
): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [{ ...sampleTask('t1', 'w1'), activity: TaskActivity.Waiting, awaitingPermission: true }],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      messages: [sampleMessage('m1', 't1', 'Run the tests.')],
      toolEvents,
      permissionRequests: requests,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <button type="button">Elsewhere</button>
        <Chat />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { fake, requests }
}

function openCards(): HTMLElement[] {
  return screen.queryAllByRole('form', { name: 'Permission request' })
}

function card(index = 0): HTMLElement {
  const found = openCards()[index]
  if (found === undefined) throw new Error(`No open card ${String(index)}`)
  return found
}

function closedCards(): HTMLElement[] {
  return screen.queryAllByRole('region', { name: 'Permission request' })
}

function button(name: string, index = 0): HTMLElement {
  return within(card(index)).getByRole('button', { name })
}

function answers(fake: Rendered['fake']): unknown[] {
  return fake.invoke.mock.calls
    .filter(([command]) => command === CommandName.PermissionsAnswer)
    .map(([, payload]) => payload)
}

/** An input block's lines, as they read. */
function lines(block: HTMLElement): string[] {
  return [...block.children].map((line) => line.textContent)
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('the permission card', () => {
  it("shows a Bash call's command and what it's for, with Allow once and Deny", async () => {
    await renderChat([
      request('p1', { input: { command: 'npm test -- --coverage', description: 'Run with coverage' } }),
    ])

    const open = card()
    expect(within(open).getByText('Bash')).toBeInTheDocument()
    expect(within(open).getByLabelText('Command')).toHaveTextContent('npm test -- --coverage')
    expect(within(open).getByText('Run with coverage')).toBeInTheDocument()
    expect(within(open).getByRole('group', { name: 'Answer' })).toBeInTheDocument()
    expect(button('Allow once')).toBeInTheDocument()
    expect(button('Deny')).toBeInTheDocument()
    expect(screen.getByText(/^agent · /)).toBeInTheDocument()
  })

  it("shows an Edit's file relative to the workspace, and its change marked line by line", async () => {
    await renderChat([EDIT])

    expect(within(card()).getByText('docs/upgrade.md')).toBeInTheDocument()
    const change = within(card()).getByLabelText('Change')
    expect(change).toHaveTextContent('## Upgrading')
    expect(change).toHaveTextContent('- No changes are needed.')
    expect(change).toHaveTextContent('+ Search is limited to 10 requests a second.')
  })

  it("shows a Write's file and content, and any other tool's input as formatted JSON", async () => {
    await renderChat([WRITE, UNKNOWN])

    expect(within(card(0)).getByText('out/announcement.txt')).toBeInTheDocument()
    expect(lines(within(card(0)).getByLabelText('Content'))).toEqual(['Acme API 2.4 is out.', 'Upgrade today.'])
    expect(within(card(1)).getByText('mcp__deploy__release')).toBeInTheDocument()
    expect(lines(within(card(1)).getByLabelText('Input'))).toEqual(
      JSON.stringify({ service: 'api', version: '2.4.0' }, null, 2).split('\n'),
    )
  })

  it("says which subagent made a subagent's call, and titles a card with Claude Code's sentence", async () => {
    const guide = request('guide', {
      ...WRITE,
      id: 'guide',
      toolUseId: 'guide-write',
      agentId: 'a1b2c3',
      title: 'Claude wants to create out/announcement.txt',
    })
    const events = [
      agentCall('guide-agent', { description: 'Upgrade guide' }),
      subagentCall('guide-write', 'guide-agent'),
    ]
    await renderChat([guide], events)

    expect(within(card()).getByText('subagent · Upgrade guide')).toBeInTheDocument()
    expect(within(card()).getByText('Claude wants to create out/announcement.txt')).toBeInTheDocument()
  })

  it("says it's a subagent's even before the tool log says which", async () => {
    await renderChat([request('p1', { agentId: 'a1b2c3' })])

    expect(within(card()).getByText('subagent')).toBeInTheDocument()
  })

  it('allows the call once, and collapses to a line saying so', async () => {
    const { fake } = await renderChat([request('p1')])

    fireEvent.click(button('Allow once'))
    await settle()

    expect(answers(fake)).toEqual([{ id: 'p1', decision: { kind: PermissionDecisionKind.AllowOnce } }])
    expect(openCards()).toHaveLength(0)
    const [line] = closedCards()
    expect(line).toHaveTextContent('Bash: npm test·allowed once')
    expect(line).toHaveAttribute('title', 'Bash: npm test · allowed once')
  })

  it('denies without a note when the note is left empty', async () => {
    const { fake } = await renderChat([request('p1')])

    fireEvent.click(button('Deny'))
    const note = within(card()).getByRole('textbox', { name: 'Note for the agent' })
    expect(note).toHaveFocus()
    expect(note).toHaveAttribute('placeholder', NOTE_PLACEHOLDER)
    fireEvent.change(note, { target: { value: '   ' } })
    fireEvent.click(button('Deny'))
    await settle()

    expect(answers(fake)).toEqual([{ id: 'p1', decision: { kind: PermissionDecisionKind.Deny } }])
    expect(closedCards()[0]).toHaveTextContent('Bash: npm test·denied')
  })

  it('denies with the note, trimmed, on ↵ in the note field', async () => {
    const { fake } = await renderChat([request('p1')])

    fireEvent.click(button('Deny'))
    const note = within(card()).getByRole('textbox', { name: 'Note for the agent' })
    fireEvent.change(note, { target: { value: '  Run only the date tests  ' } })
    // ↵ while an input method is composing belongs to it.
    fireEvent.keyDown(note, { key: 'Enter', isComposing: true })
    expect(answers(fake)).toEqual([])
    fireEvent.keyDown(note, { key: 'a' })
    fireEvent.keyDown(note, { key: 'Enter' })
    await settle()

    expect(answers(fake)).toEqual([
      { id: 'p1', decision: { kind: PermissionDecisionKind.Deny, note: 'Run only the date tests' } },
    ])
    expect(closedCards()[0]).toHaveTextContent('denied: “Run only the date tests”')
  })

  it('closes the note field with Esc or Cancel, back on Deny, keeping what you wrote', async () => {
    const { fake } = await renderChat([request('p1')])

    fireEvent.click(button('Deny'))
    const note = within(card()).getByRole('textbox', { name: 'Note for the agent' })
    fireEvent.change(note, { target: { value: 'Not yet' } })
    fireEvent.keyDown(note, { key: 'Escape' })
    expect(button('Deny')).toHaveFocus()
    expect(button('Allow once')).toBeInTheDocument()

    fireEvent.click(button('Deny'))
    expect(within(card()).getByRole('textbox', { name: 'Note for the agent' })).toHaveValue('Not yet')
    fireEvent.click(button('Cancel'))
    expect(button('Deny')).toHaveFocus()
    expect(answers(fake)).toEqual([])
  })

  it('says it was withdrawn when the turn ends under it', async () => {
    const { fake } = await renderChat([request('p1')])

    act(() => {
      fake.emit({
        type: EventType.PermissionWithdrawn,
        permissionRequest: { ...request('p1'), state: PermissionRequestState.Withdrawn, closedAt: 4_000 },
      })
    })

    expect(openCards()).toHaveLength(0)
    expect(closedCards()[0]).toHaveTextContent('Bash: npm test·withdrawn')
  })

  it("toasts when the answer doesn't reach main, and can be answered again", async () => {
    let fail = true
    const { fake } = await renderChat([request('p1')], [], {
      [CommandName.PermissionsAnswer]: () =>
        fail
          ? refuse(bridgeError(BridgeErrorCode.Internal, 'The database is locked'))
          : refuse(bridgeError(BridgeErrorCode.InvalidTransition, 'closed')),
    })

    fireEvent.click(button('Allow once'))
    // A second click while the first is on its way does nothing.
    fireEvent.click(button('Allow once'))
    await settle()

    expect(
      await screen.findByText(/Couldn’t answer the permission request: The database is locked/),
    ).toBeInTheDocument()
    expect(answers(fake)).toHaveLength(1)
    fail = false
    fireEvent.click(button('Allow once'))
    await settle()
    expect(answers(fake)).toHaveLength(2)
  })
})

describe('the keyboard', () => {
  it('takes the focus on Allow once as the card opens, so ↵ approves; ← → move to Deny and back', async () => {
    await renderChat([request('p1', { suggestions: [] })])

    expect(button('Allow once')).toHaveFocus()
    expect(button('Allow once')).toHaveAttribute('tabindex', '0')
    expect(button('Deny')).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(button('Allow once'), { key: 'ArrowRight' })
    expect(button('Deny')).toHaveFocus()
    expect(button('Deny')).toHaveAttribute('tabindex', '0')
    expect(button('Allow once')).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(button('Deny'), { key: 'ArrowLeft' })
    expect(button('Allow once')).toHaveFocus()
    // Other keys are left alone.
    fireEvent.keyDown(button('Allow once'), { key: 'ArrowDown' })
    expect(button('Allow once')).toHaveFocus()
  })

  it('answers with ↵ on the focused answer: Allow once allows, Deny opens the note', async () => {
    const { fake } = await renderChat([request('p1'), { ...request('p2'), createdAt: 3_500 }])

    fireEvent.keyDown(button('Deny', 1), { key: 'Enter' })
    expect(within(card(1)).getByRole('textbox', { name: 'Note for the agent' })).toHaveFocus()
    fireEvent.keyDown(button('Allow once', 0), { key: 'Enter' })
    await settle()

    expect(answers(fake)).toEqual([{ id: 'p1', decision: { kind: PermissionDecisionKind.AllowOnce } }])
  })

  it('starts on Deny when a stray key mustn’t approve the call (defaultToNo), with no one-key approve', async () => {
    const { fake } = await renderChat([request('p1', { defaultToNo: true })])

    expect(button('Deny')).toHaveFocus()
    expect(button('Deny')).toHaveAttribute('tabindex', '0')
    expect(button('Allow once')).toHaveAttribute('tabindex', '-1')

    // ↵ on Deny opens the note, which ↵ again sends: nothing on the way approves.
    fireEvent.click(button('Deny'))
    fireEvent.keyDown(within(card()).getByRole('textbox', { name: 'Note for the agent' }), { key: 'Enter' })
    await settle()
    expect(answers(fake)).toEqual([{ id: 'p1', decision: { kind: PermissionDecisionKind.Deny } }])
  })

  it('stays put when you are elsewhere as a card opens, and focuses it once you are not', async () => {
    const { fake } = await renderChat([])
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()

    act(() => {
      fake.emit({ type: EventType.PermissionOpened, permissionRequest: request('p1') })
    })

    expect(card()).toBeInTheDocument()
    expect(elsewhere).toHaveFocus()
  })
})

/** The rule Claude Code suggests adding for a `Bash` call, for a settings file. */
function suggestsRules(...ruleContents: string[]): Partial<PermissionRequest> {
  return {
    suggestions: [
      {
        type: PermissionUpdateType.AddRules,
        rules: ruleContents.map((ruleContent) => ({ toolName: 'Bash', ruleContent })),
        behavior: PermissionRuleBehavior.Allow,
        destination: PermissionDestination.LocalSettings,
      },
    ],
  }
}

describe('Allow for this task', () => {
  it('names the command prefix it grants, set as code, between Allow once and Deny', async () => {
    await renderChat([request('p1')])

    const grant = button('Allow npm test commands for this task')
    const answer = within(card()).getByRole('group', { name: 'Answer' })
    expect([...answer.querySelectorAll('button')].map((each) => each.textContent)).toEqual([
      'Allow once',
      'Allow npm test commands for this task',
      'Deny',
    ])
    const code = within(grant).getByText('npm test')
    expect(code.tagName).toBe('CODE')
    expect(code).toHaveAttribute('title', 'npm test')
    expect(grant).toHaveAttribute('tabindex', '-1')
  })

  it('grants the call for the task, and collapses to a line saying so', async () => {
    const { fake } = await renderChat([request('p1')])

    fireEvent.click(button('Allow npm test commands for this task'))
    await settle()

    expect(answers(fake)).toEqual([{ id: 'p1', decision: { kind: PermissionDecisionKind.AllowForTask } }])
    expect(openCards()).toHaveLength(0)
    expect(closedCards().map((line) => line.textContent)).toEqual(['Bash: npm test·allowed for this task'])
  })

  it('names the whole tool for an Edit, and the command itself for a rule without a prefix', async () => {
    await renderChat([
      EDIT,
      { ...request('touch', suggestsRules('touch a(1).txt')), input: { command: 'touch a(1).txt' }, createdAt: 3_100 },
      { ...request('legacy', suggestsRules('npm run lint:*')), createdAt: 3_200 },
    ])

    expect(button('Allow Edit for this task', 0)).toBeInTheDocument()
    expect(within(button('Allow Edit for this task', 0)).queryByText('Edit', { selector: 'code' })).toBeNull()
    expect(button('Allow touch a(1).txt for this task', 1)).toBeInTheDocument()
    expect(button('Allow npm run lint commands for this task', 2)).toBeInTheDocument()
  })

  it("isn't offered when the SDK says not to remember, for Bash without one suggested rule, or for another tool's rule", async () => {
    await renderChat([
      request('suppressed', { suppressAlwaysAllowRule: true }),
      { ...request('none', { suggestions: [] }), createdAt: 3_100 },
      { ...request('compound', suggestsRules('npm test *', 'rm -rf build')), createdAt: 3_200 },
      { ...request('whole', suggestsRules('')), createdAt: 3_300 },
      { ...EDIT, id: 'edit-bash-rule', ...suggestsRules('npm test *'), createdAt: 3_400 },
      { ...EDIT, id: 'edit-suppressed', suppressAlwaysAllowRule: true, createdAt: 3_500 },
    ])

    expect(openCards()).toHaveLength(6)
    for (const open of openCards()) {
      const answer = within(open).getByRole('group', { name: 'Answer' })
      expect(
        within(answer)
          .getAllByRole('button')
          .map((each) => each.textContent),
      ).toEqual(['Allow once', 'Deny'])
    }
  })

  it('is one of the three answers ← → move between, wrapping round, and ↵ on it grants the call', async () => {
    const { fake } = await renderChat([request('p1')])
    const grant = 'Allow npm test commands for this task'

    fireEvent.keyDown(button('Allow once'), { key: 'ArrowRight' })
    expect(button(grant)).toHaveFocus()
    expect(button(grant)).toHaveAttribute('tabindex', '0')
    expect(button('Allow once')).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(button(grant), { key: 'ArrowRight' })
    expect(button('Deny')).toHaveFocus()
    fireEvent.keyDown(button('Deny'), { key: 'ArrowRight' })
    expect(button('Allow once')).toHaveFocus()
    fireEvent.keyDown(button('Allow once'), { key: 'ArrowLeft' })
    expect(button('Deny')).toHaveFocus()
    fireEvent.keyDown(button('Deny'), { key: 'ArrowLeft' })
    expect(button(grant)).toHaveFocus()

    fireEvent.keyDown(button(grant), { key: 'Enter' })
    await settle()
    expect(answers(fake)).toEqual([{ id: 'p1', decision: { kind: PermissionDecisionKind.AllowForTask } }])
  })

  it('sends one answer however often it is pressed, and toasts when main refuses it', async () => {
    const { fake } = await renderChat([request('p1')], [], {
      [CommandName.PermissionsAnswer]: () =>
        refuse(bridgeError(BridgeErrorCode.InvalidRequest, "Permission request p1 can't be allowed for the task")),
    })
    const grant = button('Allow npm test commands for this task')

    fireEvent.click(grant)
    fireEvent.click(grant)
    await settle()

    expect(answers(fake)).toHaveLength(1)
    expect(await screen.findByText(/Couldn’t answer the permission request/)).toBeInTheDocument()
    expect(card()).toBeInTheDocument()
  })

  it('cuts a very long command short on its button, keeping the whole of it as the title', async () => {
    const command = `curl -X POST https://api.example.test/v1/${'segment/'.repeat(200)}`
    await renderChat([{ ...request('p1', suggestsRules(command)), input: { command } }])

    const code = within(card()).getByText(command, { selector: 'code' })
    expect(code).toHaveAttribute('title', command)
    expect(code).toHaveClass(moduleClass(styles, 'grantSubject'))
  })
})

describe('stress', () => {
  it('trims a very long command to its first lines, with Show all to see the rest and Show less to trim it again', async () => {
    const command = Array.from({ length: 60 }, (_, index) => `echo step ${String(index + 1)}`).join(' &&\n')
    await renderChat([request('p1', { input: { command } })])

    const block = within(card()).getByLabelText('Command')
    expect(block.children).toHaveLength(TRIMMED_LINES)
    const showAll = within(card()).getByRole('button', { name: 'Show all 60 lines' })
    expect(showAll).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(showAll)
    expect(within(card()).getByLabelText('Command').children).toHaveLength(60)
    fireEvent.click(within(card()).getByRole('button', { name: 'Show less' }))
    expect(within(card()).getByLabelText('Command').children).toHaveLength(TRIMMED_LINES)
  })

  it('cuts a one-line command of 50,000 characters short', async () => {
    await renderChat([request('p1', { input: { command: `echo ${'x'.repeat(50_000)}` } })])

    const block = within(card()).getByLabelText('Command')
    expect(block.textContent.length).toBeLessThan(2_000)
    expect(within(card()).getByRole('button', { name: 'Show all 1 line' })).toBeInTheDocument()
  })

  it('trims a huge edit, and still answers it', async () => {
    const old_string = Array.from({ length: 2_000 }, (_, index) => `old ${String(index)}`).join('\n')
    const new_string = Array.from({ length: 2_000 }, (_, index) => `new ${String(index)}`).join('\n')
    const { fake } = await renderChat([
      request('p1', { toolName: 'Edit', input: { file_path: `${ROOT}/big.ts`, old_string, new_string } }),
    ])

    expect(within(card()).getByLabelText('Change').children).toHaveLength(TRIMMED_LINES)
    expect(within(card()).getByRole('button', { name: 'Show all 4000 lines' })).toBeInTheDocument()
    fireEvent.click(button('Allow once'))
    await settle()
    expect(answers(fake)).toEqual([{ id: 'p1', decision: { kind: PermissionDecisionKind.AllowOnce } }])
  })

  it('answers two cards open in one turn each on its own, the focus moving to the next', async () => {
    const { fake } = await renderChat([request('p1'), { ...EDIT, createdAt: 3_500 }])

    expect(openCards()).toHaveLength(2)
    // The first takes the focus, not the second.
    expect(button('Allow once', 0)).toHaveFocus()

    fireEvent.click(button('Deny', 1))
    fireEvent.change(within(card(1)).getByRole('textbox', { name: 'Note for the agent' }), {
      target: { value: 'Keep the old wording' },
    })
    fireEvent.click(button('Deny', 1))
    await settle()
    expect(openCards()).toHaveLength(1)
    expect(closedCards()[0]).toHaveTextContent('Edit: docs/upgrade.md·denied: “Keep the old wording”')

    // Answering the one left, from the keyboard's focus.
    fireEvent.click(button('Allow once'))
    await settle()
    expect(openCards()).toHaveLength(0)
    expect(answers(fake)).toEqual([
      { id: 'edit', decision: { kind: PermissionDecisionKind.Deny, note: 'Keep the old wording' } },
      { id: 'p1', decision: { kind: PermissionDecisionKind.AllowOnce } },
    ])
    expect(closedCards().map((line) => line.textContent)).toEqual([
      'Bash: npm test·allowed once',
      'Edit: docs/upgrade.md·denied: “Keep the old wording”',
    ])
  })

  it('moves the focus to the next open card once the first is answered', async () => {
    await renderChat([request('p1'), { ...request('p2'), createdAt: 3_500 }])

    expect(button('Allow once', 0)).toHaveFocus()
    fireEvent.click(button('Allow once', 0))
    await settle()

    expect(openCards()).toHaveLength(1)
    expect(button('Allow once')).toHaveFocus()
  })

  it('collapses to withdrawn while you type a note, sending nothing', async () => {
    const { fake } = await renderChat([request('p1')])

    fireEvent.click(button('Deny'))
    const note = within(card()).getByRole('textbox', { name: 'Note for the agent' })
    fireEvent.change(note, { target: { value: 'Half a thou' } })
    act(() => {
      fake.emit({
        type: EventType.PermissionWithdrawn,
        permissionRequest: { ...request('p1'), state: PermissionRequestState.Withdrawn, closedAt: 4_000 },
      })
    })

    expect(openCards()).toHaveLength(0)
    expect(note).not.toBeInTheDocument()
    expect(closedCards()[0]).toHaveTextContent('withdrawn')
    expect(answers(fake)).toEqual([])
  })

  it('refuses an answer to a card already closed elsewhere, and shows it closed once main says so', async () => {
    const { fake, requests } = await renderChat([request('p1')])
    const closed = { ...request('p1'), state: PermissionRequestState.Allowed, closedAt: 4_000 }
    requests[0] = closed

    fireEvent.click(button('Deny'))
    fireEvent.click(button('Deny'))
    await settle()
    expect(await screen.findByText(/Couldn’t answer the permission request: .*isn't open/)).toBeInTheDocument()

    act(() => {
      fake.emit({ type: EventType.PermissionAnswered, permissionRequest: closed })
    })
    expect(closedCards()[0]).toHaveTextContent('allowed once')
  })
})

describe('motion', () => {
  const cls = (name: string): string => moduleClass(styles, name)

  it('rises in when it has just asked, and stays put when the chat opens on an older one', async () => {
    await renderChat([
      request('p1', { createdAt: Date.now() }),
      request('p2', { createdAt: Date.now() - APPEAR_WINDOW_MS }),
    ])
    // The older one shows first.
    expect(card(0)).not.toHaveClass(cls('appearing'))
    expect(card(1)).toHaveClass(cls('appearing'))
  })

  it('fades to its line when it closes while showing, but not when it was already closed', async () => {
    const { fake } = await renderChat([request('p1'), request('p2', { state: PermissionRequestState.Allowed })])
    act(() => {
      fake.emit({
        type: EventType.PermissionWithdrawn,
        permissionRequest: { ...request('p1'), state: PermissionRequestState.Withdrawn, closedAt: 4_000 },
      })
    })

    const [withdrawn, allowed] = closedCards()
    expect(withdrawn).toHaveClass(cls('justClosed'), cls('withdrawn'))
    expect(allowed).not.toHaveClass(cls('justClosed'))
  })
})
