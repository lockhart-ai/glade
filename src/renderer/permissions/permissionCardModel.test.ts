import { describe, expect, it } from 'vitest'
import { PermissionRequestState, ToolCallState, ToolEventKind, type ToolCallEvent } from '../../shared/domain'
import { samplePermissionRequest } from '../store/test-bridge'
import {
  callSummary,
  closedOutcome,
  InputLineKind,
  permissionBody,
  PermissionBodyKind,
  permissionTitle,
  showAllLabel,
  shownLines,
  subagentLabel,
  subagentOrigin,
  TRIMMED_CHARS,
  TRIMMED_LINES,
  type InputLine,
} from './permissionCardModel'

const ROOT = '/Users/sample/code/api'

const plain = (text: string): InputLine => ({ kind: InputLineKind.Plain, text })
const removed = (text: string): InputLine => ({ kind: InputLineKind.Removed, text })
const added = (text: string): InputLine => ({ kind: InputLineKind.Added, text })

function call(toolUseId: string, name: string, parentToolUseId: string | null, input = {}): ToolCallEvent {
  return {
    kind: ToolEventKind.ToolCall,
    id: `e-${toolUseId}`,
    taskId: 't1',
    turn: 1,
    toolUseId,
    parentToolUseId,
    name,
    input,
    state: ToolCallState.Running,
    output: null,
    createdAt: 1_000,
    finishedAt: null,
  }
}

