import { describe, expect, it } from 'vitest'
import tokensMd from '../../docs/design/tokens.md?raw'
import tokensCss from './tokens.css?raw'
import { contrastRatio } from './contrast'
import { colors, type ColorToken } from './tokens'

/** Every `--name: value;` declaration in tokens.css. */
function cssDeclarations(): Map<string, string> {
  return new Map([...tokensCss.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [name, value]))
}

describe('tokens.css', () => {
  it('declares the same colours as tokens.ts', () => {
    const cssColors = Object.fromEntries([...cssDeclarations()].filter(([name]) => name.startsWith('--color-')))

    expect(cssColors).toEqual(colors)
  })

  it('has a colour variable for every colour in tokens.md', () => {
    // Rows of the colour table whose token is written as code, e.g. | `bg` | `#0A0B0F` | ... |
    const rows = [...tokensMd.matchAll(/^\| `([\w-]+)` \| `(#[0-9A-F]{6})` \|/gim)]
    expect(rows.length).toBeGreaterThan(0)
    for (const [, name = '', hex = ''] of rows) {
      expect(cssDeclarations().get(`--color-${name}`), name).toBe(hex.toLowerCase())
    }

    // The rows described in prose.
    expect(tokensMd).toContain('`#8FB2F5` for text on dark')
    expect(tokensMd).toContain('| user bubble | `#22304D` |')
    expect(tokensMd).toContain('| question highlight | `#1E1B33` / `#3B3366` |')
    expect(colors['--color-blue-text']).toBe('#8fb2f5')
    expect(colors['--color-user-bubble']).toBe('#22304d')
    expect(colors['--color-question-bg']).toBe('#1e1b33')
    expect(colors['--color-question-border']).toBe('#3b3366')
  })

  it('declares the type, shape and spacing tokens from tokens.md', () => {
    expect(Object.fromEntries(cssDeclarations())).toMatchObject({
      '--font-sans': 'Geist, system-ui, sans-serif',
      '--font-mono': "'Geist Mono', ui-monospace, monospace",
      '--font-size-title': '26px',
      '--font-weight-title': '600',
      '--font-size-chat': '14.5px',
      '--line-height-chat': '1.6',
      '--font-size-body': '14px',
      '--font-size-secondary': '13px',
      '--font-size-secondary-sm': '12.5px',
      '--font-size-label': '11px',
      '--letter-spacing-label': '0.08em',
      '--space-outer': '12px',
      '--radius-card': '16px',
      '--radius-nested': '12px',
      '--radius-button': '8px',
      '--radius-button-sm': '7px',
      '--radius-pill': '13px',
      '--radius-menu': '10px',
      '--shadow-nested': '0 6px 20px rgba(0, 0, 0, 0.25)',
      '--shadow-menu': '0 16px 40px rgba(0, 0, 0, 0.55)',
      '--touch-target-dense': '28px',
      '--touch-target-send': '44px',
    })
  })

  it('loads Geist and Geist Mono from bundled files only', () => {
    const sources = [...tokensCss.matchAll(/url\(([^)]+)\)/g)].map(([, url]) => url)

    expect(sources).toEqual(["'./assets/fonts/Geist-Variable.woff2'", "'./assets/fonts/GeistMono-Variable.woff2'"])
  })
})

describe('text contrast', () => {
  const textColors: ColorToken[] = ['--color-text', '--color-muted', '--color-faint']
  const backgrounds: ColorToken[] = [
    '--color-bg',
    '--color-panel',
    '--color-raised',
    '--color-inner',
    '--color-inner-2',
  ]

  // Documented pairings below 4.5:1, reported rather than changing the token. Keyed `text on background`.
  const knownExceptions = new Set(['--color-faint on --color-inner-2'])

  for (const text of textColors) {
    for (const background of backgrounds) {
      const pairing = `${text} on ${background}`
      const ratio = contrastRatio(colors[text], colors[background])

      if (knownExceptions.has(pairing)) {
        it(`${pairing} is a known exception below 4.5:1`, () => {
          expect(ratio).toBeLessThan(4.5)
        })
      } else {
        it(`${pairing} meets 4.5:1`, () => {
          expect(ratio).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
  }
})
