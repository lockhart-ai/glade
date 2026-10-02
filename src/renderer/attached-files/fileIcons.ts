/** How a file attached to a message looks on its chip (#396, `docs/design/html/36-attached-files.html`). */
import {
  faFile,
  faFileAudio,
  faFileCode,
  faFileExcel,
  faFileImage,
  faFileLines,
  faFilePdf,
  faFilePowerpoint,
  faFileVideo,
  faFileWord,
  faFileZipper,
} from '@fortawesome/free-regular-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { AttachedFileKind, formatFileSize, type AttachedFile } from '../../shared/attachedFiles'
import { fileTypeName } from '../artifacts/artifactsModel'

/** The icon a file's chip shows, by its kind of file. */
export enum FileIconKind {
  Spreadsheet = 'spreadsheet',
  Pdf = 'pdf',
  Image = 'image',
  Code = 'code',
  Archive = 'archive',
  Audio = 'audio',
  Video = 'video',
  Document = 'document',
  Slides = 'slides',
  /** Any other text. */
  Text = 'text',
  /** Any other file. */
  Other = 'other',
}

/** The kinds of file with an icon of their own, by extension (lowercase, without the dot). */
const BY_EXTENSION: Readonly<Record<string, FileIconKind>> = {
  csv: FileIconKind.Spreadsheet,
  tsv: FileIconKind.Spreadsheet,
  xls: FileIconKind.Spreadsheet,
  xlsx: FileIconKind.Spreadsheet,
  numbers: FileIconKind.Spreadsheet,
  pdf: FileIconKind.Pdf,
  png: FileIconKind.Image,
  jpg: FileIconKind.Image,
  jpeg: FileIconKind.Image,
  gif: FileIconKind.Image,
  webp: FileIconKind.Image,
  svg: FileIconKind.Image,
  heic: FileIconKind.Image,
  tiff: FileIconKind.Image,
  ts: FileIconKind.Code,
  tsx: FileIconKind.Code,
  js: FileIconKind.Code,
  jsx: FileIconKind.Code,
  py: FileIconKind.Code,
  rb: FileIconKind.Code,
  go: FileIconKind.Code,
  rs: FileIconKind.Code,
  java: FileIconKind.Code,
  swift: FileIconKind.Code,
  sh: FileIconKind.Code,
  json: FileIconKind.Code,
  yml: FileIconKind.Code,
  yaml: FileIconKind.Code,
  toml: FileIconKind.Code,
  sql: FileIconKind.Code,
  html: FileIconKind.Code,
  css: FileIconKind.Code,
  zip: FileIconKind.Archive,
  gz: FileIconKind.Archive,
  tgz: FileIconKind.Archive,
  tar: FileIconKind.Archive,
  bz2: FileIconKind.Archive,
  '7z': FileIconKind.Archive,
  mp3: FileIconKind.Audio,
  wav: FileIconKind.Audio,
  m4a: FileIconKind.Audio,
  flac: FileIconKind.Audio,
  mp4: FileIconKind.Video,
  mov: FileIconKind.Video,
  webm: FileIconKind.Video,
  doc: FileIconKind.Document,
  docx: FileIconKind.Document,
  pages: FileIconKind.Document,
  rtf: FileIconKind.Document,
  ppt: FileIconKind.Slides,
  pptx: FileIconKind.Slides,
  key: FileIconKind.Slides,
}

const ICONS: Readonly<Record<FileIconKind, IconDefinition>> = {
  [FileIconKind.Spreadsheet]: faFileExcel,
  [FileIconKind.Pdf]: faFilePdf,
  [FileIconKind.Image]: faFileImage,
  [FileIconKind.Code]: faFileCode,
  [FileIconKind.Archive]: faFileZipper,
  [FileIconKind.Audio]: faFileAudio,
  [FileIconKind.Video]: faFileVideo,
  [FileIconKind.Document]: faFileWord,
  [FileIconKind.Slides]: faFilePowerpoint,
  [FileIconKind.Text]: faFileLines,
  [FileIconKind.Other]: faFile,
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Which icon a file's chip shows: by its extension, or else text or any file, by what Glade found it holds. */
export function fileIconKind(file: Pick<AttachedFile, 'name' | 'kind'>): FileIconKind {
  const known = BY_EXTENSION[extensionOf(file.name)]
  if (known !== undefined) return known
  switch (file.kind) {
    case AttachedFileKind.Text:
      return FileIconKind.Text
    case AttachedFileKind.Image:
      return FileIconKind.Image
    case AttachedFileKind.Binary:
      return FileIconKind.Other
  }
}

/** The icon on a file's chip. */
export function fileIcon(file: Pick<AttachedFile, 'name' | 'kind'>): IconDefinition {
  return ICONS[fileIconKind(file)]
}

/** What a file's chip says under its name: its type and size, `CSV · 48 KB`. */
export function fileChipDetail(file: Pick<AttachedFile, 'name' | 'size'>): string {
  return `${fileTypeName(file.name)} · ${formatFileSize(file.size)}`
}

/**
 * Whether clicking a sent file's chip opens it in the Files tab, which shows text and images; anything else (a PDF, a
 * spreadsheet) is revealed in Finder instead.
 */
export function opensInFiles(file: Pick<AttachedFile, 'kind'>): boolean {
  switch (file.kind) {
    case AttachedFileKind.Text:
    case AttachedFileKind.Image:
      return true
    case AttachedFileKind.Binary:
      return false
  }
}
