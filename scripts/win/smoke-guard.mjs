// P14-B6 / P14-B8AJ0 smoke safety guard.
// assertImageOnlyScope() (now scope-aware) must be the FIRST call in ui-smoke-image-only.mjs.
//
// Scopes:
//   image_only    (default)  — Veo / video / final-merge / export ALL forbidden.
//   minimal_video (opt-in)    — EXACTLY ONE video clip is allowed (video generation only),
//                               but final-merge AND export remain forbidden, and max_shots
//                               is forced to 1. Requires the full invariant set below.
//
// minimal_video is permitted ONLY when every one of these holds (any deviation = blocked):
//   REAL_SMOKE_SCOPE        === 'minimal_video'
//   ALLOW_VIDEO_GENERATION  === 'true'
//   DISABLE_VIDEO_GENERATION=== 'false'
//   MAX_SHOTS               === '1'
//   ALLOW_FINAL_MERGE       !== 'true'   (must be false)
//   ALLOW_EXPORT            !== 'true'   (must be false)

export function smokeScope(env = process.env) {
  return env.REAL_SMOKE_SCOPE || 'image_only';
}

// True only when a single video clip is explicitly + safely authorized.
export function videoGenerationAllowed(env = process.env) {
  return env.REAL_SMOKE_SCOPE === 'minimal_video'
    && env.ALLOW_VIDEO_GENERATION === 'true'
    && env.DISABLE_VIDEO_GENERATION === 'false'
    && String(env.MAX_SHOTS) === '1'
    && env.ALLOW_FINAL_MERGE !== 'true'
    && env.ALLOW_EXPORT !== 'true';
}

// final-merge and export are NEVER allowed in any smoke scope.
export function finalMergeAllowed() { return false; }
export function exportAllowed() { return false; }

export function assertImageOnlyScope(env = process.env) {
  const scope = smokeScope(env);
  const errors = [];
  if (scope === 'image_only') {
    if (env.DISABLE_VIDEO_GENERATION !== 'true') {
      errors.push(`image_only requires DISABLE_VIDEO_GENERATION='true', got: ${env.DISABLE_VIDEO_GENERATION ?? '(unset)'}`);
    }
  } else if (scope === 'minimal_video') {
    if (env.ALLOW_VIDEO_GENERATION !== 'true') errors.push(`minimal_video requires ALLOW_VIDEO_GENERATION='true', got: ${env.ALLOW_VIDEO_GENERATION ?? '(unset)'}`);
    if (env.DISABLE_VIDEO_GENERATION !== 'false') errors.push(`minimal_video requires DISABLE_VIDEO_GENERATION='false', got: ${env.DISABLE_VIDEO_GENERATION ?? '(unset)'}`);
    if (String(env.MAX_SHOTS) !== '1') errors.push(`minimal_video forces MAX_SHOTS='1', got: ${env.MAX_SHOTS ?? '(unset)'}`);
    if (env.ALLOW_FINAL_MERGE === 'true') errors.push(`minimal_video forbids ALLOW_FINAL_MERGE='true'`);
    if (env.ALLOW_EXPORT === 'true') errors.push(`minimal_video forbids ALLOW_EXPORT='true'`);
  } else {
    errors.push(`REAL_SMOKE_SCOPE must be 'image_only' or 'minimal_video', got: ${scope ?? '(unset)'}`);
  }
  if (errors.length > 0) {
    throw new Error(`[smoke-guard] Smoke scope violation:\n${errors.join('\n')}`);
  }
}

// Veo / video generation: blocked UNLESS a single video clip is authorized (minimal_video).
export function guardVeo(operation = 'Veo', env = process.env) {
  if (videoGenerationAllowed(env)) return;
  throw new Error(
    `[smoke-guard] BLOCKED: "${operation}" is forbidden (scope=${smokeScope(env)}, ` +
    `video authorized=${videoGenerationAllowed(env)})`
  );
}

export function guardVideoGeneration(operation = 'video generation', env = process.env) {
  if (videoGenerationAllowed(env)) return;
  throw new Error(
    `[smoke-guard] BLOCKED: "${operation}" is forbidden (scope=${smokeScope(env)})`
  );
}

