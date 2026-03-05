#!/bin/bash
set -e

VERSION=$1

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 0.2.0"
  exit 1
fi

TAG="v${VERSION}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Update tauri.conf.json
sed -i '' "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" "$ROOT_DIR/src-tauri/tauri.conf.json"

# Update Cargo.toml
sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" "$ROOT_DIR/src-tauri/Cargo.toml"

# Update npm-pkg/package.json
node -e "
  const fs = require('fs');
  const path = '$ROOT_DIR/npm-pkg/package.json';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log('Updated npm-pkg to v$VERSION');
"

# Sync Cargo.lock
(cd "$ROOT_DIR/src-tauri" && cargo generate-lockfile)

# Commit version bump
if ! git diff --quiet; then
  git add \
    "$ROOT_DIR/src-tauri/tauri.conf.json" \
    "$ROOT_DIR/src-tauri/Cargo.toml" \
    "$ROOT_DIR/src-tauri/Cargo.lock" \
    "$ROOT_DIR/npm-pkg/package.json"
  git commit -m "chore: bump version to ${VERSION}"
fi

# Delete existing release + tag if it exists
if gh release view "$TAG" &>/dev/null; then
  echo "Deleting existing release $TAG..."
  gh release delete "$TAG" --cleanup-tag --yes
  sleep 3
fi

if git rev-parse "$TAG" &>/dev/null; then
  git tag -d "$TAG" 2>/dev/null || true
fi
git push origin ":refs/tags/$TAG" 2>/dev/null || true

echo "Creating tag $TAG..."
git tag "$TAG"
git push origin main
git push origin "$TAG"

echo ""
echo "Done! Release $TAG will be built by GitHub Actions."
echo "Track progress: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:\/]\(.*\)\.git/\1/')/actions"
