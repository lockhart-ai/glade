// A session whose messages and settings wait on a gate (#448): nothing reaches a sandboxed session before its overlay,
// or at all if it won't take it.
import { expect, it } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import type { AgentSessionOptions } from './backend'
import { FakeAgentSession, settle } from './fake-backend'
import { gatedSession } from './gated-session'

const OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

const ASKING = { model: 'claude-sample-1', effort: Effort.High, permissionMode: PermissionMode.AskBeforeEdits }

/** A gate, and what opens or shuts it. */
function gate(): { readonly ready: Promise<boolean>; readonly settle: (open: boolean) => void } {
  let settleGate: (open: boolean) => void = () => undefined
  const ready = new Promise<boolean>((resolve) => {
    settleGate = resolve
  })
  return { ready, settle: settleGate }
}

/** A fake session that records the order its messages and settings changes arrive in. */
function recorded(): { readonly session: FakeAgentSession; readonly order: string[] } {
  const session = new FakeAgentSession(OPTIONS)
  const order: string[] = []
  const send = session.send.bind(session)
  const configure = session.configure.bind(session)
  session.send = (text, uuid, images) => {
    order.push(`send ${text}`)
    send(text, uuid, images)
  }
  session.configure = (settings) => {
    order.push(`configure ${settings.permissionMode}`)
    configure(settings)
  }
  return { session, order }
}

it('holds messages and settings changes until the gate opens, then delivers them in the order given', async () => {
  const { session, order } = recorded()
  const { ready, settle: open } = gate()
  const gated = gatedSession(session, ready)

  gated.send('First.', 'uuid-1')
  gated.configure(ASKING)
  gated.send('Second.', 'uuid-2', [])
  await settle()
  expect(order).toEqual([])

  open(true)
  await settle()
  expect(order).toEqual(['send First.', `configure ${PermissionMode.AskBeforeEdits}`, 'send Second.'])
  expect(session.sent.map(({ uuid }) => uuid)).toEqual(['uuid-1', 'uuid-2'])
})

it('keeps delivering in order once the gate is open', async () => {
  const { session, order } = recorded()
  const gated = gatedSession(session, Promise.resolve(true))

  gated.send('First.', 'uuid-1')
  await settle()
  gated.configure(ASKING)
  gated.send('Second.', 'uuid-2')
  await settle()

  expect(order).toEqual(['send First.', `configure ${PermissionMode.AskBeforeEdits}`, 'send Second.'])
})

it('drops everything held, and everything given later, when the gate shuts', async () => {
  const { session, order } = recorded()
  const { ready, settle: shut } = gate()
  const gated = gatedSession(session, ready)

  gated.send('First.', 'uuid-1')
  gated.configure(ASKING)
  shut(false)
  await settle()
  gated.send('Second.', 'uuid-2')
  await settle()

  expect(order).toEqual([])
  expect(session.sent).toEqual([])
  expect(session.configured).toEqual([])
})

it('passes everything else straight to the session, gate or no gate', async () => {
  const session = new FakeAgentSession(OPTIONS)
  session.onAccountInfo = () => Promise.resolve({ email: 'sam@acme.dev' })
  session.onUsage = () => Promise.resolve({ limits: [] })
  session.onContextUsage = () => Promise.resolve({ totalTokens: 1200 })
  const gated = gatedSession(session, gate().ready)

  expect(gated.messages).toBe(session.messages)
  await gated.applyFlagSettings({ sandbox: null })
  await gated.interrupt()
  await gated.stopTask('task-1')
  await expect(gated.accountInfo()).resolves.toEqual({ email: 'sam@acme.dev' })
  await expect(gated.usage()).resolves.toEqual({ limits: [] })
  await expect(gated.contextUsage()).resolves.toEqual({ totalTokens: 1200 })
  gated.close()

  expect(session.flagSettings).toEqual([{ sandbox: null }])
  expect(session.interrupts).toBe(1)
  expect(session.stoppedTasks).toEqual(['task-1'])
  expect(session.closed).toBe(true)
})
