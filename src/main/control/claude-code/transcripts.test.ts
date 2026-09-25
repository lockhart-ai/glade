import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { at, ms, plainChat, projectSlug, SESSION_ID, writeTranscript } from './test-transcripts'
import {
  CLAUDE_CONFIG_DIR_ENV,
  claudeProjectsDir,
  findTranscript,
  listTranscripts,
  readTranscript,
  transcriptAt,
  TranscriptProblem,
  type TranscriptFile,
} from './transcripts'

const CWD = '/code/acme-api'

let root: string
let projects: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-transcripts-')))
  projects = join(root, 'claude', 'projects')
  mkdirSync(projects, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('claudeProjectsDir', () => {
  it("is Claude Code's config folder's projects folder, moved by CLAUDE_CONFIG_DIR", () => {
    expect(claudeProjectsDir({}, '/Users/me')).toBe('/Users/me/.claude/projects')
    expect(claudeProjectsDir({ [CLAUDE_CONFIG_DIR_ENV]: '' }, '/Users/me')).toBe('/Users/me/.claude/projects')
    expect(claudeProjectsDir({ [CLAUDE_CONFIG_DIR_ENV]: '/tmp/claude-test/' }, '/Users/me')).toBe(
      '/tmp/claude-test/projects',
    )
    expect(claudeProjectsDir().endsWith('projects')).toBe(true)
  })
})

describe('transcriptAt', () => {
  it("finds a .jsonl file directly in a project's folder", async () => {
    const path = writeTranscript(projects, CWD, plainChat(CWD).toJsonl())
    const lookup = await transcriptAt(projects, path)
    expect(lookup).toEqual({
      ok: true,
      file: {
        path,
        sessionId: SESSION_ID,
        size: expect.any(Number) as unknown,
        modifiedAt: expect.any(Number) as unknown,
      },
    })
  })

  it('refuses paths outside the projects folder, with .., or not a transcript', async () => {
    const path = writeTranscript(projects, CWD, plainChat(CWD).toJsonl())
    const outsideFile = join(root, 'elsewhere.jsonl')
    writeFileSync(outsideFile, plainChat(CWD).toJsonl())
    const nested = join(projects, projectSlug(CWD), SESSION_ID, 'subagents', 'agent-1.jsonl')
    mkdirSync(join(nested, '..'), { recursive: true })
    writeFileSync(nested, plainChat(CWD).toJsonl())
    writeFileSync(join(projects, 'loose.jsonl'), plainChat(CWD).toJsonl())
    writeFileSync(join(projects, projectSlug(CWD), 'notes.txt'), 'Not a transcript')
    for (const refused of [
      outsideFile,
      // Unresolved, as a caller would pass it: `..` segments that climb out.
      `${projects}/${projectSlug(CWD)}/../../elsewhere.jsonl`,
      `${projects}/${projectSlug(CWD)}/../../../elsewhere.jsonl`,
      nested,
      join(projects, 'loose.jsonl'),
      join(projects, projectSlug(CWD), 'notes.txt'),
      `${projectSlug(CWD)}/${SESSION_ID}.jsonl`,
      '/etc/passwd',
    ]) {
      expect(await transcriptAt(projects, refused), refused).toEqual({
        ok: false,
        problem: TranscriptProblem.OutsideProjects,
      })
    }
    // A `..` that stays inside the projects folder is fine.
    expect(
      await transcriptAt(projects, join(projects, 'other', '..', projectSlug(CWD), `${SESSION_ID}.jsonl`)),
    ).toMatchObject({
      ok: true,
      file: { path },
    })
  })

  it('refuses a symlink that leads out of the projects folder, file or folder', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.jsonl'), plainChat(CWD).toJsonl())
    mkdirSync(join(projects, 'linked-file'))
    symlinkSync(join(outside, 'secret.jsonl'), join(projects, 'linked-file', 'session.jsonl'))
    symlinkSync(outside, join(projects, 'linked-folder'))

    for (const path of [
      join(projects, 'linked-file', 'session.jsonl'),
      join(projects, 'linked-folder', 'secret.jsonl'),
    ]) {
      expect(await transcriptAt(projects, path), path).toEqual({
        ok: false,
        problem: TranscriptProblem.OutsideProjects,
      })
    }
    // A link that stays inside is followed.
    const path = writeTranscript(projects, CWD, plainChat(CWD).toJsonl())
    symlinkSync(path, join(projects, 'linked-file', 'inside.jsonl'))
    expect(await transcriptAt(projects, join(projects, 'linked-file', 'inside.jsonl'))).toMatchObject({
      ok: true,
      file: { sessionId: 'inside' },
    })
  })

  it("says so when there's no such file, or no projects folder", async () => {
    expect(await transcriptAt(projects, join(projects, 'acme', 'missing.jsonl'))).toEqual({
      ok: false,
      problem: TranscriptProblem.Missing,
    })
    const folder = join(projects, 'acme', 'folder.jsonl')
    mkdirSync(folder, { recursive: true })
    expect(await transcriptAt(projects, folder)).toEqual({ ok: false, problem: TranscriptProblem.Missing })
    const none = join(root, 'no-projects')
    expect(await transcriptAt(none, join(none, 'acme', `${SESSION_ID}.jsonl`))).toEqual({
      ok: false,
      problem: TranscriptProblem.Missing,
    })
  })
})

