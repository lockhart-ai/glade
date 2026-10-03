// The tests `../evidence.spec.ts` runs in a Playwright run of its own (`./playwright.config.ts`), to see what the
// `launch` fixture keeps of each. Two of them fail on purpose, so they aren't part of the suite: the suite's own run
// matches `*.spec.ts`, and these are `*.inner.ts`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openWorkspace, test, type Glade, type LaunchOptions } from '../fixtures'
import { chat, inputBar, taskList } from '../selectors'
import { DELIBERATE_FAILURE, INNER_TESTS, INNER_WORKSPACE } from './inner'

/** Launches the app on a workspace, and has a task's agent answer one message. */
async function answerOneMessage(
  launch: (options?: LaunchOptions) => Promise<Glade>,
  tempFolder: () => string,
): Promise<Glade> {
  const root = join(tempFolder(), INNER_WORKSPACE)
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  const { window } = glade
  await openWorkspace(window)
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('How does the client retry?')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)
  return glade
}

test(INNER_TESTS.fails, async ({ launch, tempFolder }) => {
  await answerOneMessage(launch, tempFolder)
  throw new Error(DELIBERATE_FAILURE)
})

test(INNER_TESTS.failsClosed, async ({ launch, tempFolder }) => {
  const glade = await answerOneMessage(launch, tempFolder)
  await glade.close()
  throw new Error(DELIBERATE_FAILURE)
})

test(INNER_TESTS.passes, async ({ launch, tempFolder }) => {
  await answerOneMessage(launch, tempFolder)
})
