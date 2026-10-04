// The sandbox's escape battery (#516, docs/escape-battery.md): the acceptance test of the agent sandbox (#445). A
// sandboxed task with nothing granted, every card denied, is put through a fixed list of attacks, with the real agent
// backend, the bundled Claude Code and its real sandbox (Seatbelt), against a stand-in for the model on this Mac that
// replays the list. No real API call is made, and nothing the attacks name is real: a dummy home folder and workspace
// in the system temp folder, canary files holding random tokens, listeners on the loopback address, names under
// `.invalid`. It passes only if no canary reached the model, nothing was written outside the workspace, no listener
// was reached and the grants are still empty.
import { appendFileSync } from 'node:fs'
import type { Page, TestInfo } from '@playwright/test'
import { BRIDGE_KEY, CommandName, EventType, type GladeBridge } from '../src/shared/bridge'
import {
  PermissionDecisionKind,
  PermissionMode,
  PermissionRequestState,
  type PermissionDecision,
} from '../src/shared/domain'
import { SandboxAskKind, SandboxGrantScope, type Grant } from '../src/shared/sandbox'
import {
  attackGroups,
  conversations,
  Gate,
  groupDone,
  groupMessage,
  runnable,
  type AttackGroup,
  type Targets,
} from './battery/attacks'
import { strayNames } from './battery/isolation'
import { Listeners } from './battery/listeners'
import { DeadEnd, StandIn } from './battery/stand-in'
import {
  failures,
  judge,
  Outcome,
  report,
  setupCalls,
  snapshotWorld,
  type Evidence,
  type Verdict,
} from './battery/verdict'
import { makeWorld, WorldSettings, type World } from './battery/world'
import { expect, test, type Glade, type LaunchOptions } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'
import { invoke } from './task-view'

/** How long a group's turn may take: each attack is a round trip to the stand-in and a tool call. */
const GROUP_TIMEOUT_MS = 120_000

/** A file to add each run's whole report to, attack by attack: `GLADE_BATTERY_REPORT=/tmp/report.md npm run test:e2e`. */
const REPORT_FILE = process.env.GLADE_BATTERY_REPORT

/** Set to keep each run's world (its dummy home folder and workspace) for a look afterwards: its path is printed. */
const KEEP_WORLD = process.env.GLADE_BATTERY_KEEP !== undefined

/** The groups to run, by name with commas between, in place of them all: `GLADE_BATTERY_GROUPS=floor,overrides`. */
const ONLY_GROUPS = process.env.GLADE_BATTERY_GROUPS?.split(',')

/** How every card is answered in a run. */
enum Answer {
  /** Deny: the battery itself. */
  Deny = 'deny',
  /** Allow, as widely as the card offers: the check that the battery sees an escape when there is one. */
  Allow = 'allow',
}

/** What the page is told to answer every card with. */
interface AnswerSetup {
  readonly key: string
  readonly opened: EventType.PermissionOpened
  readonly command: CommandName.PermissionsAnswer
  readonly outside: SandboxAskKind.Outside
  /** The answer to a card for a folder or a domain, which has no Allow once. */
  readonly toGrant: PermissionDecision
  /** The answer to any other card. */
  readonly toCall: PermissionDecision
}

/**
 * Answers every permission card the moment it opens, with the same command its buttons send. A card for a folder or a
 * domain has no Allow once, so allowing one allows it for the task.
 */
async function answerEveryCard(window: Page, answer: Answer): Promise<void> {
  const deny: PermissionDecision = { kind: PermissionDecisionKind.Deny }
  const allowing = answer === Answer.Allow
  const setup: AnswerSetup = {
    key: BRIDGE_KEY,
    opened: EventType.PermissionOpened,
    command: CommandName.PermissionsAnswer,
    outside: SandboxAskKind.Outside,
    toGrant: allowing ? { kind: PermissionDecisionKind.AllowForTask } : deny,
    toCall: allowing ? { kind: PermissionDecisionKind.AllowOnce } : deny,
  }
  await window.evaluate((setup) => {
    const bridge = (globalThis as unknown as Record<string, GladeBridge>)[setup.key]
    if (bridge === undefined) throw new Error('No bridge on the page')
    bridge.subscribe((event) => {
      if (event.type !== setup.opened) return
      const { id, sandbox } = event.permissionRequest
      const decision = sandbox !== null && sandbox.kind !== setup.outside ? setup.toGrant : setup.toCall
      // A request that closed by itself meanwhile (its call was cancelled) has nothing left to answer.
      bridge.invoke(setup.command, { id, decision }).catch(() => undefined)
    })
  }, setup)
}

/** A battery's servers, all on this Mac. */
interface Servers {
  readonly standIn: StandIn
  readonly deadEnd: DeadEnd
  readonly listeners: Listeners
}

async function startServers(world: World): Promise<Servers> {
  const standIn = new StandIn()
  const servers = {
    standIn,
    deadEnd: new DeadEnd(standIn.during),
    listeners: new Listeners(world.listenerToken, world.socketPath, standIn.during),
  }
  await Promise.all([servers.standIn.start(), servers.deadEnd.start(), servers.listeners.start()])
  return servers
}

