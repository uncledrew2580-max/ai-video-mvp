#!/usr/bin/env bash
# sync-to-dist-app.sh
# Syncs current runtime files from source to dist/AI Video.app bundle.
#
# KEY PRESERVATION (default): api_key from the existing dist config is preserved.
# The user saves their key once via the running 8788 UI; sync does NOT overwrite it.
#
# Flags (mutually exclusive; --redact-key wins):
#   (no flag)         Sync code/models; preserve dist api_key
#   --overwrite-key   Copy source api_key into dist (developer use only)
#   --redact-key      Zero out all api_keys in dist config (public distribution)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_APP="$ROOT/dist/AI Video.app/Contents/Resources/app"

if [ ! -d "$DIST_APP" ]; then
  echo "❌ dist app not found: $DIST_APP"
  exit 1
fi

REDACT_KEY=0
OVERWRITE_KEY=0
for arg in "$@"; do
  case "$arg" in
    --redact-key)   REDACT_KEY=1 ;;
    --overwrite-key) OVERWRITE_KEY=1 ;;
  esac
done

echo "Syncing source → dist app bundle..."
echo "  Source: $ROOT"
echo "  Target: $DIST_APP"
echo ""

# ── Core UI service ───────────────────────────────────────────────────────────
cp "$ROOT/版本测试/serve-review-assets.mjs" "$DIST_APP/版本测试/serve-review-assets.mjs"
echo "  ✅ 版本测试/serve-review-assets.mjs"

# ── Config ────────────────────────────────────────────────────────────────────
SRC_CFG="$ROOT/版本测试/config/local-config.json"
DST_CFG="$DIST_APP/版本测试/config/local-config.json"

if [ $REDACT_KEY -eq 1 ]; then
  # Public distribution: copy source then zero out all keys
  cp "$SRC_CFG" "$DST_CFG"
  DST_CFG="$DST_CFG" node -e "
    const fs = require('fs');
    function scrub(v) {
      if (Array.isArray(v)) return v.map(scrub);
      if (!v || typeof v !== 'object') return v;
      for (const [k, child] of Object.entries(v)) {
        const normalized = k.toLowerCase();
        if (normalized === 'api_key' || normalized.endsWith('_api_key')) v[k] = '';
        else v[k] = scrub(child);
      }
      return v;
    }
    const d = JSON.parse(fs.readFileSync(process.env.DST_CFG, 'utf8'));
    fs.writeFileSync(process.env.DST_CFG, JSON.stringify(scrub(d), null, 2) + '\n');
  "
  echo "  ✅ 版本测试/config/local-config.json (api_key redacted for public distribution)"

elif [ $OVERWRITE_KEY -eq 1 ]; then
  # Developer opt-in: copy source config including source api_key
  cp "$SRC_CFG" "$DST_CFG"
  echo "  ✅ 版本测试/config/local-config.json (⚠️  api_key overwritten from source)"

else
  # Default: merge source config but preserve existing dist api_key
  SRC_CFG="$SRC_CFG" DST_CFG="$DST_CFG" node -e "
    const fs = require('fs');
    const src = JSON.parse(fs.readFileSync(process.env.SRC_CFG, 'utf8'));
    let distKey = '';
    let distVideoKey = '';
    let distWorkspaceHost = '';
    try {
      const dst = JSON.parse(fs.readFileSync(process.env.DST_CFG, 'utf8'));
      distKey = (dst.providers && dst.providers.kie && dst.providers.kie.api_key) ||
        (dst.kie && dst.kie.api_key) ||
        (dst.apis && dst.apis.image_to_video && dst.apis.image_to_video.api_key) ||
        '';
      distVideoKey = (dst.apis && dst.apis.image_to_video && dst.apis.image_to_video.api_key) || '';
      distWorkspaceHost = (dst.services && dst.services.workspace_host) || '';
    } catch (_) {}
    // Preserve dist-specific values: api_key and workspace_host (port differs from source)
    src.providers = src.providers || {};
    src.providers.kie = src.providers.kie || {};
    src.kie = src.kie || {};
    if (distKey) {
      src.providers.kie.api_key = distKey;
      src.kie.api_key = distKey;
    }
    if (src.apis && src.apis.image_to_video && (distVideoKey || distKey)) {
      src.apis.image_to_video.api_key = distVideoKey || distKey;
    }
    if (distWorkspaceHost) {
      src.services = src.services || {};
      src.services.workspace_host = distWorkspaceHost;
    }
    fs.writeFileSync(process.env.DST_CFG, JSON.stringify(src, null, 2) + '\n');
  "
  echo "  ✅ 版本测试/config/local-config.json (models/settings synced; dist api_key + workspace_host preserved)"
fi

if [ $REDACT_KEY -eq 1 ]; then
  for PUBLIC_CFG in "$DIST_APP/config/local-config.json" "$DIST_APP/版本测试/config/local-config.json"; do
    [ -f "$PUBLIC_CFG" ] || continue
    PUBLIC_CFG="$PUBLIC_CFG" node -e "
      const fs = require('fs');
      function scrub(v) {
        if (Array.isArray(v)) return v.map(scrub);
        if (!v || typeof v !== 'object') return v;
        for (const [k, child] of Object.entries(v)) {
          const normalized = k.toLowerCase();
          if (normalized === 'api_key' || normalized.endsWith('_api_key')) v[k] = '';
          else v[k] = scrub(child);
        }
        return v;
      }
      const d = JSON.parse(fs.readFileSync(process.env.PUBLIC_CFG, 'utf8'));
      fs.writeFileSync(process.env.PUBLIC_CFG, JSON.stringify(scrub(d), null, 2) + '\n');
    "
  done
  echo "  ✅ public configs redacted (root + 版本测试)"
fi

cp "$ROOT/版本测试/config/local-config.example.json" "$DIST_APP/版本测试/config/local-config.example.json"
echo "  ✅ 版本测试/config/local-config.example.json"

# ── Prompts ───────────────────────────────────────────────────────────────────
cp "$ROOT/prompts/prompt_center.json"          "$DIST_APP/prompts/prompt_center.json"
cp "$ROOT/版本测试/prompts/prompt_center.json" "$DIST_APP/版本测试/prompts/prompt_center.json"
echo "  ✅ prompts/prompt_center.json (both root + 版本测试)"

# ── Canonical workflow JSON ───────────────────────────────────────────────────
for f in n8n01.json n8n02.json n8n02a.json n8n02b.json n8n03.json; do
  cp "$ROOT/正式导入文件/iteration-v1/$f" "$DIST_APP/正式导入文件/iteration-v1/$f"
  echo "  ✅ 正式导入文件/iteration-v1/$f"
done

# ── Sync script ───────────────────────────────────────────────────────────────
cp "$ROOT/sync_iteration_v1_workflows_to_db.mjs" "$DIST_APP/sync_iteration_v1_workflows_to_db.mjs"
echo "  ✅ sync_iteration_v1_workflows_to_db.mjs"

# ── Launcher ──────────────────────────────────────────────────────────────────
cp "$ROOT/client/launcher.mjs" "$DIST_APP/client/launcher.mjs"
echo "  ✅ client/launcher.mjs"

# NOTE: client/mac/*.command files are NOT synced.
# dist .command exports REVIEW_ASSET_PORT=18788 (port isolation from source 8788).
# source .command has no port export (defaults to 8788 for dev).
# If the dist .command is ever regenerated, re-add: export REVIEW_ASSET_PORT=18788

echo ""
echo "同步完成 — $(date '+%Y-%m-%d %H:%M:%S')"
