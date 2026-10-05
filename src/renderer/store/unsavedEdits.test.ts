// The store's side of editing files in the Files tab: which files have unsaved edits, telling main, and the Save /
// Discard / Cancel prompt before closing a file, switching task, closing the window or quitting. The editor itself is
// a stand-in here (`EditSession`); the Files tab's tests drive the real one.
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CloseKind, CommandName, EventType } from '../../shared/bridge'
import { FileContentKind, UiStateKey, type FileContent } from '../../shared/domain'
import {
  UnsavedChoice,
  UnsavedReason,
  type EditSession,
  type FileEditState,
  type OpenEditSession,
  type TaskFile,
} from '../files/unsaved'
import { createGladeStore, type GladeStore } from './store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers, type FakeMain } from './test-bridge'

/** A stand-in editor: its text, and a way to make it (un)saved as typing would. */
class StubSession implements EditSession {
  editState: FileEditState = { unsaved: false, changedOnDisk: false }
  reloads = true
  readonly received: FileContent[] = []
  kept = false

  constructor(
    private current: string,
    private readonly tell: (state: FileEditState) => void,
  ) {}

  type(text: string): void {
    this.current = text
    this.editState = { ...this.editState, unsaved: true }
    this.tell(this.editState)
  }

  text(): string {
    return this.current
  }
  show(): () => void {
    return () => undefined
  }
  markLine(): void {
    // Nothing shows: there is no line to mark.
  }
  receive(content: FileContent): boolean {
    this.received.push(content)
    return true
  }
  reload(): boolean {
    return this.reloads
  }
  keepMine(): void {
    this.kept = true
  }
  markSaved(): void {
    this.editState = { unsaved: false, changedOnDisk: false }
    this.tell(this.editState)
  }
}

const A: TaskFile = { taskId: 't1', path: 'docs/a.md' }
const B: TaskFile = { taskId: 't1', path: 'docs/b.md' }
const OTHER: TaskFile = { taskId: 't2', path: 'notes.md' }

async function setup(main: Partial<FakeMain> = {}, overrides: Partial<FakeHandlers> = {}) {
  const data: FakeMain = {
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w1'), sampleTask('t3', 'w2')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
    ],
    openFiles: [{ taskId: 't1', paths: [A.path, B.path], activePath: A.path }],
    writtenFiles: [],
    unsavedEdits: [],
    ...main,
  }
  const fake = fakeBridge(data, overrides)
  const store = createGladeStore(fake.bridge)
  await store.getState().hydrate()
  const sessions = new Map<string, StubSession>()
  /** Starts editing a file, and answers its stand-in editor. */
  const edit = (file: TaskFile, text = 'saved'): StubSession => {
    const open: OpenEditSession = (tell) => {
      const session = new StubSession(text, tell)
      sessions.set(`${file.taskId}/${file.path}`, session)
      return session
    }
    store.getState().startEditing(file, open)
    const session = sessions.get(`${file.taskId}/${file.path}`)
    if (session === undefined) throw new Error('No editor made')
    return session
  }
  return { ...fake, store, data, edit }
}

/** Answers the prompt showing, once it shows. */
async function answer(store: GladeStore, choice: UnsavedChoice): Promise<void> {
  await vi.waitFor(() => {
    expect(store.getState().unsavedPrompt).not.toBeNull()
  })
  await store.getState().answerUnsavedPrompt(choice)
}

