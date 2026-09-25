// The reference docs against the code they describe (#242): where the code has a machine-readable source (the control
// tools' registry and zod schemas, the plugin API's enums and schemas, the Glade tools, the system prompt, the log's
// scopes), each doc must name everything in it, so a tool, field, code, event or scope added without a line in its doc
// fails here. (docs/keymap.md is checked against the keymap in src/renderer/commands/keymap.test.tsx.)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_PLUGIN_STATUS,
  MAX_PLUGIN_TEXT,
  PLUGIN_API_VERSION,
  PluginEventType,
  PluginMessageType,
  PluginPermissionOutcome,
  PluginQuestionOutcome,
  PluginSubagentState,
  PluginTaskActivity,
  PluginToolCallState,
  PluginWaitingOn,
} from '../shared/plugin-api'
import {
  pluginEventSchema,
  pluginPermissionRequestSchema,
  pluginQuestionSchema,
  pluginSubagentSchema,
  pluginTaskSchema,
  pluginToolCallSchema,
} from '../shared/plugin-api-schema'
import {
  AgentErrorKind,
  Effort,
  MessageRole,
  PauseReason,
  PermissionMode,
  TaskActivity,
  ToolCallState,
} from '../shared/domain'
import { formatChord, RESERVED_CHORDS } from '../shared/keymap'
import { connectCommand, controlUrl, DEFAULT_CONTROL_PORT } from '../shared/control'
import { APP_SECTIONS, SECTION_TITLES } from '../renderer/settings/sections'
import { GladeTool } from './agent/glade-tools'
import { HANDOFF_HEADING, systemPromptAppend } from './agent/system-prompt'
import { openTestDatabase, sampleTask, sampleWorkspace } from './db/repositories/test-database'
import { ControlErrorCode } from './control/errors'
import { ControlEnv } from './control/endpoint'
import { MAX_BODY_BYTES, statusOf } from './control/http'
import { ControlAccess, ControlToolName } from './control/names'
import { CONTROL_RATE_LIMITS } from './control/rate-limit'
import { CONTROL_TOOLS } from './control/tools'
import { chatTurns, MAX_MESSAGE_LENGTH, taskDetail, workspaceSummary } from './control/views'
import { LogScope } from './logging/logger'
import { PLUGIN_RATE_LIMIT } from './plugins/messages'
import { PLUGIN_CSP } from './plugins/protocol'
import { pluginManifestSchema } from './plugins/manifest'

const REPO = resolve(__dirname, '..', '..')

function doc(path: string): string {
  return readFileSync(resolve(REPO, path), 'utf8')
}

/**
 * The part of a doc under the first heading that includes `title`, up to the next heading of its level or above.
 * Throws when there's no such heading, so a renamed one fails the test that reads it.
 */
function section(markdown: string, title: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^#{1,6} /.test(line) && line.includes(title))
  if (start === -1) throw new Error(`No heading with ${title}`)
  const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 1
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${String(level)}} `).test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** The body of a TypeScript interface as a doc's code block writes it: from `interface Name` to its closing brace. */
function interfaceBlock(markdown: string, name: string): string {
  const match = new RegExp(`interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(markdown)
  if (match === null) throw new Error(`No interface ${name}`)
  return match[1] ?? ''
}

/** Whether a TypeScript block declares `field`: `field:`, `field?:`, or `readonly field:`. */
function declares(block: string, field: string): boolean {
  return new RegExp(`(^|[\\s{;])(readonly )?${field}\\??:`, 'm').test(block)
}

/** The rows of the Markdown tables in `markdown`, header rows included, each a list of its cells. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*:?-/.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
}

/** A JSON Schema's property names, as `tools/list` gives a tool's input. */
function propertiesOf(schema: Readonly<Record<string, unknown>>): Record<string, Readonly<Record<string, unknown>>> {
  const properties = schema.properties
  return typeof properties === 'object' && properties !== null
    ? (properties as Record<string, Readonly<Record<string, unknown>>>)
    : {}
}

