// Keeping a question card's answers across a task switch (#615): each task's card keeps its own draft as it goes, and
// it's stored in main as you type, so it's there again after a relaunch. Sending, withdrawing or deleting the task
// leaves nothing of it, and a draft is never shown on a card it wasn't typed on.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  EventType,
  type QuestionsDraftSetRequest,
} from '../../shared/bridge'
import {
  QuestionKind,
  QuestionSetState,
  TaskActivity,
  UiStateKey,
  type Question,
  type QuestionCardDraft,
  type QuestionSet,
} from '../../shared/domain'
import { Chat } from '../chat/Chat'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { DRAFT_SAVE_DELAY_MS } from '../input-bar/InputBar'

const LAYOUT: Question = {
  kind: QuestionKind.Choice,
  prompt: 'How should the notes be laid out?',
  options: [
    { id: 'by-type', label: 'By type' },
    { id: 'by-area', label: 'By area' },
  ],
}
const TAGS: Question = { kind: QuestionKind.Pills, prompt: 'Tags?', options: ['api', 'ui', 'docs'], multiple: true }
const NOTE: Question = { kind: QuestionKind.Text, prompt: 'Anything to call out?' }
const STRATEGY: Question = {
  kind: QuestionKind.Choice,
  prompt: 'Merge now or after review?',
  options: [
    { id: 'now', label: 'Merge now' },
    { id: 'later', label: 'After review' },
  ],
}

/** An open question set of `taskId`'s, with its id given or made up from it. */
function openSet(taskId: string, questions: readonly Question[], id = `q-${taskId}`): QuestionSet {
  return {
    id,
    taskId,
    turn: 1,
    preamble: null,
    questions,
    state: QuestionSetState.Open,
    reply: null,
    createdAt: 5_000,
    closedAt: null,
  }
}

/** What the first task's card has filled in, as `fillFirstCard` leaves it. */
const DRAFT: QuestionCardDraft = {
  questionSetId: 'q-t1',
  draft: { 0: 'by-type', 1: ['api', 'ui'], 2: 'Call out 429s' },
  anythingElse: 'And a note.',
}

type Launched = FakeBridge & { store: GladeStore }

/**
 * Opens the window on a workspace with two tasks, each with its open card, as a launch does. `drafts` is what main has
 * stored of the cards; the record is shared with main, so its saves outlive the window, as the database does.
 */
async function launch(
  drafts: Record<string, QuestionCardDraft> = {},
  overrides: Partial<FakeHandlers> = {},
): Promise<Launched> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w1')].map((task) => ({
        ...task,
        activity: TaskActivity.Waiting,
      })),
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      messages: [],
      questionSets: [openSet('t1', [LAYOUT, TAGS, NOTE]), openSet('t2', [STRATEGY])],
      questionDrafts: drafts,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <Chat />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  await act(() => Promise.resolve())
  return { ...fake, store }
}

/** Closes the window, as quitting does: it unloads, then goes. */
function quit(): void {
  act(() => {
    window.dispatchEvent(new Event('beforeunload'))
  })
  cleanup()
}

async function select(store: GladeStore, taskId: string): Promise<void> {
  await act(() => store.getState().selectTask(taskId))
  await act(() => Promise.resolve())
}

function card(): HTMLElement {
  return screen.getByRole('form', { name: 'Questions from the agent' })
}

function saves(fake: FakeBridge): QuestionsDraftSetRequest[] {
  return fake.invoke.mock.calls
    .filter(([command]) => command === CommandName.QuestionsDraftSet)
    .map(([, request]) => request as QuestionsDraftSetRequest)
}

/** Lets the save a pause after the last change go. */
async function pause(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DRAFT_SAVE_DELAY_MS)
  })
}

/** Fills the first task's card: a choice, two pills, a text answer and a note in "Anything else?". */
function fillFirstCard(): void {
  fireEvent.click(within(card()).getByRole('radio', { name: 'By type' }))
  fireEvent.click(within(card()).getByRole('checkbox', { name: 'api' }))
  fireEvent.click(within(card()).getByRole('checkbox', { name: 'ui' }))
  fireEvent.change(within(card()).getByRole('textbox', { name: 'Anything to call out?' }), {
    target: { value: 'Call out 429s' },
  })
  fireEvent.change(within(card()).getByRole('textbox', { name: 'Anything else?' }), {
    target: { value: 'And a note.' },
  })
}

