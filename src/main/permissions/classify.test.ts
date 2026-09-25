import { describe, expect, it } from 'vitest'
import { GLADE_SERVER, GladeTool } from '../agent/glade-tools'
import { TodoTool } from '../todos/todos'
import {
  permissionVerdict,
  PermissionVerdict,
  READ_ONLY_TOOLS,
  SIDE_EFFECT_TOOLS,
  SUBAGENT_TOOLS,
  TODO_TOOLS,
  type ClassifiedCall,
} from './classify'

/** Glade's own servers, as the runner passes them: the session's in-process MCP servers. */
const GLADE = [GLADE_SERVER]

/** A call to a built-in tool, not forced by a user rule. */
function builtIn(toolName: string): ClassifiedCall {
  return { toolName, mcpServer: null, matchedAskRule: false }
}

function verdict(call: ClassifiedCall): PermissionVerdict {
  return permissionVerdict(call, GLADE)
}

describe('permissionVerdict', () => {
  // Every tool in the decision (docs/decisions.md, "Per-call permission review"), one row each.
  it.each([
    ['Read', PermissionVerdict.Allow],
    ['Glob', PermissionVerdict.Allow],
    ['Grep', PermissionVerdict.Allow],
    ['LS', PermissionVerdict.Allow],
    ['NotebookRead', PermissionVerdict.Allow],
    ['WebFetch', PermissionVerdict.Allow],
    ['WebSearch', PermissionVerdict.Allow],
    ['TodoWrite', PermissionVerdict.Allow],
    ['TaskCreate', PermissionVerdict.Allow],
    ['TaskUpdate', PermissionVerdict.Allow],
    ['TaskGet', PermissionVerdict.Allow],
    ['TaskList', PermissionVerdict.Allow],
    ['Agent', PermissionVerdict.Allow],
    ['Task', PermissionVerdict.Allow],
    ['TaskOutput', PermissionVerdict.Allow],
    ['TaskStop', PermissionVerdict.Allow],
    ['Bash', PermissionVerdict.Ask],
    ['Edit', PermissionVerdict.Ask],
    ['Write', PermissionVerdict.Ask],
    ['MultiEdit', PermissionVerdict.Ask],
    ['NotebookEdit', PermissionVerdict.Ask],
    // Tools Glade doesn't know to be read-only ask, however harmless they sound.
    ['BashOutput', PermissionVerdict.Ask],
    ['KillShell', PermissionVerdict.Ask],
    ['ExitPlanMode', PermissionVerdict.Ask],
    ['EnterWorktree', PermissionVerdict.Ask],
    ['CronCreate', PermissionVerdict.Ask],
    ['Monitor', PermissionVerdict.Ask],
    ['SomeToolFromTheFuture', PermissionVerdict.Ask],
    ['', PermissionVerdict.Ask],
    // Names are exact: a tool named like a read in another case isn't one.
    ['read', PermissionVerdict.Ask],
    ['Read ', PermissionVerdict.Ask],
  ])('%s → %s', (toolName, expected) => {
    expect(verdict(builtIn(toolName))).toBe(expected)
  })

  it('allows every read, todo and subagent tool, and asks for every side-effecting one', () => {
    for (const toolName of [...READ_ONLY_TOOLS, ...TODO_TOOLS, ...SUBAGENT_TOOLS]) {
      expect(verdict(builtIn(toolName)), toolName).toBe(PermissionVerdict.Allow)
    }
    for (const toolName of SIDE_EFFECT_TOOLS) expect(verdict(builtIn(toolName)), toolName).toBe(PermissionVerdict.Ask)
  })

  it("knows every todo tool the Todos tab reads, so the agent's list never waits on you", () => {
    for (const toolName of Object.values(TodoTool)) expect(TODO_TOOLS).toContain(toolName)
  })

  it("allows every one of Glade's own tools, served by its in-process server", () => {
    for (const tool of Object.values(GladeTool)) {
      const call = {
        toolName: `mcp__${GLADE_SERVER}__${tool}`,
        mcpServer: { name: GLADE_SERVER, source: 'sdk' },
        matchedAskRule: false,
      }
      expect(verdict(call), tool).toBe(PermissionVerdict.Allow)
    }
  })

  it.each([
    ['another in-process server', { name: 'acme', source: 'sdk' }],
    ["a configured server that calls itself Glade's", { name: GLADE_SERVER, source: 'user' }],
    ['a project server', { name: GLADE_SERVER, source: 'project' }],
    ['a plugin server', { name: 'github', source: 'plugin' }],
  ])('asks for a tool of %s, whatever its name says', (_, mcpServer) => {
    expect(verdict({ toolName: `mcp__${GLADE_SERVER}__set_status`, mcpServer, matchedAskRule: false })).toBe(
      PermissionVerdict.Ask,
    )
  })

  it("asks for an MCP tool whose server the SDK didn't say, even one named like Glade's", () => {
    expect(verdict(builtIn(`mcp__${GLADE_SERVER}__set_status`))).toBe(PermissionVerdict.Ask)
    expect(verdict(builtIn('mcp__github__create_issue'))).toBe(PermissionVerdict.Ask)
  })

  it("trusts only the servers it's told are Glade's", () => {
    const call = {
      toolName: 'mcp__glade__ask',
      mcpServer: { name: GLADE_SERVER, source: 'sdk' },
      matchedAskRule: false,
    }
    expect(permissionVerdict(call, [])).toBe(PermissionVerdict.Ask)
  })

  it("asks for any call a user permissions.ask rule forced, even a read or one of Glade's own tools", () => {
    expect(verdict({ ...builtIn('Read'), matchedAskRule: true })).toBe(PermissionVerdict.Ask)
    expect(verdict({ ...builtIn('TaskCreate'), matchedAskRule: true })).toBe(PermissionVerdict.Ask)
    expect(
      verdict({ toolName: 'mcp__glade__ask', mcpServer: { name: GLADE_SERVER, source: 'sdk' }, matchedAskRule: true }),
    ).toBe(PermissionVerdict.Ask)
  })
})
