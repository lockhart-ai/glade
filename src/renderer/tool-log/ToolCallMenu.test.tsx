import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { ToolCallState, ToolEventKind, UiStateKey, type ToolCallEvent } from '../../shared/domain'
import { refuse } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import { toolCallMenuTarget } from './ToolCallMenu'
import { ToolLog } from './ToolLog'

const ROOT = '/code/w1'

function call(id: string, name: string, input: Record<string, unknown>, output: string | null): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: 1_000,
    kind: ToolEventKind.ToolCall,
    name,
    input,
    output,
    state: output === null ? ToolCallState.Running : ToolCallState.Done,
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
  }
}

const BASH = call('bash', 'Bash', { command: 'npm test' }, '148 passed')
const READ = call('read', 'Read', { file_path: `${ROOT}/src/date.ts` }, 'export {}')
const GREP = call('grep', 'Grep', { pattern: 'formatDate' }, null)

describe('toolCallMenuTarget', () => {
  it('finds a Bash call’s command, any call’s output, and the workspace file a file tool worked on', () => {
    expect(toolCallMenuTarget(BASH, ROOT)).toEqual({ command: 'npm test', output: '148 passed', file: null })
    expect(toolCallMenuTarget(READ, ROOT)).toEqual({ command: null, output: 'export {}', file: 'src/date.ts' })
    expect(toolCallMenuTarget(READ, undefined).file).toBeNull()
    expect(toolCallMenuTarget(call('odd', 'Bash', { command: 3 }, null), ROOT).command).toBeNull()
    expect(toolCallMenuTarget(call('out', 'Read', { file_path: '/etc/hosts' }, null), ROOT).file).toBeNull()
  })
})

describe('a tool call’s context menu', () => {
  async function renderLog(copied: string[] = []) {
    const wrapper = storeWrapper({
      copied,
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
    })
    await act(() => wrapper.store.getState().hydrate())
    render(<ToolLog taskId="t1" events={[BASH, READ, GREP]} rootPath={ROOT} />, { wrapper: wrapper.wrapper })
    return wrapper
  }

  async function open(name: RegExp): Promise<string[]> {
    const row = screen.getByRole('button', { name }).parentElement ?? document.body
    fireEvent.contextMenu(row)
    await act(() => Promise.resolve())
    return screen.queryAllByRole('menuitem').map((item) => item.textContent)
  }

  async function choose(name: RegExp, label: string): Promise<void> {
    await open(name)
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    await act(() => Promise.resolve())
  }

  it('copies a command and an output', async () => {
    const copied: string[] = []
    await renderLog(copied)

    expect(await open(/^Done\s*Bash/)).toEqual(['Copy command', 'Copy output'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy command' }))
    await act(() => Promise.resolve())
    await choose(/^Done\s*Bash/, 'Copy output')

    expect(copied).toEqual(['npm test', '148 passed'])
  })

  it('opens a call’s file in the Files tab', async () => {
    const { store } = await renderLog()

    await choose(/^Done\s*Read/, 'Open file')

    expect(store.getState().openFiles.t1?.activePath).toBe('src/date.ts')
    expect(store.getState().uiState[UiStateKey.RightPanelTab]).toBe('files')
  })

  it('opens nothing for a call with nothing to act on yet', async () => {
    await renderLog()

    expect(await open(/^Running\s*Grep/)).toEqual([])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('shows a toast when the file can’t be opened', async () => {
    const wrapper = storeWrapper(
      {},
      { [CommandName.FilesOpen]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')) },
    )
    render(<ToolLog taskId="t1" events={[READ]} rootPath={ROOT} />, { wrapper: wrapper.wrapper })

    await choose(/^Done\s*Read/, 'Open file')

    expect(await screen.findByText('No task t1')).toBeInTheDocument()
  })
})
