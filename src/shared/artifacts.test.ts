import { describe, expect, it } from 'vitest'
import { artifactKey, artifactRef, fileArtifacts } from './artifacts'
import { ArtifactKind, type FileArtifact, type LinkArtifact } from './domain'

const FILE: FileArtifact = {
  kind: ArtifactKind.File,
  taskId: 't1',
  path: 'docs/notes.md',
  title: 'Notes',
  addedAt: 1,
  updatedAt: 1,
  modifiedAt: null,
  missing: false,
}

const LINK: LinkArtifact = {
  kind: ArtifactKind.Link,
  taskId: 't1',
  url: 'https://github.com/acme/api/pull/412',
  title: '#412',
  addedAt: 2,
  updatedAt: 2,
}

describe('naming artifacts (#407)', () => {
  it('names a file by its path and a link by its URL', () => {
    expect(artifactRef(FILE)).toEqual({ kind: ArtifactKind.File, path: 'docs/notes.md' })
    expect(artifactRef(LINK)).toEqual({ kind: ArtifactKind.Link, url: 'https://github.com/acme/api/pull/412' })
  })

  it('keys an artifact and its ref alike, never taking a file for a link with the same text', () => {
    expect(artifactKey(FILE)).toBe(artifactKey(artifactRef(FILE)))
    expect(artifactKey(LINK)).toBe('link:https://github.com/acme/api/pull/412')
    expect(artifactKey({ kind: ArtifactKind.File, path: LINK.url })).not.toBe(artifactKey(LINK))
  })

  it('picks out the files', () => {
    expect(fileArtifacts([LINK, FILE, LINK])).toEqual([FILE])
    expect(fileArtifacts([])).toEqual([])
  })
})