/** Expects the first task's card to be filled exactly as `fillFirstCard` leaves it. */
function expectFirstCardFilled(): void {
  expect(within(card()).getByRole('radio', { name: 'By type' })).toBeChecked()
  expect(within(card()).getByRole('checkbox', { name: 'api' })).toBeChecked()
  expect(within(card()).getByRole('checkbox', { name: 'ui' })).toBeChecked()
  expect(within(card()).getByRole('checkbox', { name: 'docs' })).not.toBeChecked()
  expect(within(card()).getByRole('textbox', { name: 'Anything to call out?' })).toHaveValue('Call out 429s')
  expect(within(card()).getByRole('textbox', { name: 'Anything else?' })).toHaveValue('And a note.')
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('switching task and back', () => {
  it('shows the card as you left it: the choice, the pills, the text and the note all stay', async () => {
    const fake = await launch()
    fillFirstCard()

    await select(fake.store, 't2')
    expect(within(card()).getByRole('radio', { name: 'Merge now' })).not.toBeChecked()
    await select(fake.store, 't1')

    expectFirstCardFilled()
  })

  it('keeps two tasks’ drafts apart', async () => {
    const fake = await launch()
    fillFirstCard()
    await select(fake.store, 't2')
    fireEvent.click(within(card()).getByRole('radio', { name: 'After review' }))
    fireEvent.change(within(card()).getByRole('textbox', { name: 'Anything else?' }), {
      target: { value: 'For the second task.' },
    })

    await select(fake.store, 't1')
    expectFirstCardFilled()

    await select(fake.store, 't2')
    expect(within(card()).getByRole('radio', { name: 'After review' })).toBeChecked()
    expect(within(card()).getByRole('textbox', { name: 'Anything else?' })).toHaveValue('For the second task.')
  })

  it('keeps a card it never touched, too', async () => {
    const fake = await launch({ t1: DRAFT })

    await select(fake.store, 't2')
    await select(fake.store, 't1')

    expectFirstCardFilled()
    expect(saves(fake)).toEqual([])
  })
})

describe('after a relaunch', () => {
  it('fills the card back in from what main stored', async () => {
    await launch({ t1: DRAFT })

    expectFirstCardFilled()
  })

  it('starts a card empty that main has nothing for', async () => {
    await launch()

    expect(within(card()).getByRole('radio', { name: 'By type' })).not.toBeChecked()
    expect(within(card()).getByRole('textbox', { name: 'Anything else?' })).toHaveValue('')
  })
})

describe('storing the draft', () => {
  it('stores it a pause after the last change, once for a burst of them, with everything in it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const drafts: Record<string, QuestionCardDraft> = {}
    const fake = await launch(drafts)
    fillFirstCard()

    await pause()

    expect(saves(fake)).toEqual([{ taskId: 't1', draft: DRAFT }])
    expect(drafts).toEqual({ t1: DRAFT })
    await pause()
    expect(saves(fake)).toHaveLength(1)
  })

  it('stores it at once when the card goes (another task selected), and not again after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const drafts: Record<string, QuestionCardDraft> = {}
    const fake = await launch(drafts)
    fillFirstCard()
    await select(fake.store, 't2')

    expect(saves(fake)).toEqual([{ taskId: 't1', draft: DRAFT }])
    expect(drafts).toEqual({ t1: DRAFT })
    await pause()
    expect(saves(fake)).toHaveLength(1)
  })

  it('stores it at once as the window unloads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const drafts: Record<string, QuestionCardDraft> = {}
    await launch(drafts)
    fillFirstCard()

    quit()

    expect(drafts).toEqual({ t1: DRAFT })
  })

  it('stores none once the card is emptied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const drafts: Record<string, QuestionCardDraft> = {}
    const fake = await launch(drafts)
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'api' }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'ui' }))
    fireEvent.change(within(card()).getByRole('textbox', { name: 'Anything to call out?' }), {
      target: { value: 'Call out 429s' },
    })
    await pause()
    expect(drafts).toEqual({
      t1: { questionSetId: 'q-t1', draft: { 1: ['api', 'ui'], 2: 'Call out 429s' }, anythingElse: '' },
    })

    fireEvent.click(within(card()).getByRole('checkbox', { name: 'api' }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'ui' }))
    fireEvent.change(within(card()).getByRole('textbox', { name: 'Anything to call out?' }), {
      target: { value: '  ' },
    })
    fireEvent.change(within(card()).getByRole('textbox', { name: 'Anything else?' }), { target: { value: '' } })

    await pause()

    expect(saves(fake).at(-1)).toEqual({ taskId: 't1', draft: null })
    expect(drafts).toEqual({})
  })

  it('carries on when a save fails: the card keeps it, and the next save carries it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let failing = true
    const drafts: Record<string, QuestionCardDraft> = {}
    const fake = await launch(drafts, {
      [CommandName.QuestionsDraftSet]: (change) => {
        if (failing) return refuse(bridgeError(BridgeErrorCode.Internal, 'database is locked'))
        if (change.draft === null) Reflect.deleteProperty(drafts, change.taskId)
        else drafts[change.taskId] = change.draft
        return null
      },
    })
    fillFirstCard()
    await pause()
    expect(drafts).toEqual({})
    expectFirstCardFilled()

    failing = false
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'docs' }))
    await pause()
    expect(saves(fake)).toHaveLength(2)
    expect(drafts).toEqual({ t1: { ...DRAFT, draft: { ...DRAFT.draft, 1: ['api', 'ui', 'docs'] } } })
  })
})

