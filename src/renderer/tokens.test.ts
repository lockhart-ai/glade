import { describe, expect, it } from 'vitest'
import tokensMd from '../../docs/design/tokens.md?raw'
import tokensCss from './tokens.css?raw'
import { contrastRatio, relativeLuminance } from './contrast'
import { colors, scrollbarTokens, type ColorToken } from './tokens'

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
      '--font-size-title': '20px',
      '--font-weight-title': '600',
      '--font-size-chat': '14.5px',
      '--line-height-chat': '1.6',
      '--font-size-body': '14px',
      '--font-size-secondary': '13px',
      '--font-size-secondary-sm': '12.5px',
      '--font-size-label': '11px',
      '--letter-spacing-label': '0.08em',
      '--space-outer': 'var(--space-md)',
      '--space-inset': 'var(--space-md)',
      '--space-item': 'var(--space-md)',
      '--radius-card': '16px',
      '--radius-nested': '12px',
      '--radius-button': '8px',
      '--radius-button-sm': '7px',
      '--radius-pill': '13px',
      '--radius-menu': '10px',
      '--shadow-nested': '0 6px 20px rgba(0, 0, 0, 0.25)',
      '--shadow-menu': '0 16px 40px rgba(0, 0, 0, 0.55)',
      '--shadow-toast': '0 12px 32px rgba(0, 0, 0, 0.45)',
      '--touch-target-dense': '28px',
      '--touch-target-send': '44px',
    })
  })

  it('has a spacing variable for every step of the scale in tokens.md', () => {
    // Rows of the spacing table, e.g. | `space-md` | 8 |
    const rows = [...tokensMd.matchAll(/^\| `(space-[\w-]+)` \| (\d+) \|$/gm)]
    expect(rows.map(([, name = '', px = '']) => [`--${name}`, `${px}px`])).toEqual([
      ['--space-2xs', '2px'],
      ['--space-xs', '4px'],
      ['--space-sm', '6px'],
      ['--space-md', '8px'],
      ['--space-lg', '12px'],
      ['--space-xl', '16px'],
      ['--space-2xl', '24px'],
    ])
    for (const [, name = '', px = ''] of rows) {
      expect(cssDeclarations().get(`--${name}`), name).toBe(`${px}px`)
    }
  })

  it('builds the outer padding and the shared panel inset from the scale, 8px each', () => {
    const resolve = (name: string): string | undefined => {
      const value = cssDeclarations().get(name)
      const reference = /^var\((--[\w-]+)\)$/.exec(value ?? '')
      return reference === null ? value : resolve(reference[1] ?? '')
    }
    expect(resolve('--space-outer')).toBe('8px')
    expect(resolve('--space-inset')).toBe('8px')
    expect(resolve('--space-item')).toBe('8px')
    expect(tokensMd).toContain('`space-outer` = 8')
    expect(tokensMd).toContain('`space-inset` = 8')
    expect(tokensMd).toContain('`space-item` = 8')
  })

  it('declares the motion tokens from tokens.md, easing out', () => {
    // Rows of the motion table, e.g. | `motion-duration` | 200ms | ... |
    const rows = [...tokensMd.matchAll(/^\| `(motion-[\w-]+)` \| `?([^`|]+?)`? \|/gm)]
    expect(rows.map(([, name = '', value = '']) => [`--${name}`, value])).toEqual([
      ['--motion-duration', '200ms'],
      ['--motion-duration-fast', '120ms'],
      ['--motion-ease', 'cubic-bezier(0.2, 0, 0, 1)'],
    ])
    for (const [, name = '', value = ''] of rows) {
      expect(tokensCss, name).toContain(`--${name}: ${value};`)
    }
  })

  it('sets every motion duration to 0 with Reduce motion on, so nothing moves', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/.exec(tokensCss)?.[1] ?? ''
    expect(reduced).toContain('--motion-duration: 0ms;')
    expect(reduced).toContain('--motion-duration-fast: 0ms;')
    expect(tokensMd).toContain('**Reduce motion**')
  })

  it('registers --panel-open as a number that starts open, so panels animate it', () => {
    expect(tokensCss).toMatch(
      /@property --panel-open \{\s*syntax: '<number>';\s*inherits: false;\s*initial-value: 1;\s*\}/,
    )
  })

  it('loads Geist and Geist Mono from bundled files only', () => {
    const sources = [...tokensCss.matchAll(/url\(([^)]+)\)/g)].map(([, url]) => url)

    expect(sources).toEqual(["'./assets/fonts/Geist-Variable.woff2'", "'./assets/fonts/GeistMono-Variable.woff2'"])
  })
})

describe('scroll bar tokens', () => {
  it('declares the scroll bar tokens from tokens.md', () => {
    // Rows of the scroll bar table, e.g. | `scrollbar-size` | 10px | ... | or | `scrollbar-thumb` | `strong` | ... |
    const rows = [...tokensMd.matchAll(/^\| `(scrollbar-[\w-]+)` \| `?([^`|]+?)`? \|/gm)].map(
      ([, name = '', value = '']) => [`--${name}`, value.endsWith('px') ? value : `var(--color-${value})`],
    )
    expect(rows).toEqual([
      ['--scrollbar-size', '10px'],
      ['--scrollbar-inset', '2px'],
      ['--scrollbar-thumb-min', '32px'],
      ['--scrollbar-thumb', 'var(--color-strong)'],
      ['--scrollbar-thumb-hover', 'var(--color-slate)'],
      ['--scrollbar-thumb-active', 'var(--color-faint)'],
    ])
    for (const [name = '', value] of rows) expect(cssDeclarations().get(name), name).toBe(value)
  })

  it('gives the terminal the same thumb colours as tokens.css', () => {
    expect(cssDeclarations().get('--scrollbar-thumb')).toBe(`var(${scrollbarTokens.thumb})`)
    expect(cssDeclarations().get('--scrollbar-thumb-hover')).toBe(`var(${scrollbarTokens.thumbHover})`)
    expect(cssDeclarations().get('--scrollbar-thumb-active')).toBe(`var(${scrollbarTokens.thumbActive})`)
  })

  it('lightens the thumb under the pointer, and again while it is dragged', () => {
    const { thumb, thumbHover, thumbActive } = scrollbarTokens
    expect(relativeLuminance(colors[thumbHover])).toBeGreaterThan(relativeLuminance(colors[thumb]))
    expect(relativeLuminance(colors[thumbActive])).toBeGreaterThan(relativeLuminance(colors[thumbHover]))
  })

  it('keeps the thumb standing off the surfaces that scroll', () => {
    const surfaces: readonly ColorToken[] = ['--color-bg', '--color-panel', '--color-inner', '--color-menu']
    for (const surface of surfaces) {
      expect(contrastRatio(colors[scrollbarTokens.thumb], colors[surface]), surface).toBeGreaterThanOrEqual(1.45)
    }
  })
})

