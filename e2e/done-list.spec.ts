import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { searchResults, taskList } from './selectors'

const DONE_TASKS = 1_200
/** A screenful of rows and the few rendered past its edges: far fewer than the Done section holds. */
const MOST_ROWS_RENDERED = 60

/** A workspace of one active task and `count` made-up done tasks, `Finished 0` the most recent, as a seed fixture. */
function doneSeed(count: number): unknown {
  return {
    workspace: { name: 'Acme API', rootPath: '/Users/sample/code/api' },
    tasks: [
      { title: 'Add rate limiting to public API', status: 'Waiting on you', minutesAgo: 0 },
      ...Array.from({ length: count }, (_, index) => ({
        title: `Finished ${String(index)}`,
        status: `Shipped change ${String(index)}`,
        state: 'done',
        minutesAgo: 10 + index,
      })),
    ],
  }
}

test('Done list: over a thousand done tasks load a page at a time and render only the rows in view', async ({
  launch,
  tempFolder,
}) => {
  const seed = join(tempFolder(), 'done.json')
  writeFileSync(seed, JSON.stringify(doneSeed(DONE_TASKS)))
  const { window } = await launch({ seed })
  const list = taskList(window)

  // Collapsed, as it starts, Done counts every task in it.
  await expect(list.sectionHeader('Done')).toHaveAttribute('aria-expanded', 'false')
  await expect(list.sectionHeader('Done')).toHaveText(`Done${String(DONE_TASKS)}`)

  await list.sectionHeader('Done').click()
  await expect(list.rows('Done').first()).toContainText('Finished 0')
  const rendered = await list.rows('Done').count()
  expect(rendered).toBeGreaterThan(5)
  expect(rendered).toBeLessThan(MOST_ROWS_RENDERED)

  // Scrolling to the bottom again and again loads page after page, down to the very last task.
  const scroller = list.section('Done').locator('..')
  const last = list.row('Done', `Finished ${String(DONE_TASKS - 1)}`)
  await expect(async () => {
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(last).toBeVisible({ timeout: 250 })
  }).toPass({ timeout: 20_000 })
  expect(await list.rows('Done').count()).toBeLessThan(MOST_ROWS_RENDERED)
  await expect(list.sectionHeader('Done')).toHaveText(`Done${String(DONE_TASKS)}`)

  // A row down there works like any other: clicking it selects it.
  await last.click()
  await expect(last).toHaveAttribute('aria-current', 'true')

  // ⌥↑ steps up through the rows, rendering each as it comes into view.
  await last.blur()
  await window.keyboard.press('Alt+ArrowUp')
  await expect(list.row('Done', `Finished ${String(DONE_TASKS - 2)}`)).toHaveAttribute('aria-current', 'true')
})

test('Done list: a done task found by search, below the pages loaded, shows in its place in Done', async ({
  launch,
  tempFolder,
}) => {
  const seed = join(tempFolder(), 'done.json')
  writeFileSync(seed, JSON.stringify(doneSeed(DONE_TASKS)))
  const { window } = await launch({ seed })
  const list = taskList(window)
  const search = searchResults(window)
  await list.sectionHeader('Done').click()
  await expect(list.rows('Done').first()).toContainText('Finished 0')

  await list.search.fill('Finished 1100')
  await expect(search.row('Finished 1100')).toBeVisible()
  await search.row('Finished 1100').click()
  await list.search.press('Escape')

  // The list loads down to it and scrolls it into view, selected.
  const found = list.row('Done', 'Finished 1100')
  await expect(found).toBeInViewport()
  await expect(found).toHaveAttribute('aria-current', 'true')
  expect(await list.rows('Done').count()).toBeLessThan(MOST_ROWS_RENDERED)
})
