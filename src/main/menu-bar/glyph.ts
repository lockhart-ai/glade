/**
 * The menu bar icon's glyph (`docs/design/html/29-menu-bar.html`): Glade's mark, still, with a purple dot at its top
 * right while any task needs you.
 *
 * The plain glyph is a macOS template image, which macOS draws in the menu bar's own colour, light or dark. A template
 * can't have a colour, so the glyph with the dot is drawn for each: one for a dark menu bar and one for a light one,
 * picked by the system's appearance and swapped when it changes. `scripts/make-menu-bar-icons.sh` draws them all.
 */

/** Whether the menu bar is light or dark: the system's appearance (`nativeTheme.shouldUseDarkColors`). */
export enum MenuBarAppearance {
  Light = 'light',
  Dark = 'dark',
}

/** The images the icon shows. */
export enum Glyph {
  /** Nothing needs you: the plain glyph, a template image. */
  Plain = 'plain',
  /** Something needs you, on a dark menu bar: a light glyph with the dot. */
  DotOnDark = 'dot-on-dark',
  /** Something needs you, on a light menu bar: a dark glyph with the dot. */
  DotOnLight = 'dot-on-light',
}

/** Every glyph, in a fixed order. */
export const GLYPHS: readonly Glyph[] = [Glyph.Plain, Glyph.DotOnDark, Glyph.DotOnLight]

/**
 * Each glyph's file in `assets/icon/menu-bar`: its @1x image, 18×18. macOS picks the `@2x` beside it, 36×36, on a
 * Retina display. The plain glyph's `Template` names it a template image.
 */
export const GLYPH_FILES: Readonly<Record<Glyph, string>> = {
  [Glyph.Plain]: 'glyphTemplate.png',
  [Glyph.DotOnDark]: 'glyph-dot-on-dark.png',
  [Glyph.DotOnLight]: 'glyph-dot-on-light.png',
}

/** Whether a glyph is a template image, drawn in the menu bar's colour: only the plain one, which has no colour. */
export function isTemplateGlyph(glyph: Glyph): boolean {
  switch (glyph) {
    case Glyph.Plain:
      return true
    case Glyph.DotOnDark:
    case Glyph.DotOnLight:
      return false
  }
}

/** What the icon shows: the plain glyph, or while something needs you, the one with the dot for the menu bar. */
export function glyphFor(dot: boolean, appearance: MenuBarAppearance): Glyph {
  if (!dot) return Glyph.Plain
  switch (appearance) {
    case MenuBarAppearance.Dark:
      return Glyph.DotOnDark
    case MenuBarAppearance.Light:
      return Glyph.DotOnLight
  }
}
