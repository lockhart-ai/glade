import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  UiStateKey,
  type Question,
  type QuestionSet,
} from '../../shared/domain'
import { Chat } from '../chat/Chat'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleMessage, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'

const LAYOUT: Question = {
  kind: QuestionKind.Choice,
  prompt: 'How should the notes be laid out?',
  options: [
    {
      id: 'by-type',
      label: 'By type',
      detail: 'Features, fixes, internal.',
      sketch: '# Features\n- Rate limits\n\n# Fixes',
    },
    { id: 'by-area', label: 'By area' },
  ],
}
const DJANGO: Question = {
  kind: QuestionKind.Pills,
  prompt: 'Where does the Django 5.2 upgrade go?',
  options: ['Features', 'Internal changes', 'Leave it out'],
}
const NOTE: Question = {
  kind: QuestionKind.Text,
  prompt: 'Anything to call out?',
  placeholder: 'e.g. the 429s',
  optional: true,
}
const AREAS: Question = {
  kind: QuestionKind.Choice,
  prompt: 'Which areas changed?',
  options: [
    { id: 'api', label: 'API' },
    { id: 'admin', label: 'Admin' },
  ],
  multiple: true,
}
const TAGS: Question = { kind: QuestionKind.Pills, prompt: 'Tags?', options: ['api', 'ui', 'docs'], multiple: true }
const REASON: Question = { kind: QuestionKind.Text, prompt: 'Why?' }

function questionSet(questions: readonly Question[], patch: Partial<QuestionSet> = {}): QuestionSet {
  return {
    id: 'q1',
    taskId: 't1',
    turn: 1,
    questions,
    state: QuestionSetState.Open,
    reply: null,
    createdAt: 5_000,
    closedAt: null,
    ...patch,
  }
}

async function renderCard(sets: QuestionSet[], overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [{ ...sampleTask('t1', 'w1'), activity: TaskActivity.Waiting, asking: true }],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      messages: [sampleMessage('m1', 't1', 'Draft the release notes.')],
      toolEvents: [],
      questionSets: sets,
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
  return fake
}

function card(): HTMLElement {
  return screen.getByRole('form', { name: 'Questions from the agent' })
}

function sendButton(): HTMLElement {
  return within(card()).getByRole('button', { name: 'Send answers' })
}

function focused(): Element | null {
  return document.activeElement
}

/** The element, which the test expects to be there. */
function present<T extends Element>(element: T | null | undefined): T {
  if (element === null || element === undefined) throw new Error('Expected an element')
  return element
}

