#!/usr/bin/env node
// P14-B6: Pre-flight security gate for the image-only real smoke test.
// Must pass before any model API calls are made.
//
// Exported as a function for nonpaid tests; also runnable as CLI for CI.
//
// SECURITY: This module NEVER reads, logs, stores, or compares the API key
// value. It only checks that the env var is truthy (set and non-empty).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {Record<string,string|undefined>} env  Defaults to process.env.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkSmokeSecurityGate(env = process.env) {
  const errors = [];
  const scope = env.REAL_SMOKE_SCOPE ?? null;

  if (scope === 'image_only') {
    // Default safe scope: video must be disabled.
    if (env.DISABLE_VIDEO_GENERATION !== 'true') {
      errors.push(`image_only requires DISABLE_VIDEO_GENERATION='true', got: ${JSON.stringify(env.DISABLE_VIDEO_GENERATION ?? null)}`);
    }
  } else if (scope === 'minimal_video') {
    // Opt-in: EXACTLY one video clip. Every invariant must hold; final-merge/export forbidden.
    if (env.ALLOW_VIDEO_GENERATION !== 'true') errors.push(`minimal_video requires ALLOW_VIDEO_GENERATION='true', got: ${JSON.stringify(env.ALLOW_VIDEO_GENERATION ?? null)}`);
    if (env.DISABLE_VIDEO_GENERATION !== 'false') errors.push(`minimal_video requires DISABLE_VIDEO_GENERATION='false', got: ${JSON.stringify(env.DISABLE_VIDEO_GENERATION ?? null)}`);
    if (String(env.MAX_SHOTS) !== '1') errors.push(`minimal_video forces MAX_SHOTS='1', got: ${JSON.stringify(env.MAX_SHOTS ?? null)}`);
    if (env.ALLOW_FINAL_MERGE === 'true') errors.push(`minimal_video forbids ALLOW_FINAL_MERGE='true' (final-merge is never allowed)`);
    if (env.ALLOW_EXPORT === 'true') errors.push(`minimal_video forbids ALLOW_EXPORT='true' (export is never allowed)`);
  } else {
    errors.push(`REAL_SMOKE_SCOPE must be 'image_only' or 'minimal_video', got: ${JSON.stringify(scope)}`);
  }

  // NEVER log the actual API key value, not even its length.
  if (!env.AI_VIDEO_API_KEY) {
    errors.push('AI_VIDEO_API_KEY is not set — configure it in GitHub Secrets (Actions → Settings → Secrets)');
  }

  return { ok: errors.length === 0, errors };
}

// CLI entry — only when run directly (not when imported as a module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ok, errors } = checkSmokeSecurityGate();
  if (!ok) {
    for (const e of errors) process.stderr.write(`[smoke-security] FAIL: ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(
    '[smoke-security] PASS: REAL_SMOKE_SCOPE=image_only, DISABLE_VIDEO_GENERATION=true, AI_VIDEO_API_KEY present.\n',
  );
}
