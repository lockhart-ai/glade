import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components'
import { MotionPhase } from '../motion'
import panelMotionStyles from '../motion/PanelMotion.module.css'
import { moduleClass } from '../components/moduleClass'
import {
  MAX_SIDEBAR_WIDTH,
  MIN_BOTTOM_BAR_HEIGHT,
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_TASK_HEIGHT,
} from '../panels'
import { sampleWorkspace } from '../store/test-bridge'
import {
  AppShell,
  BottomBar,
  INPUT_BAR_HEIGHT_VAR,
  RightPanel,
  Sidebar,
  SidebarHeader,
  TASK_HEADER_HEIGHT_VAR,
  TaskCard,
  TaskHeader,
  type AppShellProps,
} from '.'
import appShellStyles from './AppShell.module.css'
import bottomBarStyles from './BottomBar.module.css'

/** The sizes and handlers every `AppShell` takes, for tests that aren't about them. */
const SIZES = {
  sidebarWidth: 300,
  onSidebarWidthChange: vi.fn(),
  bottomBarHeight: 300,
  onBottomBarHeightChange: vi.fn(),
} satisfies Partial<AppShellProps>

/** Stands in for the layout jsdom doesn't do: an element's laid-out size. */
function layOut(element: Element, box: { readonly width?: number; readonly height?: number }): void {
  const rect = new DOMRect(0, 0, box.width ?? 0, box.height ?? 0)
  element.getBoundingClientRect = () => rect
}

/** Stands in for the minimum sizes the stylesheet (which jsdom doesn't apply) gives some elements. */
function stubMinimums(minimums: ReadonlyMap<Element, { readonly minWidth?: string; readonly minHeight?: string }>) {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const stub = minimums.get(element)
    // AppShell reads nothing else of these elements' styles.
    return stub === undefined ? real(element) : ({ minWidth: '', minHeight: '', ...stub } as CSSStyleDeclaration)
  })
}

