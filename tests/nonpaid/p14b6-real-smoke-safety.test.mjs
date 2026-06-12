// P14-B6 nonpaid tests — real-smoke safety boundaries.
// Verifies: workflow_dispatch only, secrets only, image_only scope,
// Veo/final/video guard functions throw, no key-logging patterns.
// Zero model calls, zero network, runs on macOS/Linux/Windows offline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-real-smoke-image-only.yml');
const SMOKE_GUARD = path.join(ROOT, 'scripts', 'win', 'smoke-guard.mjs');
const SMOKE_SCRIPT = path.join(ROOT, 'scripts', 'win', 'smoke-image-only.mjs');
// On Windows, dynamic import() of an absolute path (e.g. D:\...) throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME — it must be a file:// URL.
const SMOKE_GUARD_URL = pathToFileURL(SMOKE_GUARD).href;

// ── Workflow YAML structure ───────────────────────────────────────────────────

test('workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW), `missing ${WORKFLOW}`);
});

test('workflow triggers ONLY on workflow_dispatch (no push/pull_request/schedule)', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(yml.includes('workflow_dispatch'), 'must have workflow_dispatch trigger');
  assert.ok(!yml.includes('push:'), 'must NOT have push: trigger');
  assert.ok(!yml.includes('pull_request:'), 'must NOT have pull_request: trigger');
  assert.ok(!yml.includes('schedule:'), 'must NOT have schedule: trigger');
});

test('workflow job env has REAL_SMOKE_SCOPE: image_only', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(
    /REAL_SMOKE_SCOPE:\s*image_only/.test(yml),
    'workflow must set REAL_SMOKE_SCOPE: image_only'
  );
});

test("workflow job env has DISABLE_VIDEO_GENERATION: 'true'", () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(
    /DISABLE_VIDEO_GENERATION:\s*['"]?true['"]?/.test(yml),
    "workflow must set DISABLE_VIDEO_GENERATION: 'true'"
  );
});

test('workflow uses GitHub Secrets for API key — not hardcoded values', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(yml.includes('secrets.AI_VIDEO_API_KEY'), 'must reference secrets.AI_VIDEO_API_KEY');
  // Reject any line that looks like AI_VIDEO_API_KEY: <literal-value>
  assert.ok(
    !/AI_VIDEO_API_KEY:\s*['"]?[A-Za-z0-9_\-]{8,}['"]?/.test(yml),
    'must NOT have a hardcoded API key value in the workflow'
  );
});

test('workflow has ::add-mask:: step for secret masking', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(yml.includes('add-mask'), 'workflow must invoke ::add-mask:: to mask secrets');
});

test('workflow does NOT reference Veo video endpoints', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(!yml.includes('/v1/veo'), 'workflow must not reference /v1/veo endpoint');
  assert.ok(!yml.includes('veo/generate'), 'workflow must not reference veo/generate');
  assert.ok(!yml.includes('reviewSubmitVeoV2'), 'workflow must not reference reviewSubmitVeoV2');
});

test('workflow does NOT reference final-merge, review-submit, or review-rerun-shot', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(!yml.includes('final-merge'), 'workflow must not reference final-merge');
  assert.ok(!yml.includes('review-submit'), 'workflow must not reference review-submit');
  assert.ok(!yml.includes('review-rerun-shot'), 'workflow must not reference review-rerun-shot');
});

// ── Script syntax ─────────────────────────────────────────────────────────────

test('smoke-guard.mjs passes node --check', () => {
  assert.ok(fs.existsSync(SMOKE_GUARD), `missing ${SMOKE_GUARD}`);
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', SMOKE_GUARD], { stdio: 'pipe' });
  }, 'smoke-guard.mjs must pass node --check');
});

test('smoke-image-only.mjs passes node --check', () => {
  assert.ok(fs.existsSync(SMOKE_SCRIPT), `missing ${SMOKE_SCRIPT}`);
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', SMOKE_SCRIPT], { stdio: 'pipe' });
  }, 'smoke-image-only.mjs must pass node --check');
});