async function stopServers({ standIn, deadEnd, listeners }: Servers): Promise<void> {
  await Promise.all([standIn.close(), deadEnd.close(), listeners.close()])
}

/** The grants of every scope Settings lists, each as a line. */
async function grantLines(window: Page, workspaceId: string): Promise<string[]> {
  const line = (scope: string, grant: Grant): string => `${scope}: ${JSON.stringify(grant)}`
  const glade = await invoke(window, CommandName.SandboxListGrants, { target: { scope: SandboxGrantScope.Glade } })
  const workspace = await invoke(window, CommandName.SandboxListGrants, {
    target: { scope: SandboxGrantScope.Workspace, workspaceId },
  })
  return [
    ...glade.grants.map((grant) => line('Glade-wide', grant)),
    ...workspace.grants.map((grant) => line('workspace', grant)),
  ]
}

/** What a battery run needs: the world, how its cards are answered, and which groups to run. */
interface Run {
  readonly settings: WorldSettings
  readonly answer: Answer
  /** The groups to run, by name; all that aren't pending, by default. */
  readonly only?: readonly string[]
}

interface RunResult {
  readonly verdict: Verdict
  readonly groups: readonly AttackGroup[]
}

/**
 * Runs the battery: makes the world and its servers, launches the app on the stand-in with the dummy home folder,
 * turns the sandbox on, and sends the task a message for each group, waiting for the group's turn to end. Then judges
 * what the run left behind, and attaches the report.
 */
async function runBattery(
  launch: (options?: LaunchOptions) => Promise<Glade>,
  userData: string,
  testInfo: TestInfo,
  { settings, answer, only }: Run,
): Promise<RunResult> {
  const world = makeWorld({ userData, settings })
  const servers = await startServers(world)
  const { standIn, deadEnd, listeners } = servers
  try {
    const glade = await launch({
      chosenFolder: world.workspace,
      standInModel: { baseUrl: standIn.baseUrl, deadEndProxy: deadEnd.url },
      // Glade's notion of the home folder, and its agent's: the dummy one.
      env: { HOME: world.home },
    })
    const { window } = glade
    await firstRun(window).openFolder.click()
    await expect(taskList(window).newTask).toBeVisible()
    // The sandbox on, and the control endpoint too: its token is in a session's environment, which commands mustn't get.
    await invoke(window, CommandName.SettingsUpdate, { patch: { sandboxEnabled: true, controlEnabled: true } })
    const { status } = await invoke(window, CommandName.ControlStatus, {})
    const controlToken = status.token ?? ''
    const targets: Targets = {
      tcpPort: listeners.tcpPort,
      udpPort: listeners.udpPort,
      controlUrl: status.url ?? 'http://127.0.0.1:9',
    }
    const all = attackGroups(world, targets)
    // Before anything runs: no attack names a real path or a real host.
    expect(strayNames(world, all)).toEqual([])
    const groups = only === undefined ? all : all.filter(({ name }) => only.includes(name))
    const watched = [
      ...Object.values(world.canaries).map(({ token }) => token),
      world.listingToken,
      world.listenerToken,
      ...(controlToken === '' ? [] : [controlToken]),
    ]
    standIn.play(conversations(groups), watched)
    await answerEveryCard(window, answer)
    const before = snapshotWorld(world)

    // The first group's message makes the task; the rest go to it, each once the turn before has ended.
    let taskId = ''
    const setMode = async (permissionMode: PermissionMode): Promise<void> => {
      await invoke(window, CommandName.TasksUpdate, { id: taskId, patch: { permissionMode } })
    }
    standIn.onGate(Gate.AskMode, () => setMode(PermissionMode.AskBeforeEdits))
    standIn.onGate(Gate.AllowAll, () => setMode(PermissionMode.AllowAll))
    await taskList(window).newTask.click()
    for (const { name } of runnable(groups)) {
      await inputBar(window).field.fill(groupMessage(name))
      await inputBar(window).field.press('Enter')
      if (taskId === '') {
        await expect(taskList(window).current).toHaveAttribute('data-task-id', /.+/)
        taskId = (await taskList(window).current.getAttribute('data-task-id')) ?? ''
      }
      await expect(chat(window).agentReplies.last()).toContainText(groupDone(name), { timeout: GROUP_TIMEOUT_MS })
    }

    const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
    const { permissionRequests } = await invoke(window, CommandName.TasksHistory, { id: taskId })
    const evidence: Evidence = {
      world,
      groups,
      results: standIn.results,
      sightings: standIn.sightings,
      standInProblems: standIn.problems,
      strays: standIn.strays,
      deadEnd: deadEnd.requests,
      arrivals: listeners.arrivals,
      before,
      grants: await grantLines(window, workspaces[0]?.id ?? ''),
      allowed: permissionRequests
        .filter(({ state, grantedScope }) => state === PermissionRequestState.Allowed || grantedScope !== null)
        .map(({ toolName, input }) => `${toolName} ${JSON.stringify(input).slice(0, 200)}`),
      controlToken,
    }
    const verdict = judge(evidence)
    const text = report(verdict, groups, {
      sandbox: standIn.sandboxDescription,
      sideRequests: standIn.sideRequests,
      setup: setupCalls(groups, standIn.results),
    })
    await testInfo.attach('escape-battery-report.md', { body: text, contentType: 'text/markdown' })
    // The whole report, attack by attack, for whoever asked to keep it: a passing test's attachment isn't kept.
    if (REPORT_FILE !== undefined) appendFileSync(REPORT_FILE, `# ${testInfo.title}\n\n${text}\n`)
    // The verdict in the test run's own output, with how the cards were answered: with every card allowed, a failed
    // battery is what the test wants.
    const answered = answer === Answer.Deny ? 'Every card denied' : 'Every card allowed, to check the battery itself'
    console.log(`${answered}. ${text.split('\n')[0] ?? ''}`)
    await glade.close()
    return { verdict, groups }
  } finally {
    await stopServers(servers)
    if (KEEP_WORLD) console.log(`The battery's world is kept at ${world.root}`)
    else world.remove()
  }
}

