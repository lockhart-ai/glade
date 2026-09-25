import { resolve } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, inputBar, regions, taskList, taskPanel } from './selectors'
import { boxOf, MIN_WINDOW, resize, type Box } from './window-layout'

/** The design's sample workspace (scripts/fixtures/task-workspace.json): pinned, active and done tasks, one selected. */
const TASK_WORKSPACE = resolve(__dirname, '../scripts/fixtures/task-workspace.json')

/** The shared panel inset (`--space-inset`), inside a card's 1px border. */
const INSET = 8
const BORDER = 1

/** Layout rounding. */
const SLACK = 0.5

/** Where an element's content starts: its left edge plus its left border and padding. */
async function contentLeft(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return (
      element.getBoundingClientRect().left +
      Number.parseFloat(style.borderLeftWidth) +
      Number.parseFloat(style.paddingLeft)
    )
  })
}

/** The box of the first element around this one that draws a border: the card or bar it sits in. */
async function borderedBox(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    let around = element.parentElement
    while (around !== null && Number.parseFloat(getComputedStyle(around).borderTopWidth) === 0) {
      around = around.parentElement
    }
    if (around === null) throw new Error('Nothing around the element draws a border')
    const { x, y, width, height } = around.getBoundingClientRect()
    return { x, y, width, height }
  })
}

/** How far in a box sits from each edge of the box around it. */
function insets(inner: Box, outer: Box): { left: number; right: number; top: number; bottom: number } {
  return {
    left: inner.x - outer.x,
    right: outer.x + outer.width - (inner.x + inner.width),
    top: inner.y - outer.y,
    bottom: outer.y + outer.height - (inner.y + inner.height),
  }
}

function expectNear(actual: number, expected: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${String(actual)} vs ${String(expected)}`).toBeLessThanOrEqual(SLACK)
}

for (const size of [{ width: 1920, height: 1200 }, MIN_WINDOW]) {
  test(`alignment: panels share one inset and the sidebar one left edge, at ${String(size.width)}×${String(size.height)}`, async ({
    launch,
  }) => {
    const glade = await launch({ seed: TASK_WORKSPACE })
    const { window } = glade
    await resize(glade, size.width, size.height)
    const areas = regions(window)
    const list = taskList(window)
    await expect(list.rows('Active')).not.toHaveCount(0)
    await expect(chat(window).agentReplies).not.toHaveCount(0)

    // The task card: the header card, the input bar and the right panel card sit the same distance in from its edges.
    const card = await boxOf(areas.task)
    const header = insets(await boxOf(areas.taskHeader), card)
    // The input bar: the bordered bar its message field sits in.
    const bar = await borderedBox(inputBar(window).field)
    const input = insets(bar, card)
    const panel = insets(await boxOf(areas.taskPanel), card)
    const inset = BORDER + INSET
    expectNear(header.left, inset, 'header card, left')
    expectNear(header.top, inset, 'header card, top')
    expectNear(input.left, inset, 'input bar, left')
    expectNear(input.bottom, inset, 'input bar, bottom')
    expectNear(panel.right, inset, 'right panel card, right')
    expectNear(panel.top, inset, 'right panel card, top')
    expectNear(panel.bottom, inset, 'right panel card, bottom')
    // The input bar's bottom edge and the right panel card's are one line.
    expectNear(input.bottom, panel.bottom, 'input bar and right panel card, bottom')

    // The chat column runs between the same lines: an agent reply starts where the input bar does, and a message of
    // yours ends where it ends.
    const reply = await boxOf(chat(window).agentReplies.first())
    expectNear(reply.x, bar.x, 'agent reply, left')
    const headerBox = await boxOf(areas.taskHeader)
    expectNear(headerBox.x + headerBox.width, bar.x + bar.width, 'header card and input bar, right')

    // The right panel's rows sit the panel inset in from its edges, the tabs and the tool log alike.
    const panelBox = await boxOf(areas.taskPanel)
    const tabs = await boxOf(window.getByTestId('right-panel-tabs').getByRole('tablist'))
    expectNear(tabs.x - panelBox.x, inset, 'right panel tabs, left')
    // A tool call's content (its dot first) starts where the tabs' labels do.
    const call = await boxOf(taskPanel(window).log.getByRole('button').first())
    expectNear(call.x, await contentLeft(taskPanel(window).tab(/^Tool calls/)), 'tool call and tab label')

    // The sidebar: the workspace button, the search field, the filter chips, the section headers and the task rows
    // share one left edge, the panel inset in from the card, and one inner padding, so their content lines up too.
    const sidebar = await boxOf(areas.sidebar)
    const items: Record<string, Locator> = {
      'workspace button': areas.workspace.getByRole('button').first(),
      'search field': list.search.locator('xpath=..'),
      'first filter chip': list.filter('All'),
      'Pinned header': list.sectionHeader('Pinned'),
      'Active header': list.sectionHeader('Active'),
      'Done header': list.sectionHeader('Done'),
      'pinned row': list.rows('Pinned').first(),
      'active row': list.rows('Active').first(),
    }
    const left = sidebar.x + inset
    const content = left + BORDER + INSET
    for (const [name, item] of Object.entries(items)) {
      expectNear((await boxOf(item)).x, left, `${name}, left edge`)
      expectNear(await contentLeft(item), content, `${name}, content`)
    }
    // And their right edges, where they run the sidebar's width: the list's rows stop short by its scrollbar, when the
    // system shows scrollbars that take room (they overlay the content on a Mac with a trackpad, but not in CI).
    const right = sidebar.x + sidebar.width - inset
    expectNear((await boxOf(list.newTask)).x + (await boxOf(list.newTask)).width, right, 'New task, right edge')
    const scrollbar = await list
      .rows('Active')
      .first()
      .evaluate((row) => {
        let scroller = row.parentElement
        while (scroller !== null && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement
        if (scroller === null) throw new Error('The task list does not scroll')
        return scroller.offsetWidth - scroller.clientWidth
      })
    for (const item of [list.sectionHeader('Active'), list.rows('Active').first()]) {
      const box = await boxOf(item)
      expectNear(box.x + box.width, right - scrollbar, 'task list item, right edge')
    }
    // A row's dot sits on that content line, like the section headers' chevrons and the search field's icon.
    expectNear((await boxOf(list.dot(list.rows('Active').first()))).x, content, 'task row dot')
    expectNear((await boxOf(list.sectionHeader('Active').locator('svg'))).x, content, 'section chevron')
    expectNear((await boxOf(list.search.locator('xpath=..').locator('svg'))).x, content, 'search icon')
  })
}