// ── Guard module: scope enforcement ──────────────────────────────────────────

test('assertImageOnlyScope throws when env vars are absent', async () => {
  const { assertImageOnlyScope } = await import(SMOKE_GUARD_URL);
  const prevScope = process.env.REAL_SMOKE_SCOPE;
  const prevDis = process.env.DISABLE_VIDEO_GENERATION;
  delete process.env.REAL_SMOKE_SCOPE;
  delete process.env.DISABLE_VIDEO_GENERATION;
  try {
    assert.throws(() => assertImageOnlyScope(), /scope violation/i);
  } finally {
    if (prevScope !== undefined) process.env.REAL_SMOKE_SCOPE = prevScope;
    if (prevDis !== undefined) process.env.DISABLE_VIDEO_GENERATION = prevDis;
  }
});

test('assertImageOnlyScope throws when DISABLE_VIDEO_GENERATION is not true', async () => {
  const { assertImageOnlyScope } = await import(SMOKE_GUARD_URL);
  const prevScope = process.env.REAL_SMOKE_SCOPE;
  const prevDis = process.env.DISABLE_VIDEO_GENERATION;
  process.env.REAL_SMOKE_SCOPE = 'image_only';
  process.env.DISABLE_VIDEO_GENERATION = 'false';
  try {
    assert.throws(() => assertImageOnlyScope(), /DISABLE_VIDEO_GENERATION/);
  } finally {
    if (prevScope !== undefined) process.env.REAL_SMOKE_SCOPE = prevScope;
    else delete process.env.REAL_SMOKE_SCOPE;
    if (prevDis !== undefined) process.env.DISABLE_VIDEO_GENERATION = prevDis;
    else delete process.env.DISABLE_VIDEO_GENERATION;
  }
});

test('assertImageOnlyScope throws when REAL_SMOKE_SCOPE is not image_only', async () => {
  const { assertImageOnlyScope } = await import(SMOKE_GUARD_URL);
  const prevScope = process.env.REAL_SMOKE_SCOPE;
  const prevDis = process.env.DISABLE_VIDEO_GENERATION;
  process.env.REAL_SMOKE_SCOPE = 'full';
  process.env.DISABLE_VIDEO_GENERATION = 'true';
  try {
    assert.throws(() => assertImageOnlyScope(), /REAL_SMOKE_SCOPE/);
  } finally {
    if (prevScope !== undefined) process.env.REAL_SMOKE_SCOPE = prevScope;
    else delete process.env.REAL_SMOKE_SCOPE;
    if (prevDis !== undefined) process.env.DISABLE_VIDEO_GENERATION = prevDis;
    else delete process.env.DISABLE_VIDEO_GENERATION;
  }
});

test('assertImageOnlyScope passes when correctly set', async () => {
  const { assertImageOnlyScope } = await import(SMOKE_GUARD_URL);
  const prevScope = process.env.REAL_SMOKE_SCOPE;
  const prevDis = process.env.DISABLE_VIDEO_GENERATION;
  process.env.REAL_SMOKE_SCOPE = 'image_only';
  process.env.DISABLE_VIDEO_GENERATION = 'true';
  try {
    assert.doesNotThrow(() => assertImageOnlyScope());
  } finally {
    if (prevScope !== undefined) process.env.REAL_SMOKE_SCOPE = prevScope;
    else delete process.env.REAL_SMOKE_SCOPE;
    if (prevDis !== undefined) process.env.DISABLE_VIDEO_GENERATION = prevDis;
    else delete process.env.DISABLE_VIDEO_GENERATION;
  }
});

// ── Guard module: forbidden operations throw ──────────────────────────────────

// image_only env — the video guards block ONLY outside minimal_video, so assert with an
// explicit image_only env (deterministic regardless of the ambient/job scope).
const IMG_ONLY = { REAL_SMOKE_SCOPE: 'image_only', DISABLE_VIDEO_GENERATION: 'true' };