describe('AppShell', () => {
  beforeEach(() => {
    // jsdom doesn't capture pointers.
    Element.prototype.setPointerCapture = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the sidebar, task card and bottom bar slots', () => {
    render(<AppShell {...SIZES} sidebar={<p>Sidebar slot</p>} task={<p>Task slot</p>} bottomBar={<p>Bottom slot</p>} />)

    expect(screen.getByText('Sidebar slot')).toBeInTheDocument()
    expect(screen.getByText('Task slot')).toBeInTheDocument()
    expect(screen.getByText('Bottom slot')).toBeInTheDocument()
    // The title bar row holds nothing: the traffic lights are the window's own.
    expect(screen.getByTestId('window-title-bar')).toBeEmptyDOMElement()
    expect(screen.getByTestId('window-title-bar')).toHaveClass(moduleClass(appShellStyles, 'titleBar'))
    expect(screen.getByText('Task slot').parentElement).not.toHaveClass(moduleClass(appShellStyles, 'full'))
    expect(screen.getByText('Bottom slot').parentElement).not.toHaveClass(moduleClass(appShellStyles, 'collapsed'))
  })

  it('gives the task card the whole width without a sidebar, and the bottom bar only its height when collapsed', () => {
    render(<AppShell {...SIZES} task={<p>Task slot</p>} bottomBar={<p>Bottom slot</p>} bottomBarCollapsed />)

    expect(screen.getByText('Task slot').parentElement).toHaveClass(moduleClass(appShellStyles, 'full'))
    expect(screen.getByText('Bottom slot').parentElement).toHaveClass(moduleClass(appShellStyles, 'collapsed'))
    // Neither has a handle: there's no sidebar, and the bar is collapsed to its tab row.
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('shows the banner above the rest when there is one', () => {
    render(
      <AppShell
        {...SIZES}
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

  it('sets the sizes you chose, and the limits, for the stylesheet to cap', () => {
    const { container, rerender } = render(
      <AppShell {...SIZES} sidebarWidth={412} bottomBarHeight={264} task={<p>Task</p>} bottomBar={<p>Bar</p>} />,
    )

    const shell = container.firstElementChild as HTMLElement
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('412px')
    expect(shell.style.getPropertyValue('--bottom-bar-height')).toBe('264px')
    expect(shell.style.getPropertyValue('--sidebar-min-width')).toBe(`${String(MIN_SIDEBAR_WIDTH)}px`)
    expect(shell.style.getPropertyValue('--bottom-bar-min-height')).toBe(`${String(MIN_BOTTOM_BAR_HEIGHT)}px`)
    expect(shell.style.getPropertyValue('--task-min-height')).toBe(`${String(MIN_TASK_HEIGHT)}px`)
    expect(shell.style.getPropertyValue('--chat-min-width')).toBe(`${String(MIN_CHAT_WIDTH)}px`)
    expect(shell.style.getPropertyValue('--right-panel-min-width')).toBe(`${String(MIN_PANEL_WIDTH)}px`)
    // The task card's minimum makes room for the right panel only while it shows.
    expect(screen.getByText('Task').parentElement).toHaveAttribute('data-right-panel', 'false')

    rerender(<AppShell {...SIZES} taskHasRightPanel task={<p>Task</p>} bottomBar={<p>Bar</p>} />)
    expect(screen.getByText('Task').parentElement).toHaveAttribute('data-right-panel', 'true')
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('300px')
  })

  it('widens the sidebar as you drag its handle, up to the room the task card has past its minimum', () => {
    const onSidebarWidthChange = vi.fn()
    const { container } = render(
      <AppShell
        {...SIZES}
        onSidebarWidthChange={onSidebarWidthChange}
        sidebar={<p>Sidebar</p>}
        task={<p>Task</p>}
        bottomBar={<p>Bar</p>}
      />,
    )
    const shell = container.firstElementChild as HTMLElement
    const slot = screen.getByTestId('sidebar-slot')
    const card = screen.getByText('Task')
    // The sidebar shows 300px wide, and the task card 800px, 76px more than its minimum.
    layOut(slot, { width: 300 })
    layOut(card, { width: 800 })
    stubMinimums(new Map([[card, { minWidth: '724px' }]]))
    const handle = screen.getByRole('separator', { name: 'Resize task list' })
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 310 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 350 })
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('340px')
    expect(onSidebarWidthChange).not.toHaveBeenCalled()
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('376px')
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onSidebarWidthChange).toHaveBeenCalledExactlyOnceWith(376)

    // However much room there is, it stops at its own maximum; and at its minimum the other way.
    layOut(card, { width: 2000 })
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 310 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 3000 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onSidebarWidthChange).toHaveBeenLastCalledWith(MAX_SIDEBAR_WIDTH)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(onSidebarWidthChange).toHaveBeenLastCalledWith(284)
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 310 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onSidebarWidthChange).toHaveBeenLastCalledWith(MIN_SIDEBAR_WIDTH)
  })

  it('starts from the width showing when a smaller window squeezed the sidebar, and holds it without a task card', () => {
    const onSidebarWidthChange = vi.fn()
    const { rerender } = render(
      <AppShell
        {...SIZES}
        sidebarWidth={500}
        onSidebarWidthChange={onSidebarWidthChange}
        sidebar={<p>Sidebar</p>}
        task={<p>Task</p>}
        bottomBar={<p>Bar</p>}
      />,
    )
    // The window squeezed the sidebar to 352px, and the task card to its minimum: there's no more room to take.
    const card = screen.getByText('Task')
    layOut(screen.getByTestId('sidebar-slot'), { width: 352 })
    layOut(card, { width: 724 })
    stubMinimums(new Map([[card, { minWidth: '724px' }]]))
    const handle = screen.getByRole('separator', { name: 'Resize task list' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onSidebarWidthChange).toHaveBeenLastCalledWith(352)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(onSidebarWidthChange).toHaveBeenLastCalledWith(336)

    // With nothing beside it to measure, there's only room for its minimum.
    rerender(
      <AppShell
        {...SIZES}
        onSidebarWidthChange={onSidebarWidthChange}
        sidebar={<p>Sidebar</p>}
        task={null}
        bottomBar={<p>Bar</p>}
      />,
    )
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize task list' }), { key: 'ArrowRight' })
    expect(onSidebarWidthChange).toHaveBeenLastCalledWith(MIN_SIDEBAR_WIDTH)
  })

  it('makes the bottom bar taller as you drag its handle up, until the task card is at its minimum height', () => {
    const onBottomBarHeightChange = vi.fn()
    const { container } = render(
      <AppShell
        {...SIZES}
        onBottomBarHeightChange={onBottomBarHeightChange}
        sidebar={<p>Sidebar</p>}
        task={<p>Task</p>}
        bottomBar={<p>Bar</p>}
      />,
    )
    const shell = container.firstElementChild as HTMLElement
    const row = screen.getByText('Task').parentElement
    if (row === null) throw new Error('The task card has no row')
    // The bar shows 300px tall, and the row above it 600px, 140px more than the task card's minimum.
    layOut(screen.getByTestId('bottom-bar-slot'), { height: 300 })
    layOut(row, { height: 600 })
    stubMinimums(new Map([[row, { minHeight: `${String(MIN_TASK_HEIGHT)}px` }]]))
    const handle = screen.getByRole('separator', { name: 'Resize bottom panel' })
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal')

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 600 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 550 })
    expect(shell.style.getPropertyValue('--bottom-bar-height')).toBe('350px')
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 })
    expect(shell.style.getPropertyValue('--bottom-bar-height')).toBe('440px')
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onBottomBarHeightChange).toHaveBeenCalledExactlyOnceWith(440)

    // Down, it stops at its minimum; ↑ moves it a step.
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 600 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 2000 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onBottomBarHeightChange).toHaveBeenLastCalledWith(MIN_BOTTOM_BAR_HEIGHT)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(onBottomBarHeightChange).toHaveBeenLastCalledWith(316)
    expect(shell.style.getPropertyValue('--bottom-bar-height')).toBe('316px')
  })

  it('slides the sidebar and the bottom bar with no handles while they move, the leaving one inert', () => {
    const { rerender } = render(
      <AppShell
        {...SIZES}
        sidebar={<p>Sidebar slot</p>}
        sidebarMotion={MotionPhase.Leaving}
        task={<p>Task slot</p>}
        bottomBar={<p>Bottom slot</p>}
        bottomBarMotion={MotionPhase.Entering}
      />,
    )
    const sidebarSlot = screen.getByTestId('sidebar-slot')
    expect(sidebarSlot.parentElement).toHaveClass(moduleClass(panelMotionStyles, 'leaving'))
    expect(sidebarSlot).toHaveAttribute('data-motion', 'leaving')
    expect(sidebarSlot).toHaveAttribute('inert')
    expect(screen.getByTestId('bottom-bar-slot')).toHaveAttribute('data-motion', 'entering')
    expect(screen.getByTestId('bottom-bar-slot')).not.toHaveAttribute('inert')
    expect(screen.queryByRole('separator')).toBeNull()

    rerender(
      <AppShell
        {...SIZES}
        sidebar={<p>Sidebar slot</p>}
        sidebarMotion={MotionPhase.Shown}
        task={<p>Task slot</p>}
        bottomBar={<p>Bottom slot</p>}
        bottomBarMotion={MotionPhase.Shown}
      />,
    )
    expect(sidebarSlot).not.toHaveAttribute('data-motion')
    expect(sidebarSlot.parentElement).not.toHaveClass(moduleClass(panelMotionStyles, 'leaving'))
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  it('gives the bottom bar only its minimum when the row above can’t be measured', () => {
    const onBottomBarHeightChange = vi.fn()
    render(
      <AppShell
        {...SIZES}
        onBottomBarHeightChange={onBottomBarHeightChange}
        task={<p>Task</p>}
        bottomBar={<p>Bar</p>}
      />,
    )
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize bottom panel' }), { key: 'ArrowUp' })
    expect(onBottomBarHeightChange).toHaveBeenLastCalledWith(MIN_BOTTOM_BAR_HEIGHT)
  })
})

