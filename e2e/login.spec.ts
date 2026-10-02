// Logging in to Claude from Glade (#409): a lost login stops a task with the logged-out card, Log in runs the login
// (a stand-in here, which never touches a real login), and once you're in the task carries on.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { LOGIN_EXPIRED_ERROR } from '../src/main/agent/scripts'
import { agentSessions, expect, finishLogin, loginRuns, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, settings, taskHeader, taskList, taskPanel } from './selectors'

/** The title the `logged-out` script's agent gives its task. */
const TITLE = 'Move image uploads to S3'

/** Starts a task and sends it its first message, which the `logged-out` script stops on a lost login. */
async function startTask(window: Page): Promise<void> {
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Move the user image uploads from local disk to S3, and copy the existing files over.')
  await bar.field.press('Enter')
}

/** Checks the selected task shows it was stopped logged out: the card, the header's state dot and its row. */
async function expectLoggedOut(window: Page, row = taskList(window).taskRow(TITLE)): Promise<void> {
  const { errorCard, agentReplies } = chat(window)
  await expect(errorCard).toContainText('You’re logged out of Claude')
  await expect(errorCard).toContainText(
    'Claude Code’s login expired or isn’t there, so the agent couldn’t carry on. Log in, and Claude Code’s sign-in ' +
      'page opens in your browser. Nothing is lost: the chat, tool log and files are as they were.',
  )
  await expect(agentReplies).toHaveCount(0)
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · stopped by an error')
  await expect(row).toContainText('Error: logged out of Claude · log in?')
  await expect(taskList(window).dot(row)).toHaveAttribute('data-state', 'error')
}

/** Checks the selected task carried on once logged in: the card is gone, and the copy finished. */
async function expectCarriedOn(window: Page): Promise<void> {
  const { errorCard, agentReplies, userMessages } = chat(window)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('The copy finished: all 3,900 files are in the bucket.')
  await expect(errorCard).toHaveCount(0)
  // The same turn, carried on: your message wasn't sent into the chat again.
  await expect(userMessages).toHaveCount(1)
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · waiting on you')
}

test('a lost login stops the task with a Log in card, and logging in carries the task on', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'logged-out', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await startTask(window)

  await expectLoggedOut(window)
  await chat(window).errorButton('Show details').click()
  await expect(chat(window).errorDetails).toHaveText(LOGIN_EXPIRED_ERROR)
  await expect(taskPanel(window).call(/^Failed\s*API/)).toContainText('authentication failed')

  // Log in runs the login and waits on the browser; Cancel stops it.
  await chat(window).errorButton('Log in').click()
  await expect(chat(window).errorButton('Waiting for the browser…')).toBeDisabled()
  await expect(chat(window).errorCard).toContainText(
    'Finish logging in in your browser: this task carries on once you’re in.',
  )
  expect(await loginRuns(glade)).toEqual({ runs: 1, waiting: true })
  await chat(window).errorButton('Cancel').click()
  await expect(chat(window).errorButton('Log in')).toBeVisible()
  expect(await loginRuns(glade)).toEqual({ runs: 1, waiting: false })

  // A login that fails says why, and Log in tries again.
  await chat(window).errorButton('Log in').click()
  await finishLogin(glade, { loggedIn: false, message: 'Login failed: the sign-in page timed out' })
  await expect(chat(window).errorCard).toContainText(
    'Logging in didn’t finish: Login failed: the sign-in page timed out.',
  )

  // Once you're in, the task carries on by itself, in a Claude Code started again on the same conversation.
  await chat(window).errorButton('Log in').click()
  await finishLogin(glade, { loggedIn: true })
  await expectCarriedOn(window)
  const sessions = await agentSessions(glade)
  expect(sessions).toHaveLength(2)
  expect(sessions[1]?.resumeSessionId).not.toBeNull()
})

test('Settings › General logs in, and Retry all carries on every task a lost login stopped', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'logged-out', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await startTask(window)
  await expectLoggedOut(window)
  await startTask(window)
  const rows = taskList(window).rows('Active')
  await expect(rows).toHaveCount(2)
  await expectLoggedOut(window, rows.first())
  await expect(rows.nth(1)).toContainText('Error: logged out of Claude · log in?')
  await expect(chat(window).errorButton('Retry all 2 tasks')).toBeVisible()

  // Settings › General offers Log in while a lost login stops a task; it retries no task by itself.
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const modal = settings(window)
  await modal.section('General').click()
  await modal.logIn.click()
  await expect(modal.dialog).toContainText('Finish logging in in your browser.')
  await finishLogin(glade, { loggedIn: true })
  await expect(modal.dialog).toContainText('You’re logged in.')
  await window.keyboard.press('Escape')
  await expect(modal.dialog).toBeHidden()

  // Each card now says you're logged in; Retry all carries both tasks on.
  await expect(chat(window).errorCard).toContainText('You’re logged in again: retry to carry on.')
  await chat(window).errorButton('Retry all 2 tasks').click()
  await expectCarriedOn(window)
  await rows.nth(1).click()
  await expectCarriedOn(window)
})
