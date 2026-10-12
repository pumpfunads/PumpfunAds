#!/usr/bin/env bash
# Every icon and the link card, from brand/logo.png and brand/banner.png. Run from the repo root: bash brand/make-icons.sh
set -euo pipefail
P=web/public
T="$(mktemp -d)"
# The logo is the operator's raster (brand/logo.png, 500x500 on black: the green-to-white "ad" mark, 11 Oct 2026). Small
# sizes use a tight square crop around the artwork (box 314x252+93+124) so the mark stays legible at 16 px.
magick brand/logo.png -crop 334x334+83+83 +repage "$T/tight.png"
tile() { # size src out: rounded corners, transparent outside
  local r=$(( $1 / 5 ))
  magick "$2" -resize "$1x$1" \( -size "$1x$1" xc:none -fill white -draw "roundrectangle 0,0 $(( $1 - 1 )),$(( $1 - 1 )) $r,$r" \) -compose DstIn -composite -strip "$3"
}
tile 512 brand/logo.png $P/logo.png
tile 192 "$T/tight.png" $P/icon-192.png
# iOS rounds the icon itself: a full-bleed square.
magick "$T/tight.png" -resize 180x180 -strip $P/apple-touch-icon.png
# TRANSPARENT versions (operator, 10 Oct): the black square cut away (alpha = brightness, colour un-premultiplied).
#   logo-white.png  the mark as drawn (green to white): for dark backgrounds (the site, dark browser tabs)
#   logo-dark.png   the white end blends to near-black, the green deepens: for light backgrounds (light browser tabs)
magick brand/logo.png -alpha off \( +clone -fx 'max(r,max(g,b))' -level 6%,96% \) -alpha off -compose CopyOpacity -composite \
  -channel RGB -fx 'a>0.02 ? u/a : 0' +channel -trim +repage $P/logo-white.png
magick $P/logo-white.png -channel RGB -fx 'kk=min(1,(max(r,max(g,b))-min(r,min(g,b)))/0.45); kk*u*0.68+(1-kk)*0.04' +channel \
  -channel A -fx 'min(1,u*1.15)' +channel $P/logo-dark.png
sq() { magick "$1" -resize "$2x$2" -background none -gravity center -extent "$2x$2" -strip "$3"; } # square, transparent margin
sq $P/logo-white.png 128 $P/mark.png
# FAVICON (operator 12 Oct: "make the favicon transparent"): the mark cut out of its black, trimmed and centred on a
# transparent square, in every format. favicon.svg also switches by colour scheme (logo-dark on a light tab, where the
# white half of the mark would vanish); the PNG/ICO cannot switch, so they carry the mark as drawn.
magick $P/logo-white.png -trim +repage "$T/fav-w.png"; magick $P/logo-dark.png -trim +repage "$T/fav-d.png"
sq "$T/fav-w.png" 64 "$T/w64.png"; sq "$T/fav-d.png" 64 "$T/d64.png"
sq "$T/fav-w.png" 32 $P/favicon.png
sq "$T/fav-w.png" 16 "$T/f16.png"; sq "$T/fav-w.png" 48 "$T/f48.png"
magick "$T/f16.png" $P/favicon.png "$T/f48.png" $P/favicon.ico
cat > $P/favicon.svg <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>.d{display:none}@media (prefers-color-scheme:light){.w{display:none}.d{display:inline}}</style><image class="w" width="64" height="64" href="data:image/png;base64,$(base64 < "$T/w64.png" | tr -d '\n')"/><image class="d" width="64" height="64" href="data:image/png;base64,$(base64 < "$T/d64.png" | tr -d '\n')"/></svg>
SVG
# The link card (og:image / twitter:image, 1200x630), 11 Oct rebrand: the mark cut out of its black, a soft green glow,
# PUMPFUN ADS and the tagline under it. Barlow Condensed from brand/fonts.
magick -size 1200x630 xc:'#0A0A0B' -fill '#123a24' -draw "ellipse 600,190 260,150 0,360" -blur 0x100 \
  \( $P/logo-white.png -resize x190 \) -gravity north -geometry +0+70 -compose over -composite \
  -font brand/fonts/BarlowCondensed-Bold.ttf -pointsize 96 -fill '#F5F5F7' -gravity north -annotate +0+290 'PUMPFUN ADS' \
  -font brand/fonts/BarlowCondensed-Bold.ttf -pointsize 44 -fill '#86EFAC' -annotate +0+415 'WE BECOME YOUR MARKETING TEAM.' \
  -font brand/fonts/BarlowCondensed-Medium.ttf -pointsize 27 -fill '#9A9AA3' -annotate +0+480 "Launch on Pumpfun. Your coin's fees pay for its ads." \
  -strip $P/og.png
rm -rf "$T"
echo "icons and og.png written to $P"