describe('Sidebar', () => {
  it('is a navigation landmark, its content from the top: the window’s title bar row clears the traffic lights', () => {
    render(<Sidebar>Tasks list</Sidebar>)

    const nav = screen.getByRole('navigation', { name: 'Tasks' })
    expect(nav).toHaveTextContent('Tasks list')
    expect(nav.firstElementChild).toHaveTextContent('Tasks list')
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
  })

  it('shows a title row above the header while it is given one', () => {
    render(
      <ToastProvider>
        <TaskCard
          titleBar={<button type="button">Show task list</button>}
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
  })

  it('keeps the header’s and input bar’s heights on the stage for the chat under them to clip and clear, as they resize', () => {
    const resizes: (() => void)[] = []
    let disconnected = false
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resizes.push(callback)
        }
        observe = (): void => undefined
        disconnect = (): void => {
          disconnected = true
        }
      },
    )
    let headerHeight = 72
    let inputBarHeight = 110
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'input-bar' ? inputBarHeight : headerHeight
      })

    const { unmount } = render(
      <ToastProvider>
        <TaskCard header={<p>Header slot</p>} chat={<p>Chat slot</p>} inputBar={<p>Input slot</p>} rightPanel={null} />
      </ToastProvider>,
    )

    // The header and the input bar float over the chat: all three are in the stage, the header first and the input
    // bar last.
    const stage = screen.getByTestId('task-stage')
    const chat = screen.getByRole('region', { name: 'Chat' })
    const inputBar = screen.getByTestId('input-bar')
    expect(stage).toContainElement(screen.getByText('Header slot'))
    expect(stage).toContainElement(chat)
    expect(stage).toContainElement(inputBar)
    expect(chat.compareDocumentPosition(inputBar)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(stage.style.getPropertyValue(TASK_HEADER_HEIGHT_VAR)).toBe('72px')
    expect(stage.style.getPropertyValue(INPUT_BAR_HEIGHT_VAR)).toBe('110px')

    // A field wraps, or the header shows up once a task is selected: it grows, and the chat's clip and clearance with
    // it. The input bar's don't move.
    headerHeight = 118
    resizes[0]?.()
    expect(stage.style.getPropertyValue(TASK_HEADER_HEIGHT_VAR)).toBe('118px')
    expect(stage.style.getPropertyValue(INPUT_BAR_HEIGHT_VAR)).toBe('110px')

    // The queue opens above the input, or the message runs to more lines: the input bar grows, and the chat's clip and
    // clearance at the bottom with it.
    inputBarHeight = 196
    resizes[1]?.()
    expect(stage.style.getPropertyValue(INPUT_BAR_HEIGHT_VAR)).toBe('196px')
    expect(stage.style.getPropertyValue(TASK_HEADER_HEIGHT_VAR)).toBe('118px')

    unmount()
    expect(disconnected).toBe(true)
    offsetHeight.mockRestore()
    vi.unstubAllGlobals()
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

  it('sets its width for the stylesheet to cap (with the limits AppShell sets), its handle on its left edge', () => {
    render(<RightPanel width={612} onWidthChange={vi.fn()} />)

    const slot = screen.getByTestId('right-panel')
    expect(slot.style.getPropertyValue('--right-panel-width')).toBe('612px')
    const handle = screen.getByRole('separator', { name: 'Resize side panel' })
    expect(handle).toHaveAttribute('data-edge', 'left')
    expect(handle).toHaveAttribute('aria-valuenow', '612')
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
    const handle = screen.getByRole('separator', { name: 'Resize side panel' })

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
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize side panel' }), { key: 'ArrowLeft' })

    expect(onWidthChange).toHaveBeenCalledExactlyOnceWith(MIN_PANEL_WIDTH)
  })
})

