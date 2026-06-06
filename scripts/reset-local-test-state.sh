#!/usr/bin/env bash
set -euo pipefail

# Cache root resolution:
#   1. RESET_CACHE_ROOT env var (passed by serve-review-assets.mjs /reset-test-data route)
#   2. WORKFLOW_DATA_ROOT env var + /.n8n-local-cache
#   3. Script-relative fallback: <repo-root>/.n8n-local-cache
if [[ -n "${RESET_CACHE_ROOT:-}" ]]; then
  CACHE_DIR="$RESET_CACHE_ROOT"
elif [[ -n "${WORKFLOW_DATA_ROOT:-}" ]]; then
  CACHE_DIR="$WORKFLOW_DATA_ROOT/.n8n-local-cache"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  CACHE_DIR="$ROOT/.n8n-local-cache"
fi

BACKUP_DIR="${CACHE_DIR%/.n8n-local-cache}/.n8n-local-cache-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_DIR/cache-before-project-reset-$STAMP.tar.gz"

echo "Cache root: $CACHE_DIR"
mkdir -p "$CACHE_DIR" "$BACKUP_DIR"

if find "$CACHE_DIR" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
  tar -czf "$BACKUP" -C "$(dirname "$CACHE_DIR")" "$(basename "$CACHE_DIR")"
  echo "Backed up to: $BACKUP"
else
  echo "Cache already empty; no backup needed."
fi

DIRS=(
  project-state
  concept-context
  review-context
  review-progress
  selected-concepts
  uploaded-product-images
  input-images
  nanobanana
  panels
  final-video
  gemini-requests
  gemini-responses
  gemini-text-requests
  gemini-text-responses
  script-context
  concept-revisions
  project-notes
  project-feedback
  text-model-requests
  text-model-responses
  stale
)

for dir in "${DIRS[@]}"; do
  target="$CACHE_DIR/$dir"
  mkdir -p "$target"
  find "$target" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
done

# Remove project-history.json (project list sidebar)
if [[ -f "$CACHE_DIR/project-history.json" ]]; then
  rm -f "$CACHE_DIR/project-history.json"
  echo "Removed project-history.json"
fi

echo "Reset complete. Remaining files: $(find "$CACHE_DIR" -type f | wc -l | tr -d ' ')"
