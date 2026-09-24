import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components'
import { moduleClass } from '../components/moduleClass'
import { MIN_CHAT_WIDTH, MIN_PANEL_WIDTH } from '../right-panel/panelModel'
import { sampleWorkspace } from '../store/test-bridge'
import { AppShell, BottomBar, RightPanel, Sidebar, SidebarHeader, TaskCard, TaskHeader } from '.'
import appShellStyles from './AppShell.module.css'
import bottomBarStyles from './BottomBar.module.css'
import taskCardStyles from './TaskCard.module.css'

describe('AppShell', () => {
  it('renders the sidebar, task card and bottom bar slots', () => {
    render(<AppShell sidebar={<p>Sidebar slot</p>} task={<p>Task slot</p>} bottomBar={<p>Bottom slot</p>} />)

    expect(screen.getByText('Sidebar slot')).toBeInTheDocument()
    expect(screen.getByText('Task slot')).toBeInTheDocument()
    expect(screen.getByText('Bottom slot')).toBeInTheDocument()
    expect(screen.getByTestId('window-drag-strip')).toBeEmptyDOMElement()
    expect(screen.getByText('Task slot').parentElement).not.toHaveClass(moduleClass(appShellStyles, 'full'))
    expect(screen.getByText('Bottom slot').parentElement).not.toHaveClass(moduleClass(appShellStyles, 'collapsed'))
  })

  it('gives the task card the whole width without a sidebar, and the bottom bar only its height when collapsed', () => {
    render(<AppShell task={<p>Task slot</p>} bottomBar={<p>Bottom slot</p>} bottomBarCollapsed />)

    expect(screen.getByText('Task slot').parentElement).toHaveClass(moduleClass(appShellStyles, 'full'))
    expect(screen.getByText('Bottom slot').parentElement).toHaveClass(moduleClass(appShellStyles, 'collapsed'))
  })

  it('shows the banner above the rest when there is one', () => {
    render(
      <AppShell
        sidebar={<p>Sidebar slot</p>}
        task={<p>Task slot</p>}
        bottomBar={<p>Bottom slot</p>}
        banner={<p>Banner</p>}
      />,
    )

    expect(screen.getByText('Banner').compareDocumentPosition(screen.getByText('Sidebar slot'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
})

describe('Sidebar', () => {
  it('is a navigation landmark with a clear strip under the traffic lights', () => {
    render(<Sidebar>Tasks list</Sidebar>)

    const nav = screen.getByRole('navigation', { name: 'Tasks' })
    expect(nav).toHaveTextContent('Tasks list')
    expect(within(nav).getByTestId('sidebar-title-bar')).toBeEmptyDOMElement()
  })
})

describe('SidebarHeader', () => {
  it('shows the workspace initial, name and root shortened to ~', () => {
    render(<SidebarHeader workspace={{ ...sampleWorkspace('w1', 'acme API'), rootPath: '/Users/sam/code/api' }} />)

    const header = screen.getByRole('region', { name: 'Workspace' })
    expect(header).toHaveTextContent('Aacme API~/code/api')
  })

  it('shows the switcher chevron, and the collapse button it is given', () => {
    render(<SidebarHeader workspace={sampleWorkspace('w1')} collapseButton={<button type="button">Collapse</button>} />)

    const header = screen.getByRole('region', { name: 'Workspace' })
    expect(header.querySelectorAll('svg')).toHaveLength(1)
    expect(within(header).getByRole('button', { name: 'Collapse' })).toBeInTheDocument()
  })

  it('says to open a folder when there is no workspace', () => {
    render(<SidebarHeader />)

    expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('?No workspaceOpen a folder to begin')
  })

  it('shows a ? badge for a workspace without a name', () => {
    render(<SidebarHeader workspace={sampleWorkspace('w1', '')} />)

    expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('?/code/w1')
  })
})

describe('TaskCard', () => {
  it('is the main landmark holding the header, chat, input bar and right panel', () => {
    render(
      <ToastProvider>
        <TaskCard
          header={<p>Header slot</p>}
          chat={<p>Chat slot</p>}
          inputBar={<p>Input slot</p>}
          rightPanel={<p>Panel slot</p>}
        />
      </ToastProvider>,
    )

    const main = screen.getByRole('main', { name: 'Task' })
    expect(within(main).getByText('Header slot')).toBeInTheDocument()
    expect(within(main).getByRole('region', { name: 'Chat' })).toHaveTextContent('Chat slot')
    expect(within(main).getByTestId('input-bar')).toHaveTextContent('Input slot')
    expect(within(main).getByText('Panel slot')).toBeInTheDocument()
    expect(within(main).queryByTestId('task-title-bar')).toBeNull()
    expect(within(main).getByText('Header slot').parentElement).not.toHaveClass(
      moduleClass(taskCardStyles, 'belowTrafficLights'),
    )
  })

  it('shows a title row above the header while it is given one', () => {
    render(
      <ToastProvider>
        <TaskCard
          titleBar={<button type="button">Show task list</button>}
          clearTrafficLights
          header={<p>Header slot</p>}
          chat={null}
          inputBar={null}
          rightPanel={null}
        />
      </ToastProvider>,
    )

    const titleBar = screen.getByTestId('task-title-bar')
    expect(within(titleBar).getByRole('button', { name: 'Show task list' })).toBeInTheDocument()
    expect(titleBar.compareDocumentPosition(screen.getByText('Header slot'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(titleBar.parentElement).toHaveClass(moduleClass(taskCardStyles, 'belowTrafficLights'))
  })

  it('shows toasts above the input bar', () => {
    render(
      <ToastProvider>
        <TaskCard header={null} chat={null} inputBar={<p>Input slot</p>} rightPanel={null} />
      </ToastProvider>,
    )

    const anchor = within(screen.getByTestId('input-bar')).getByTestId('toast-anchor')
    expect(within(anchor).getByRole('region', { name: 'Notifications' })).toBeInTheDocument()
  })
})

describe('TaskHeader', () => {
  it('is a labelled region', () => {
    render(<TaskHeader>Title</TaskHeader>)

    expect(screen.getByRole('region', { name: 'Task header' })).toHaveTextContent('Title')
  })
})

describe('RightPanel', () => {
  it('is a complementary landmark with a tab row above its content', () => {
    render(
      <RightPanel tabs={<span>Tab row</span>} width={440} onWidthChange={vi.fn()}>
        Panel content
      </RightPanel>,
    )

    const panel = screen.getByRole('complementary', { name: 'Task panel' })
    expect(within(panel).getByTestId('right-panel-tabs')).toHaveTextContent('Tab row')
    expect(panel).toHaveTextContent('Panel content')
  })

  it('sets its width, and its limits, for the stylesheet to cap', () => {
    render(<RightPanel width={612} onWidthChange={vi.fn()} />)

    const slot = screen.getByTestId('right-panel')
    expect(slot.style.getPropertyValue('--right-panel-width')).toBe('612px')
    expect(slot.style.getPropertyValue('--right-panel-min-width')).toBe(`${String(MIN_PANEL_WIDTH)}px`)
    expect(slot.style.getPropertyValue('--chat-min-width')).toBe(`${String(MIN_CHAT_WIDTH)}px`)
  })

  it('resizes as you drag its handle, leaving the chat its minimum, and hands on the width you let go at', () => {
    Element.prototype.setPointerCapture = vi.fn()
    const onWidthChange = vi.fn()
    render(
      <div data-testid="card" style={{ paddingLeft: '12px', paddingRight: '12px', columnGap: '12px' }}>
        <RightPanel width={440} onWidthChange={onWidthChange} />
      </div>,
    )
    // jsdom lays nothing out: the task card is 1200px wide, so the panel and chat share 1200 - 12 - 12 - 12.
    Object.defineProperty(screen.getByTestId('card'), 'clientWidth', { configurable: true, value: 1200 })
    const slot = screen.getByTestId('right-panel')
    const handle = screen.getByRole('separator', { name: 'Resize panel' })

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 800 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 })
    expect(slot.style.getPropertyValue('--right-panel-width')).toBe('540px')
    expect(onWidthChange).not.toHaveBeenCalled()
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    expect(onWidthChange).toHaveBeenCalledExactlyOnceWith(1164 - MIN_CHAT_WIDTH)
  })

  it('counts no padding or gap its card doesn’t set', () => {
    const onWidthChange = vi.fn()
    render(<RightPanel width={440} onWidthChange={onWidthChange} />)
    // Unmeasured, there's only room for the minimum width.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize panel' }), { key: 'ArrowLeft' })

    expect(onWidthChange).toHaveBeenCalledExactlyOnceWith(MIN_PANEL_WIDTH)
  })
})

describe('BottomBar', () => {
  it('holds the terminal card with its tab row and terminal', () => {
    render(<BottomBar terminalTabs={<span>Shells</span>} terminal={<pre>Prompt</pre>} />)

    const terminal = screen.getByRole('region', { name: 'Terminal' })
    expect(within(terminal).getByTestId('terminal-tabs')).toHaveTextContent('Shells')
    expect(within(terminal).getByText('Prompt')).toBeInTheDocument()
    expect(within(terminal).getByTestId('terminal-tabs')).not.toHaveClass(moduleClass(bottomBarStyles, 'alone'))
  })

  it('keeps only its tab row, with the toggle at its end, while collapsed', () => {
    render(
      <BottomBar
        collapsed
        terminalTabs={<span>Shells</span>}
        terminal={<pre>Prompt</pre>}
        toggle={<button type="button">Show bottom panel</button>}
      />,
    )

    const tabs = within(screen.getByRole('region', { name: 'Terminal' })).getByTestId('terminal-tabs')
    expect(tabs).toHaveTextContent('ShellsShow bottom panel')
    expect(tabs).toHaveClass(moduleClass(bottomBarStyles, 'alone'))
    // The terminal stays in the page, hidden, so its screens keep what they show.
    expect(screen.getByText('Prompt')).not.toBeVisible()
  })
})