test('guardVeo throws with BLOCKED message', async () => {
  const { guardVeo } = await import(SMOKE_GUARD_URL);
  assert.throws(() => guardVeo('Veo', IMG_ONLY), /BLOCKED/);
  assert.throws(() => guardVeo('Veo', IMG_ONLY), /BLOCKED.*Veo/);
  assert.throws(() => guardVeo('reviewSubmitVeoV2', IMG_ONLY), /BLOCKED.*reviewSubmitVeoV2/);
});

test('guardFinalMerge throws with BLOCKED final-merge message', async () => {
  const { guardFinalMerge } = await import(SMOKE_GUARD_URL);
  assert.throws(() => guardFinalMerge(), /BLOCKED.*final-merge/);
});

test('guardVideoGeneration throws with BLOCKED video generation message', async () => {
  const { guardVideoGeneration } = await import(SMOKE_GUARD_URL);
  assert.throws(() => guardVideoGeneration('video generation', IMG_ONLY), /BLOCKED.*video generation/);
});

test('guardReviewSubmit throws with BLOCKED /review-submit message', async () => {
  const { guardReviewSubmit } = await import(SMOKE_GUARD_URL);
  assert.throws(() => guardReviewSubmit('/review-submit', IMG_ONLY), /BLOCKED.*\/review-submit/);
});

test('guardReviewRerunShot throws with BLOCKED /review-rerun-shot message', async () => {
  const { guardReviewRerunShot } = await import(SMOKE_GUARD_URL);
  assert.throws(() => guardReviewRerunShot(), /BLOCKED.*\/review-rerun-shot/);
});

test('guardReviewSubmitVeoV2 throws with BLOCKED reviewSubmitVeoV2 message', async () => {
  const { guardReviewSubmitVeoV2 } = await import(SMOKE_GUARD_URL);
  assert.throws(() => guardReviewSubmitVeoV2(IMG_ONLY), /BLOCKED.*reviewSubmitVeoV2/);
});

// ── selfTest passes when scope env vars are correctly set ─────────────────────

test('selfTest passes with correct env and confirms all guards throw', async () => {
  const { selfTest } = await import(SMOKE_GUARD_URL);
  const prevScope = process.env.REAL_SMOKE_SCOPE;
  const prevDis = process.env.DISABLE_VIDEO_GENERATION;
  process.env.REAL_SMOKE_SCOPE = 'image_only';
  process.env.DISABLE_VIDEO_GENERATION = 'true';
  try {
    assert.doesNotThrow(() => selfTest());
  } finally {
    if (prevScope !== undefined) process.env.REAL_SMOKE_SCOPE = prevScope;
    else delete process.env.REAL_SMOKE_SCOPE;
    if (prevDis !== undefined) process.env.DISABLE_VIDEO_GENERATION = prevDis;
    else delete process.env.DISABLE_VIDEO_GENERATION;
  }
});

// ── Source-level checks on smoke-image-only.mjs ───────────────────────────────

test('smoke-image-only.mjs calls assertImageOnlyScope() at startup', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(
    src.includes('assertImageOnlyScope()'),
    'smoke-image-only.mjs must call assertImageOnlyScope() unconditionally at startup'
  );
});

test('smoke-image-only.mjs calls selfTest() at startup', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(src.includes('selfTest()'), 'smoke-image-only.mjs must call selfTest() at startup');
});

test('smoke-image-only.mjs writes smoke-report.json', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(src.includes('smoke-report.json'), 'smoke-image-only.mjs must write smoke-report.json');
});

test('smoke-image-only.mjs does not log Authorization header value', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  // console.log/error/warn/info must not be passed a string containing "Authorization"
  assert.ok(
    !/console\.(log|error|warn|info)\s*\([^)]*Authorization/i.test(src),
    'smoke-image-only.mjs must not log Authorization header value'
  );
});

