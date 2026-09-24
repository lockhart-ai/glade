import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToastProvider } from '../components'
import { sampleWorkspace } from '../store/test-bridge'
import { AppShell, BottomBar, RightPanel, Sidebar, SidebarHeader, TaskCard, TaskHeader } from '.'

describe('AppShell', () => {
  it('renders the sidebar, task card and bottom bar slots', () => {
    render(<AppShell sidebar={<p>Sidebar slot</p>} task={<p>Task slot</p>} bottomBar={<p>Bottom slot</p>} />)

    expect(screen.getByText('Sidebar slot')).toBeInTheDocument()
    expect(screen.getByText('Task slot')).toBeInTheDocument()
    expect(screen.getByText('Bottom slot')).toBeInTheDocument()
    expect(screen.getByTestId('window-drag-strip')).toBeEmptyDOMElement()
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

  it('shows the switcher chevron and the collapse button, which do nothing yet', () => {
    render(<SidebarHeader workspace={sampleWorkspace('w1')} />)

    const header = screen.getByRole('region', { name: 'Workspace' })
    expect(header.querySelectorAll('svg')).toHaveLength(2)
    expect(within(header).getByRole('button', { name: 'Collapse task list' })).toBeEnabled()
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
    render(<RightPanel tabs={<span>Tab row</span>}>Panel content</RightPanel>)

    const panel = screen.getByRole('complementary', { name: 'Task panel' })
    expect(within(panel).getByTestId('right-panel-tabs')).toHaveTextContent('Tab row')
    expect(panel).toHaveTextContent('Panel content')
  })
})

describe('BottomBar', () => {
  it('holds the terminal card with its tab row and terminal', () => {
    render(<BottomBar terminalTabs={<span>Shells</span>} terminal={<pre>Prompt</pre>} />)

    const terminal = screen.getByRole('region', { name: 'Terminal' })
    expect(within(terminal).getByTestId('terminal-tabs')).toHaveTextContent('Shells')
    expect(within(terminal).getByText('Prompt')).toBeInTheDocument()
  })
})
