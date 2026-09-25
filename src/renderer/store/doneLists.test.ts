// The store's side of the Done section's paging: its pages, its counts kept by events, and the tasks it loads by id.
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { TaskFilter } from '../../shared/attention'
import { DONE_PAGE_SIZE, type DonePage } from '../../shared/doneList'
import { TaskState, UiStateKey, type Task } from '../../shared/domain'
import { SearchField } from '../../shared/search'
import { listedTaskIds } from '../task-list/sections'
import { doneCountsFor, doneListKey, isLoaded, withCountedChange, withDonePage } from './doneLists'
import { INITIAL_DATA } from './state'
import { createGladeStore } from './store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers, type FakeMain } from './test-bridge'

const DONE_TASKS = 1_050

/** A done task in w1, `index` places down the Done section. */
function done(index: number, change: Partial<Task> = {}): Task {
  return {
    ...sampleTask(`d${String(index).padStart(4, '0')}`, 'w1', `Done ${String(index)}`),
    state: TaskState.Done,
    updatedAt: 1_000_000 - index,
    ...change,
  }
}

function main(tasks: Task[], uiState: FakeMain['uiState'] = []): FakeMain {
  return {
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
    tasks,
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.DoneSectionCollapsed, value: 'false' },
      ...uiState,
    ],
  }
}

function manyDone(): Task[] {
  return Array.from({ length: DONE_TASKS }, (_, index) => done(index, { unread: index % 10 === 0 }))
}

async function hydrated(data: FakeMain, overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge(data, overrides)
  const store = createGladeStore(fake.bridge)
  await store.getState().hydrate()
  return { ...fake, store, data }
}

function pagesLoaded(invoke: ReturnType<typeof fakeBridge>['invoke']): number {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksListDone).length
}

describe('isLoaded', () => {
  const pages = { end: { updatedAt: 500, id: 'm' }, hasMore: true }

  it('holds the tasks at or above the last one loaded, every one once all are, and none before any page', () => {
    expect(isLoaded({ updatedAt: 600, id: 'z' }, pages)).toBe(true)
    expect(isLoaded({ updatedAt: 500, id: 'm' }, pages)).toBe(true)
    expect(isLoaded({ updatedAt: 500, id: 'n' }, pages)).toBe(false)
    expect(isLoaded({ updatedAt: 400, id: 'a' }, pages)).toBe(false)
    expect(isLoaded({ updatedAt: 1, id: 'a' }, { ...pages, hasMore: false })).toBe(true)
    expect(isLoaded({ updatedAt: 1, id: 'a' }, undefined)).toBe(false)
    expect(isLoaded({ updatedAt: 1, id: 'a' }, { end: null, hasMore: true })).toBe(false)
  })
})

describe('withDonePage', () => {
  it('keeps where the pages ended when a page brings no tasks', () => {
    const key = doneListKey('w1', TaskFilter.All)
    const state = { ...INITIAL_DATA, doneLists: { [key]: { end: { updatedAt: 5, id: 'x' }, hasMore: true } } }
    const empty: DonePage = { tasks: [], hasMore: false }

    expect(withDonePage(state, 'w1', TaskFilter.All, empty).doneLists[key]).toEqual({
      end: { updatedAt: 5, id: 'x' },
      hasMore: false,
    })
    expect(withDonePage(INITIAL_DATA, 'w1', TaskFilter.All, empty).doneLists[key]).toEqual({
      end: null,
      hasMore: false,
    })
  })

  it('keeps a task the store already has over the page’s copy, which may be older', () => {
    const fresh = done(0, { title: 'Renamed since' })
    const state = { ...INITIAL_DATA, tasks: { [fresh.id]: fresh } }

    const paged = withDonePage(state, 'w1', TaskFilter.All, { tasks: [done(0), done(1)], hasMore: false })

    expect(paged.tasks[fresh.id]).toBe(fresh)
    expect(paged.tasks[done(1).id]).toEqual(done(1))
  })
})

describe('withCountedChange', () => {
  it('leaves the counts alone for a task the store didn’t have, and for a change that doesn’t move them', () => {
    const state = { ...INITIAL_DATA, doneCounts: { w1: { all: 3, unread: 1 } } }

    expect(withCountedChange(state, undefined, done(0))).toBe(state)
    expect(withCountedChange(state, done(0), done(0, { title: 'Renamed' }))).toBe(state)
    expect(doneCountsFor(withCountedChange(INITIAL_DATA, sampleTask('a', 'w9'), done(0)), 'w9')).toEqual({
      all: 1,
      unread: 0,
    })
  })
})

