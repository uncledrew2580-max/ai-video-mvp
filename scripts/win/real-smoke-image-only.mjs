#!/usr/bin/env node
// P14-B6: Real smoke guard — image-only scope.
// Guards run first: scope is validated and all video/Veo/final/review-submit/
// rerun-shot paths are blocked before any other work proceeds.
// In --dry-run / NONPAID=1 mode: no model calls, no network, no key logging.
// Live model call is a TODO inside callImageModel() — never auto-triggered.
//
// Usage: node real-smoke-image-only.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARTIFACT_ROOT = path.join(REPO_ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001');
const REPORT_PATH = path.join(REPO_ROOT, 'smoke-report.json');
const DIAGNOSTICS_DIR = path.join(REPO_ROOT, 'diagnostics');

const DRY_RUN = process.argv.includes('--dry-run') || process.env.NONPAID === '1';

// ── safety constants ──────────────────────────────────────────────────────────

const REQUIRED_SCOPE = 'image_only';

// Any operation or path name containing these tokens is unconditionally blocked.
const FORBIDDEN_PATH_TOKENS = [
  'video',
  'veo',
  'final',
  'review-submit',
  'review_submit',
  'rerun-shot',
  'rerun_shot',
];

// ── guard functions ───────────────────────────────────────────────────────────

function enforceImageOnlyScope() {
  const scope = process.env.REAL_SMOKE_SCOPE;
  if (scope !== REQUIRED_SCOPE) {
    fatal(`REAL_SMOKE_SCOPE must be "${REQUIRED_SCOPE}", got: "${scope ?? '(unset)'}"`);
  }
  const videoDisabled = process.env.DISABLE_VIDEO_GENERATION;
  if (videoDisabled !== 'true') {
    fatal(`DISABLE_VIDEO_GENERATION must be "true", got: "${videoDisabled ?? '(unset)'}"`);
  }
}

function guardForbiddenPath(requestedPath) {
  const lower = String(requestedPath ?? '').toLowerCase();
  for (const token of FORBIDDEN_PATH_TOKENS) {
    if (lower.includes(token)) {
      fatal(
        `Forbidden path/operation in image-only mode: "${requestedPath}" ` +
        `(matched guard token: "${token}")`
      );
    }
  }
}

// ── fatal / report ────────────────────────────────────────────────────────────

function fatal(msg) {
  console.error(`[real-smoke-image-only] FATAL: ${msg}`);
  writeReport({ ok: false, error: msg, dry_run: DRY_RUN });
  process.exit(1);
}

function writeReport(data) {
  try {
    fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
    const payload = { ...data, ts: new Date().toISOString() };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error('[real-smoke-image-only] warn: could not write smoke-report.json:', e.message);
  }
}

// ── artifact shape verification ───────────────────────────────────────────────

function verifyArtifactShape() {
  const errors = [];
  if (!fs.existsSync(ARTIFACT_ROOT)) {
    errors.push(`artifact root missing: ${ARTIFACT_ROOT}`);
    return errors;
  }
  const checks = [
    { p: path.join(ARTIFACT_ROOT, 'resources', 'runtime', 'node_modules'), label: 'resources/runtime/node_modules' },
    { p: path.join(ARTIFACT_ROOT, 'resources', 'app'), label: 'resources/app' },
    { p: path.join(ARTIFACT_ROOT, 'version.json'), label: 'version.json' },
    { p: path.join(ARTIFACT_ROOT, 'runtime-manifest.json'), label: 'runtime-manifest.json' },
  ];
  for (const { p, label } of checks) {
    if (!fs.existsSync(p)) errors.push(`missing: ${label}`);
  }
  return errors;
}

// ── redacted config (no secrets, no keys) ────────────────────────────────────

function writeRedactedConfig() {
  const cfg = {
    scope: REQUIRED_SCOPE,
    disable_video_generation: true,
    api_key_present: !!process.env.AI_VIDEO_API_KEY,
    base_url_present: !!process.env.AI_VIDEO_BASE_URL,
    dry_run: DRY_RUN,
  };
  fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DIAGNOSTICS_DIR, 'smoke-config-redacted.json'),
    JSON.stringify(cfg, null, 2)
  );
  console.log('[real-smoke-image-only] redacted config written (no secrets)');
}

// ── live model call (future, guarded) ────────────────────────────────────────

function callImageModel(params) {
  // Re-enforce scope and block forbidden paths even inside this function.
  enforceImageOnlyScope();
  guardForbiddenPath(params?.operation ?? params?.path);

  // TODO(P14-B6-live): implement real image-model API call here.
  // Requirements before removing this TODO:
  //   1. Confirm AI_VIDEO_API_KEY is valid for image generation (not video).
  //   2. Veo/video/final/review-submit/rerun-shot paths remain blocked by guardForbiddenPath above.
  //   3. Rate-limit and cost estimate must be checked before calling.
  //   4. Response must be written to diagnostics/; never log raw API response.
  //   5. This function must never be called from --dry-run or NONPAID=1 paths.
  throw new Error(
    'Live model call not yet implemented (P14-B6 TODO). ' +
    'Run with --dry-run until this TODO is resolved.'
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[real-smoke-image-only] starting  dry_run=${DRY_RUN}  scope=${process.env.REAL_SMOKE_SCOPE ?? '(unset)'}`);

  // Guards first — unconditional, before any I/O or work.
  enforceImageOnlyScope();

  fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });

  const shapeErrors = verifyArtifactShape();
  if (shapeErrors.length > 0) {
    console.error('[real-smoke-image-only] artifact shape errors:');
    for (const e of shapeErrors) console.error('  ❌ ' + e);
    writeReport({ ok: false, errors: shapeErrors, dry_run: DRY_RUN, scope: REQUIRED_SCOPE });
    process.exit(1);
  }
  console.log('[real-smoke-image-only] artifact shape: OK');

  writeRedactedConfig();

  if (DRY_RUN) {
    console.log('[real-smoke-image-only] DRY-RUN: scope and guards validated. No model calls.');
    writeReport({ ok: true, dry_run: true, scope: REQUIRED_SCOPE, artifact_shape: 'ok' });
    console.log('[real-smoke-image-only] PASS (dry-run)');
    return;
  }

  // Live path: callImageModel enforces guards internally before any network call.
  // Uncomment the call below only after resolving the TODO inside callImageModel.
  // callImageModel({ operation: 'image_generate' });
  fatal('Live mode not yet implemented. Use --dry-run until the TODO in callImageModel is resolved.');
}

main().catch((err) => {
  console.error('[real-smoke-image-only] unhandled error:', err.message);
  writeReport({ ok: false, error: err.message, dry_run: DRY_RUN });
  process.exit(1);
});
