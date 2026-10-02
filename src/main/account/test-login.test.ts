import { afterEach, describe, expect, it } from 'vitest'
import { E2E_LOGIN_GLOBAL, type E2eLogin } from '../e2e'
import { LoginOutcomeKind } from './login'
import { createE2eLogin, WAITING_LOGIN } from './test-login'

function e2eLogin(): E2eLogin {
  return Reflect.get(globalThis, E2E_LOGIN_GLOBAL) as E2eLogin
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, E2E_LOGIN_GLOBAL)
})

describe('createE2eLogin', () => {
  it('puts a login on the global object that waits until the spec logs it in', async () => {
    const run = createE2eLogin()
    expect(e2eLogin()).toMatchObject({ runs: 0, waiting: false })

    const login = run()
    expect(e2eLogin()).toMatchObject({ runs: 1, waiting: true })

    e2eLogin().finish({ loggedIn: true })
    await expect(login.done).resolves.toEqual({ kind: LoginOutcomeKind.LoggedIn })
    expect(e2eLogin().waiting).toBe(false)
  })

  it('fails as the spec says', async () => {
    const login = createE2eLogin()()

    e2eLogin().finish({ loggedIn: false, message: 'Login failed: timed out' })

    await expect(login.done).resolves.toEqual({ kind: LoginOutcomeKind.Failed, message: 'Login failed: timed out' })
  })

  it('ends cancelled, and finishing it then does nothing', async () => {
    const login = createE2eLogin()()

    login.cancel()
    e2eLogin().finish({ loggedIn: true })

    await expect(login.done).resolves.toEqual({ kind: LoginOutcomeKind.Cancelled })
    expect(e2eLogin().waiting).toBe(false)
  })

  it('finishes the latest run, leaving an older one cancelled after it was replaced alone', async () => {
    const run = createE2eLogin()
    const first = run()
    const second = run()

    first.cancel()
    expect(e2eLogin()).toMatchObject({ runs: 2, waiting: true })
    e2eLogin().finish({ loggedIn: true })

    await expect(first.done).resolves.toEqual({ kind: LoginOutcomeKind.Cancelled })
    await expect(second.done).resolves.toEqual({ kind: LoginOutcomeKind.LoggedIn })
  })

  it('does nothing to finish with no login running', () => {
    createE2eLogin()
    e2eLogin().finish({ loggedIn: true })
    expect(e2eLogin().waiting).toBe(false)
  })
})

describe('WAITING_LOGIN', () => {
  it('never ends, and cancelling it does nothing', async () => {
    const login = WAITING_LOGIN()
    login.cancel()
    const ended = await Promise.race([
      login.done.then(() => true),
      new Promise((resolve) => setImmediate(resolve, false)),
    ])
    expect(ended).toBe(false)
  })
})
