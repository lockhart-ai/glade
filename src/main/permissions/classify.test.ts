import { describe, expect, it } from 'vitest'
import { GLADE_SERVER, gladeOwnServers, GladeTool } from '../agent/glade-tools'
import { CONTROL_SERVER, CONTROL_TOOL_ACCESS, ControlAccess, ControlToolName } from '../control/names'
import { TodoTool } from '../todos/todos'
import {
  permissionVerdict,
  PermissionVerdict,
  READ_ONLY_TOOLS,
  SELF_TOOLS,
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
    // The agent's follow-up tools: scheduling itself, telling you and listing its agents go ahead; running a command
    // (Monitor) or reaching outside (RemoteTrigger, SendMessage) asks.
    ['ScheduleWakeup', PermissionVerdict.Allow],
    ['CronCreate', PermissionVerdict.Allow],
    ['CronDelete', PermissionVerdict.Allow],
    ['CronList', PermissionVerdict.Allow],
    ['PushNotification', PermissionVerdict.Allow],
    ['ListAgents', PermissionVerdict.Allow],
    ['Monitor', PermissionVerdict.Ask],
    ['RemoteTrigger', PermissionVerdict.Ask],
    ['SendMessage', PermissionVerdict.Ask],
    // Tools Glade doesn't know to be read-only ask, however harmless they sound.
    ['BashOutput', PermissionVerdict.Ask],
    ['KillShell', PermissionVerdict.Ask],
    ['ExitPlanMode', PermissionVerdict.Ask],
    ['EnterWorktree', PermissionVerdict.Ask],
    ['SomeToolFromTheFuture', PermissionVerdict.Ask],
    ['', PermissionVerdict.Ask],
    // Names are exact: a tool named like a read in another case isn't one.
    ['read', PermissionVerdict.Ask],
    ['Read ', PermissionVerdict.Ask],
  ])('%s → %s', (toolName, expected) => {
    expect(verdict(builtIn(toolName))).toBe(expected)
  })

  it("allows every read, todo, subagent and agent's-own tool, and asks for every side-effecting one", () => {
    for (const toolName of [...READ_ONLY_TOOLS, ...TODO_TOOLS, ...SUBAGENT_TOOLS, ...SELF_TOOLS]) {
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

  describe("Glade's control tools", () => {
    /** A call to a `glade-control` tool, served by `source`. */
    function control(tool: string, source = 'sdk'): ClassifiedCall {
      return {
        toolName: `mcp__${CONTROL_SERVER}__${tool}`,
        mcpServer: { name: CONTROL_SERVER, source },
        matchedAskRule: false,
      }
    }

    it('allows the reads of the in-process glade-control server, and asks for every change', () => {
      for (const tool of Object.values(ControlToolName)) {
        const expected =
          CONTROL_TOOL_ACCESS[tool] === ControlAccess.Read ? PermissionVerdict.Allow : PermissionVerdict.Ask
        expect(verdict(control(tool)), tool).toBe(expected)
      }
      expect(
        Object.values(ControlToolName).filter((tool) => verdict(control(tool)) === PermissionVerdict.Allow),
      ).toEqual(['list_workspaces', 'list_tasks', 'get_task', 'get_chat', 'list_claude_code_sessions'])
    })

    it.each(['user', 'project', 'plugin', 'claudeai'])(
      'asks for every tool, reads included, of a glade-control server whose source is %s',
      (source) => {
        for (const tool of Object.values(ControlToolName)) {
          expect(verdict(control(tool, source)), tool).toBe(PermissionVerdict.Ask)
        }
      },
    )

    it('asks for a tool of the in-process server that is not one of its reads, or not an MCP name at all', () => {
      expect(verdict(control('drop_everything'))).toBe(PermissionVerdict.Ask)
      expect(verdict({ ...control('list_tasks'), toolName: 'list_tasks' })).toBe(PermissionVerdict.Ask)
    })

    it('asks for a read a user permissions.ask rule forced', () => {
      expect(verdict({ ...control('list_tasks'), matchedAskRule: true })).toBe(PermissionVerdict.Ask)
    })

    it("doesn't trust glade-control's changes even when told it's one of Glade's own servers", () => {
      // What the runner passed before it kept its own servers to glade: every in-process server's name.
      expect(permissionVerdict(control('delete_task'), gladeOwnServers({ glade: {}, [CONTROL_SERVER]: {} }))).toBe(
        PermissionVerdict.Ask,
      )
    })
  })
})
