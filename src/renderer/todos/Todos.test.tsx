import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TodoState } from '../../shared/domain'
import { askAboutTodo, NO_TODOS, NoTodos, STATE_LABELS, StateIcon } from './Todos'

describe('a todo’s icon (#308)', () => {
  const icon = (state: TodoState): HTMLElement => render(<StateIcon state={state} />).container

  it('draws done as a filled check, with the tick cut out of it', () => {
    const svg = icon(TodoState.Done).querySelector('svg')

    expect(svg?.querySelector('circle')).toHaveAttribute('fill', 'currentColor')
    expect(svg?.querySelector('path')?.getAttribute('class')).toMatch(/check/)
  })

  it.each([TodoState.Todo, TodoState.Waiting])('draws %s as a hollow ring, unfilled and unticked', (state) => {
    const svg = icon(state).querySelector('svg')

    expect(svg).toHaveAttribute('stroke', 'currentColor')
    expect(svg?.querySelector('circle')).not.toHaveAttribute('fill')
    expect(svg?.querySelector('path')).toBeNull()
  })

  it('draws doing as a ring with a dot in it', () => {
    const drawn = icon(TodoState.Doing)

    expect(drawn.querySelector('[class*="doingRing"] > [class*="doingDot"]')).not.toBeNull()
    expect(drawn.querySelector('svg')).toBeNull()
  })

  it('has a name for each state, for a screen reader', () => {
    expect(Object.values(TodoState).map((state) => STATE_LABELS[state])).toEqual([
      STATE_LABELS[TodoState.Todo],
      STATE_LABELS[TodoState.Doing],
      STATE_LABELS[TodoState.Done],
      STATE_LABELS[TodoState.Waiting],
    ])
    expect(new Set(Object.values(STATE_LABELS)).size).toBe(4)
    expect(STATE_LABELS[TodoState.Waiting]).toBe('Waiting on you')
  })
})

describe('the tab’s empty state', () => {
  it('says there are no todos yet', () => {
    render(<NoTodos />)

    expect(screen.getByText(NO_TODOS)).toHaveTextContent('No todos yet.')
  })
})

describe('askAboutTodo', () => {
  it('names the todo, for you to finish with your question', () => {
    expect(
      askAboutTodo({ id: '10', text: 'Run the tests', state: TodoState.Todo, note: null, completedAt: null }),
    ).toBe('About the todo “Run the tests”: ')
  })
})
