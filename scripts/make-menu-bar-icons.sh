#!/bin/sh
# Draws the menu bar icon's glyph (docs/design/html/29-menu-bar.html), each at 18×18 and, for Retina displays, 36×36
# (`@2x`), into assets/icon/menu-bar (GLYPH_FILES in src/main/menu-bar/glyph.ts names them):
#
# - glyphTemplate.png: the plain glyph, the three blades of assets/icon/glade-mark.svg in black, as a macOS template
#   image: macOS draws it in the menu bar's own colour, light or dark, so only its alpha counts.
# - glyph-dot-on-dark.png and glyph-dot-on-light.png: the glyph with the purple dot at its top right, while tasks need
#   you. A template image can't have a colour, so these are drawn for each menu bar: the glyph in the colour macOS draws
#   a template in on a dark bar (white) and on a light one (black), at 85% as it does, and the dot in `--color-purple`
#   (src/renderer/tokens.css), with a gap cut out of the glyph around it.
#
# The PNGs are committed, so packaging doesn't run this. Rerun it after changing the mark, the dot or the purple, then
# commit the result:
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

# Glade's Needs you purple, from the design tokens.
purple=$(sed -n 's/^ *--color-purple: *\(#[0-9a-fA-F]\{6\}\);.*/\1/p' "$root/src/renderer/tokens.css")
test -n "$purple"

blades='<path d="M18.0 80 C18.0 62.9 24.5 49.6 38.0 42.0 C36.5 53.4 32.0 64.8 32.0 80Z"/><path d="M38.0 80 C38.0 56.6 45.5 38.4 60.0 28.0 C57.2 43.6 52.0 59.2 52.0 80Z"/><path d="M58.0 80 C58.0 51.2 66.5 28.8 82.0 16.0 C78.0 35.2 72.0 54.4 72.0 80Z"/>'

# png <size> <svg body> <file>
png() {
  svg="$work/glyph.svg"
  cat >"$svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$1" height="$1" viewBox="16 14 68 68">$2</svg>
SVG
  sips -s format png "$svg" --out "$3" >/dev/null
}

# The plain glyph, a template.
plain="<g fill=\"#000000\">$blades</g>"

# dotted <glyph colour>: the glyph with the dot, the gap around the dot cut out of it.
dotted() {
  printf '%s' "<defs><mask id=\"gap\"><rect x=\"0\" y=\"0\" width=\"100\" height=\"100\" fill=\"#ffffff\"/><circle cx=\"72\" cy=\"24\" r=\"17\" fill=\"#000000\"/></mask></defs><g fill=\"$1\" fill-opacity=\"0.85\" mask=\"url(#gap)\">$blades</g><circle cx=\"72\" cy=\"24\" r=\"11\" fill=\"$purple\"/>"
}

for scale in 1 2; do
  size=$((18 * scale))
  suffix=$([ "$scale" = 2 ] && echo '@2x' || echo '')
  png "$size" "$plain" "$out/glyphTemplate$suffix.png"
  png "$size" "$(dotted '#ffffff')" "$out/glyph-dot-on-dark$suffix.png"
  png "$size" "$(dotted '#000000')" "$out/glyph-dot-on-light$suffix.png"
done
echo "Wrote $out"