describe('permissionBody', () => {
  it("shows a Bash call's command, and its own description over Claude Code's", () => {
    const body = permissionBody({
      toolName: 'Bash',
      input: { command: 'npm run build\nnpm test', description: 'Build, then test' },
      description: 'Claude Code says',
    })
    expect(body).toEqual({
      kind: PermissionBodyKind.Command,
      lines: [plain('npm run build'), plain('npm test')],
      description: 'Build, then test',
    })
  })

  it("falls back to Claude Code's description, and to none when both are blank", () => {
    const input = { command: 'ls', description: '  ' }
    expect(permissionBody({ toolName: 'Bash', input, description: 'List files' })).toMatchObject({
      description: 'List files',
    })
    expect(permissionBody({ toolName: 'Bash', input, description: ' ' })).toMatchObject({ description: null })
    expect(permissionBody({ toolName: 'Bash', input: { command: 'ls' }, description: null })).toMatchObject({
      description: null,
    })
  })

  it("shows an Edit's file relative to the workspace, and its change between the lines it leaves alike", () => {
    const body = permissionBody(
      {
        toolName: 'Edit',
        input: {
          file_path: `${ROOT}/docs/upgrade.md`,
          old_string: '## Upgrading\n\nNo changes.\n\nThanks!',
          new_string: '## Upgrading\n\nSearch is rate limited.\nBack off on 429.\n\nThanks!',
        },
        description: 'upgrade.md',
      },
      ROOT,
    )
    expect(body).toEqual({
      kind: PermissionBodyKind.FileChange,
      path: 'docs/upgrade.md',
      lines: [
        plain('## Upgrading'),
        plain(''),
        removed('No changes.'),
        added('Search is rate limited.'),
        added('Back off on 429.'),
        plain(''),
        plain('Thanks!'),
      ],
    })
  })

  it('shows an edit that only adds, or only removes, and one outside the workspace by its full path', () => {
    const adding = permissionBody({
      toolName: 'Edit',
      input: { file_path: '/etc/hosts', old_string: '', new_string: '127.0.0.1 api.local' },
      description: null,
    })
    expect(adding).toEqual({
      kind: PermissionBodyKind.FileChange,
      path: '/etc/hosts',
      lines: [added('127.0.0.1 api.local')],
    })

    const removing = permissionBody(
      {
        toolName: 'Edit',
        input: { file_path: `${ROOT}/a.ts`, old_string: 'debugger', new_string: '' },
        description: null,
      },
      ROOT,
    )
    expect(removing).toMatchObject({ path: 'a.ts', lines: [removed('debugger')] })

    // Lines alike at both ends of a change that adds lines in the middle don't overlap.
    const same = permissionBody({
      toolName: 'Edit',
      input: { file_path: '/a', old_string: 'a\na', new_string: 'a\nb\na' },
      description: null,
    })
    expect(same).toMatchObject({ lines: [plain('a'), added('b'), plain('a')] })
  })

  it("shows a MultiEdit's edits one after another, a gap between them", () => {
    const body = permissionBody(
      {
        toolName: 'MultiEdit',
        input: {
          file_path: `${ROOT}/src/date.ts`,
          edits: [
            { old_string: 'let a', new_string: 'const a' },
            { old_string: 'var b', new_string: 'const b' },
          ],
        },
        description: null,
      },
      ROOT,
    )
    expect(body).toEqual({
      kind: PermissionBodyKind.FileChange,
      path: 'src/date.ts',
      lines: [
        removed('let a'),
        added('const a'),
        { kind: InputLineKind.Gap, text: '⋯' },
        removed('var b'),
        added('const b'),
      ],
    })
  })

  it("shows a Write's file and new content", () => {
    const body = permissionBody(
      { toolName: 'Write', input: { file_path: `${ROOT}/notes.md`, content: '# Notes\n\nDone.' }, description: null },
      `${ROOT}/`,
    )
    expect(body).toEqual({
      kind: PermissionBodyKind.FileContent,
      path: 'notes.md',
      lines: [plain('# Notes'), plain(''), plain('Done.')],
    })
  })

  it('shows any other tool, or input that does not fit its tool, as formatted JSON', () => {
    const json = (input: Record<string, unknown>, toolName: string) =>
      permissionBody({ toolName, input, description: null })
    expect(json({ url: 'https://example.com', depth: 2 }, 'mcp__browser__open')).toEqual({
      kind: PermissionBodyKind.Json,
      lines: [plain('{'), plain('  "url": "https://example.com",'), plain('  "depth": 2'), plain('}')],
    })
    expect(json({ cmd: 'ls' }, 'Bash').kind).toBe(PermissionBodyKind.Json)
    expect(json({ file_path: 'a', old_string: 'x' }, 'Edit').kind).toBe(PermissionBodyKind.Json)
    expect(json({ old_string: 'x', new_string: 'y' }, 'Edit').kind).toBe(PermissionBodyKind.Json)
    expect(json({ file_path: 'a', edits: 'x' }, 'MultiEdit').kind).toBe(PermissionBodyKind.Json)
    expect(json({ file_path: 'a', edits: ['x'] }, 'MultiEdit').kind).toBe(PermissionBodyKind.Json)
    expect(json({ file_path: 'a', edits: [{ old_string: 'x' }] }, 'MultiEdit').kind).toBe(PermissionBodyKind.Json)
    expect(json({ file_path: 'a' }, 'Write').kind).toBe(PermissionBodyKind.Json)
    expect(json({}, 'NotebookEdit')).toEqual({ kind: PermissionBodyKind.Json, lines: [plain('{}')] })
  })
})

describe('shownLines', () => {
  const many = Array.from({ length: 40 }, (_, index) => plain(`line ${String(index + 1)}`))

  it('shows short input whole, with nothing to show more of', () => {
    expect(shownLines(many.slice(0, TRIMMED_LINES), false)).toEqual({
      lines: many.slice(0, TRIMMED_LINES),
      trimmed: false,
    })
  })

  it('trims long input to its first lines, and shows all of it when asked', () => {
    expect(shownLines(many, false)).toEqual({ lines: many.slice(0, TRIMMED_LINES), trimmed: true })
    expect(shownLines(many, true)).toEqual({ lines: many, trimmed: false })
  })

  it('cuts a very long line short, however few lines there are', () => {
    const long = plain('x'.repeat(TRIMMED_CHARS * 20))
    const shown = shownLines([plain('npm test'), long, plain('after')], false)
    expect(shown.trimmed).toBe(true)
    expect(shown.lines).toHaveLength(2)
    expect(shown.lines[1]?.text).toHaveLength(TRIMMED_CHARS - 'npm test'.length + 1)
    expect(shown.lines[1]?.text.endsWith('…')).toBe(true)
  })

  it('cuts a line that starts once the room has run out to nothing but the ellipsis', () => {
    const full = plain('x'.repeat(TRIMMED_CHARS))
    expect(shownLines([full, plain('more')], false).lines).toEqual([full, plain('…')])
  })
})

