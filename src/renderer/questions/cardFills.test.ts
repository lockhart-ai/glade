// The question card and the permission card sit on the fill and border of every agent reply, and nothing of their own
// inside them sits on the window's black (#538). The cards were left grey when the replies turned purple (#410), since
// each has a stylesheet of its own: this pins them to the reply's tokens, so they can't drift apart again. Vitest
// blanks CSS (even `?raw`), so this reads the stylesheets from disk; the e2e specs (e2e/questions.spec.ts,
// e2e/permissions.spec.ts) check what the real app draws.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const chatCss = readFileSync(join(here, '../chat/Chat.module.css'), 'utf8')
const permissionCss = readFileSync(join(here, '../permissions/PermissionCard.module.css'), 'utf8')
const questionCss = readFileSync(join(here, 'QuestionCard.module.css'), 'utf8')

/** A stylesheet without its comments. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The declarations of every rule whose selector list names `selector` exactly, in order: property → value. */
function declarations(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, selectors = '', body = ''] of withoutComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      !selectors
        .split(',')
        .map((each) => each.trim())
        .includes(selector)
    )
      continue
    for (const [, property = '', value = ''] of body.matchAll(/([\w-]+):\s*([^;]+);/g)) found.set(property, value)
  }
  return found
}

/** A rule's border colour, whether it's set alone or in the `border` shorthand. */
function borderColor(rule: Map<string, string>): string | undefined {
  return rule.get('border-color') ?? rule.get('border')?.replace(/^1px solid /, '')
}

const SURFACE = 'var(--color-question-surface)'
const SURFACE_BORDER = 'var(--color-question-surface-border)'

describe('the reply card', () => {
  it('is on the question highlight', () => {
    const reply = declarations(chatCss, '.question')
    expect(reply.get('background')).toBe('var(--color-question-bg)')
    expect(borderColor(reply)).toBe('var(--color-question-border)')
  })
})

describe('the question card', () => {
  const reply = declarations(chatCss, '.question')
  const card = declarations(questionCss, '.card')

  it("has the reply's fill and border, open or closed", () => {
    expect(card.get('background')).toBe(reply.get('background'))
    expect(borderColor(card)).toBe(borderColor(reply))
    // No state of the card changes either: not answered, skipped or withdrawn.
    for (const state of ['.withdrawn', '.appearing', '.justClosed']) {
      const rule = declarations(questionCss, state)
      expect(rule.has('background'), state).toBe(false)
      expect(borderColor(rule), state).toBeUndefined()
    }
  })

  it("rules its preamble off with the card's border", () => {
    expect(declarations(questionCss, '.preamble').get('border-bottom')).toBe(`1px solid ${String(borderColor(reply))}`)
  })

  it.each(['.option', '.pill'])('puts %s on the surface inside the card', (selector) => {
    const rule = declarations(questionCss, selector)
    expect(rule.get('background')).toBe(SURFACE)
    expect(borderColor(rule)).toBe(SURFACE_BORDER)
  })

  it('puts its fields on the surface too, over the inset colour a field has elsewhere', () => {
    for (const selector of ['.card .text', '.card .anythingElse']) {
      const rule = declarations(questionCss, selector)
      expect(rule.get('background'), selector).toBe(SURFACE)
      expect(borderColor(rule), selector).toBe(SURFACE_BORDER)
    }
    expect(borderColor(declarations(questionCss, '.card .text:focus-within'))).toBe('var(--color-question-outline)')
    expect(borderColor(declarations(questionCss, '.card .anythingElse:focus'))).toBe('var(--color-question-outline)')
  })

  it('fills a picked option a step lighter than the others, outlined, under the pointer too', () => {
    for (const selector of ['.option.checked', '.pill.checked', '.option.checked:hover', '.pill.checked:hover']) {
      const rule = declarations(questionCss, selector)
      expect(rule.get('background'), selector).toBe('var(--color-question-border)')
      expect(borderColor(rule), selector).toBe('var(--color-question-outline)')
    }
  })

  it("mixes a sketch's fill from the surface and the picked fill, so it's never darker than the card", () => {
    expect(declarations(questionCss, '.sketch').get('background')).toBe(
      'color-mix(in srgb, var(--color-question-surface), var(--color-question-border) 33%)',
    )
  })
})

describe('the permission card', () => {
  const reply = declarations(chatCss, '.question')

  it("has the reply's fill and border while it waits", () => {
    expect(declarations(permissionCss, '.card').get('background')).toBe(reply.get('background'))
    // A permission card is in the chat only while it's open (#459).
    expect(borderColor(declarations(permissionCss, '.open'))).toBe(borderColor(reply))
  })

  it.each(['.titleSubject', '.block', '.grantSubject', '.card .note'])(
    'puts %s on the surface inside the card',
    (selector) => {
      const rule = declarations(permissionCss, selector)
      expect(rule.get('background')).toBe(SURFACE)
      expect(borderColor(rule)).toBe(SURFACE_BORDER)
    },
  )

  it('keeps pink for removed lines and teal for added ones', () => {
    expect(declarations(permissionCss, '.removed').get('color')).toBe('var(--color-pink)')
    expect(declarations(permissionCss, '.added').get('color')).toBe('var(--color-teal)')
  })
})

describe.each([
  ['question', questionCss],
  ['permission', permissionCss],
])('the %s card', (_name, css) => {
  it("fills nothing with the window's black, or with a nested card's grey", () => {
    const fills = [...withoutComments(css).matchAll(/background(?:-color)?:\s*([^;]+);/g)].map(([, value]) => value)
    expect(fills.length).toBeGreaterThan(0)
    for (const fill of fills) {
      expect(fill).not.toContain('--color-bg')
      expect(fill).not.toContain('--color-inner')
    }
  })
})