describe('listTranscripts and findTranscript', () => {
  it("lists the top-level transcripts of every project's folder, and finds one by its session id", async () => {
    const first = writeTranscript(projects, CWD, plainChat(CWD).toJsonl())
    const second = writeTranscript(projects, '/code/acme-dashboard', plainChat('/code/acme-dashboard').toJsonl(), 'b-2')
    // Not sessions: a subagent's transcript, another kind of file, and a file loose in the projects folder.
    mkdirSync(join(projects, projectSlug(CWD), SESSION_ID, 'subagents'), { recursive: true })
    writeFileSync(join(projects, projectSlug(CWD), SESSION_ID, 'subagents', 'agent-1.jsonl'), '{}\n')
    writeFileSync(join(projects, projectSlug(CWD), 'notes.md'), 'Notes')
    writeFileSync(join(projects, 'loose.jsonl'), '{}\n')
    utimesSync(first, new Date(ms(100)), new Date(ms(100)))

    const files = await listTranscripts(projects)
    expect(files.map((file) => file.path).sort()).toEqual([second, first].sort())
    expect(files.find((file) => file.path === first)).toEqual({
      path: first,
      sessionId: SESSION_ID,
      size: plainChat(CWD).toJsonl().length,
      modifiedAt: ms(100),
    })

    expect((await findTranscript(projects, 'b-2'))?.path).toBe(second)
    expect(await findTranscript(projects, 'missing')).toBeUndefined()
    // An id that isn't one can't reach outside.
    expect(await findTranscript(projects, '../../elsewhere')).toBeUndefined()
  })

  it('lists nothing when there is no projects folder', async () => {
    expect(await listTranscripts(join(root, 'no-projects'))).toEqual([])
    expect(await findTranscript(join(root, 'no-projects'), SESSION_ID)).toBeUndefined()
  })

  it('leaves out a transcript that goes before it can be read', async () => {
    const path = writeTranscript(projects, CWD, plainChat(CWD).toJsonl())
    symlinkSync(join(root, 'gone.jsonl'), join(projects, projectSlug(CWD), 'dangling.jsonl'))
    expect((await listTranscripts(projects)).map((file) => file.path)).toEqual([path])
  })
})

describe('readTranscript', () => {
  function fileFor(text: string): TranscriptFile {
    const path = writeTranscript(projects, CWD, text)
    return { path, sessionId: SESSION_ID, size: text.length, modifiedAt: ms(500) }
  }

  it('reads a transcript line by line into its session', async () => {
    const session = await readTranscript(fileFor(plainChat(CWD).toJsonl()))
    expect(session.turns).toHaveLength(2)
    expect(session.messages).toBe(4)
    expect(session.skipped).toEqual({ lines: 0, images: 0 })
  })

  it('skips and counts a truncated last line and invalid lines, and ignores blank ones', async () => {
    const text = plainChat(CWD).toJsonl()
    const session = await readTranscript(
      fileFor(`\n${text.replaceAll('\n', '\r\n')}\n   \nnot json\n{"type":"user","message":{"content":"Also`),
    )
    expect(session.messages).toBe(4)
    expect(session.skipped.lines).toBe(2)
  })

  it('reads an empty file as a session with nothing in it, timed by the file', async () => {
    const session = await readTranscript(fileFor(''))
    expect(session).toMatchObject({ turns: [], messages: 0, cwd: null, startedAt: ms(500), lastActivityAt: ms(500) })
    expect(at(0)).toBe('2026-09-01T10:00:00.000Z')
  })
})
