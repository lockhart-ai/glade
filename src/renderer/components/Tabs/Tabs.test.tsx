import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { moduleClass } from '../moduleClass'
import { TabPanel, Tabs, type TabItem } from './Tabs'
import styles from './Tabs.module.css'

const cls = (name: string): string => moduleClass(styles, name)

enum Panel {
  ToolCalls = 'tool-calls',
  Files = 'files',
  Todos = 'todos',
}

const TABS: TabItem<Panel>[] = [
  { value: Panel.ToolCalls, label: 'Tool calls', count: 7 },
  { value: Panel.Files, label: 'Files' },
  { value: Panel.Todos, label: 'Todos', count: '3/4' },
]

function renderTabs(value: Panel | '', onChange = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <>
      <Tabs<Panel | ''> id="side" label="Task panels" tabs={TABS} value={value} onChange={onChange} className="extra" />
      {value !== '' && (
        <TabPanel tabsId="side" value={value}>
          Content
        </TabPanel>
      )}
    </>,
  )
  return onChange
}

describe('Tabs', () => {
  it('renders a tab list with the selected tab holding the tab stop', () => {
    renderTabs(Panel.Files)

    const tablist = screen.getByRole('tablist', { name: 'Task panels' })
    expect(tablist).toHaveClass(cls('tablist'))
    expect(tablist.parentElement).toHaveClass(cls('strip'), 'extra')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Tool calls 7', 'Files', 'Todos 3/4'])
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Todos 3/4' })).toHaveAttribute('aria-selected', 'false')
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1])
    expect(tabs[0]?.querySelector(`.${cls('count')}`)).toHaveTextContent('7')
    for (const tab of tabs) expect(tab).toHaveClass(cls('tab'))
  })

  it('links the selected tab and its panel', () => {
    renderTabs(Panel.Todos)
    const panel = screen.getByRole('tabpanel', { name: 'Todos 3/4' })

    expect(panel).toHaveTextContent('Content')
    expect(screen.getByRole('tab', { name: 'Todos 3/4' })).toHaveAttribute('aria-controls', panel.id)
    expect(screen.getByRole('tab', { name: 'Files' })).not.toHaveAttribute('aria-controls')
  })

  it('gives the first tab the tab stop when nothing is selected', () => {
    renderTabs('')

    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
  })

  it('selects a tab on click', () => {
    const onChange = renderTabs(Panel.ToolCalls)
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))

    expect(onChange).toHaveBeenCalledExactlyOnceWith(Panel.Files)
  })

  it.each([
    ['ArrowRight', Panel.ToolCalls, Panel.Files],
    ['ArrowLeft', Panel.Files, Panel.ToolCalls],
    ['ArrowRight', Panel.Todos, Panel.ToolCalls],
    ['ArrowLeft', Panel.ToolCalls, Panel.Todos],
  ])('%s from %s selects and focuses %s', (key, from, to) => {
    const onChange = renderTabs(from)
    const current = screen.getByRole('tab', { selected: true })
    current.focus()
    fireEvent.keyDown(current, { key })

    expect(onChange).toHaveBeenCalledExactlyOnceWith(to)
    expect(screen.getAllByRole('tab')[TABS.findIndex((tab) => tab.value === to)]).toHaveFocus()
  })

  it('ignores other keys', () => {
    const onChange = renderTabs(Panel.Files)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Files' }), { key: 'ArrowDown' })

    expect(onChange).not.toHaveBeenCalled()
  })
})
