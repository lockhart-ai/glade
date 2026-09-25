import { describe, expect, it } from 'vitest'
import { permissionSubject, permissionSummary } from './permissions'

describe('permissionSummary', () => {
  it.each([
    ['Bash', { command: 'npm test', description: 'Run the tests' }, 'Bash: npm test'],
    ['Edit', { file_path: 'src/date.ts', old_string: 'a', new_string: 'b' }, 'Edit: src/date.ts'],
    ['MultiEdit', { file_path: 'src/date.ts', edits: [] }, 'MultiEdit: src/date.ts'],
    ['Write', { file_path: 'CHANGELOG.md', content: '…' }, 'Write: CHANGELOG.md'],
    ['Read', { file_path: '/etc/hosts' }, 'Read: /etc/hosts'],
    ['NotebookEdit', { notebook_path: 'analysis.ipynb', new_source: 'x = 1' }, 'NotebookEdit: analysis.ipynb'],
    ['Bash', { command: '  git status  ' }, 'Bash: git status'],
    // Nothing to say beyond the tool: no known field, a blank one, or one that isn't text.
    ['Bash', { command: '   ' }, 'Bash'],
    ['Edit', { file_path: 42 }, 'Edit'],
    ['Monitor', { command: 'tail -f log' }, 'Monitor'],
    ['mcp__github__create_issue', { title: 'Flaky test' }, 'mcp__github__create_issue'],
    // Glade's own tools read as the tool's own name, as the tool log shows them.
    ['mcp__glade__show_file', { path: 'a.txt' }, 'show_file'],
  ])('%s %j → %s', (toolName, input, expected) => {
    expect(permissionSummary(toolName, input)).toBe(expected)
  })

  it('says what a call acts on, or null', () => {
    expect(permissionSubject('Write', { file_path: 'a.txt' })).toBe('a.txt')
    expect(permissionSubject('Grep', { pattern: 'x' })).toBeNull()
  })
})
