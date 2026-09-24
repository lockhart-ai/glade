/**
 * Syntax highlighting for the Files tab's viewer, with Shiki: TextMate grammars, as VS Code uses, in the design's
 * colours. It runs offline under the page's CSP: the JavaScript regex engine needs no WebAssembly, and each language's
 * grammar is bundled with the app and loaded (as its own chunk) the first time a file in it is shown. Shiki itself
 * loads the first time any file is, so it adds nothing to the app's start.
 *
 * A large file is highlighted a chunk of lines at a time, yielding to the page between chunks, so the viewer stays
 * responsive: it shows the plain text at once and colours it in from the top.
 */
import type { GrammarState, HighlighterCore, LanguageInput, ThemeRegistration, ThemedToken } from 'shiki/core'
import { colors } from '../tokens'

/** The languages the viewer highlights, by Shiki's name, each loaded when first needed. */
const LANGUAGES = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  make: () => import('@shikijs/langs/make'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} as const satisfies Readonly<Record<string, () => LanguageInput>>

/** A language the viewer highlights. */
export type Language = keyof typeof LANGUAGES

/** Every language the viewer highlights. */
export const LANGUAGE_NAMES = Object.keys(LANGUAGES) as readonly Language[]

/** Each file extension's language (lowercase, without the dot). */
const EXTENSIONS: Readonly<Record<string, Language>> = {
  bash: 'shellscript',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  diff: 'diff',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  patch: 'diff',
  php: 'php',
  plist: 'xml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shellscript',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shellscript',
}

/** Files known by their whole name rather than an extension. */
const FILE_NAMES: Readonly<Record<string, Language>> = {
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  Dockerfile: 'dockerfile',
  GNUmakefile: 'make',
  Makefile: 'make',
}

/** The language a file is highlighted in, by its name; null for a file the viewer shows as plain text. */
export function languageOf(path: string): Language | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const byName = FILE_NAMES[name]
  if (byName !== undefined) return byName
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? null : (EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null)
}

const THEME_NAME = 'glade'

/**
 * The design's code colours (`docs/design/html/08-open-file.html` and `docs/design/tokens.md`): keywords and headings
 * blue, strings and code blocks teal, numbers, types and inline code purple, comments and punctuation faint.
 */
export const GLADE_THEME: ThemeRegistration = {
  name: THEME_NAME,
  type: 'dark',
  fg: colors['--color-text'],
  bg: colors['--color-bg'],
  settings: [
    { settings: { foreground: colors['--color-text'], background: colors['--color-bg'] } },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: colors['--color-faint'], fontStyle: 'italic' },
    },
    {
      scope: ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.new', 'variable.language'],
      settings: { foreground: colors['--color-blue-text'] },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'markup.fenced_code.block', 'markup.raw.block'],
      settings: { foreground: colors['--color-teal'] },
    },
    {
      scope: [
        'constant.numeric',
        'constant.language',
        'constant.character',
        'support.type',
        'entity.name.type',
        'entity.name.class',
        'markup.inline.raw',
      ],
      settings: { foreground: colors['--color-purple'] },
    },
    {
      scope: ['markup.heading', 'entity.name.section', 'punctuation.definition.heading'],
      settings: { foreground: colors['--color-blue-text'], fontStyle: 'bold' },
    },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    {
      scope: ['punctuation.definition.table', 'markup.table punctuation', 'punctuation.separator.table'],
      settings: { foreground: colors['--color-faint'] },
    },
    { scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: colors['--color-blue-text'] } },
    { scope: ['markup.inserted'], settings: { foreground: colors['--color-teal'] } },
    { scope: ['markup.deleted', 'invalid'], settings: { foreground: colors['--color-pink'] } },
  ],
}

/** One run of text in one colour and style. */
export interface HighlightToken {
  readonly content: string
  /** A lowercase hex colour; the text colour when undefined. */
  readonly color: string | undefined
  readonly bold: boolean
  readonly italic: boolean
}

/** One line's tokens. An empty line has none. */
export type HighlightedLine = readonly HighlightToken[]

/** How many lines are highlighted between yields to the page. */
export const HIGHLIGHT_CHUNK_LINES = 100

/** Lines longer than this aren't highlighted, so one huge line (a minified file) can't hold the page up. */
const MAX_HIGHLIGHT_LINE_LENGTH = 2000

// Shiki's FontStyle bits.
const ITALIC = 1
const BOLD = 2

let highlighter: Promise<HighlighterCore> | undefined

async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ])
  return createHighlighterCore({
    themes: [GLADE_THEME],
    langs: [],
    // Forgiving: a grammar's rare regex the engine can't translate leaves that rule out rather than failing the file.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighter()
  return highlighter
}

function toToken({ content, color, fontStyle = 0 }: ThemedToken): HighlightToken {
  const hex = color?.toLowerCase()
  return {
    content,
    color: hex === colors['--color-text'] ? undefined : hex,
    bold: (fontStyle & BOLD) !== 0,
    italic: (fontStyle & ITALIC) !== 0,
  }
}

/** Lets the page paint and handle input before the next chunk. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A file's lines, as the viewer numbers them: a final newline ends the last line rather than starting another. */
export function sourceLines(text: string): readonly string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Highlights `lines` in `language`, a chunk of lines at a time: each chunk's tokens go to `onLines` with the index of
 * its first line, and the page gets a turn between chunks. Stops early, without calling `onLines` again, once `signal`
 * is aborted.
 */
export async function highlight(
  lines: readonly string[],
  language: Language,
  onLines: (start: number, highlighted: readonly HighlightedLine[]) => void,
  signal: AbortSignal,
): Promise<void> {
  const shiki = await getHighlighter()
  await shiki.loadLanguage(LANGUAGES[language]())
  let grammarState: GrammarState | undefined
  for (let start = 0; start < lines.length; start += HIGHLIGHT_CHUNK_LINES) {
    if (signal.aborted) return
    const chunk = lines.slice(start, start + HIGHLIGHT_CHUNK_LINES).join('\n')
    const result = shiki.codeToTokens(chunk, {
      lang: language,
      theme: THEME_NAME,
      grammarState,
      tokenizeMaxLineLength: MAX_HIGHLIGHT_LINE_LENGTH,
    })
    grammarState = result.grammarState
    onLines(
      start,
      result.tokens.map((line) => line.map(toToken)),
    )
    await nextTask()
  }
}
