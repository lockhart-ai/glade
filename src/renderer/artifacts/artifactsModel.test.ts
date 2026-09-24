import { describe, expect, it } from 'vitest'
import { FileInfoKind } from '../../shared/domain'
import { describeFile, fileTypeName, formatLines } from './artifactsModel'

describe('fileTypeName', () => {
  it('names the common kinds, and capitalizes the extension of others', () => {
    expect(fileTypeName('docs/releases/2.4.md')).toBe('Markdown')
    expect(fileTypeName('out/announcement-2.4.txt')).toBe('Text')
    expect(fileTypeName('src/Date.TS')).toBe('TypeScript')
    expect(fileTypeName('reports/usage.csv')).toBe('CSV')
    expect(fileTypeName('scan.pdf')).toBe('PDF')
  })

  it('is File for a file with no extension, or a dot file', () => {
    expect(fileTypeName('Makefile')).toBe('File')
    expect(fileTypeName('config/.env')).toBe('File')
    expect(fileTypeName('notes.')).toBe('File')
    expect(fileTypeName('v2.4/NOTES')).toBe('File')
  })
})

describe('formatLines', () => {
  it('counts lines, with thousands separated', () => {
    expect(formatLines(1)).toBe('1 line')
    expect(formatLines(0)).toBe('0 lines')
    expect(formatLines(1240)).toBe('1,240 lines')
  })
})

describe('describeFile', () => {
  const now = 100 * 60_000

  it('gives a text file’s type, lines and age, as the design does', () => {
    expect(
      describeFile('docs/releases/2.4.md', { kind: FileInfoKind.Text, lines: 128, modifiedAt: now - 12 * 60_000 }, now),
    ).toBe('Markdown · 128 lines · 12m ago')
  })

  it('gives another file’s type and age, a missing one’s type and "missing", and only the type until looked at', () => {
    expect(describeFile('logo.png', { kind: FileInfoKind.Other, modifiedAt: now }, now)).toBe('PNG · just now')
    expect(describeFile('out/email.txt', { kind: FileInfoKind.Missing }, now)).toBe('Text · missing')
    expect(describeFile('out/email.txt', undefined, now)).toBe('Text')
  })
})
