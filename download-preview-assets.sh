#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# download-preview-assets.sh
# Run once on the VPS (or locally then rsync) to fetch and optimise
# all images referenced by the 6 preview templates.
#
# Usage:
#   chmod +x download-preview-assets.sh
#   ./download-preview-assets.sh
#
# Requires: curl, jpegoptim (apt install jpegoptim)
# Output:   /var/www/previews/assets/previews/{shared,general,...}/
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

BASE="/var/www/previews/assets/previews"
HERO_MAX_KB=200
FULLBLEED_MAX_KB=160
PROJECT_MAX_KB=90
SECTOR_MAX_KB=90
AVATAR_MAX_KB=20

mkdir -p \
  "$BASE/shared" \
  "$BASE/general" \
  "$BASE/electrical" \
  "$BASE/plumbing" \
  "$BASE/hvac" \
  "$BASE/concreting" \
  "$BASE/landscaping"

download_and_compress() {
  local local_path="$1"
  local url="$2"
  local max_kb="$3"
  local dest="${BASE}${local_path#/assets/previews}"

  if [ -f "$dest" ]; then
    local existing_size_kb
    existing_size_kb=$(du -k "$dest" | cut -f1)
    if [ "$existing_size_kb" -le "$max_kb" ]; then
      echo "  skip  $local_path (exists, ${existing_size_kb}KB)"
      return
    fi

    echo "  fix   $local_path (${existing_size_kb}KB > ${max_kb}KB)"
    compress_to_target "$dest" "$max_kb"
    echo "  ok    $local_path ($(du -k "$dest" | cut -f1)KB)"
    return
  fi

  echo "  fetch $local_path"
  curl -fsSL --max-time 30 \
    -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" \
    -H "Referer: https://unsplash.com/" \
    "$url" -o "$dest"

  compress_to_target "$dest" "$max_kb"
  echo "  ok    $local_path ($(du -k "$dest" | cut -f1)KB)"
}

compress_to_target() {
  local dest="$1"
  local max_kb="$2"
  local size_kb

  jpegoptim --max=82 --size="${max_kb}k" --strip-all --quiet "$dest" || true

  size_kb=$(du -k "$dest" | cut -f1)
  if [ "$size_kb" -gt "$max_kb" ]; then
    echo "  WARN  $local_path is ${size_kb}KB (target ${max_kb}KB) — try higher jpegoptim compression"
    jpegoptim --max=70 --size="${max_kb}k" --strip-all --quiet "$dest" || true
  fi

  size_kb=$(du -k "$dest" | cut -f1)
  if [ "$size_kb" -gt "$max_kb" ]; then
    jpegoptim --max=60 --size="${max_kb}k" --strip-all --quiet "$dest" || true
  fi

  size_kb=$(du -k "$dest" | cut -f1)
  if [ "$size_kb" -gt "$max_kb" ]; then
    jpegoptim --max=50 --size="${max_kb}k" --strip-all --quiet "$dest" || true
  fi

  size_kb=$(du -k "$dest" | cut -f1)
  if [ "$size_kb" -gt "$max_kb" ]; then
    jpegoptim --max=40 --size="${max_kb}k" --strip-all --quiet "$dest" || true
  fi
}

echo "── Shared assets ────────────────────────────────────────────"
download_and_compress "/assets/previews/shared/avatar-1.jpg"           "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=120&h=120&q=85&auto=format&fit=crop&crop=face" $AVATAR_MAX_KB
download_and_compress "/assets/previews/shared/avatar-2.jpg"           "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=120&h=120&q=85&auto=format&fit=crop&crop=face" $AVATAR_MAX_KB
download_and_compress "/assets/previews/shared/avatar-3.jpg"           "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=120&h=120&q=85&auto=format&fit=crop&crop=face"   $AVATAR_MAX_KB
download_and_compress "/assets/previews/shared/sector-residential.jpg" "https://images.unsplash.com/photo-1600210492493-0946911123ea?w=800&q=75&auto=format&fit=crop"                $SECTOR_MAX_KB
download_and_compress "/assets/previews/shared/sector-commercial.jpg"  "https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&q=75&auto=format&fit=crop"                 $SECTOR_MAX_KB
download_and_compress "/assets/previews/shared/sector-hospitality.jpg" "https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=800&q=75&auto=format&fit=crop"                 $SECTOR_MAX_KB
download_and_compress "/assets/previews/shared/sector-civic.jpg"       "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=800&q=75&auto=format&fit=crop"                 $SECTOR_MAX_KB
download_and_compress "/assets/previews/shared/sector-healthcare.jpg"  "https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=800&q=75&auto=format&fit=crop"                    $SECTOR_MAX_KB

echo "── General ──────────────────────────────────────────────────"
download_and_compress "/assets/previews/general/hero.jpg"        "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1400&q=80&auto=format&fit=crop" $HERO_MAX_KB
download_and_compress "/assets/previews/general/fullbleed-1.jpg" "https://images.unsplash.com/photo-1541123437800-1bb1317badc2?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/general/fullbleed-2.jpg" "https://images.unsplash.com/photo-1503387762-592deb58ef4e?w=1200&q=78&auto=format&fit=crop"   $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/general/project-1.jpg"   "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/general/project-2.jpg"   "https://images.unsplash.com/photo-1497366216548-37526070297c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/general/project-3.jpg"   "https://images.unsplash.com/photo-1600210492493-0946911123ea?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/general/project-4.jpg"   "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/general/project-5.jpg"   "https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB

