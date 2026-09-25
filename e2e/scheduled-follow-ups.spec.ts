import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FOLLOW_UPS, type AgentScriptName } from '../src/main/agent/scripts'
import { expect, notifications, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

/** A follow-up the agent schedules itself with one of the SDK's tools (`docs/sdk-notes.md` §11). */
interface FollowUp {
  readonly tool: string
  readonly script: AgentScriptName
  readonly title: string
  readonly message: string
  readonly scheduled: string
  readonly checking: string
  readonly reported: string
}

const FOLLOW_UP_SCRIPTS: readonly FollowUp[] = [
  {
    tool: 'Monitor',
    script: 'watches-ci',
    title: 'Watch the CI run on PR #42',
    message: 'Watch the CI checks on PR #42.',
    scheduled: FOLLOW_UPS.watching,
    checking: FOLLOW_UPS.checkFailed,
    reported: FOLLOW_UPS.failed,
  },
  {
    tool: 'ScheduleWakeup',
    script: 'checks-back-later',
    title: 'Deploy the docs site',
    message: 'Deploy the docs site and check the rollout.',
    scheduled: FOLLOW_UPS.deploying,
    checking: FOLLOW_UPS.checkingDeploy,
    reported: FOLLOW_UPS.deployed,
  },
  {
    tool: 'CronCreate',
    script: 'scheduled-check',
    title: 'Check the staging migration',
    message: 'Check the staging migration at 2:30.',
    scheduled: FOLLOW_UPS.scheduled,
    checking: FOLLOW_UPS.checkingMigration,
    reported: FOLLOW_UPS.migrated,
  },
]

for (const followUp of FOLLOW_UP_SCRIPTS) {
  test(`${followUp.tool}: the follow-up wakes the agent into a turn in the chat, with unread and a notification`, async ({
    launch,
    tempFolder,
  }) => {
    const root = join(tempFolder(), 'acme-api')
    mkdirSync(root)
    const glade = await launch({ agentScript: followUp.script, chosenFolder: root })
    const { window } = glade
    await firstRun(window).openFolder.click()
    const list = taskList(window)
    await list.newTask.click()
    const bar = inputBar(window)
    await bar.field.fill(followUp.message)
    await bar.field.press('Enter')

    // The turn that schedules it ends at once, and the task waits on you.
    const { agentReplies, turnSummaries, workingLine } = chat(window)
    await expect(agentReplies).toHaveCount(1)
    await expect(agentReplies.first()).toContainText(followUp.scheduled)

    // With no message from you, the follow-up wakes the agent: the task works on it, saying what it's doing.
    await expect(workingLine).toHaveText(`Working · ${followUp.checking}`)
    const row = list.taskRow(followUp.title)
    await expect(list.dot(row)).toHaveAttribute('data-state', 'working')

    // Look away before it replies: its reply marks the task unread, and is notified.
    await list.newTask.click()
    await expect(chat(window).newTaskPrompt).toBeVisible()
    await expect(row.getByRole('img', { name: 'Unread' })).toBeVisible()
    await expect
      .poll(async () =>
        (await notifications(glade)).some(
          ({ title, body }) => title === followUp.title && body.startsWith(followUp.reported.slice(0, 25)),
        ),
      )
      .toBe(true)

    // Its reply is in the chat as a turn of its own, with its summary.
    await row.click()
    await expect(agentReplies.nth(1)).toContainText(followUp.reported)
    await expect(chat(window).userMessages).toHaveCount(1)
    await expect(turnSummaries.nth(1)).toBeVisible()
  })

  test(`${followUp.tool}: Stop cuts short the turn the follow-up woke the agent for`, async ({
    launch,
    tempFolder,
  }) => {
    const root = join(tempFolder(), 'acme-api')
    mkdirSync(root)
    const { window } = await launch({ agentScript: followUp.script, chosenFolder: root })
    await firstRun(window).openFolder.click()
    await taskList(window).newTask.click()
    const bar = inputBar(window)
    await bar.field.fill(followUp.message)
    await bar.field.press('Enter')
    const { agentReplies, workingLine } = chat(window)
    await expect(agentReplies).toHaveCount(1)

    await expect(workingLine).toHaveText(`Working · ${followUp.checking}`)
    await bar.stop.click()

    if (followUp.tool === 'Monitor') {
      // Stopping the turn doesn't end the watch: its end still wakes the agent, into the turn after.
      await expect(agentReplies).toHaveCount(2)
      await expect(agentReplies.nth(1)).toContainText(FOLLOW_UPS.runDone)
    }
    // The agent stops working, and the stopped turn never replies.
    await expect(workingLine).toHaveCount(0)
    await expect(bar.send).toBeVisible()
    await expect(agentReplies.filter({ hasText: followUp.reported })).toHaveCount(0)
  })
}
