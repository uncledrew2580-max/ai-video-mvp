// P14-B6 smoke safety guard.
// assertImageOnlyScope() must be the FIRST call in smoke-image-only.mjs.
// Every Veo / video / final-merge function throws unconditionally —
// importing this module and calling the guards is the only way they can run.

export function assertImageOnlyScope() {
  const scope = process.env.REAL_SMOKE_SCOPE;
  const videoDisabled = process.env.DISABLE_VIDEO_GENERATION;
  const errors = [];
  if (scope !== 'image_only') {
    errors.push(`REAL_SMOKE_SCOPE must be 'image_only', got: ${scope ?? '(unset)'}`);
  }
  if (videoDisabled !== 'true') {
    errors.push(`DISABLE_VIDEO_GENERATION must be 'true', got: ${videoDisabled ?? '(unset)'}`);
  }
  if (errors.length > 0) {
    throw new Error(`[smoke-guard] Image-only scope violation:\n${errors.join('\n')}`);
  }
}

export function guardVeo(operation = 'Veo') {
  throw new Error(
    `[smoke-guard] BLOCKED: "${operation}" is forbidden in image-only smoke ` +
    `(DISABLE_VIDEO_GENERATION=true, REAL_SMOKE_SCOPE=image_only)`
  );
}

export function guardFinalMerge() {
  throw new Error('[smoke-guard] BLOCKED: final-merge is forbidden in image-only smoke');
}

export function guardVideoGeneration(operation = 'video generation') {
  throw new Error(
    `[smoke-guard] BLOCKED: "${operation}" is forbidden in image-only smoke ` +
    `(DISABLE_VIDEO_GENERATION=true)`
  );
}

export function guardReviewSubmit(endpoint = '/review-submit') {
  throw new Error(`[smoke-guard] BLOCKED: "${endpoint}" is forbidden in image-only smoke`);
}

export function guardReviewRerunShot() {
  throw new Error('[smoke-guard] BLOCKED: /review-rerun-shot is forbidden in image-only smoke');
}

export function guardReviewSubmitVeoV2() {
  throw new Error('[smoke-guard] BLOCKED: reviewSubmitVeoV2 is forbidden in image-only smoke');
}

// selfTest: verify all guard functions throw. Called from smoke-image-only.mjs at startup
// and from the CI "guard self-test" step. Saves/restores env vars around the scope test.
export function selfTest() {
  function expectThrow(name, fn) {
    try { fn(); return `${name}: did NOT throw`; } catch { return null; }
  }

  const prevScope = process.env.REAL_SMOKE_SCOPE;
  const prevDis = process.env.DISABLE_VIDEO_GENERATION;
  delete process.env.REAL_SMOKE_SCOPE;
  delete process.env.DISABLE_VIDEO_GENERATION;

  const failures = [];
  const r0 = expectThrow('assertImageOnlyScope (no env)', assertImageOnlyScope);
  if (r0) failures.push(r0);

  if (prevScope !== undefined) process.env.REAL_SMOKE_SCOPE = prevScope;
  if (prevDis !== undefined) process.env.DISABLE_VIDEO_GENERATION = prevDis;

  for (const [name, fn] of [
    ['guardVeo', guardVeo],
    ['guardFinalMerge', guardFinalMerge],
    ['guardVideoGeneration', guardVideoGeneration],
    ['guardReviewSubmit', guardReviewSubmit],
    ['guardReviewRerunShot', guardReviewRerunShot],
    ['guardReviewSubmitVeoV2', guardReviewSubmitVeoV2],
  ]) {
    const r = expectThrow(name, fn);
    if (r) failures.push(r);
  }

  if (failures.length > 0) {
    throw new Error(`[smoke-guard] selfTest FAILED:\n${failures.join('\n')}`);
  }
  console.log('[smoke-guard] selfTest PASS: all guards throw as expected.');
}
