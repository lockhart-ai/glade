import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** global.css, read from disk: the test build hands out an empty module for stylesheets it imports. */
const globalCss = readFileSync(join(__dirname, 'global.css'), 'utf8')

/** The declarations of the global.css rule whose selector is exactly `selector`, e.g. `::-webkit-scrollbar-thumb`. */
function rule(selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(globalCss)?.[1]
}

/** Every stylesheet in the renderer, by its path from here, with its text. */
function stylesheets(): Map<string, string> {
  const sheets = new Map<string, string>()
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.css')) sheets.set(relative(__dirname, path), readFileSync(path, 'utf8'))
    }
  }
  walk(__dirname)
  return sheets
}

describe('global.css scroll bars', () => {
  it('gives every scroll bar the thin bar and transparent track of the design', () => {
    expect(rule('::-webkit-scrollbar')).toContain('width: var(--scrollbar-size);')
    expect(rule('::-webkit-scrollbar')).toContain('height: var(--scrollbar-size);')
    expect(rule('::-webkit-scrollbar')).toContain('background: transparent;')
    expect(rule('::-webkit-scrollbar-track,\n::-webkit-scrollbar-corner')).toContain('background: transparent;')
    expect(rule('::-webkit-scrollbar-button')).toContain('display: none;')
  })

  it('draws a rounded thumb inset in the bar, lighter under the pointer and while dragged', () => {
    const thumb = rule('::-webkit-scrollbar-thumb') ?? ''
    expect(thumb).toContain('background-color: var(--scrollbar-thumb);')
    expect(thumb).toContain('background-clip: padding-box;')
    expect(thumb).toContain('border: var(--scrollbar-inset) solid transparent;')
    expect(thumb).toContain('border-radius: var(--scrollbar-size);')
    expect(rule('::-webkit-scrollbar-thumb:vertical')).toContain('min-height: var(--scrollbar-thumb-min);')
    expect(rule('::-webkit-scrollbar-thumb:horizontal')).toContain('min-width: var(--scrollbar-thumb-min);')
    expect(rule('::-webkit-scrollbar-thumb:hover')).toContain('background-color: var(--scrollbar-thumb-hover);')
    expect(rule('::-webkit-scrollbar-thumb:active')).toContain('background-color: var(--scrollbar-thumb-active);')
  })

  it('styles scroll bars in one place: no component restyles them or turns the standard properties on', () => {
    // Chromium ignores ::-webkit-scrollbar wherever scrollbar-color or a scrollbar-width other than none is set (and
    // scrollbar-color inherits), so one stray declaration would bring back the default scroll bars under it.
    for (const [path, sheet] of stylesheets()) {
      const css = sheet.replace(/\/\*[\s\S]*?\*\//g, '')
      expect(css, path).not.toMatch(/scrollbar-color\s*:/)
      expect(css, path).not.toMatch(/scrollbar-width:\s*(?!\s|none;)/)
      if (path === 'global.css') continue
      // A component may only hide its bar outright (the panel tabs'), or move its track's ends in (the chat's, clear
      // of the header card); never restyle the bar.
      for (const [, selector = '', body = ''] of css.matchAll(/([^{}]*::-webkit-scrollbar[^{]*)\{([^}]*)\}/g)) {
        const declarations = body
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean)
        const where = `${path} ${selector.trim()}`
        if (selector.trim().endsWith('::-webkit-scrollbar-track')) {
          for (const declaration of declarations) expect(declaration, where).toMatch(/^margin-(top|bottom):/)
        } else {
          expect(selector.trim(), where).toMatch(/::-webkit-scrollbar$/)
          expect(declarations, where).toEqual(['display: none'])
        }
      }
    }
  })

  it('starts the chat’s scroll track below the header card it scrolls under', () => {
    const chat = stylesheets().get(join('chat', 'Chat.module.css')) ?? ''
    expect(chat).toMatch(/\.scroller \{[^}]*padding-top: var\(--task-header-clearance, 0px\);/)
    expect(chat).toMatch(
      /\.scroller::-webkit-scrollbar-track \{\s*margin-top: var\(--task-header-clearance, 0px\);\s*\}/,
    )
  })
})