test('smoke-image-only.mjs does not print the raw API key value', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  // Guard against naive console.log(apiKey) or console.log(process.env.AI_VIDEO_API_KEY)
  assert.ok(
    !src.includes('console.log(apiKey)') &&
    !src.includes('console.error(apiKey)') &&
    !src.includes('console.log(process.env.AI_VIDEO_API_KEY)') &&
    !src.includes('console.error(process.env.AI_VIDEO_API_KEY)'),
    'smoke-image-only.mjs must not print the raw API key to console'
  );
});

test('smoke-image-only.mjs does not log API key length or any derived secret info', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(
    !src.includes('apiKey.length'),
    'smoke-image-only.mjs must not log apiKey.length — even length is derived secret info'
  );
});

test('smoke-image-only.mjs report includes B6 stop-proof fields', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(src.includes('video_generation_skipped'), 'report must include video_generation_skipped field');
  assert.ok(src.includes('veo_not_called'), 'report must include veo_not_called field');
  assert.ok(src.includes('final_merge_not_called'), 'report must include final_merge_not_called field');
  assert.ok(src.includes("stopped_at"), 'report must include stopped_at field');
  assert.ok(src.includes("'image_generation'"), "stopped_at must be set to 'image_generation'");
});

test('smoke-image-only.mjs stages array includes video_skipped entry', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(src.includes("'video_skipped'"), "stages must include 'video_skipped' to prove video was not reached");
});

test('smoke-image-only.mjs uses an enum resolution (not pixel dimensions)', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(!src.includes('720x1280'), "must not use pixel-dimension resolution '720x1280' — Kie API rejects it");
  assert.ok(!src.includes('1080x1920'), "must not use pixel-dimension resolution '1080x1920' — Kie API rejects it");
  assert.ok(src.includes("resolution: '2K'"), "must use enum resolution '2K' to match Kie API allowed options");
});

test('smoke-image-only.mjs does not reference Veo video endpoint', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  assert.ok(!src.includes('/v1/veo'), 'must not reference /v1/veo');
  assert.ok(!src.includes('veo/generate'), 'must not reference veo/generate');
  assert.ok(!src.includes('reviewSubmitVeoV2'), 'must not reference reviewSubmitVeoV2');
});

test('smoke-image-only.mjs does not reference final-merge or review-submit routes', () => {
  const src = fs.readFileSync(SMOKE_SCRIPT, 'utf8');
  // guardFinalMerge/guardReviewSubmit imports are allowed; raw path strings are not
  assert.ok(!src.includes("'final-merge'") && !src.includes('"final-merge"'), 'must not have literal final-merge string');
  assert.ok(!src.includes("'/review-submit'") && !src.includes('"/review-submit"'), 'must not have literal /review-submit string');
  assert.ok(!src.includes("'/review-rerun-shot'") && !src.includes('"/review-rerun-shot"'), 'must not have literal /review-rerun-shot string');
});

// ── checkSmokeSecurityGate (check-smoke-security.mjs) ────────────────────────

const CHECK_SECURITY = path.join(ROOT, 'scripts', 'win', 'check-smoke-security.mjs');
const CHECK_SECURITY_URL = pathToFileURL(CHECK_SECURITY).href;

test('check-smoke-security.mjs passes node --check', () => {
  assert.ok(fs.existsSync(CHECK_SECURITY), `missing ${CHECK_SECURITY}`);
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', CHECK_SECURITY], { stdio: 'pipe' });
  });
});

test('checkSmokeSecurityGate passes when all three conditions are met', async () => {
  const { checkSmokeSecurityGate } = await import(CHECK_SECURITY_URL);
  const { ok, errors } = checkSmokeSecurityGate({
    REAL_SMOKE_SCOPE: 'image_only',
    DISABLE_VIDEO_GENERATION: 'true',
    AI_VIDEO_API_KEY: 'dummy-test-key-for-nonpaid-test',
  });
  assert.equal(ok, true, `expected ok=true, got errors: ${errors.join('; ')}`);
  assert.equal(errors.length, 0);
});