// Submitting the storyboard for video is the video-generation trigger — allowed only in
// minimal_video (where it produces exactly one capped clip).
export function guardReviewSubmit(endpoint = '/review-submit', env = process.env) {
  if (videoGenerationAllowed(env)) return;
  throw new Error(`[smoke-guard] BLOCKED: "${endpoint}" is forbidden (scope=${smokeScope(env)})`);
}

export function guardReviewSubmitVeoV2(env = process.env) {
  if (videoGenerationAllowed(env)) return;
  throw new Error('[smoke-guard] BLOCKED: reviewSubmitVeoV2 is forbidden in image-only smoke');
}

// final-merge / rerun-shot / export are ALWAYS blocked (never authorized by any scope).
export function guardFinalMerge() {
  throw new Error('[smoke-guard] BLOCKED: final-merge is forbidden in every smoke scope');
}

export function guardReviewRerunShot() {
  throw new Error('[smoke-guard] BLOCKED: /review-rerun-shot is forbidden in every smoke scope');
}

export function guardExport(endpoint = '/api/export-project') {
  throw new Error(`[smoke-guard] BLOCKED: "${endpoint}" (export) is forbidden in every smoke scope`);
}

// selfTest: verify guards throw under image_only (default) AND that the always-forbidden
// guards throw even under a (hypothetical) minimal_video env. Saves/restores env.
export function selfTest() {
  function expectThrow(name, fn) {
    try { fn(); return `${name}: did NOT throw`; } catch { return null; }
  }
  const saved = {
    REAL_SMOKE_SCOPE: process.env.REAL_SMOKE_SCOPE,
    DISABLE_VIDEO_GENERATION: process.env.DISABLE_VIDEO_GENERATION,
    ALLOW_VIDEO_GENERATION: process.env.ALLOW_VIDEO_GENERATION,
    MAX_SHOTS: process.env.MAX_SHOTS,
    ALLOW_FINAL_MERGE: process.env.ALLOW_FINAL_MERGE,
    ALLOW_EXPORT: process.env.ALLOW_EXPORT,
  };
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  const failures = [];
  // 1) no env at all → scope assert throws, all video/final/export guards throw.
  for (const k of Object.keys(saved)) delete process.env[k];
  const r0 = expectThrow('assertImageOnlyScope (no env)', () => assertImageOnlyScope());
  if (r0) failures.push(r0);
  for (const [name, fn] of [
    ['guardVeo', () => guardVeo()],
    ['guardVideoGeneration', () => guardVideoGeneration()],
    ['guardFinalMerge', guardFinalMerge],
    ['guardReviewSubmit', () => guardReviewSubmit()],
    ['guardReviewRerunShot', guardReviewRerunShot],
    ['guardReviewSubmitVeoV2', () => guardReviewSubmitVeoV2()],
    ['guardExport', () => guardExport()],
  ]) { const r = expectThrow(name, fn); if (r) failures.push(r); }

  // 2) under a fully-authorized minimal_video env, final-merge / rerun / export STILL throw.
  process.env.REAL_SMOKE_SCOPE = 'minimal_video';
  process.env.ALLOW_VIDEO_GENERATION = 'true';
  process.env.DISABLE_VIDEO_GENERATION = 'false';
  process.env.MAX_SHOTS = '1';
  process.env.ALLOW_FINAL_MERGE = 'false';
  process.env.ALLOW_EXPORT = 'false';
  for (const [name, fn] of [
    ['guardFinalMerge (minimal_video)', guardFinalMerge],
    ['guardReviewRerunShot (minimal_video)', guardReviewRerunShot],
    ['guardExport (minimal_video)', () => guardExport()],
  ]) { const r = expectThrow(name, fn); if (r) failures.push(r); }
  // and video IS allowed there (must NOT throw)
  try { guardVideoGeneration(); } catch (e) { failures.push(`guardVideoGeneration (minimal_video): threw unexpectedly: ${e.message}`); }

  restore();
  if (failures.length > 0) {
    throw new Error(`[smoke-guard] selfTest FAILED:\n${failures.join('\n')}`);
  }
  console.log('[smoke-guard] selfTest PASS: image_only blocks all; minimal_video allows only video, still blocks final-merge/rerun/export.');
}