/** A colour that sits on a surface, and the least WCAG contrast it must keep against it. */
interface ContrastFloor {
  readonly foreground: ColorToken
  readonly background: ColorToken
  readonly minimum: number
}

/**
 * Neighbouring surfaces, and the borders on the surfaces they sit on, from tokens.md's Contrast table. Raised in #226
 * so the cards stay distinct in bright light; each floor is above what the pair had before.
 */
const surfaceFloors: readonly ContrastFloor[] = [
  { foreground: '--color-panel', background: '--color-bg', minimum: 1.12 },
  { foreground: '--color-raised', background: '--color-panel', minimum: 1.15 },
  { foreground: '--color-inner', background: '--color-panel', minimum: 1.13 },
  { foreground: '--color-inner-2', background: '--color-inner', minimum: 1.21 },
  { foreground: '--color-menu', background: '--color-panel', minimum: 1.2 },
  { foreground: '--color-border', background: '--color-bg', minimum: 1.56 },
  { foreground: '--color-border', background: '--color-panel', minimum: 1.39 },
  { foreground: '--color-inner-border', background: '--color-panel', minimum: 1.6 },
  { foreground: '--color-inner-border', background: '--color-inner', minimum: 1.4 },
  { foreground: '--color-strong', background: '--color-panel', minimum: 1.78 },
  { foreground: '--color-strong', background: '--color-raised', minimum: 1.54 },
  { foreground: '--color-strong', background: '--color-inner', minimum: 1.56 },
]

/** `--color-inner-border` as tokens.md writes it, `inner-border`. */
function shortName(token: ColorToken): string {
  return token.replace(/^--color-/, '')
}

describe('surface contrast', () => {
  for (const { foreground, background, minimum } of surfaceFloors) {
    it(`${foreground} on ${background} is at least ${String(minimum)}:1`, () => {
      expect(contrastRatio(colors[foreground], colors[background])).toBeGreaterThanOrEqual(minimum)
    })
  }

  it('steps each surface lighter than the one it sits on', () => {
    for (const { foreground, background } of surfaceFloors) {
      expect(relativeLuminance(colors[foreground]), `${foreground} on ${background}`).toBeGreaterThan(
        relativeLuminance(colors[background]),
      )
    }
  })

  it('lists the same floors in tokens.md', () => {
    // Rows of the contrast table, e.g. | `panel` on `bg` | 1.12 |
    const rows = [...tokensMd.matchAll(/^\| `([\w-]+)` on `([\w-]+)` \| ([\d.]+) \|$/gm)]
    expect(
      rows.map(([, foreground = '', background = '', minimum = '']) => [foreground, background, Number(minimum)]),
    ).toEqual(
      surfaceFloors.map(({ foreground, background, minimum }) => [
        shortName(foreground),
        shortName(background),
        minimum,
      ]),
    )
  })
})

describe('text contrast', () => {
  const textColors: readonly ColorToken[] = ['--color-text', '--color-muted', '--color-faint']
  const surfaces: readonly ColorToken[] = [
    '--color-bg',
    '--color-panel',
    '--color-raised',
    '--color-inner',
    '--color-inner-2',
    '--color-menu',
  ]

  for (const text of textColors) {
    for (const surface of surfaces) {
      it(`${text} on ${surface} meets 4.5:1`, () => {
        expect(contrastRatio(colors[text], colors[surface])).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('has no known exceptions left in tokens.md', () => {
    expect(tokensMd).not.toMatch(/known exception/i)
    expect(tokensMd).toContain('`text`, `muted` and `faint` each meet 4.5:1 on every surface')
  })
})