describe('docs/control-api.md', () => {
  const api = doc('docs/control-api.md')
  const tools = section(api, '## Tools')

  it('has a heading for every tool, in the order tools/list gives them', () => {
    const headings = tools
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .flatMap((line) => [...line.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]))
    expect(headings).toEqual(CONTROL_TOOLS.map(({ name }) => name))
    expect([...headings].sort()).toEqual(Object.values(ControlToolName).sort())
  })

  it.each(CONTROL_TOOLS.map((tool) => [tool.name, tool] as const))(
    'gives every input field of %s, and its page size',
    (name, tool) => {
      const text = section(tools, `\`${name}\``)
      const properties = propertiesOf(tool.inputSchema)
      // `update_task`'s fields are `id` and `patch`, and the patch's own.
      const fields = Object.entries(properties).flatMap(([field, schema]) => [
        field,
        ...Object.keys(propertiesOf(schema)),
      ])
      for (const field of fields) expect(text, field).toMatch(new RegExp(`\\b${field}\\b`))
      const limit = properties.limit
      if (limit !== undefined) expect(text).toContain(`1–${String(limit.maximum)}`)
    },
  )

  it('lists every error code, and the status /v1 answers each with', () => {
    const errors = tableRows(section(api, '## Calls, results and errors'))
    expect(errors.slice(1).map(([code]) => code)).toEqual(Object.values(ControlErrorCode).map((code) => `\`${code}\``))
    const statuses = new Map(
      tableRows(section(api, '## Scripting')).map(([status = '', codes = '']) => [status, codes]),
    )
    for (const code of Object.values(ControlErrorCode)) {
      expect(statuses.get(`\`${String(statusOf(code))}\``), code).toContain(`\`${code}\``)
    }
  })

  it('gives the endpoint’s defaults, limits and variables as the code has them', () => {
    const prose = api.replace(/\s+/g, ' ')
    expect(api).toContain(connectCommand(controlUrl(DEFAULT_CONTROL_PORT), '<token>'))
    expect(api).toContain(`\`${controlUrl(DEFAULT_CONTROL_PORT)}\``)
    expect(MAX_BODY_BYTES).toBe(1024 * 1024)
    expect(prose).toContain('over 1 MB get `413`')
    const reads = CONTROL_RATE_LIMITS[ControlAccess.Read].toLocaleString('en-US')
    const changes = CONTROL_RATE_LIMITS[ControlAccess.Change].toLocaleString('en-US')
    expect(prose).toContain(`${reads} reads and ${changes} changes a minute`)
    for (const variable of Object.values(ControlEnv)) expect(api).toContain(`\`${variable}\``)
    expect(prose).toContain(`over ${MAX_MESSAGE_LENGTH.toLocaleString('en-US')} characters`)
  })

  it('types every field a workspace, a task and a chat turn have, with their enums’ values', () => {
    const database = openTestDatabase()
    try {
      const workspace = sampleWorkspace(database.db)
      const task = sampleTask(database.db, workspace.id)
      const summary = workspaceSummary(workspace)
      const detail = taskDetail(database.db, task, summary)
      const types = section(api, '### Types')
      const blocks = [
        ['WorkspaceSummary', summary],
        ['TaskDetail', detail],
      ] as const
      for (const [name, value] of blocks) {
        const block = `${interfaceBlock(types, name)}\n${name === 'TaskDetail' ? interfaceBlock(types, 'TaskSummary') : ''}`
        for (const field of Object.keys(value)) expect(declares(block, field), `${name}.${field}`).toBe(true)
      }
      const [turn] = chatTurns(
        { db: database.db, taskId: task.id, rootPath: workspace.rootPath, messages: [], toolEvents: [] },
        1,
        1,
        true,
      )
      for (const field of Object.keys(turn ?? {})) expect(declares(interfaceBlock(types, 'ChatTurn'), field)).toBe(true)
      for (const value of [
        ...Object.values(TaskActivity),
        ...Object.values(Effort),
        ...Object.values(PermissionMode),
        ...Object.values(AgentErrorKind),
        ...Object.values(PauseReason),
        ...Object.values(ToolCallState),
        ...Object.values(MessageRole),
      ]) {
        expect(types, value).toContain(`'${value}'`)
      }
    } finally {
      database.close()
    }
  })
})

