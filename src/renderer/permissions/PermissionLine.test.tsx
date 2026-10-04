import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { moduleClass } from '../components/moduleClass'
import { PERMISSION_LINE_LABEL, PERMISSION_LINE_STATE, PermissionLineView } from './PermissionLine'
import { PermissionLineScope, PermissionLineState, type PermissionLine } from './permissionLineModel'
import styles from './PermissionLine.module.css'

const cls = (name: string): string => moduleClass(styles, name)

function renderLine(line: PermissionLine, className?: string): HTMLElement {
  const { container } = render(<PermissionLineView line={line} className={className} />)
  const element = container.querySelector<HTMLElement>(`[${PERMISSION_LINE_STATE}]`)
  if (element === null) throw new Error('No permission line')
  return element
}

/** The status: the part in the state's colour. */
function status(line: HTMLElement): HTMLElement {
  const element = line.querySelector<HTMLElement>(`.${cls('status')}`)
  if (element === null) throw new Error('No status')
  return element
}

describe('the permission line', () => {
  it('starts with the shield, named for a screen reader, then the status alone when there is nothing to name', () => {
    const line = renderLine({ state: PermissionLineState.Allowed, scope: PermissionLineScope.Once, subject: null })

    expect(screen.getByRole('img', { name: PERMISSION_LINE_LABEL })).toBeInTheDocument()
    expect(line.querySelector('svg')).not.toBeNull()
    expect(line).toHaveTextContent(/^Allowed once$/)
    expect(status(line)).toHaveTextContent(/^Allowed once$/)
    expect(line).toHaveAttribute(PERMISSION_LINE_STATE, 'allowed')
  })

  it('puts a colon after the status, then what it was about outside the coloured part', () => {
    const line = renderLine({
      state: PermissionLineState.Allowed,
      scope: PermissionLineScope.Task,
      subject: 'npm run lint commands',
    })

    expect(line).toHaveTextContent(/^Allowed for this task: npm run lint commands$/)
    expect(status(line)).toHaveTextContent(/^Allowed for this task:$/)
  })

  it("shows a denial's note in quotes after the status, and after the subject when there is one", () => {
    const noted = renderLine({ state: PermissionLineState.Denied, subject: null, note: 'Keep dist.' })
    expect(noted).toHaveTextContent(/^Denied: “Keep dist.”$/)
    expect(status(noted)).toHaveTextContent(/^Denied:$/)

    const both = renderLine({ state: PermissionLineState.Denied, subject: 'reach registry.npmjs.org', note: 'No.' })
    expect(both).toHaveTextContent(/^Denied: reach registry.npmjs.org · “No.”$/)
  })

  it("takes its state's class, which colours the shield and the status", () => {
    const lines: readonly PermissionLine[] = [
      { state: PermissionLineState.Waiting, subject: null },
      { state: PermissionLineState.Allowed, scope: PermissionLineScope.WorkspaceGrant, subject: 'read ~/code/shared' },
      { state: PermissionLineState.Denied, subject: null, note: null },
      { state: PermissionLineState.Blocked, subject: 'write to ~/.cache/uv' },
      { state: PermissionLineState.Withdrawn, subject: 'write to ~/.cache/uv' },
    ]

    for (const line of lines) {
      const element = renderLine(line)
      expect(element).toHaveClass(cls('line'), cls(line.state))
      expect(element).toHaveAttribute(PERMISSION_LINE_STATE, line.state)
    }
    expect(screen.getByText('Blocked by the sandbox:')).toBeInTheDocument()
    expect(screen.getByText('Allowed by workspace grant:')).toBeInTheDocument()
    expect(screen.getByText('Waiting on you')).toBeInTheDocument()
    expect(screen.getByText('Withdrawn:')).toBeInTheDocument()
  })

  it("takes its row's class too, for where it sits", () => {
    const line = renderLine({ state: PermissionLineState.Waiting, subject: null }, 'in-a-row')

    expect(line).toHaveClass('in-a-row', cls('line'), cls('waiting'))
  })
})