describe('RightPanel motion', () => {
  it('slides open and shut with no handle while it moves, inert on its way out', () => {
    const { rerender } = render(<RightPanel width={440} onWidthChange={vi.fn()} motion={MotionPhase.Entering} />)
    const slot = screen.getByTestId('right-panel')
    expect(slot).toHaveClass(moduleClass(panelMotionStyles, 'entering'))
    expect(slot).toHaveAttribute('data-motion', 'entering')
    expect(screen.queryByRole('separator')).toBeNull()

    rerender(<RightPanel width={440} onWidthChange={vi.fn()} motion={MotionPhase.Leaving} />)
    expect(slot).toHaveClass(moduleClass(panelMotionStyles, 'leaving'))
    expect(slot).toHaveAttribute('inert')

    rerender(<RightPanel width={440} onWidthChange={vi.fn()} />)
    expect(slot).not.toHaveAttribute('data-motion')
    expect(screen.getByRole('separator', { name: 'Resize side panel' })).toBeInTheDocument()
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

  it('holds the plugin card beside the terminal card, after it in the bar', () => {
    render(
      <BottomBar
        terminal={<pre>Prompt</pre>}
        plugin={
          <section role="region" aria-label="Nekomata">
            Cats
          </section>
        }
      />,
    )

    const terminal = screen.getByRole('region', { name: 'Terminal' })
    const plugin = screen.getByRole('region', { name: 'Nekomata' })
    expect(plugin.parentElement).toBe(terminal.parentElement)
    expect(terminal.nextElementSibling).toBe(plugin)
  })

  it('has the terminal card alone without a plugin', () => {
    render(<BottomBar terminal={<pre>Prompt</pre>} />)

    expect(screen.getByRole('region', { name: 'Terminal' }).parentElement?.children).toHaveLength(1)
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

  it('slides between its height and its tab row’s, measured as it starts, with the terminal showing', () => {
    // jsdom lays nothing out: the tab row is 40px and the card has a 1px border.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'terminal-tabs') return 40
      return this.getAttribute('role') === 'region' ? 302 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'region' ? 300 : 0
    })
    const { rerender } = render(<BottomBar terminal={<pre>Prompt</pre>} motion={MotionPhase.Shown} />)
    const bar = screen.getByRole('region', { name: 'Terminal' }).parentElement
    expect(bar).not.toHaveClass(moduleClass(bottomBarStyles, 'moving'))
    expect(bar?.style.getPropertyValue('--bottom-bar-collapsed-height')).toBe('')

    rerender(<BottomBar terminal={<pre>Prompt</pre>} motion={MotionPhase.Leaving} />)
    expect(bar).toHaveClass(moduleClass(bottomBarStyles, 'moving'), moduleClass(panelMotionStyles, 'leaving'))
    expect(bar?.style.getPropertyValue('--bottom-bar-collapsed-height')).toBe('42px')
    expect(screen.getByText('Prompt')).toBeVisible()

    rerender(<BottomBar collapsed terminal={<pre>Prompt</pre>} motion={MotionPhase.Hidden} />)
    expect(bar).not.toHaveClass(moduleClass(bottomBarStyles, 'moving'))
    rerender(<BottomBar terminal={<pre>Prompt</pre>} motion={MotionPhase.Entering} />)
    expect(bar).toHaveClass(moduleClass(panelMotionStyles, 'entering'))
    vi.restoreAllMocks()
  })
})
