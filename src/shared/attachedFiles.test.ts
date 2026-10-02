import { describe, expect, it } from 'vitest'
import {
  AttachedFileKind,
  attachedFileLine,
  attachmentsFolderOf,
  dedupedName,
  formatFileSize,
  isAttachedFileName,
  isAttachedFileOf,
  MAX_ATTACHED_FILE_NAME_LENGTH,
  withAttachedFiles,
  type AttachedFile,
} from './attachedFiles'

const SALES: AttachedFile = {
  name: 'sales.csv',
  path: '.glade/attachments/t1/sales.csv',
  size: 48 * 1024,
  kind: AttachedFileKind.Text,
}

const POLICY: AttachedFile = {
  name: 'retention policy (2).pdf',
  path: '.glade/attachments/t1/retention policy (2).pdf',
  size: 1_258_291,
  kind: AttachedFileKind.Binary,
}

describe('dedupedName', () => {
  it('keeps the name for the first copy, then numbers the rest before the extension', () => {
    expect(dedupedName('sales.csv', 1)).toBe('sales.csv')
    expect(dedupedName('sales.csv', 2)).toBe('sales (2).csv')
    expect(dedupedName('sales.csv', 12)).toBe('sales (12).csv')
    expect(dedupedName('archive.tar.gz', 2)).toBe('archive.tar (2).gz')
  })

  it('numbers after the whole name when there’s no extension, or it’s a dot file', () => {
    expect(dedupedName('Makefile', 2)).toBe('Makefile (2)')
    expect(dedupedName('.env', 3)).toBe('.env (3)')
    expect(dedupedName('notes.', 2)).toBe('notes (2).')
  })
})

describe('formatFileSize', () => {
  it('says bytes under a kilobyte, one decimal under ten of a unit, and whole numbers from there', () => {
    expect(formatFileSize(0)).toBe('0 bytes')
    expect(formatFileSize(1)).toBe('1 byte')
    expect(formatFileSize(1023)).toBe('1023 bytes')
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(48 * 1024)).toBe('48 KB')
    expect(formatFileSize(1_258_291)).toBe('1.2 MB')
    expect(formatFileSize(200 * 1024 * 1024)).toBe('200 MB')
    expect(formatFileSize(3 * 1024 ** 3)).toBe('3 GB')
    expect(formatFileSize(5000 * 1024 ** 3)).toBe('5000 GB')
  })
})

describe('the task’s attached files', () => {
  it('are in the task’s own folder under .glade/attachments', () => {
    expect(attachmentsFolderOf('t1')).toBe('.glade/attachments/t1')
  })

  it('have names that are one path segment, not too long', () => {
    expect(isAttachedFileName('sales (2).csv')).toBe(true)
    expect(isAttachedFileName('a'.repeat(MAX_ATTACHED_FILE_NAME_LENGTH))).toBe(true)
    for (const name of ['', '.', '..', 'a/b', 'a\u0000b', 'a'.repeat(MAX_ATTACHED_FILE_NAME_LENGTH + 1)]) {
      expect(isAttachedFileName(name)).toBe(false)
    }
  })

  it('are only the task’s own copies, at their place in its folder', () => {
    expect(isAttachedFileOf('t1', SALES)).toBe(true)
    expect(isAttachedFileOf('t2', SALES)).toBe(false)
    expect(isAttachedFileOf('t1', { name: 'sales.csv', path: 'sales.csv' })).toBe(false)
    expect(isAttachedFileOf('t1', { name: '..', path: '.glade/attachments/t1/..' })).toBe(false)
    expect(isAttachedFileOf('t1', { name: 'b', path: '.glade/attachments/t1/a/b' })).toBe(false)
  })
})

describe('what the agent gets', () => {
  it('is a line per file with its name, size, path from the workspace root, and absolute path', () => {
    expect(attachedFileLine(SALES, '/tmp/acme-api')).toBe(
      'Attached file: sales.csv (48 KB) at .glade/attachments/t1/sales.csv (absolute path: /tmp/acme-api/.glade/attachments/t1/sales.csv)',
    )
    expect(attachedFileLine(SALES, '/tmp/acme-api/')).toContain('(absolute path: /tmp/acme-api/.glade/')
  })

  it('puts the lines at the end of the text, in order, after a blank line', () => {
    expect(withAttachedFiles('Check these against the manifest.', [SALES, POLICY], '/tmp/acme-api')).toBe(
      [
        'Check these against the manifest.',
        '',
        'Attached file: sales.csv (48 KB) at .glade/attachments/t1/sales.csv (absolute path: /tmp/acme-api/.glade/attachments/t1/sales.csv)',
        'Attached file: retention policy (2).pdf (1.2 MB) at .glade/attachments/t1/retention policy (2).pdf (absolute path: /tmp/acme-api/.glade/attachments/t1/retention policy (2).pdf)',
      ].join('\n'),
    )
  })

  it('is just the lines when the text is blank, and just the text with no files', () => {
    expect(withAttachedFiles('  ', [SALES], '/tmp/acme-api')).toBe(attachedFileLine(SALES, '/tmp/acme-api'))
    expect(withAttachedFiles('Hello', [], '/tmp/acme-api')).toBe('Hello')
  })
})