describe('QuestionCard', () => {
  it('shows each question with its option cards, pills and text field, numbered, under its title', async () => {
    await renderCard([questionSet([LAYOUT, DJANGO, NOTE])])

    expect(card()).toHaveTextContent('3 questions before I finish')
    const layout = within(card()).getByRole('radiogroup', { name: 'How should the notes be laid out?' })
    const byType = within(layout).getByRole('radio', { name: 'By type' })
    expect(byType).toHaveAccessibleDescription('Features, fixes, internal.')
    expect(byType).toHaveAttribute('aria-checked', 'false')
    expect(byType).toHaveTextContent(/^Features- Rate limits\s+FixesBy type/)
    expect(within(layout).getByRole('radio', { name: 'By area' })).not.toHaveAccessibleDescription()
    const django = within(card()).getByRole('radiogroup', { name: 'Where does the Django 5.2 upgrade go?' })
    expect(
      within(django)
        .getAllByRole('radio')
        .map((pill) => pill.textContent),
    ).toEqual(['Features', 'Internal changes', 'Leave it out'])
    const note = within(card()).getByRole('textbox', { name: 'Anything to call out?' })
    expect(note).toHaveAttribute('placeholder', 'e.g. the 429s')
    expect(card()).toHaveTextContent('optional')
    expect(card()).toHaveTextContent('0 of 3 answered')
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('picks one option of a question that takes one, and counts it answered', async () => {
    await renderCard([questionSet([LAYOUT, DJANGO])])
    const radios = within(card()).getAllByRole('radio')

    fireEvent.click(present(radios[0]))
    fireEvent.click(present(radios[1]))
    fireEvent.click(present(radios[3]))

    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'true',
      'false',
    ])
    expect(card()).toHaveTextContent('2 of 2 answered')
    expect(sendButton()).toHaveAttribute('aria-disabled', 'false')
  })

  it('toggles checkboxes for a question that takes more than one', async () => {
    await renderCard([questionSet([AREAS, TAGS])])
    const areas = within(card()).getByRole('group', { name: 'Which areas changed?' })
    const tags = within(card()).getByRole('group', { name: 'Tags?' })

    fireEvent.click(within(areas).getByRole('checkbox', { name: 'API' }))
    fireEvent.click(within(areas).getByRole('checkbox', { name: 'Admin' }))
    fireEvent.click(within(tags).getByRole('checkbox', { name: 'ui' }))
    fireEvent.click(within(tags).getByRole('checkbox', { name: 'ui' }))

    expect(within(areas).getByRole('checkbox', { name: 'API' })).toBeChecked()
    expect(within(areas).getByRole('checkbox', { name: 'Admin' })).toBeChecked()
    expect(within(tags).getByRole('checkbox', { name: 'ui' })).not.toBeChecked()
    expect(card()).toHaveTextContent('1 of 2 answered')
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('sends the answers, and then shows them on the closed card', async () => {
    const { invoke } = await renderCard([questionSet([LAYOUT, AREAS, DJANGO, NOTE])])
    fireEvent.click(within(card()).getByRole('radio', { name: 'By area' }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'Admin' }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'API' }))
    fireEvent.click(within(card()).getByRole('radio', { name: 'Leave it out' }))
    expect(card()).toHaveTextContent('3 of 4 answered')

    await act(async () => {
      fireEvent.click(sendButton())
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith(CommandName.QuestionsAnswer, {
      id: 'q1',
      answers: { 0: 'by-area', 1: ['api', 'admin'], 2: 'Leave it out' },
    })
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    const closed = screen.getByRole('region', { name: 'Questions from the agent' })
    expect(closed).toHaveTextContent('4 questions · answered')
    expect(
      within(closed)
        .getAllByRole('definition')
        .map((answer) => answer.textContent),
    ).toEqual(['By area', 'API, Admin', 'Leave it out', 'No answer'])
    expect(
      within(closed)
        .getAllByRole('term')
        .map((prompt) => prompt.textContent),
    ).toEqual([
      '1How should the notes be laid out?',
      '2Which areas changed?',
      '3Where does the Django 5.2 upgrade go?',
      '4Anything to call out?',
    ])
  })

  it('sends nothing while the answers are incomplete', async () => {
    const { invoke } = await renderCard([questionSet([LAYOUT, REASON])])
    fireEvent.click(within(card()).getByRole('radio', { name: 'By type' }))
    const reason = within(card()).getByRole('textbox', { name: 'Why?' })
    fireEvent.change(reason, { target: { value: '   ' } })

    fireEvent.click(sendButton())
    fireEvent.keyDown(reason, { key: 'Enter' })

    expect(invoke).not.toHaveBeenCalledWith(CommandName.QuestionsAnswer, expect.anything())
    expect(card()).toHaveTextContent('1 of 2 answered')
  })

  it('says so in a toast when the answers could not be sent, and lets you send again', async () => {
    await renderCard([questionSet([DJANGO])], {
      [CommandName.QuestionsAnswer]: () =>
        refuse(bridgeError(BridgeErrorCode.InvalidTransition, 'The questions are not open any more')),
    })
    fireEvent.click(within(card()).getByRole('radio', { name: 'Features' }))

    await act(async () => {
      fireEvent.click(sendButton())
      await Promise.resolve()
    })

    expect(await screen.findByText(/Couldn’t send your answers: The questions are not open any more/)).toBeVisible()
    expect(sendButton()).toHaveAttribute('aria-disabled', 'false')
  })

  it('answers by keyboard alone: digits pick, arrows move, Enter sends', async () => {
    const { invoke } = await renderCard([questionSet([LAYOUT, TAGS, NOTE])])
    const byType = within(card()).getByRole('radio', { name: 'By type' })
    const byArea = within(card()).getByRole('radio', { name: 'By area' })
    const [api, ui, docs] = within(card()).getAllByRole('checkbox')
    const note = within(card()).getByRole('textbox', { name: 'Anything to call out?' })

    // One tab stop per question: the first option until one is picked.
    expect(byType).toHaveAttribute('tabindex', '0')
    expect(byArea).toHaveAttribute('tabindex', '-1')
    byType.focus()

    // 2 picks the second option; ← → move between options, picking in a radio group, and wrap around.
    fireEvent.keyDown(byType, { key: '2' })
    expect(byArea).toHaveAttribute('aria-checked', 'true')
    expect(focused()).toBe(byArea)
    expect(byArea).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(byArea, { key: 'ArrowRight' })
    expect(byType).toHaveAttribute('aria-checked', 'true')
    expect(focused()).toBe(byType)
    fireEvent.keyDown(byType, { key: 'ArrowLeft' })
    expect(byArea).toHaveAttribute('aria-checked', 'true')
    // A digit past the options, or with a modifier, does nothing.
    fireEvent.keyDown(byArea, { key: '9' })
    fireEvent.keyDown(byArea, { key: '1', metaKey: true })
    expect(byArea).toHaveAttribute('aria-checked', 'true')
    // Other keys are left alone.
    fireEvent.keyDown(byArea, { key: 'a' })

    // ↓ to the next question; its digits toggle, and its arrows move without picking.
    fireEvent.keyDown(byArea, { key: 'ArrowDown' })
    expect(focused()).toBe(api)
    fireEvent.keyDown(present(api), { key: '3' })
    expect(docs).toBeChecked()
    expect(focused()).toBe(docs)
    fireEvent.keyDown(present(docs), { key: 'ArrowLeft' })
    expect(focused()).toBe(ui)
    expect(ui).not.toBeChecked()
    expect(ui).toHaveAttribute('tabindex', '0')
    fireEvent.focus(present(ui))
    expect(ui).toHaveAttribute('tabindex', '0')

    // ↑ back, and ↑ again stays on the first question.
    fireEvent.keyDown(present(ui), { key: 'ArrowUp' })
    expect(focused()).toBe(byArea)
    fireEvent.keyDown(byArea, { key: 'ArrowUp' })
    expect(focused()).toBe(byArea)

    // ↓ ↓ to the text field, where digits are typed and ↓ goes on to Send, and ↑ from Send comes back.
    fireEvent.keyDown(byArea, { key: 'ArrowDown' })
    fireEvent.keyDown(present(focused()), { key: 'ArrowDown' })
    expect(focused()).toBe(note)
    fireEvent.change(note, { target: { value: 'Call out 429s' } })
    fireEvent.keyDown(note, { key: 'a' })
    fireEvent.keyDown(note, { key: 'ArrowDown' })
    expect(focused()).toBe(sendButton())
    fireEvent.keyDown(sendButton(), { key: 'a' })
    fireEvent.keyDown(sendButton(), { key: 'ArrowUp' })
    expect(focused()).toBe(note)
    // Back to the option you were last on.
    fireEvent.keyDown(note, { key: 'ArrowUp' })
    expect(focused()).toBe(ui)

    // ↵ on an option sends, now the answers are complete.
    await act(async () => {
      fireEvent.keyDown(present(ui), { key: 'Enter' })
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.QuestionsAnswer, {
      id: 'q1',
      answers: { 0: 'by-area', 1: ['docs'], 2: 'Call out 429s' },
    })
  })

  it('sends with Enter in a text field once complete', async () => {
    const { invoke } = await renderCard([questionSet([REASON])])
    const reason = within(card()).getByRole('textbox', { name: 'Why?' })
    fireEvent.change(reason, { target: { value: 'Because.' } })

    await act(async () => {
      fireEvent.keyDown(reason, { key: 'Enter' })
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith(CommandName.QuestionsAnswer, { id: 'q1', answers: { 0: 'Because.' } })
  })

  it('shows a set answered in your words as such, with your message after it', async () => {
    const answered = questionSet([LAYOUT, DJANGO], {
      state: QuestionSetState.Answered,
      reply: { kind: QuestionReplyKind.FreeText, text: 'By type.' },
      closedAt: 6_000,
    })
    await renderCard([answered])

    const closed = screen.getByRole('region', { name: 'Questions from the agent' })
    expect(closed).toHaveTextContent('2 questions · answered in your words')
    expect(closed).toHaveTextContent('How should the notes be laid out?')
    expect(within(closed).queryAllByRole('definition')).toHaveLength(0)
    expect(within(closed).queryByRole('radio')).not.toBeInTheDocument()
  })

  it('shows a withdrawn set, muted, with no way to answer it', async () => {
    const fake = await renderCard([questionSet([LAYOUT])])

    act(() => {
      fake.emit({
        type: EventType.QuestionWithdrawn,
        questionSet: questionSet([LAYOUT], { state: QuestionSetState.Withdrawn, closedAt: 6_000 }),
      })
    })

    const closed = screen.getByRole('region', { name: 'Questions from the agent' })
    expect(closed).toHaveTextContent('1 question · withdrawn')
    expect(within(closed).queryByRole('button')).not.toBeInTheDocument()
  })
})
