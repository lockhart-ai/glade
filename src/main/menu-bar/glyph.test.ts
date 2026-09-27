import { describe, expect, it } from 'vitest'
import { GLYPH_FILES, GLYPHS, Glyph, glyphFor, isTemplateGlyph, MenuBarAppearance } from './glyph'

describe('glyphFor', () => {
  it('is the plain glyph while nothing needs you, on either menu bar', () => {
    expect(glyphFor(false, MenuBarAppearance.Dark)).toBe(Glyph.Plain)
    expect(glyphFor(false, MenuBarAppearance.Light)).toBe(Glyph.Plain)
  })

  it("has the dot while something needs you, drawn for the menu bar's appearance", () => {
    expect(glyphFor(true, MenuBarAppearance.Dark)).toBe(Glyph.DotOnDark)
    expect(glyphFor(true, MenuBarAppearance.Light)).toBe(Glyph.DotOnLight)
  })
})

describe('isTemplateGlyph', () => {
  it('makes only the plain glyph a template: the dot has a colour, which a template would lose', () => {
    expect(GLYPHS.filter(isTemplateGlyph)).toEqual([Glyph.Plain])
  })
})

describe('GLYPH_FILES', () => {
  it('names every glyph, each its own file, a template by its name only when it is one', () => {
    expect(GLYPHS).toEqual(Object.values(Glyph))
    expect(new Set(GLYPHS.map((glyph) => GLYPH_FILES[glyph])).size).toBe(GLYPHS.length)
    for (const glyph of GLYPHS) expect(GLYPH_FILES[glyph].includes('Template')).toBe(isTemplateGlyph(glyph))
  })
})
