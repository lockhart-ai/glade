import { describe, expect, it } from 'vitest'
import { ArtifactDateGroup, type Artifact, type EpochMs } from '../../shared/domain'
import {
  artifactTime,
  fileTileKind,
  FileTileKind,
  fileTypeName,
  formatArtifactAge,
  groupArtifacts,
} from './artifactsModel'

/** A local time: `month` counts from 1. */
function local(year: number, month: number, day: number, hours = 0, minutes = 0): EpochMs {
  return new Date(year, month - 1, day, hours, minutes).getTime()
}

// Saturday 26 September 2026, 14:20.
const NOW = local(2026, 9, 26, 14, 20)

/** An artifact whose file last changed at `modifiedAt` (null: not looked at yet), declared at `updatedAt`. */
function artifact(
  path: string,
  modifiedAt: EpochMs | null,
  updatedAt: EpochMs = local(2026, 8, 1),
  addedAt: EpochMs = updatedAt,
): Artifact {
  return { taskId: 't1', path, title: path, addedAt, updatedAt, modifiedAt, missing: false }
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

describe('formatArtifactAge', () => {
  it('is how long ago today, the time yesterday, and the day before that', () => {
    expect(formatArtifactAge(NOW - 20_000, NOW)).toBe('now')
    expect(formatArtifactAge(NOW - 8 * 60_000, NOW)).toBe('8m')
    expect(formatArtifactAge(local(2026, 9, 26, 12, 5), NOW)).toBe('2h')
    expect(formatArtifactAge(local(2026, 9, 25, 15, 2), NOW)).toBe('15:02')
    expect(formatArtifactAge(local(2026, 9, 25, 9, 5), NOW)).toBe('09:05')
    expect(formatArtifactAge(local(2026, 9, 22, 11, 0), NOW)).toBe('Sep 22')
    expect(formatArtifactAge(local(2026, 9, 15, 11, 0), NOW)).toBe('Sep 15')
    expect(formatArtifactAge(local(2026, 9, 2, 11, 0), NOW)).toBe('Sep 2')
    expect(formatArtifactAge(local(2026, 8, 12, 11, 0), NOW)).toBe('Aug 12')
  })

  it('says yesterday’s time from just after midnight', () => {
    expect(formatArtifactAge(local(2026, 9, 26, 23, 50), local(2026, 9, 27, 0, 5))).toBe('23:50')
  })
})

describe('artifactTime', () => {
  it('is when the file last changed, or when it was declared until that’s known', () => {
    expect(artifactTime(artifact('a.png', 50, 10))).toBe(50)
    expect(artifactTime(artifact('a.png', null, 10))).toBe(10)
  })
})

describe('groupArtifacts', () => {
  it('lists them newest first by when each one’s file last changed, in their date groups', () => {
    const artifacts = [
      artifact('docs/site/rate-limits.md', local(2026, 9, 26, 12, 20)),
      artifact('site/redirects.yml', local(2026, 9, 25, 11, 26)),
      // Declared long ago, and edited a few minutes back: it's at the top, in Today.
      artifact('out/screens/landing-dark.png', NOW - 8 * 60_000, local(2026, 3, 1)),
      artifact('docs/site/ia.md', local(2026, 8, 20)),
      artifact('site/src/components/NavSidebar.tsx', local(2026, 9, 25, 15, 2)),
      // Declared today, but its file hasn't changed since last month.
      artifact('docs/site/old-nav.md', local(2026, 8, 3), NOW - 60_000),
      // Not looked at yet: dated by when it was declared.
      artifact('docs/site/changelog.md', null, NOW - 14 * 60_000),
    ]

    const grouped = groupArtifacts(artifacts, NOW)

    expect(grouped.map(({ group, items }) => [group, items.map(({ path }) => path)])).toEqual([
      [ArtifactDateGroup.Today, ['out/screens/landing-dark.png', 'docs/site/changelog.md', 'docs/site/rate-limits.md']],
      [ArtifactDateGroup.Yesterday, ['site/src/components/NavSidebar.tsx', 'site/redirects.yml']],
      [ArtifactDateGroup.Older, ['docs/site/ia.md', 'docs/site/old-nav.md']],
    ])
    // The list it was given stays as it was.
    expect(artifacts[0]?.path).toBe('docs/site/rate-limits.md')
  })

  it('keeps a file that’s gone at its last known time', () => {
    const gone = { ...artifact('out/screens/old.png', local(2026, 9, 22, 10, 0)), missing: true }
    const grouped = groupArtifacts([gone, artifact('a.md', NOW - 60_000)], NOW)
    expect(grouped.map(({ group, items }) => [group, items.map(({ path }) => path)])).toEqual([
      [ArtifactDateGroup.Today, ['a.md']],
      [ArtifactDateGroup.ThisWeek, ['out/screens/old.png']],
    ])
  })

  it('orders files changed at the same moment by when they were declared, then first declared, then by path', () => {
    const at = NOW - 60_000
    const grouped = groupArtifacts(
      [
        artifact('b.md', at, at - 5, at - 9),
        artifact('c.md', at, at - 5, at - 1),
        artifact('a.md', at, at - 5, at - 9),
        artifact('d.md', at, at - 2, at - 9),
      ],
      NOW,
    )
    expect(grouped[0]?.items.map(({ path }) => path)).toEqual(['d.md', 'c.md', 'a.md', 'b.md'])
  })

  it('makes no groups of none, and one of artifacts all changed today', () => {
    expect(groupArtifacts([], NOW)).toEqual([])
    const today = Array.from({ length: 250 }, (_, index) => artifact(`shot-${String(index)}.png`, NOW - index * 60_000))
    const grouped = groupArtifacts(today, NOW)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.items[0]?.path).toBe('shot-0.png')
    expect(grouped[0]?.items.at(-1)?.path).toBe('shot-249.png')
  })
})
