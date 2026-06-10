#!/usr/bin/env node
/**
 * scripts/win/install-playwright-with-retry.mjs — P14-B8R1
 *
 * Installs Playwright for the Windows UI smoke with retry, so a single transient
 * npm network error (ECONNRESET / ETIMEDOUT / ENOTFOUND / ...) does NOT fail the
 * run before the UI smoke body ever starts (the B8R failure: a lone ECONNRESET in
 * "Install Playwright" skipped the whole smoke).
 *
 * Behavior:
 *   - If Playwright already resolves (lockfile/devDep already installed), skip.
 *   - Otherwise `npm install --no-save <spec>` with >=3 attempts + backoff.
 *   - Transient network errors are recognized and retried; the classification is
 *     logged each attempt.
 *   - On exhausting retries it FAILS CLEARLY (exit 1) as
 *     failed_stage=install_playwright_dependency and writes a GitHub step summary
 *     stating the UI smoke never started (no app launch, no model/Veo/video/final).
 *
 * Uses --no-save so package.json / the lockfile stay unchanged; it is a local
 * (not global) install. No secrets are read or printed.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const FAILED_STAGE = 'install_playwright_dependency';
export const PLAYWRIGHT_SPEC = process.env.PLAYWRIGHT_SPEC || 'playwright@^1.49.0';
export const MAX_ATTEMPTS = Math.max(3, Number(process.env.PLAYWRIGHT_INSTALL_ATTEMPTS || 3));

// Transient = worth retrying (network/registry hiccups). NOT: 404/E404 (missing
// package), EPERM-only, version-not-found — those won't fix themselves on retry.
export const TRANSIENT_PATTERNS = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_SOCKET|socket hang up|network read|read ECONN|fetch failed|request to .* failed|\b(502|503|504|429)\b|registry\.npmjs\.org.*(reset|timeout|timed out)/i;

export function isTransient(text) {
  return TRANSIENT_PATTERNS.test(String(text || ''));
}

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alreadyInstalled() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

function writeSummary(text) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (!f) return;
  try { appendFileSync(f, text + '\n'); } catch {}
}

function runInstall() {
  const r = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', PLAYWRIGHT_SPEC], {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const stderr = r.stderr || '';
  if (stderr) process.stderr.write(stderr);
  return { code: r.status, stderr };
}

async function main() {
  if (alreadyInstalled()) {
    console.log('[playwright-install] playwright already resolvable — skipping install.');
    return;
  }
  let lastTransient = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[playwright-install ${attempt}/${MAX_ATTEMPTS}] npm install --no-save ${PLAYWRIGHT_SPEC}`);
    const { code, stderr } = runInstall();
    if (code === 0 && alreadyInstalled()) {
      console.log('[playwright-install] success.');
      return;
    }
    lastTransient = isTransient(stderr);
    console.warn(`[playwright-install] attempt ${attempt} failed (exit=${code}, transient=${lastTransient}).`);
    if (attempt < MAX_ATTEMPTS) {
      const backoff = Math.min(15 * attempt, 60);
      console.warn(`[playwright-install] retrying in ${backoff}s …`);
      await sleep(backoff * 1000);
    }
  }
  console.error(`[playwright-install] FAILED after ${MAX_ATTEMPTS} attempts — failed_stage=${FAILED_STAGE} (last transient=${lastTransient}).`);
  writeSummary(
    `### ❌ UI smoke did not start — failed_stage=${FAILED_STAGE}\n` +
    `- Playwright install failed after ${MAX_ATTEMPTS} attempts` +
    `${lastTransient ? ' (transient npm network error, e.g. ECONNRESET)' : ''}.\n` +
    `- **AI Video.exe was NOT launched.**\n` +
    `- No model call (Gemini / Nano Banana / Veo); no video clips; no final merge.\n` +
    `- REAL_SMOKE_SCOPE=image_only, DISABLE_VIDEO_GENERATION=true.`,
  );
  process.exit(1);
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();
if (isMain) main();
