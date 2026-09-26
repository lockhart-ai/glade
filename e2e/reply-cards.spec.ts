import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

/** The title the finishes-in-background agent gives its task. */
const TITLE = 'Build the docs site'

/** The card colours (docs/design/tokens.md): the neutral reply card, and the purple question card. */
const NEUTRAL = { background: 'rgb(34, 36, 48)', border: 'rgb(47, 51, 67)' }
const QUESTION = { background: 'rgb(30, 27, 51)', border: 'rgb(59, 51, 102)' }

/** How a reply's text is drawn: the fill, outline and corners of the element it's rendered on. */
interface CardStyle {
  readonly background: string
  readonly border: string
  readonly borderWidth: string
  readonly radius: string
}

/** The card style of an agent reply's text. */
function card(reply: Locator): Promise<CardStyle> {
  return reply
    .locator(':scope > div')
    .first()
    .evaluate((body) => {
      const style = getComputedStyle(body)
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        radius: style.borderTopLeftRadius,
      }
    })
}

test('every agent reply is on a card: an earlier one, a turn the agent started itself, and after a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'finishes-in-background', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  const bar = inputBar(first.window)
  await bar.field.fill('Build the docs site and check it for broken links.')
  await bar.field.press('Enter')

  // The agent replies, then starts a turn of its own with no message from you, and replies again.
  const { agentReplies, workingLine } = chat(first.window)
  await expect(agentReplies).toHaveCount(2)
  await expect(workingLine).toHaveCount(0)

  // The earlier reply is on the neutral card, the latest (the agent waits on you) on the purple one.
  const expected = [
    { ...NEUTRAL, borderWidth: '1px', radius: '12px' },
    { ...QUESTION, borderWidth: '1px', radius: '12px' },
  ]
  await expect.poll(() => Promise.all([card(agentReplies.nth(0)), card(agentReplies.nth(1))])).toEqual(expected)
  await first.close()

  // After a relaunch, they're still on their cards.
  const { window } = await launch({ agentScript: 'finishes-in-background' })
  await taskList(window).taskRow(TITLE).click()
  const relaunched = chat(window).agentReplies
  await expect(relaunched).toHaveCount(2)
  await expect.poll(() => Promise.all([card(relaunched.nth(0)), card(relaunched.nth(1))])).toEqual(expected)
})
