#!/usr/bin/env bash
# Build the spell crafter as a static site and publish it to the fork's
# GitHub Pages (gh-pages branch). The demo has no backend: pages that
# need one are set aside for the build, demo mode (NEXT_PUBLIC_SPELL_DEMO)
# bundles the song list and seeds a starter experience, and the site is
# served under /conjurer.
#
#   ./scripts/deployDemo.sh           build + publish
#   ./scripts/deployDemo.sh --build   build only (out/)
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_URL=$(git remote get-url origin)

# Pages the static demo does not ship (API routes cannot be exported;
# the rest are the main app, which wants a backend).
STASH=$(mktemp -d)
PAGES=(api admin.tsx beatMapper.tsx experience index.tsx laws-of-conjury.tsx playground.tsx portal.tsx test.tsx viewer.tsx vj.tsx)
restore() {
  for page in "${PAGES[@]}"; do
    [ -e "$STASH/$page" ] && mv "$STASH/$page" "src/pages/$page"
  done
}
trap restore EXIT
for page in "${PAGES[@]}"; do
  mv "src/pages/$page" "$STASH/$page"
done

rm -rf out .next
NEXT_PUBLIC_SPELL_DEMO=1 yarn next build

# Only the demo song ships; other local uploads stay private.
find out/cloud-assets/audio -type f ! -name "no homework - shiny_2.mp3" -delete

# GitHub Pages: no Jekyll (folders starting with _), and / redirects to
# the editor.
touch out/.nojekyll
cat > out/index.html << 'HTML'
<!doctype html>
<meta http-equiv="refresh" content="0; url=./editor/" />
<a href="./editor/">Conjurer Spell Crafter</a>
HTML

if [ "${1:-}" = "--build" ]; then
  echo "Build only: out/ is ready."
  exit 0
fi

# Publish out/ as the gh-pages branch (fresh history each deploy).
(
  cd out
  rm -rf .git
  git init -q
  git checkout -qb gh-pages
  git add -A
  git commit -qm "Deploy Spell Crafter demo"
  git push -f "$REMOTE_URL" gh-pages
  rm -rf .git
)
echo "Published gh-pages to $REMOTE_URL"