describe('docs/plugin-api.md', () => {
  const api = doc('docs/plugin-api.md')

  it('has a row for every event and every message, and no others', () => {
    const events = tableRows(section(api, '## Events (Glade to plugin)'))
      .slice(1)
      .map(([type]) => type)
    expect(events).toEqual(Object.values(PluginEventType).map((type) => `\`${type}\``))
    expect(pluginEventSchema.options).toHaveLength(events.length)
    const messages = tableRows(section(api, '## Messages (plugin to Glade)'))
      .slice(1)
      .map(([type]) => type)
    expect(messages).toEqual(Object.values(PluginMessageType).map((type) => `\`${type}\``))
  })

  it.each([
    ['PluginTask', pluginTaskSchema],
    ['PluginToolCall', pluginToolCallSchema],
    ['PluginSubagent', pluginSubagentSchema],
    ['PluginQuestion', pluginQuestionSchema],
    ['PluginPermissionRequest', pluginPermissionRequestSchema],
  ] as const)('declares every field of %s, and no others', (name, schema) => {
    const block = interfaceBlock(api, name)
    const declared = [...block.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1])
    expect(declared).toEqual(Object.keys(schema.shape))
  })

  it('gives every value of the enums the events carry', () => {
    for (const value of [
      ...Object.values(PluginTaskActivity),
      ...Object.values(PluginWaitingOn),
      ...Object.values(PluginToolCallState),
      ...Object.values(PluginSubagentState),
      ...Object.values(PluginQuestionOutcome),
      ...Object.values(PluginPermissionOutcome),
    ]) {
      expect(api, value).toContain(`'${value}'`)
    }
  })

  it('gives the manifest’s fields, the CSP, the limits and the version as the code has them', () => {
    const manifest = tableRows(section(api, '## Manifest'))
      .slice(1)
      .map(([field]) => field)
    expect(manifest).toEqual(Object.keys(pluginManifestSchema.in.shape).map((field) => `\`${field}\``))
    expect(api.replace(/\s+/g, ' ')).toContain(PLUGIN_CSP)
    expect(api).toContain(`cut to ${String(MAX_PLUGIN_TEXT)} characters`)
    expect(api).toContain(`up to ${String(MAX_PLUGIN_STATUS)} characters`)
    expect(api).toContain(
      `a burst of ${String(PLUGIN_RATE_LIMIT.burst)}, then ${String(PLUGIN_RATE_LIMIT.perSecond)} a second`,
    )
    expect(api).toContain(`version **${String(PLUGIN_API_VERSION)}**`)
  })
})

describe('docs/model-surface.md', () => {
  const surface = doc('docs/model-surface.md')

  it('has every Glade tool in its table', () => {
    const table = tableRows(surface)
      .filter(([, input]) => input?.startsWith('`{') === true)
      .map(([tool]) => tool)
    for (const tool of Object.values(GladeTool)) expect(table, tool).toContain(`\`${tool}\``)
  })

  it('quotes the system prompt a new task gets, as system-prompt.ts makes it', () => {
    const database = openTestDatabase()
    try {
      const task = { ...sampleTask(database.db, sampleWorkspace(database.db).id), id: '<id>' }
      const quoted = /```\n(You are running inside Glade[\s\S]*?)\n```/.exec(section(surface, '## System prompt'))
      expect(quoted?.[1]).toBe(systemPromptAppend(task))
      expect(surface).toContain(`## ${HANDOFF_HEADING}`)
    } finally {
      database.close()
    }
  })
})

describe('docs/logs.md', () => {
  it('has a row for every log scope, in order, and no others', () => {
    const scopes = tableRows(section(doc('docs/logs.md'), '## Scopes'))
      .slice(1)
      .map(([scope]) => scope)
    expect(scopes).toEqual(Object.values(LogScope).map((scope) => `\`${scope}\``))
  })
})

describe('docs/keymap.md', () => {
  it('names every key Settings › Keyboard refuses as macOS’s or the app menu’s, as it shows them', () => {
    const rebinding = section(doc('docs/keymap.md'), '## Rebinding')
    for (const { chord } of RESERVED_CHORDS) expect(rebinding).toContain(formatChord(chord))
  })
})

describe('docs/product.md', () => {
  it('lists every Settings section, in the nav’s order', () => {
    const listed = section(doc('docs/product.md'), '## Settings')
      .split('\n')
      .flatMap((line) => /^- \*\*(\w+)(:\*\*|\*\*)/.exec(line)?.[1] ?? [])
    expect(listed).toEqual([...APP_SECTIONS.map((id) => SECTION_TITLES[id]), 'Workspace'])
  })
})

describe('llms.txt', () => {
  const llms = doc('llms.txt')

  it('follows llmstxt.org: an H1, a blockquote summary, then sections of links with a line each', () => {
    const lines = llms.split('\n')
    expect(lines[0]).toBe('# Glade')
    expect(lines.find((line) => line !== '' && !line.startsWith('# '))).toMatch(/^> /)
    const links = lines.filter((line) => line.startsWith('- '))
    expect(links.length).toBeGreaterThan(0)
    for (const line of links) {
      expect(line).toMatch(/^- \[[^\]]+\]\(https:\/\/github\.com\/lockhart-ai\/glade\/blob\/main\/[^)]+\): \S/)
    }
  })

  it('puts the control API first, with how to connect', () => {
    const first = llms.split('\n').find((line) => line.startsWith('- '))
    expect(first).toContain('docs/control-api.md')
    expect(llms).toContain(connectCommand(controlUrl(DEFAULT_CONTROL_PORT), '<token>'))
  })
})
