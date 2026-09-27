#!/bin/sh
# Draws the menu bar icon's glyph (docs/design/html/29-menu-bar.html) as a macOS template image:
# assets/icon/menu-bar/glyphTemplate.png (18×18) and glyphTemplate@2x.png (36×36), for Retina displays. The glyph is the
# three blades of assets/icon/glade-mark.svg in black; macOS draws a template image in the menu bar's own colour, light
# or dark, so only its alpha counts. GLYPH_FILE in src/main/menu-bar/electron.ts names it.
#
# The PNGs are committed, so packaging doesn't run this. Rerun it after changing the mark, then commit the result:
#
#   scripts/make-menu-bar-icons.sh
#
# Uses only macOS built-in tools: `sips` rasterises the SVG.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/assets/icon/menu-bar"
mkdir -p "$out"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# glyph <size> <file>
glyph() {
  svg="$work/glyph.svg"
  cat >"$svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$1" height="$1" viewBox="16 14 68 68"><g fill="#000000"><path d="M18.0 80 C18.0 62.9 24.5 49.6 38.0 42.0 C36.5 53.4 32.0 64.8 32.0 80Z"/><path d="M38.0 80 C38.0 56.6 45.5 38.4 60.0 28.0 C57.2 43.6 52.0 59.2 52.0 80Z"/><path d="M58.0 80 C58.0 51.2 66.5 28.8 82.0 16.0 C78.0 35.2 72.0 54.4 72.0 80Z"/></g></svg>
SVG
  sips -s format png "$svg" --out "$2" >/dev/null
}

glyph 18 "$out/glyphTemplate.png"
glyph 36 "$out/glyphTemplate@2x.png"
echo "Wrote $out"