describe('the Done section in the store', () => {
  it('hydrates with the counts of 1,000+ done tasks and only their first page', async () => {
    const { store } = await hydrated(main(manyDone()))
    const state = store.getState()

    expect(state.doneCounts.w1).toEqual({ all: DONE_TASKS, unread: 105 })
    expect(Object.keys(state.tasks)).toHaveLength(DONE_PAGE_SIZE)
    expect(listedTaskIds(state, 'w1')).toHaveLength(DONE_PAGE_SIZE)
  })

  it('loads the pages one after another to the last, then no more', async () => {
    const { store, invoke } = await hydrated(main(manyDone()))

    for (let page = 1; page < Math.ceil(DONE_TASKS / DONE_PAGE_SIZE); page += 1) {
      await store.getState().loadDonePage('w1', TaskFilter.All)
      expect(listedTaskIds(store.getState(), 'w1')).toHaveLength(Math.min((page + 1) * DONE_PAGE_SIZE, DONE_TASKS))
    }
    const loads = pagesLoaded(invoke)
    await store.getState().loadDonePage('w1', TaskFilter.All)

    expect(pagesLoaded(invoke)).toBe(loads)
    expect(store.getState().doneLists[doneListKey('w1', TaskFilter.All)]?.hasMore).toBe(false)
    expect(listedTaskIds(store.getState(), 'w1').at(-1)).toBe(done(DONE_TASKS - 1).id)
  })

  it('loads a page once however many ask for it while it loads', async () => {
    const { store, invoke } = await hydrated(main(manyDone()))
    const before = pagesLoaded(invoke)

    await Promise.all([
      store.getState().loadDonePage('w1', TaskFilter.All),
      store.getState().loadDonePage('w1', TaskFilter.All),
      store.getState().loadDonePage('w1', TaskFilter.All),
    ])

    expect(pagesLoaded(invoke)).toBe(before + 1)
    expect(listedTaskIds(store.getState(), 'w1')).toHaveLength(2 * DONE_PAGE_SIZE)
  })

  it('pages each filter chip on its own, starting with the first page', async () => {
    const { store, invoke } = await hydrated(main(manyDone()))

    await store.getState().loadDonePage('w1', TaskFilter.Unread)

    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksListDone, {
      workspaceId: 'w1',
      filter: TaskFilter.Unread,
      after: null,
      limit: DONE_PAGE_SIZE,
    })
    expect(store.getState().doneLists[doneListKey('w1', TaskFilter.Unread)]?.hasMore).toBe(true)
  })

  it('loads through the page that has a task, or all of them, and stops for a task not in the section', async () => {
    const { store, invoke } = await hydrated(main([...manyDone(), sampleTask('active', 'w1')]))

    await store.getState().loadDoneThrough('w1', TaskFilter.All, done(450).id)
    expect(pagesLoaded(invoke)).toBe(5)
    expect(listedTaskIds(store.getState(), 'w1')).toContain(done(450).id)

    await store.getState().loadDoneThrough('w1', TaskFilter.All, 'active')
    await store.getState().loadDoneThrough('w1', TaskFilter.All, 'unknown')
    await store.getState().loadDoneThrough('w1', TaskFilter.All, done(10).id)
    expect(pagesLoaded(invoke)).toBe(5)

    await store.getState().loadDoneThrough('w1', TaskFilter.All, null)
    expect(listedTaskIds(store.getState(), 'w1')).toHaveLength(DONE_TASKS + 1)
    await store.getState().loadDoneThrough('w1', TaskFilter.All, null)
    expect(pagesLoaded(invoke)).toBe(Math.ceil(DONE_TASKS / DONE_PAGE_SIZE))
  })

  it('loads the first page before looking for the task, when none has loaded', async () => {
    const { store } = await hydrated(main(manyDone(), [{ key: UiStateKey.ActiveWorkspaceId, value: 'w2' }]))
    expect(store.getState().doneLists[doneListKey('w1', TaskFilter.All)]).toBeUndefined()

    await store.getState().loadDoneThrough('w1', TaskFilter.All, done(150).id)

    expect(store.getState().doneLists[doneListKey('w1', TaskFilter.All)]?.end?.id).toBe(done(199).id)
  })

  it('stops paging when a page brings nothing new, rather than asking forever', async () => {
    const { store, invoke } = await hydrated(main(manyDone()), {
      [CommandName.TasksListDone]: () => ({ tasks: [], hasMore: true }),
    })
    const before = pagesLoaded(invoke)

    await store.getState().loadDoneThrough('w1', TaskFilter.All, null)

    expect(pagesLoaded(invoke)).toBe(before + 1)
  })

  it('rejects when a page fails to load, and can load it again after', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'disk full')
    let fail = false
    const tasks = manyDone()
    const { store } = await hydrated(main(tasks), {
      [CommandName.TasksListDone]: (request) => {
        if (fail) return refuse(failure)
        return fakeBridge(main(tasks)).bridge.invoke(CommandName.TasksListDone, request)
      },
    })
    fail = true

    await expect(store.getState().loadDonePage('w1', TaskFilter.All)).rejects.toBe(failure)
    fail = false
    await store.getState().loadDonePage('w1', TaskFilter.All)
    expect(listedTaskIds(store.getState(), 'w1')).toHaveLength(2 * DONE_PAGE_SIZE)
  })

  it('never brings back a task deleted while its page was loading', async () => {
    const tasks = manyDone()
    let deleteDuringLoad = (): void => undefined
    const { store, emit } = await hydrated(main(tasks), {
      [CommandName.TasksListDone]: async (request) => {
        const page = await fakeBridge(main(tasks)).bridge.invoke(CommandName.TasksListDone, request)
        deleteDuringLoad()
        return page
      },
    })
    const doomed = done(DONE_PAGE_SIZE + 3)
    deleteDuringLoad = () => {
      emit({ type: EventType.TaskDeleted, taskId: doomed.id })
    }

    await store.getState().loadDonePage('w1', TaskFilter.All)

    expect(store.getState().tasks[doomed.id]).toBeUndefined()
    expect(listedTaskIds(store.getState(), 'w1')).toHaveLength(2 * DONE_PAGE_SIZE - 1)
  })

  it('keeps the counts right as tasks move to and from Done, get read, pinned or deleted', async () => {
    const active = { ...sampleTask('active', 'w1'), updatedAt: 2_000_000 }
    const { store, emit } = await hydrated(main([active, ...manyDone()]))
    const counts = (): unknown => store.getState().doneCounts.w1

    emit({ type: EventType.TaskUpdated, task: { ...active, state: TaskState.Done, unread: true } })
    expect(counts()).toEqual({ all: DONE_TASKS + 1, unread: 106 })
    emit({ type: EventType.TaskUpdated, task: { ...active, state: TaskState.Done } })
    expect(counts()).toEqual({ all: DONE_TASKS + 1, unread: 105 })
    emit({ type: EventType.TaskUpdated, task: { ...active, state: TaskState.Done, pinned: true } })
    expect(counts()).toEqual({ all: DONE_TASKS, unread: 105 })
    emit({ type: EventType.TaskUpdated, task: { ...done(0), state: TaskState.Active } })
    expect(counts()).toEqual({ all: DONE_TASKS - 1, unread: 104 })
    emit({ type: EventType.TaskDeleted, taskId: done(1).id })
    expect(counts()).toEqual({ all: DONE_TASKS - 2, unread: 104 })
    // A task below the pages loaded isn't in the store: its deletion is counted from main's next answer, not here.
    emit({ type: EventType.TaskDeleted, taskId: done(900).id })
    expect(counts()).toEqual({ all: DONE_TASKS - 2, unread: 104 })
  })

  it('forgets a removed workspace’s counts and pages', async () => {
    const { store } = await hydrated(main(manyDone()))

    await store.getState().removeWorkspace('w1')

    expect(store.getState().doneCounts.w1).toBeUndefined()
    expect(store.getState().doneLists).toEqual({})
    expect(store.getState().doneCounts.w2).toEqual({ all: 0, unread: 0 })
  })
})

