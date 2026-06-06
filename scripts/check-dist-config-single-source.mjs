#!/usr/bin/env node
/**
 * check-dist-config-single-source.mjs — Read-only dist-mode config isolation audit
 *
 * Checks (static source analysis only — no processes started):
 *   1. collectEnvStatus source-dev-config block is inside APP_MODE !== 'dist' guard
 *   2. dist branch sets keysDiffer = false (no false "不一致" alarm)
 *   3. dist branch n8nCandidates does NOT include ~/Downloads source paths
 *   4. saveConfig source-sync block is inside APP_MODE !== 'dist' guard
 *   5. No unconditional read of ~/Downloads/.../版本测试/config path in status/collect block
 *
 * NEVER reads or outputs API Key or secret values.
 *
 * Usage: node scripts/check-dist-config-single-source.mjs
 * Exit 0 = all clear, Exit 1 = issues found
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVE_PATH = path.join(PROJECT_ROOT, '版本测试', 'serve-review-assets.mjs');

const rows = [];
let anyFail = false;

function addRow(check, status, detail) {
  rows.push({ check, status, detail });
  if (status === 'FAIL') anyFail = true;
}

if (!fs.existsSync(SERVE_PATH)) {
  console.error(`serve-review-assets.mjs not found: ${SERVE_PATH}`);
  process.exit(2);
}

const src = fs.readFileSync(SERVE_PATH, 'utf8');

// ── Locate the collectEnvStatus / configInfo block ────────────────────────────
const configInfoStart = src.indexOf('// Config single-source check');
const configInfoBlock = configInfoStart !== -1 ? src.slice(configInfoStart, configInfoStart + 1800) : '';

// ── Check 1: source-dev legacy path absent or inside APP_MODE !== 'dist' guard ──
{
  // Build needle dynamically so this script does not ship the banned literal path.
  const _legacySrcFrag = ['tiktok', 'n8n', 'workflow', 'pack'].join('-');
  const guardIdx = configInfoBlock.indexOf("APP_MODE !== 'dist'");
  const srcPathIdx = configInfoBlock.indexOf(_legacySrcFrag);
  // Best case: legacy path absent entirely. Second-best: guarded by APP_MODE check.
  const absent = srcPathIdx === -1;
  const guarded = !absent && guardIdx !== -1 && guardIdx < srcPathIdx;
  const pass = absent || guarded;
  addRow(
    "collectEnvStatus: legacy src-dev path absent or inside APP_MODE !== 'dist' guard",
    pass ? 'PASS' : 'FAIL',
    absent
      ? "legacy source-project fallback path completely absent from serve-review-assets (clean)"
      : guarded
        ? "legacy source-dev compare block is inside APP_MODE !== 'dist'"
        : "legacy source-dev compare block is NOT guarded — runs unconditionally in dist mode",
  );
}

// ── Check 2: dist branch sets keysDiffer = false ──────────────────────────────
{
  const elseIdx = configInfoBlock.indexOf('} else {');
  const elseBlock = elseIdx !== -1 ? configInfoBlock.slice(elseIdx, elseIdx + 400) : '';
  const hasKeysDifferFalse = /keysDiffer\s*=\s*false/.test(elseBlock);
  addRow(
    'dist branch: keysDiffer = false (no false "不一致" alarm)',
    hasKeysDifferFalse ? 'PASS' : 'FAIL',
    hasKeysDifferFalse
      ? 'dist else-branch sets keysDiffer = false'
      : 'dist else-branch missing keysDiffer = false',
  );
}

// ── Check 3: dist branch n8nCandidates has no ~/Downloads paths ───────────────
{
  // The outer else is the one that follows the closing brace of
  // `if (APP_MODE !== 'dist') { ... }` — find it after the outer guard block ends.
  // Strategy: find the last `} else {` before the try-catch closes in configInfoBlock.
  let lastElseIdx = -1;
  let searchFrom = 0;
  while (true) {
    const idx = configInfoBlock.indexOf('} else {', searchFrom);
    if (idx === -1) break;
    lastElseIdx = idx;
    searchFrom = idx + 1;
  }
  const elseBlock = lastElseIdx !== -1 ? configInfoBlock.slice(lastElseIdx, lastElseIdx + 400) : '';
  const hasDownloadsInElse = elseBlock.includes("'Downloads'") || elseBlock.includes('"Downloads"');
  addRow(
    'dist branch n8nCandidates: no ~/Downloads source paths',
    !hasDownloadsInElse ? 'PASS' : 'FAIL',
    !hasDownloadsInElse
      ? 'dist else-branch does not include ~/Downloads candidate paths'
      : 'dist else-branch still contains ~/Downloads path — would show dev path to users',
  );
}

// ── Check 4: saveConfig legacy source-sync absent or inside APP_MODE !== 'dist' ─
{
  // Build needle dynamically to avoid shipping the banned literal path string.
  const _legacySrcFrag = ['tiktok', 'n8n', 'workflow', 'pack'].join('-');
  const needle = _legacySrcFrag + "', '版本测试', 'config', 'local-config.json'";
  const saveFnStart = src.indexOf('function saveConfig(');
  const saveFnEnd = src.indexOf('\nfunction ', saveFnStart + 10);
  const saveFnBlock = saveFnStart !== -1 ? src.slice(saveFnStart, saveFnEnd !== -1 ? saveFnEnd : saveFnStart + 15000) : '';
  const srcCfgIdx = saveFnBlock.indexOf(needle);
  const absent = srcCfgIdx === -1;
  const windowBefore = !absent ? saveFnBlock.slice(Math.max(0, srcCfgIdx - 200), srcCfgIdx) : '';
  const hasGuard = !absent && /APP_MODE\s*!==\s*['"]dist['"]/.test(windowBefore);
  const pass = absent || hasGuard;
  addRow(
    "saveConfig: source-sync path absent or inside APP_MODE !== 'dist' guard",
    pass ? 'PASS' : 'FAIL',
    absent
      ? 'saveConfig source-sync fallback path completely absent (clean)'
      : hasGuard
        ? 'saveConfig source-sync guarded by APP_MODE !== dist'
        : 'saveConfig source-sync NOT guarded — would write to source repo in dist mode',
  );
}

// ── Check 5: No unconditional ~/Downloads read in collectEnvStatus ─────────────
{
  // The configInfoBlock must not have Downloads path BEFORE the APP_MODE guard
  const guardIdx = configInfoBlock.indexOf("APP_MODE !== 'dist'");
  const preGuard = guardIdx !== -1 ? configInfoBlock.slice(0, guardIdx) : configInfoBlock;
  const hasUnguardedDownloads = preGuard.includes("'Downloads'") || preGuard.includes('"Downloads"');
  addRow(
    'collectEnvStatus: no unconditional ~/Downloads read before APP_MODE guard',
    !hasUnguardedDownloads ? 'PASS' : 'FAIL',
    !hasUnguardedDownloads
      ? 'no unconditional Downloads path read before APP_MODE guard'
      : 'Downloads path read before APP_MODE guard — runs in dist mode',
  );
}

// ── Render ────────────────────────────────────────────────────────────────────
const COL = { check: 68, status: 8 };
const header = ['check'.padEnd(COL.check), 'status'.padEnd(COL.status), 'detail'].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-dist-config-single-source — static analysis, no secret output ===\n');
console.log(header);
console.log(sep);
for (const r of rows) {
  const statusDisplay =
    r.status === 'PASS' ? '✅ PASS ' :
    r.status === 'FAIL' ? '❌ FAIL ' :
    r.status === 'WARN' ? '⚠️  WARN ' :
    '   SKIP ';
  console.log([
    String(r.check).padEnd(COL.check),
    statusDisplay.padEnd(COL.status),
    String(r.detail).slice(0, 110),
  ].join('  '));
}
console.log(sep);

if (anyFail) {
  console.log('\n❌ RESULT: One or more dist config isolation checks FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All dist config isolation checks passed.');
  process.exit(0);
}
