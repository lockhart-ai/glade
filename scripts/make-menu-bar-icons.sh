#!/bin/sh
# Draws the menu bar icon's glyph (docs/design/html/29-menu-bar.html) at each strength its pulse steps through, as
# macOS template images: assets/icon/menu-bar/glyph-<n>Template.png (18×18) and glyph-<n>Template@2x.png (36×36).
# The glyph is the three blades of assets/icon/glade-mark.svg in black; macOS draws a template image in the menu bar's
# own colour, so only its alpha counts. The strengths are GLYPH_STRENGTHS in src/main/menu-bar/pulse.ts, in order.
#
# The PNGs are committed, so packaging doesn't run this. Rerun it after changing the mark or the strengths, then commit
# the result:
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

# glyph <size> <opacity> <file>
glyph() {
  svg="$work/glyph.svg"
  cat >"$svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="$1" height="$1" viewBox="16 14 68 68"><g fill="#000000" fill-opacity="$2"><path d="M18.0 80 C18.0 62.9 24.5 49.6 38.0 42.0 C36.5 53.4 32.0 64.8 32.0 80Z"/><path d="M38.0 80 C38.0 56.6 45.5 38.4 60.0 28.0 C57.2 43.6 52.0 59.2 52.0 80Z"/><path d="M58.0 80 C58.0 51.2 66.5 28.8 82.0 16.0 C78.0 35.2 72.0 54.4 72.0 80Z"/></g></svg>
SVG
  sips -s format png "$svg" --out "$3" >/dev/null
}

frame=0
for strength in 1 0.78 0.55; do
  glyph 18 "$strength" "$out/glyph-${frame}Template.png"
  glyph 36 "$strength" "$out/glyph-${frame}Template@2x.png"
  frame=$((frame + 1))
done
echo "Wrote $out"
