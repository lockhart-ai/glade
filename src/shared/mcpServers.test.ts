// How the sandbox names an MCP server (#515): by the key its tools' names carry, with the name Claude Code reported
// only for showing.
import { describe, expect, it } from 'vitest'
import {
  isMcpServerKey,
  isToolOfServer,
  MAX_SERVER_KEY,
  MAX_SERVER_NAME,
  mcpServerKey,
  mcpServerKeys,
  mcpServerLabel,
  mcpServerOfTool,
} from './mcpServers'

describe('mcpServerKey', () => {
  it.each([
    ['acme-tracker', 'acme-tracker'],
    ['claude.ai Acme Docs', 'claude_ai_Acme_Docs'],
    ['plugin:documents:docs', 'plugin_documents_docs'],
    ['my server/ü', 'my_server__'],
    ['a__b', 'a__b'],
    ['', ''],
  ])('writes %j as %j: each character a tool’s name can’t carry becomes an underscore', (name, key) => {
    expect(mcpServerKey(name)).toBe(key)
  })
})

describe('mcpServerKeys', () => {
  it('is the name as normalised, then with its runs of underscores made one', () => {
    expect(mcpServerKeys('acme-tracker')).toEqual(['acme-tracker'])
    expect(mcpServerKeys('claude.ai Acme Docs')).toEqual(['claude_ai_Acme_Docs'])
    expect(mcpServerKeys('claude.ai  Acme (Docs)')).toEqual(['claude_ai__Acme__Docs_', 'claude_ai_Acme_Docs'])
  })

  it('leaves out what no grant could be kept by', () => {
    expect(mcpServerKeys('')).toEqual([])
    // Only the collapsed form of a name that is nothing but odd characters would be empty.
    expect(mcpServerKeys('…')).toEqual(['_'])
    expect(mcpServerKeys('x'.repeat(MAX_SERVER_KEY + 1))).toEqual([])
  })
})

describe('isMcpServerKey', () => {
  it('takes only what a tool’s name can carry', () => {
    for (const key of ['gmail', 'acme-tracker', 'claude_ai_Acme_Docs', '_', 'A9', 'x'.repeat(MAX_SERVER_KEY)]) {
      expect(isMcpServerKey(key)).toBe(true)
    }
    for (const key of ['', ' ', 'claude.ai Acme Docs', 'a b', 'a/b', 'a*', 'ü', 'x'.repeat(MAX_SERVER_KEY + 1)]) {
      expect(isMcpServerKey(key)).toBe(false)
    }
  })
})

describe('isToolOfServer', () => {
  it('is a tool named under the server’s key, and nothing that only starts like it', () => {
    expect(isToolOfServer('mcp__gmail__send', 'gmail')).toBe(true)
    expect(isToolOfServer('mcp__gmail__', 'gmail')).toBe(false)
    expect(isToolOfServer('mcp__gmail', 'gmail')).toBe(false)
    expect(isToolOfServer('mcp__gmail2__send', 'gmail')).toBe(false)
    expect(isToolOfServer('gmail__send', 'gmail')).toBe(false)
  })
})

describe('mcpServerOfTool', () => {
  it('is the reported name’s key when the tool’s name starts with it', () => {
    expect(mcpServerOfTool('mcp__claude_ai_Acme_Docs__search', 'claude.ai Acme Docs')).toBe('claude_ai_Acme_Docs')
    expect(mcpServerOfTool('mcp__acme-tracker__create_issue', 'acme-tracker')).toBe('acme-tracker')
    // The collapsed spelling, should a version write a connector's that way.
    expect(mcpServerOfTool('mcp__claude_ai_Acme_Docs__search', 'claude.ai  Acme (Docs)')).toBe('claude_ai_Acme_Docs')
  })

  it('tells a server whose own name has two underscores from a shorter-named one', () => {
    expect(mcpServerOfTool('mcp__a__b__c', 'a__b')).toBe('a__b')
    expect(mcpServerOfTool('mcp__a__b__c', 'a')).toBe('a')
    // With nobody to say, the name ends at the first separator.
    expect(mcpServerOfTool('mcp__a__b__c', null)).toBe('a')
  })

  it('goes by the tool’s name when the reported name isn’t what it starts with', () => {
    expect(mcpServerOfTool('mcp__gmail__send', 'Something Else')).toBe('gmail')
    expect(mcpServerOfTool('mcp__gmail__send', '')).toBe('gmail')
  })

  it('takes a name with no tool, or that starts with an underscore, whole', () => {
    expect(mcpServerOfTool('mcp__gmail', null)).toBe('gmail')
    expect(mcpServerOfTool('mcp___private__read', null)).toBe('_private')
    expect(mcpServerOfTool('mcp__', null)).toBe('')
  })

  it('is null for a tool that isn’t an MCP server’s', () => {
    expect(mcpServerOfTool('Read', null)).toBeNull()
    expect(mcpServerOfTool('SendMessage', 'gmail')).toBeNull()
    expect(mcpServerOfTool('xmcp__gmail__send', null)).toBeNull()
  })
})

describe('mcpServerLabel', () => {
  it('shows the name as reported', () => {
    expect(mcpServerLabel('claude.ai Acme Docs', 'claude_ai_Acme_Docs')).toBe('claude.ai Acme Docs')
  })

  it('shows it on one line, with no control or text-direction character', () => {
    expect(mcpServerLabel('  Acme\n\tDocs  ', 'x')).toBe('Acme Docs')
    expect(mcpServerLabel('Gmail‮gnp.exe', 'x')).toBe('Gmail gnp.exe')
    expect(mcpServerLabel('a\u0000b⁦c', 'x')).toBe('a b c')
  })

  it('cuts a very long one short', () => {
    const shown = mcpServerLabel('n'.repeat(MAX_SERVER_NAME + 50), 'x')
    expect(shown).toHaveLength(MAX_SERVER_NAME)
    expect(shown.endsWith('…')).toBe(true)
    expect(mcpServerLabel('n'.repeat(MAX_SERVER_NAME), 'x')).toBe('n'.repeat(MAX_SERVER_NAME))
  })

  it('falls back to the key when nothing is left to show', () => {
    expect(mcpServerLabel('', 'gmail')).toBe('gmail')
    expect(mcpServerLabel(' \n‮ ', 'gmail')).toBe('gmail')
  })
})