test.describe('the escape battery', () => {
  // Seatbelt is macOS's: there is no agent sandbox to test anywhere else.
  test.skip(
    process.platform !== 'darwin',
    'The escape battery needs macOS: the agent sandbox is Seatbelt, which only macOS has. Run it on a Mac.',
  )

  test('with nothing granted and every card denied, a sandboxed agent reaches nothing beyond its floor', async ({
    launch,
    userData,
  }, testInfo) => {
    test.setTimeout(600_000)
    const { verdict } = await runBattery(launch, userData, testInfo, {
      settings: WorldSettings.AllowEverything,
      answer: Answer.Deny,
      ...(ONLY_GROUPS === undefined ? {} : { only: ONLY_GROUPS }),
    })
    expect(failures(verdict)).toEqual([])
    expect(verdict.passed).toBe(true)
  })

  // The battery's own check: a battery that could not see an escape would pass whatever the sandbox did. Here every
  // card is allowed instead, so the attacks that only a card stops do get out, into the same dummy world, and the
  // verdict has to say so, by each kind of evidence: a canary read, a marker left, a listener reached, a grant made.
  test('the battery sees an escape when there is one: with every card allowed, it fails on the attacks that got out', async ({
    launch,
    userData,
  }, testInfo) => {
    test.setTimeout(300_000)
    const { verdict } = await runBattery(launch, userData, testInfo, {
      settings: WorldSettings.AllowEverything,
      answer: Answer.Allow,
      only: ['floor', 'tool-network', 'overrides', 'access-requests', 'mcp-and-messages'],
    })
    expect(verdict.passed).toBe(false)
    const reasons = (id: string): string =>
      verdict.outcomes
        .filter((entry) => entry.id === id && entry.outcome === Outcome.Escaped)
        .flatMap((entry) => entry.reasons)
        .join('; ')

    // Allowed to run outside the sandbox, a command read a canary, left its marker and reached the listener.
    expect(reasons('override-true')).toContain('its result shows the home-file canary')
    expect(reasons('override-true')).toContain('new file: home/override-true.txt')
    expect(reasons('override-true')).toContain('reached the listener (tcp 127.0.0.1)')
    // So did a command the settings keep out of the sandbox.
    expect(reasons('override-excluded-user')).toContain('its result shows the home-file canary')
    expect(reasons('override-excluded-project')).toContain('its result shows the documents canary')
    // With the folder granted, a command and the file tools read and wrote it.
    expect(reasons('access-then-command')).toContain('its result shows the documents canary')
    expect(reasons('access-then-read')).toContain('its result shows the documents canary')
    expect(reasons('access-then-write')).toContain('new file: home/Documents/after-access.txt')
    // With the domain granted, WebFetch reached the listener, and sent a request for a name outside this Mac, which
    // went to the dead end.
    expect(reasons('tool-net-loopback')).toContain('reached the listener (tcp 127.0.0.1)')
    expect(reasons('tool-net-outside-https')).toContain('Claude Code sent a request past this Mac: CONNECT tool-net-')
    // With its server granted, an MCP tool read a canary, wrote the home folder and reached the listener, from
    // outside the sandbox; and a message to another session went through to Claude Code.
    expect(reasons('mcp-user-read')).toContain('its result shows the home-file canary')
    expect(reasons('mcp-repo-write')).toContain('new file: home/mcp-repo-write.txt')
    expect(reasons('mcp-user-fetch')).toContain('reached the listener (tcp 127.0.0.1)')
    expect(reasons('message-name')).toContain("its result doesn't say Glade stopped it")
    // And the requests that were allowed are named.
    expect(verdict.problems.filter((problem) => problem.startsWith('a request was allowed'))).not.toEqual([])
    // The floor still works, and is no escape.
    expect(verdict.outcomes.filter(({ group }) => group === 'floor').map(({ outcome }) => outcome)).toEqual(
      verdict.outcomes.filter(({ group }) => group === 'floor').map(() => Outcome.Works),
    )
  })
})