describe('tasks loaded by id', () => {
  it('selects a done task below the pages loaded, loading it first', async () => {
    const tasks = manyDone()
    const { store, invoke } = await hydrated(main(tasks))
    const deep = done(701)

    await store.getState().selectTask(deep.id)

    expect(invoke).toHaveBeenCalledWith(CommandName.TasksGet, { ids: [deep.id] })
    expect(store.getState().selectedTaskId).toBe(deep.id)
    expect(store.getState().tasks[deep.id]).toEqual(tasks[701])
    // It waits for its page before it lists.
    expect(listedTaskIds(store.getState(), 'w1')).not.toContain(deep.id)
  })

  it('asks main only for the tasks it doesn’t have, and never for a deleted one', async () => {
    const { store, invoke, emit } = await hydrated(main(manyDone()))
    emit({ type: EventType.TaskDeleted, taskId: done(800).id })

    await store.getState().selectTask(done(0).id)
    await store.getState().selectTask(done(800).id)

    expect(invoke.mock.calls.filter(([command]) => command === CommandName.TasksGet)).toEqual([])
  })

  it('loads the selection a workspace restores when it opens', async () => {
    const tasks = manyDone()
    const { store } = await hydrated({
      ...main(tasks, [{ key: UiStateKey.ActiveWorkspaceId, value: 'w2' }]),
      workspaceSelections: { w1: done(640).id },
    })

    await store.getState().openWorkspace('w1')

    expect(store.getState().selectedTaskId).toBe(done(640).id)
    expect(store.getState().tasks[done(640).id]).toEqual(tasks[640])
  })

  it('loads the tasks a search finds below the pages loaded, so their rows show', async () => {
    const tasks = manyDone()
    const { store } = await hydrated(main(tasks), {
      [CommandName.SearchQuery]: () => ({
        results: [done(3), done(999)].map(({ id }) => ({ taskId: id, field: SearchField.Title, snippet: [] })),
      }),
    })

    const results = await store.getState().searchTasks('w1', 'done')

    expect(results).toHaveLength(2)
    expect(store.getState().tasks[done(999).id]).toEqual(tasks[999])
  })
})

describe('deleting the selected task at the end of the pages loaded', () => {
  it('selects the next done task, loading its page', async () => {
    const tasks = manyDone()
    const last = done(DONE_PAGE_SIZE - 1)
    const { store } = await hydrated(main(tasks, [{ key: UiStateKey.SelectedTaskId, value: last.id }]))

    await store.getState().deleteTask(last.id)

    expect(store.getState().selectedTaskId).toBe(done(DONE_PAGE_SIZE).id)
  })
})
