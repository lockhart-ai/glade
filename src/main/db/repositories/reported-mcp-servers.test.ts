import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../../../shared/domain'
import { listReportedServers, noteReportedServers } from './reported-mcp-servers'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from './test-database'
import { createWorkspace } from './workspaces'

const DOCS = { server: 'claude_ai_Acme_Docs', name: 'claude.ai Acme Docs' }
const TRACKER = { server: 'acme-tracker', name: 'acme-tracker' }
const GMAIL = { server: 'gmail', name: 'Gmail' }

let database: TestDatabase
let workspace: Workspace
let other: Workspace

beforeEach(() => {
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  other = createWorkspace(database.db, { name: 'Acme Web', rootPath: '/code/acme-web' }, 1_000)
})

afterEach(() => {
  database.close()
})

describe('noteReportedServers', () => {
  it('keeps each server a workspace reported, once, and lists them by name', () => {
    expect(noteReportedServers(database.db, workspace.id, [TRACKER, DOCS], 10)).toBe(2)
    expect(noteReportedServers(database.db, workspace.id, [GMAIL], 11)).toBe(1)

    // By name, whatever its case, not by when it was reported.
    expect(listReportedServers(database.db, workspace.id)).toEqual([TRACKER, DOCS, GMAIL])
    expect(listReportedServers(database.db, other.id)).toEqual([])
  })

  it('changes nothing for one it already has under that name', () => {
    noteReportedServers(database.db, workspace.id, [TRACKER, DOCS], 10)

    expect(noteReportedServers(database.db, workspace.id, [DOCS, TRACKER], 20)).toBe(0)
    expect(noteReportedServers(database.db, workspace.id, [], 20)).toBe(0)
    expect(listReportedServers(database.db, workspace.id)).toEqual([TRACKER, DOCS])
  })

  it('takes the name a server is reported under now', () => {
    noteReportedServers(database.db, workspace.id, [GMAIL], 10)

    expect(noteReportedServers(database.db, workspace.id, [{ server: 'gmail', name: 'gmail (work)' }], 20)).toBe(1)

    expect(listReportedServers(database.db, workspace.id)).toEqual([{ server: 'gmail', name: 'gmail (work)' }])
  })

  it('saves all of a report or none of it', () => {
    expect(() => noteReportedServers(database.db, workspace.id, [TRACKER, { server: '', name: 'x' }], 10)).toThrow()

    expect(listReportedServers(database.db, workspace.id)).toEqual([])
  })
})

describe('listReportedServers', () => {
  it('lists every workspace’s for the Glade-wide list, each server once, under the name it was last reported by', () => {
    noteReportedServers(database.db, workspace.id, [TRACKER, { server: 'gmail', name: 'gmail' }], 10)
    noteReportedServers(database.db, other.id, [DOCS, GMAIL], 20)

    expect(listReportedServers(database.db, null)).toEqual([TRACKER, DOCS, GMAIL])

    // The latest report of a server names it, whichever workspace made it.
    noteReportedServers(database.db, workspace.id, [{ server: 'gmail', name: 'Gmail (work)' }], 30)
    expect(listReportedServers(database.db, null)).toEqual([TRACKER, DOCS, { server: 'gmail', name: 'Gmail (work)' }])
    expect(listReportedServers(database.db, other.id)).toEqual([DOCS, GMAIL])
  })

  it('is empty until a session reports one', () => {
    expect(listReportedServers(database.db, null)).toEqual([])
    expect(listReportedServers(database.db, workspace.id)).toEqual([])
  })
})