echo "── Electrical ───────────────────────────────────────────────"
download_and_compress "/assets/previews/electrical/hero.jpg"        "https://images.unsplash.com/photo-1621905251918-48416bd8575a?w=1400&q=80&auto=format&fit=crop" $HERO_MAX_KB
download_and_compress "/assets/previews/electrical/fullbleed-1.jpg" "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&q=78&auto=format&fit=crop"   $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/electrical/fullbleed-2.jpg" "https://images.unsplash.com/photo-1581092335397-9583eb92d232?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/electrical/project-1.jpg"   "https://images.unsplash.com/photo-1565814636199-ae8133055c1c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/electrical/project-2.jpg"   "https://images.unsplash.com/photo-1497366216548-37526070297c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/electrical/project-3.jpg"   "https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/electrical/project-4.jpg"   "https://images.unsplash.com/photo-1600607686527-6fb886090705?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/electrical/project-5.jpg"   "https://images.unsplash.com/photo-1509391366360-2e959784a276?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB

echo "── Plumbing ─────────────────────────────────────────────────"
download_and_compress "/assets/previews/plumbing/hero.jpg"        "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=1400&q=80&auto=format&fit=crop"   $HERO_MAX_KB
download_and_compress "/assets/previews/plumbing/fullbleed-1.jpg" "https://images.unsplash.com/photo-1507652313519-d4e9174996dd?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/plumbing/fullbleed-2.jpg" "https://images.unsplash.com/photo-1540518614846-7eded433c457?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/plumbing/project-1.jpg"   "https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=700&q=75&auto=format&fit=crop"    $PROJECT_MAX_KB
download_and_compress "/assets/previews/plumbing/project-2.jpg"   "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/plumbing/project-3.jpg"   "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/plumbing/project-4.jpg"   "https://images.unsplash.com/photo-1583608205776-bfd35f0d9f83?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/plumbing/project-5.jpg"   "https://images.unsplash.com/photo-1600607686527-6fb886090705?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB

echo "── HVAC ─────────────────────────────────────────────────────"
download_and_compress "/assets/previews/hvac/hero.jpg"        "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=1400&q=80&auto=format&fit=crop" $HERO_MAX_KB
download_and_compress "/assets/previews/hvac/fullbleed-1.jpg" "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&q=78&auto=format&fit=crop"   $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/hvac/fullbleed-2.jpg" "https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/hvac/project-1.jpg"   "https://images.unsplash.com/photo-1600210492493-0946911123ea?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/hvac/project-2.jpg"   "https://images.unsplash.com/photo-1497366216548-37526070297c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/hvac/project-3.jpg"   "https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/hvac/project-4.jpg"   "https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=700&q=75&auto=format&fit=crop"    $PROJECT_MAX_KB
download_and_compress "/assets/previews/hvac/project-5.jpg"   "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB

echo "── Concreting ───────────────────────────────────────────────"
download_and_compress "/assets/previews/concreting/hero.jpg"        "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1400&q=80&auto=format&fit=crop" $HERO_MAX_KB
download_and_compress "/assets/previews/concreting/fullbleed-1.jpg" "https://images.unsplash.com/photo-1572120360610-d971b9d7767c?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/concreting/fullbleed-2.jpg" "https://images.unsplash.com/photo-1541123437800-1bb1317badc2?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/concreting/project-1.jpg"   "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/concreting/project-2.jpg"   "https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/concreting/project-3.jpg"   "https://images.unsplash.com/photo-1572120360610-d971b9d7767c?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/concreting/project-4.jpg"   "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/concreting/project-5.jpg"   "https://images.unsplash.com/photo-1541123437800-1bb1317badc2?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB

echo "── Landscaping ──────────────────────────────────────────────"
download_and_compress "/assets/previews/landscaping/hero.jpg"        "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=1400&q=80&auto=format&fit=crop" $HERO_MAX_KB
download_and_compress "/assets/previews/landscaping/fullbleed-1.jpg" "https://images.unsplash.com/photo-1585320806297-9794b3e4eeae?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/landscaping/fullbleed-2.jpg" "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=78&auto=format&fit=crop" $FULLBLEED_MAX_KB
download_and_compress "/assets/previews/landscaping/project-1.jpg"   "https://images.unsplash.com/photo-1585320806297-9794b3e4eeae?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/landscaping/project-2.jpg"   "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/landscaping/project-3.jpg"   "https://images.unsplash.com/photo-1566438480900-0609be27a4be?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/landscaping/project-4.jpg"   "https://images.unsplash.com/photo-1463936575829-25148e1db1b8?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB
download_and_compress "/assets/previews/landscaping/project-5.jpg"   "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=700&q=75&auto=format&fit=crop"  $PROJECT_MAX_KB

echo ""
echo "── Audit ────────────────────────────────────────────────────"
echo "Total files: $(find "$BASE" -name '*.jpg' | wc -l)"
echo "Total size:  $(du -sh "$BASE" | cut -f1)"
echo ""
echo "Files over 200KB (should be none):"
find "$BASE" -name '*.jpg' -size +200k -exec du -k {} \; | sort -rn || echo "  none"
echo ""
echo "Done. Set correct ownership:"
echo "  sudo chown -R www-data:www-data /var/www/previews/assets/"
