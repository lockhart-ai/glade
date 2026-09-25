import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, seedPath, test } from './fixtures'
import { chat, regions, searchResults, taskHeader, taskList } from './selectors'

test('search: results replace the list as you type, with the matches marked; opening one marks them in its header and chat; Esc brings the list back', async ({
  launch,
}) => {
  const { window } = await launch({ seed: seedPath('search.json') })
  const list = taskList(window)
  const search = searchResults(window)
  const header = taskHeader(window)
  const conversation = chat(window)
  await expect(list.row('Active', 'Move image uploads to S3')).toHaveAttribute('aria-current', 'true')

  // ⌘F focuses the search field from anywhere.
  await regions(window).chat.click()
  await window.keyboard.press('Meta+F')
  await expect(list.search).toBeFocused()

  // Typing replaces the task list (and its filter chips) with the matching tasks, each with a snippet around its best
  // match, the match marked.
  await window.keyboard.type('Retry-After')
  await expect(search.count).toHaveText('Results3')
  await expect(list.section('Active')).toHaveCount(0)
  await expect(window.getByRole('group', { name: 'Filter tasks' })).toHaveCount(0)
  await expect(search.rows).toHaveCount(3)
  for (const title of ['Add rate limiting to public API', 'Add webhook retries', 'Fix flaky login test']) {
    await expect(search.marks(search.row(title))).toHaveText(['Retry-After'])
  }
  await expect(search.row('Add webhook retries')).toContainText('honour the Retry-After')
  await expect(search.row('Fix flaky login test')).toContainText('the client ignores Retry-After')
  await expect(search.results).toContainText('Searches titles, objectives, outcomes and full chat logs.')

  // A result has its task's context menu, as a row in the task list does.
  await search.row('Add webhook retries').click({ button: 'right' })
  const menu = window.getByRole('menu', { name: 'Task actions' })
  await expect(menu).toContainText('Reopen')
  await expect(menu).toContainText('Copy outcome')
  await window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Opening a result selects its task, whose header and chat mark the matches.
  await search.row('Add rate limiting to public API').click()
  await expect(search.row('Add rate limiting to public API')).toHaveAttribute('aria-current', 'true')
  await expect(header.title).toHaveText('Add rate limiting to public API')
  await expect(search.marks(header.field('Goal'))).toHaveText(['Retry-After'])
  await expect(search.marks(header.field('Outcome'))).toHaveText(['Retry-After'])
  await expect(search.marks(conversation.userMessages)).toHaveText(['Retry-After'])
  await expect(search.marks(conversation.agentReplies)).toHaveText(['Retry-After'])

  // Searching again moves the marks to the new matches, in the title too.
  await list.search.fill('limit')
  await expect(search.count).toHaveText('Results1')
  await expect(search.marks(header.title)).toHaveText(['limiting'])
  await expect(search.marks(search.row('Add rate limiting to public API'))).toContainText(['limiting'])

  // Esc ends the search: the list is back (the Done section, where the opened task is, starts collapsed), the task
  // stays open, and nothing is marked.
  await list.search.press('Escape')
  await expect(list.search).toHaveValue('')
  await expect(search.results).toHaveCount(0)
  await expect(header.title).toHaveText('Add rate limiting to public API')
  await expect(window.getByRole('group', { name: 'Filter tasks' })).toBeVisible()
  await expect(regions(window).task.locator('mark')).toHaveCount(0)

  // A search that matches nothing says so.
  await list.search.fill('kubernetes')
  await expect(search.count).toHaveText('Results0')
  await expect(search.rows).toHaveCount(0)
})

/** A workspace of `tasks` made-up tasks, each with `messages` messages in its chat, as a seed fixture. */
function bigSeed(tasks: number, messages: number): unknown {
  const words = ['rate', 'limit', 'webhook', 'retry', 'header', 'client', 'deploy', 'cache', 'schema', 'token']
  const sentence = (seed: number): string =>
    Array.from({ length: 24 }, (_, index) => words[(seed + index * 7) % words.length] ?? '').join(' ')
  return {
    workspace: { name: 'Acme API', rootPath: '/Users/sample/code/api' },
    tasks: Array.from({ length: tasks }, (_, task) => ({
      title: `Task ${String(task)}: ${sentence(task).split(' ').slice(0, 4).join(' ')}`,
      objective: sentence(task + 1),
      status: sentence(task + 2),
      minutesAgo: task,
      messages: Array.from({ length: messages }, (_, message) => ({
        role: message % 2 === 0 ? 'user' : 'agent',
        // One message in the whole workspace mentions the needle.
        body:
          task === 123 && message === 7 ? `${sentence(message)} haystack needle` : sentence(task * messages + message),
        turn: 1 + Math.floor(message / 2),
        minutesAgo: task + 1,
      })),
    })),
  }
}

test('search: results keep up with typing on a workspace with hundreds of tasks', async ({ launch, tempFolder }) => {
  const seed = join(tempFolder(), 'big.json')
  writeFileSync(seed, JSON.stringify(bigSeed(400, 20)))
  const { window } = await launch({ seed })
  const list = taskList(window)
  const search = searchResults(window)
  await expect(list.section('Active')).toContainText('Active400')

  // Each keystroke's search comes back while you type: a prefix that matches every task, then one message.
  await list.search.pressSequentially('re')
  await expect(search.count).toHaveText('Results400')
  await list.search.fill('')
  const started = Date.now()
  await list.search.pressSequentially('needle', { delay: 30 })
  await expect(search.count).toHaveText('Results1')
  // Typing took about 200ms and the search waits 120ms for a pause: well under a second in all.
  expect(Date.now() - started).toBeLessThan(2_000)
  await expect(search.row('Task 123')).toContainText('haystack needle')
  await expect(search.marks(search.row('Task 123'))).toHaveText(['needle'])
})