describe('sending the answers', () => {
  it('leaves nothing of the draft behind, and the next card starts empty', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const drafts: Record<string, QuestionCardDraft> = {}
    const fake = await launch(drafts)
    fillFirstCard()
    await pause()
    expect(drafts).toEqual({ t1: DRAFT })

    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Send answers' }))
      await Promise.resolve()
    })
    const closed = screen.getByRole('region', { name: 'Questions from the agent' })
    expect(closed).toHaveTextContent('3 questions · answered')
    expect(fake.store.getState().questionDrafts).toEqual({})
    expect(drafts).toEqual({})

    act(() => {
      fake.emit({ type: EventType.QuestionOpened, questionSet: openSet('t1', [STRATEGY], 'q-next') })
    })
    expect(within(card()).getByRole('radio', { name: 'Merge now' })).not.toBeChecked()
    expect(within(card()).getByRole('textbox', { name: 'Anything else?' })).toHaveValue('')
  })

  it('keeps the draft when sending fails, to send again', async () => {
    await launch(
      {},
      {
        [CommandName.QuestionsAnswer]: () =>
          refuse(bridgeError(BridgeErrorCode.InvalidTransition, 'The questions are not open any more')),
      },
    )
    fillFirstCard()

    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Send answers' }))
      await Promise.resolve()
    })

    expect(await screen.findByText(/Couldn’t send your answers/)).toBeVisible()
    expectFirstCardFilled()
  })
})

describe('a draft that cannot be answered any more', () => {
  it('is dropped when the card it was for is withdrawn while you are away', async () => {
    const fake = await launch({ t1: DRAFT })
    await select(fake.store, 't2')

    act(() => {
      fake.emit({
        type: EventType.QuestionWithdrawn,
        questionSet: { ...openSet('t1', [LAYOUT, TAGS, NOTE]), state: QuestionSetState.Withdrawn, closedAt: 6_000 },
      })
    })

    expect(fake.store.getState().questionDrafts).toEqual({})
  })

  it('is dropped when its task is deleted', async () => {
    const fake = await launch({ t1: DRAFT })
    fillFirstCard()

    await act(async () => {
      await fake.store.getState().deleteTask('t1')
    })

    expect(fake.store.getState().questionDrafts).toEqual({})
  })

  it('is ignored, and dropped, when it is for another question set than the card showing', async () => {
    const fake = await launch({
      t1: { ...DRAFT, questionSetId: 'q-stale', draft: { 0: 'now' }, anythingElse: 'Off the old card.' },
    })

    expect(within(card()).getByRole('radio', { name: 'By type' })).not.toBeChecked()
    expect(within(card()).getByRole('textbox', { name: 'Anything else?' })).toHaveValue('')
    expect(fake.store.getState().questionDrafts).toEqual({})
  })
})
