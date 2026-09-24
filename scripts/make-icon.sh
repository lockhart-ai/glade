#!/bin/sh
# Builds build/icon.icns (the macOS app icon electron-builder packages) from assets/icon/glade-icon.svg.
#
# The .icns is committed, so packaging doesn't run this. Rerun it after changing the SVG, then commit the result:
#
#   scripts/make-icon.sh
#
# Uses only macOS built-in tools: `sips` rasterises the SVG at each size and `iconutil` packs the iconset.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
svg="$root/assets/icon/glade-icon.svg"
out="$root/build/icon.icns"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
iconset="$work/icon.iconset"
mkdir "$iconset"

# Render the SVG once at full size, then scale down, so every size comes from the same raster.
sips -s format png "$svg" --out "$work/icon-1024.png" >/dev/null

for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

mkdir -p "$(dirname "$out")"
iconutil -c icns "$iconset" -o "$out"
echo "Wrote $out"
