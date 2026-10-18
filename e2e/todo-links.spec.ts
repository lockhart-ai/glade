// A todo link in a reply (#684), end to end with the todo hub's seed: `[any text](todo:N)` in what the agent wrote is
// a link that opens the right panel on the Todos tab, expands that todo, scrolls it into view and highlights it for a
// moment; a link to a todo the task doesn't have is plain text, and `#123` and URLs stay as they were.
import { resolve } from 'node:path'
import { expect, test } from './fixtures'
import { chat, taskPanel, todoHub } from './selectors'

/** The todo hub's sample data (screens 46 to 49), whose one reply carries the todo links. */
const HUB_SEED = resolve(__dirname, '../scripts/fixtures/todo-hub.json')

test('todo links: clicking a todo link in a reply opens the Todos tab on that todo, expanded, and highlights it', async ({
  launch,
}) => {
  const glade = await launch({ seed: HUB_SEED })
  const { window } = glade
  const panel = taskPanel(window)
  const hub = todoHub(window)
  const reply = chat(window).agentReplies.first()

  // A link to a todo the task keeps is a link; the one for a todo it doesn't have is its text alone.
  const todo = reply.getByRole('link', { name: 'the #501 todo' })
  await expect(todo).toHaveAttribute('href', 'todo:2')
  await expect(reply.getByRole('link')).toHaveCount(1)
  await expect(reply).toContainText('the deleted todo is gone')

  // The seed leaves the panel on Todos; put it on Agents first, so the click is seen to open Todos.
  await panel.tab(/^Agents/).click()
  await todo.click()

  await expect(panel.tab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
  // The todo was closed: it opens, and its head takes the focus.
  const asked = hub.card('Per-key limits for /search')
  await expect(hub.head('Per-key limits for /search')).toHaveAttribute('aria-expanded', 'true')
  await expect(hub.head('Per-key limits for /search')).toBeFocused()

  // The card is highlighted for a moment, then not.
  await expect.poll(() => asked.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0)
  await expect.poll(() => asked.evaluate((element) => element.getAnimations().length), { timeout: 3_000 }).toBe(0)
})