test('checkSmokeSecurityGate fails when REAL_SMOKE_SCOPE is wrong', async () => {
  const { checkSmokeSecurityGate } = await import(CHECK_SECURITY_URL);
  const { ok, errors } = checkSmokeSecurityGate({
    REAL_SMOKE_SCOPE: 'full',
    DISABLE_VIDEO_GENERATION: 'true',
    AI_VIDEO_API_KEY: 'dummy-test-key',
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('REAL_SMOKE_SCOPE')), `expected REAL_SMOKE_SCOPE error, got: ${errors}`);
});

test('checkSmokeSecurityGate fails when REAL_SMOKE_SCOPE is absent', async () => {
  const { checkSmokeSecurityGate } = await import(CHECK_SECURITY_URL);
  const { ok, errors } = checkSmokeSecurityGate({
    DISABLE_VIDEO_GENERATION: 'true',
    AI_VIDEO_API_KEY: 'dummy-test-key',
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('REAL_SMOKE_SCOPE')));
});

test('checkSmokeSecurityGate fails when DISABLE_VIDEO_GENERATION is not true', async () => {
  const { checkSmokeSecurityGate } = await import(CHECK_SECURITY_URL);
  const { ok, errors } = checkSmokeSecurityGate({
    REAL_SMOKE_SCOPE: 'image_only',
    DISABLE_VIDEO_GENERATION: 'false',
    AI_VIDEO_API_KEY: 'dummy-test-key',
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('DISABLE_VIDEO_GENERATION')));
});

test('checkSmokeSecurityGate fails when AI_VIDEO_API_KEY is absent', async () => {
  const { checkSmokeSecurityGate } = await import(CHECK_SECURITY_URL);
  const { ok, errors } = checkSmokeSecurityGate({
    REAL_SMOKE_SCOPE: 'image_only',
    DISABLE_VIDEO_GENERATION: 'true',
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('AI_VIDEO_API_KEY')));
});

test('checkSmokeSecurityGate fails when AI_VIDEO_API_KEY is empty string', async () => {
  const { checkSmokeSecurityGate } = await import(CHECK_SECURITY_URL);
  const { ok, errors } = checkSmokeSecurityGate({
    REAL_SMOKE_SCOPE: 'image_only',
    DISABLE_VIDEO_GENERATION: 'true',
    AI_VIDEO_API_KEY: '',
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('AI_VIDEO_API_KEY')));
});

test('checkSmokeSecurityGate collects all errors when nothing is set', async () => {
  const { checkSmokeSecurityGate } = await import(CHECK_SECURITY_URL);
  const { ok, errors } = checkSmokeSecurityGate({});
  assert.equal(ok, false);
  // Empty env → unknown scope error + missing API key (the gate collects multiple errors).
  assert.ok(errors.length >= 2, `expected at least 2 errors, got ${errors.length}: ${errors}`);
  assert.ok(errors.some((e) => /REAL_SMOKE_SCOPE/.test(e)) && errors.some((e) => /AI_VIDEO_API_KEY/.test(e)), 'reports scope + key errors');
});

// ── Batch syntax check (mirrors nonpaid style in p14-n8n-runtime.test.mjs) ───

test('new smoke scripts are syntactically valid (batch node --check)', () => {
  for (const s of ['smoke-guard.mjs', 'smoke-image-only.mjs', 'check-smoke-security.mjs']) {
    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        ['--check', path.join(ROOT, 'scripts', 'win', s)],
        { stdio: 'pipe' }
      );
    }, `scripts/win/${s} must pass node --check`);
  }
});

test('workflow runs smoke-image-only.mjs as the actual smoke runner (not permanent --dry-run)', () => {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(yml.includes('smoke-image-only.mjs'), 'workflow must reference smoke-image-only.mjs as runner');
  assert.ok(!yml.includes('--dry-run'), 'workflow must not permanently pass --dry-run to the smoke script');
});