describe('what the card says', () => {
  it('titles it with Claude Code’s sentence when there is one, else the tool', () => {
    expect(permissionTitle({ title: 'Claude wants to edit a.txt', toolName: 'Edit' })).toBe(
      'Claude wants to edit a.txt',
    )
    expect(permissionTitle({ title: null, toolName: 'Bash' })).toBe('Bash')
    expect(permissionTitle({ title: '  ', toolName: 'mcp__glade__ask' })).toBe('ask')
  })

  it('says how many lines Show all shows', () => {
    expect(showAllLabel([plain('a')])).toBe('Show all 1 line')
    expect(showAllLabel([plain('a'), plain('b')])).toBe('Show all 2 lines')
  })

  it('puts the call in a line: the command, the file, or just the tool', () => {
    const request = samplePermissionRequest('p1', 't1')
    expect(callSummary({ ...request, input: { command: 'npm run build\nnpm test' } })).toBe(
      'Bash: npm run build npm test',
    )
    expect(callSummary({ toolName: 'Write', input: { file_path: `${ROOT}/a.md`, content: '' } }, ROOT)).toBe(
      'Write: a.md',
    )
    expect(
      callSummary({ toolName: 'Edit', input: { file_path: `${ROOT}/a.md`, old_string: 'a', new_string: 'b' } }, ROOT),
    ).toBe('Edit: a.md')
    expect(callSummary({ toolName: 'mcp__browser__open', input: { url: 'x' } })).toBe('mcp__browser__open')
  })

  it('says what happened to a closed request, with the note it was denied with', () => {
    const request = samplePermissionRequest('p1', 't1')
    expect(closedOutcome(request)).toBeNull()
    expect(closedOutcome({ state: PermissionRequestState.Allowed, denyNote: null })).toBe('allowed once')
    expect(closedOutcome({ state: PermissionRequestState.Denied, denyNote: null })).toBe('denied')
    expect(closedOutcome({ state: PermissionRequestState.Denied, denyNote: '  ' })).toBe('denied')
    expect(closedOutcome({ state: PermissionRequestState.Denied, denyNote: ' Not on main ' })).toBe(
      'denied: “Not on main”',
    )
    expect(closedOutcome({ state: PermissionRequestState.Withdrawn, denyNote: null })).toBe('withdrawn')
  })
})

describe('subagentOrigin', () => {
  const events = [
    call('guide', 'Agent', null, { description: 'Upgrade guide', subagent_type: 'general-purpose' }),
    call('guide-write', 'Write', 'guide'),
    call('orphan', 'Write', 'gone'),
  ]

  it("is none for the agent's own call", () => {
    expect(subagentOrigin({ agentId: null, toolUseId: 'guide-write' }, events)).toBeNull()
  })

  it('names the subagent from the Agent call that started it', () => {
    const origin = subagentOrigin({ agentId: 'a1', toolUseId: 'guide-write' }, events)
    expect(origin).toEqual({ name: 'Upgrade guide' })
    expect(subagentLabel(origin ?? { name: null })).toBe('subagent · Upgrade guide')
  })

  it("doesn't know which subagent before its call or its Agent call reach the tool log", () => {
    expect(subagentOrigin({ agentId: 'a1', toolUseId: 'not-yet' }, events)).toEqual({ name: null })
    expect(subagentOrigin({ agentId: 'a1', toolUseId: 'orphan' }, events)).toEqual({ name: null })
    expect(subagentOrigin({ agentId: 'a1', toolUseId: 'guide' }, events)).toEqual({ name: null })
    expect(subagentLabel({ name: null })).toBe('subagent')
  })
})
