import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

/** The title the finishes-in-background agent gives its task. */
const TITLE = 'Build the docs site'

/** The purple card colour every agent reply is on (docs/design/tokens.md), always (#410). */
const QUESTION = { background: 'rgb(30, 27, 51)', border: 'rgb(59, 51, 102)' }
/** An agent reply's full card style, border and corners included. */
const PURPLE_CARD = { ...QUESTION, borderWidth: '1px', radius: '12px' }

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

test('every agent reply is on the purple card: an earlier one, a turn the agent started itself, after a relaunch, and once a newer reply arrives (#410)', async ({
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

  // Both replies are on the purple card: the earlier one just as much as the latest.
  await expect
    .poll(() => Promise.all([card(agentReplies.nth(0)), card(agentReplies.nth(1))]))
    .toEqual([PURPLE_CARD, PURPLE_CARD])
  await first.close()

  // After a relaunch, they're still on their cards.
  const { window } = await launch({ agentScript: 'finishes-in-background' })
  await taskList(window).taskRow(TITLE).click()
  const relaunched = chat(window).agentReplies
  await expect(relaunched).toHaveCount(2)
  await expect
    .poll(() => Promise.all([card(relaunched.nth(0)), card(relaunched.nth(1))]))
    .toEqual([PURPLE_CARD, PURPLE_CARD])

  // A further message gets its own reply, and doesn't turn the earlier ones back to a neutral card (#410).
  await inputBar(window).field.fill('Thanks — is it live yet?')
  await inputBar(window).field.press('Enter')
  await expect(relaunched).toHaveCount(3)
  await expect
    .poll(() => Promise.all([card(relaunched.nth(0)), card(relaunched.nth(1)), card(relaunched.nth(2))]))
    .toEqual([PURPLE_CARD, PURPLE_CARD, PURPLE_CARD])
})
