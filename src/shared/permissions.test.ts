import { describe, expect, it } from 'vitest'
import {
  PermissionDestination,
  PermissionRuleBehavior,
  PermissionUpdateType,
  type PermissionRule,
  type PermissionSuggestion,
} from './domain'
import { permissionRuleString, permissionSubject, permissionSummary, taskPermissionRule } from './permissions'

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

/** Claude Code's suggestion to add rules for a call, for a settings file. */
function addRules(...rules: PermissionRule[]): PermissionSuggestion {
  return {
    type: PermissionUpdateType.AddRules,
    rules,
    behavior: PermissionRuleBehavior.Allow,
    destination: PermissionDestination.LocalSettings,
  }
}

const ACCEPT_EDITS: PermissionSuggestion = {
  type: PermissionUpdateType.SetMode,
  mode: 'acceptEdits',
  destination: PermissionDestination.Session,
}

const DIRECTORY: PermissionSuggestion = {
  type: PermissionUpdateType.AddDirectories,
  directories: ['/code/acme-api/logs'],
  destination: PermissionDestination.Session,
}

function rule(
  toolName: string,
  suggestions: readonly PermissionSuggestion[],
  suppressAlwaysAllowRule = false,
): PermissionRule | null {
  return taskPermissionRule({ toolName, suggestions, suppressAlwaysAllowRule })
}

describe('taskPermissionRule', () => {
  it('grants the rule Claude Code suggests, whichever settings file it suggests, ignoring its other suggestions', () => {
    const bash = { toolName: 'Bash', ruleContent: 'npm test *' }
    expect(rule('Bash', [addRules(bash), DIRECTORY, ACCEPT_EDITS])).toEqual(bash)
    expect(rule('Bash', [{ ...addRules(bash), destination: PermissionDestination.UserSettings }])).toEqual(bash)
    // An exact command, and content kept as it is, spaces and all.
    expect(rule('Bash', [addRules({ toolName: 'Bash', ruleContent: "touch 'a(1).txt'" })])).toEqual({
      toolName: 'Bash',
      ruleContent: "touch 'a(1).txt'",
    })
    expect(rule('WebFetch', [addRules({ toolName: 'WebFetch', ruleContent: 'domain:example.test' })])).toEqual({
      toolName: 'WebFetch',
      ruleContent: 'domain:example.test',
    })
  })

  it('grants the whole tool when no rule is suggested, or one without content, except for Bash', () => {
    expect(rule('Edit', [ACCEPT_EDITS])).toEqual({ toolName: 'Edit' })
    expect(rule('Write', [])).toEqual({ toolName: 'Write' })
    expect(rule('mcp__deploy__release', [])).toEqual({ toolName: 'mcp__deploy__release' })
    expect(rule('Edit', [addRules({ toolName: 'Edit' })])).toEqual({ toolName: 'Edit' })
    expect(rule('Edit', [addRules({ toolName: 'Edit', ruleContent: '  ' })])).toEqual({ toolName: 'Edit' })
    expect(rule('Bash', [])).toBeNull()
    expect(rule('Bash', [ACCEPT_EDITS, DIRECTORY])).toBeNull()
    expect(rule('Bash', [addRules({ toolName: 'Bash' })])).toBeNull()
    expect(rule('Bash', [addRules({ toolName: 'Bash', ruleContent: '' })])).toBeNull()
    for (const ruleContent of ['*', ' *', ':*', ' : * ']) {
      expect(rule('Bash', [addRules({ toolName: 'Bash', ruleContent })]), ruleContent).toBeNull()
    }
    // Only Bash: another tool's wildcard is its own business.
    expect(rule('WebFetch', [addRules({ toolName: 'WebFetch', ruleContent: '*' })])).toEqual({
      toolName: 'WebFetch',
      ruleContent: '*',
    })
  })

  it("isn't offered when the SDK says not to remember, or suggests anything but one rule for the tool", () => {
    expect(rule('Edit', [], true)).toBeNull()
    expect(rule('Bash', [addRules({ toolName: 'Bash', ruleContent: 'npm test *' })], true)).toBeNull()
    // A compound command: a rule for each command it runs.
    const mkdir = { toolName: 'Bash', ruleContent: 'mkdir -p logs' }
    const touch = { toolName: 'Bash', ruleContent: 'touch evil.txt' }
    expect(rule('Bash', [addRules(mkdir, touch)])).toBeNull()
    expect(rule('Bash', [addRules(mkdir), addRules(touch)])).toBeNull()
    // Another tool's rule, and rules that deny or ask, grant nothing.
    expect(rule('Edit', [addRules({ toolName: 'Write' })])).toBeNull()
    expect(rule('Edit', [addRules({ toolName: 'Edit' }, { toolName: 'Edit', ruleContent: 'src/**' })])).toBeNull()
    const denying = { ...addRules(mkdir), behavior: PermissionRuleBehavior.Deny } as PermissionSuggestion
    expect(rule('Bash', [denying])).toBeNull()
    expect(
      rule('Edit', [
        {
          ...addRules({ toolName: 'Edit', ruleContent: 'x' }),
          type: PermissionUpdateType.RemoveRules,
        } as PermissionSuggestion,
      ]),
    ).toEqual({ toolName: 'Edit' })
  })
})

describe('permissionRuleString', () => {
  it.each([
    [{ toolName: 'Edit' }, 'Edit'],
    [{ toolName: 'Edit', ruleContent: '' }, 'Edit'],
    [{ toolName: 'Bash', ruleContent: 'npm test *' }, 'Bash(npm test *)'],
    [{ toolName: 'Bash', ruleContent: 'npm test:*' }, 'Bash(npm test:*)'],
    [{ toolName: 'Bash', ruleContent: "touch 'a(1).txt'" }, "Bash(touch 'a\\(1\\).txt')"],
    [{ toolName: 'Bash', ruleContent: 'echo a\\b' }, 'Bash(echo a\\\\b)'],
    [{ toolName: 'mcp__glade' }, 'mcp__glade'],
  ])('%j → %s', (value, expected) => {
    expect(permissionRuleString(value)).toBe(expected)
  })
})
