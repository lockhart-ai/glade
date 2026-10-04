import { describe, expect, it } from 'vitest'
import { ArtifactKind, type EpochMs, type FileArtifact, type LinkArtifact } from '../../shared/domain'
import {
  artifactTime,
  artifactTypeName,
  fileTileKind,
  FileTileKind,
  fileTypeName,
  isImageArtifact,
} from './artifactsModel'

/** A local time: `month` counts from 1. */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): EpochMs {
  return new Date(year, month - 1, day, hours, minutes).getTime()
}

/** An artifact whose file last changed at `modifiedAt` (null: not looked at yet), declared at `updatedAt`. */
function artifact(
  path: string,
  modifiedAt: EpochMs | null,
  updatedAt: EpochMs = local(2026, 8, 1),
  addedAt: EpochMs = updatedAt,
): FileArtifact {
  return { kind: ArtifactKind.File, taskId: 't1', path, title: path, addedAt, updatedAt, modifiedAt, missing: false }
}

/** A link artifact (#407), titled by its URL, declared at `updatedAt`. */
function link(url: string, updatedAt: EpochMs, addedAt: EpochMs = updatedAt): LinkArtifact {
  return { kind: ArtifactKind.Link, taskId: 't1', url, title: url, addedAt, updatedAt }
}

describe('fileTypeName', () => {
  it('names the common kinds, and capitalizes the extension of others', () => {
    expect(fileTypeName('docs/releases/2.4.md')).toBe('Markdown')
    expect(fileTypeName('out/announcement-2.4.txt')).toBe('Text')
    expect(fileTypeName('src/Date.TS')).toBe('TypeScript')
    expect(fileTypeName('reports/usage.csv')).toBe('CSV')
    expect(fileTypeName('out/screens/landing-dark.png')).toBe('PNG')
    expect(fileTypeName('shot.jpeg')).toBe('JPEG')
    expect(fileTypeName('site/redirects.yml')).toBe('YAML')
  })

  it('is File for a file with no extension, or a dot file', () => {
    expect(fileTypeName('Makefile')).toBe('File')
    expect(fileTypeName('config/.env')).toBe('File')
    expect(fileTypeName('notes.')).toBe('File')
    expect(fileTypeName('v2.4/NOTES')).toBe('File')
  })
})

describe('fileTileKind', () => {
  it('shows an image, code or a page, by the file’s extension', () => {
    for (const path of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg']) {
      expect(fileTileKind(path), path).toBe(FileTileKind.Image)
    }
    for (const path of ['NavSidebar.tsx', 'redirects.yml', 'package.json', 'deploy.sh', 'schema.sql']) {
      expect(fileTileKind(path), path).toBe(FileTileKind.Code)
    }
    for (const path of ['changelog.md', 'email.txt', 'report.pdf', 'Makefile', '.env']) {
      expect(fileTileKind(path), path).toBe(FileTileKind.Text)
    }
  })
})

describe('artifactTime', () => {
  it('is when the file last changed, or when it was declared until that’s known', () => {
    expect(artifactTime(artifact('a.png', 50, 10))).toBe(50)
    expect(artifactTime(artifact('a.png', null, 10))).toBe(10)
  })

  it('is when a link was last declared or changed: it has no file (#407)', () => {
    expect(artifactTime(link('https://github.com/acme/api/pull/412', 30, 10))).toBe(30)
  })
})

describe('link artifacts (#407)', () => {
  const PR = 'https://github.com/acme/api/pull/412'

  it('say what they are after their title, and are never images', () => {
    expect(artifactTypeName(link(PR, 1))).toBe('#412 · acme/api')
    expect(artifactTypeName(link('https://github.com/acme/api/issues/398', 1))).toBe('#398 · acme/api')
    expect(artifactTypeName(link('https://acme.atlassian.net/browse/API-123', 1))).toBe('API-123')
    expect(artifactTypeName(link('https://www.example.com/shot.png', 1))).toBe('example.com')
    expect(artifactTypeName(artifact('docs/notes.md', 1))).toBe('Markdown')
    expect(isImageArtifact(link('https://www.example.com/shot.png', 1))).toBe(false)
    expect(isImageArtifact(artifact('shot.png', 1))).toBe(true)
  })
})
