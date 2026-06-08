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

  if (env.REAL_SMOKE_SCOPE !== 'image_only') {
    errors.push(
      `REAL_SMOKE_SCOPE must be 'image_only', got: ${JSON.stringify(env.REAL_SMOKE_SCOPE ?? null)}`,
    );
  }

  if (env.DISABLE_VIDEO_GENERATION !== 'true') {
    errors.push(
      `DISABLE_VIDEO_GENERATION must be 'true', got: ${JSON.stringify(env.DISABLE_VIDEO_GENERATION ?? null)}`,
    );
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