describe('unsaved edits', () => {
  it('keeps each file’s editor once, and tells main as the window starts and stops having unsaved edits', async () => {
    const { store, data, edit } = await setup()
    const a = edit(A)
    // A file already being edited keeps its editor.
    store.getState().startEditing(A, () => {
      throw new Error('made again')
    })
    const b = edit(B)

    a.type('mine')
    b.type('mine too')
    expect(store.getState().fileEdits.t1?.[A.path]).toMatchObject({ unsaved: true, changedOnDisk: false })

    await store.getState().saveFile(A)
    await store.getState().saveFile(B)

    expect(data.writtenFiles).toEqual([
      { ...A, text: 'mine' },
      { ...B, text: 'mine too' },
    ])
    expect(data.unsavedEdits).toEqual([true, false])
  })

  it('tells main again after telling it failed', async () => {
    const setUnsaved = vi.fn(() => refuse(bridgeError(BridgeErrorCode.Internal, 'the window is closing')))
    const { edit } = await setup({}, { [CommandName.WindowSetUnsavedEdits]: setUnsaved })
    const a = edit(A)

    a.type('mine')
    await vi.waitFor(() => {
      expect(setUnsaved).toHaveBeenCalledOnce()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    edit(B).type('again')

    await vi.waitFor(() => {
      expect(setUnsaved).toHaveBeenCalledTimes(2)
    })
    expect(setUnsaved).toHaveBeenLastCalledWith({ unsaved: true })
  })

  it('saves nothing for a file with no unsaved edits, or none being edited', async () => {
    const { store, data, edit } = await setup()
    edit(A)

    await store.getState().saveFile(A)
    await store.getState().saveFile(OTHER)

    expect(data.writtenFiles).toEqual([])
  })

  it('Reload and Keep mine reach the file’s editor; a Reload with nothing to show stops editing', async () => {
    const { store, edit } = await setup()
    const a = edit(A)

    store.getState().keepMyEdits(A)
    store.getState().reloadFile(A)
    expect(a.kept).toBe(true)
    expect(store.getState().fileEdits.t1?.[A.path]).toBeDefined()

    a.reloads = false
    store.getState().reloadFile(A)
    expect(store.getState().fileEdits.t1).toBeUndefined()
    // Nothing being edited: nothing to do.
    store.getState().reloadFile(A)
    store.getState().keepMyEdits(A)
  })

  it('drops a deleted task’s editors, and says nothing of an editor after it’s dropped', async () => {
    const { store, emit, edit } = await setup()
    edit(OTHER).type('mine')
    const a = edit(A)

    emit({ type: EventType.TaskDeleted, taskId: 't2' })
    store.getState().stopEditing(A)
    a.type('late')

    expect(store.getState().fileEdits).toEqual({})
  })
})

describe('the unsaved edits prompt', () => {
  it('closes a file with nothing unsaved at once', async () => {
    const { store, edit } = await setup()
    edit(A)

    await expect(store.getState().closeFile('t1', A.path)).resolves.toBe(true)

    expect(store.getState().unsavedPrompt).toBeNull()
    expect(store.getState().fileEdits).toEqual({})
  })

  it('asks before switching task: Cancel stays, Save saves and goes', async () => {
    const { store, data, edit } = await setup()
    edit(A).type('mine')

    const staying = store.getState().selectTask('t2')
    await answer(store, UnsavedChoice.Cancel)
    await staying
    expect(store.getState().selectedTaskId).toBe('t1')
    expect(store.getState().unsavedPrompt).toBeNull()

    const going = store.getState().selectTask('t2')
    await vi.waitFor(() => {
      expect(store.getState().unsavedPrompt).toEqual({ reason: UnsavedReason.SwitchTask, files: [A] })
    })
    await store.getState().answerUnsavedPrompt(UnsavedChoice.Save)
    await going
    expect(store.getState().selectedTaskId).toBe('t2')
    expect(data.writtenFiles).toEqual([{ ...A, text: 'mine' }])
    // Selecting the task you're on asks nothing.
    await store.getState().selectTask('t2')
  })

  it('asks before a task main opens (a plugin, on a subagent): Cancel stays, showing nothing', async () => {
    const { store, emit, edit } = await setup()
    edit(A).type('mine')

    emit({ type: EventType.TaskOpenRequested, taskId: 't3', subagentId: 'toolu_kitten' })
    await answer(store, UnsavedChoice.Cancel)

    await vi.waitFor(() => {
      expect(store.getState().unsavedPrompt).toBeNull()
    })
    expect(store.getState().selectedTaskId).toBe('t1')
    expect(store.getState().selectedWorkspaceId).toBe('w1')
    expect(store.getState().uiState[UiStateKey.RightPanelTabs]).toBeUndefined()
  })

  it('asks before a new task, and before another workspace: Discard drops the edits and goes', async () => {
    const { store, data, edit } = await setup()
    edit(A).type('mine')

    const cancelled = store.getState().createTask('w1')
    await answer(store, UnsavedChoice.Cancel)
    await expect(cancelled).resolves.toBeNull()

    const switching = store.getState().openWorkspace('w2')
    await answer(store, UnsavedChoice.Discard)
    await switching
    expect(store.getState().selectedWorkspaceId).toBe('w2')
    expect(store.getState().fileEdits).toEqual({})
    expect(data.writtenFiles).toEqual([])
    // The workspace you're in asks nothing.
    await store.getState().openWorkspace('w2')
  })

  it('stays when a save fails, rejecting with why', async () => {
    const { store, edit } = await setup({ refuseWrites: 'the disk is full' })
    edit(A).type('mine')

    const closing = store.getState().closeFile('t1', A.path)
    await vi.waitFor(() => {
      expect(store.getState().unsavedPrompt?.reason).toBe(UnsavedReason.CloseFile)
    })
    await expect(store.getState().answerUnsavedPrompt(UnsavedChoice.Save)).rejects.toMatchObject({
      message: 'the disk is full',
    })

    await expect(closing).resolves.toBe(false)
    expect(store.getState().unsavedPrompt).toBeNull()
    expect(store.getState().fileEdits.t1?.[A.path]?.unsaved).toBe(true)
  })

  it('asks one thing at a time, and an answer with no prompt showing does nothing', async () => {
    const { store, edit } = await setup()
    edit(A).type('mine')
    await store.getState().answerUnsavedPrompt(UnsavedChoice.Save)

    const first = store.getState().closeFile('t1', A.path)
    await vi.waitFor(() => {
      expect(store.getState().unsavedPrompt).not.toBeNull()
    })
    await expect(store.getState().selectTask('t2')).resolves.toBeUndefined()
    expect(store.getState().selectedTaskId).toBe('t1')

    await store.getState().answerUnsavedPrompt(UnsavedChoice.Cancel)
    await expect(first).resolves.toBe(false)
  })

  it('asks when main calls off quitting, about every task’s files, then quits again', async () => {
    const { store, data, emit, edit } = await setup()
    edit(A).type('mine')
    edit(OTHER).type('theirs')

    emit({ type: EventType.CloseBlocked, kind: CloseKind.Quit })
    await vi.waitFor(() => {
      expect(store.getState().unsavedPrompt).toEqual({ reason: UnsavedReason.Quit, files: [A, OTHER] })
    })
    await store.getState().answerUnsavedPrompt(UnsavedChoice.Discard)

    await vi.waitFor(() => {
      expect(data.quits).toBe(1)
    })
    expect(data.closedWindows).toBeUndefined()
  })

  it('asks when main calls off closing the window: Save, then close; Cancel, and it stays open', async () => {
    const { store, data, emit, edit } = await setup()
    const a = edit(A)
    a.type('mine')

    emit({ type: EventType.CloseBlocked, kind: CloseKind.Window })
    await answer(store, UnsavedChoice.Cancel)
    expect(data.closedWindows).toBeUndefined()

    emit({ type: EventType.CloseBlocked, kind: CloseKind.Window })
    await vi.waitFor(() => {
      expect(store.getState().unsavedPrompt?.reason).toBe(UnsavedReason.CloseWindow)
    })
    await store.getState().answerUnsavedPrompt(UnsavedChoice.Save)
    await vi.waitFor(() => {
      expect(data.closedWindows).toBe(1)
    })
    expect(data.writtenFiles).toEqual([{ ...A, text: 'mine' }])
  })

  it('closes or quits at once when main calls it off with nothing unsaved any more', async () => {
    const { store, data, emit } = await setup()

    emit({ type: EventType.CloseBlocked, kind: CloseKind.Quit })

    await vi.waitFor(() => {
      expect(data.quits).toBe(1)
    })
    expect(store.getState().unsavedPrompt).toBeNull()
  })
})

describe('reading a file', () => {
  it('answers what main read', async () => {
    const content: FileContent = { kind: FileContentKind.Text, text: 'x', truncated: false, size: 1 }
    const { store } = await setup({ files: { [A.path]: content } })

    await expect(store.getState().readFile('t1', A.path)).resolves.toEqual(content)
  })
})
