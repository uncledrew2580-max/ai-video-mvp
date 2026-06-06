#!/usr/bin/env node
/**
 * check-workflow-startup-guard.mjs — Read-only static audit
 *
 * Checks (static source analysis only — no processes started):
 *   1. runWorkflowBootstrap() env includes REVIEW_ASSET_PORT and WORKSPACE_HOST
 *   2. runWorkflowSync() env includes REVIEW_ASSET_PORT and WORKSPACE_HOST
 *   3. bootstrap failure in _IS_DIST mode exits with process.exit(1)
 *   4. sync failure in _IS_DIST mode exits with process.exit(1)
 *   5. Error messages include LOG_DIR (absolute path, no hardcoded user name)
 *
 * NEVER reads or outputs secret values.
 *
 * Usage: node scripts/check-workflow-startup-guard.mjs
 * Exit 0 = all clear, Exit 1 = issues found
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_PATH = path.join(PROJECT_ROOT, 'client', 'launcher.mjs');

const rows = [];
let anyFail = false;

function addRow(check, status, detail) {
  rows.push({ check, status, detail });
  if (status === 'FAIL') anyFail = true;
}

if (!fs.existsSync(LAUNCHER_PATH)) {
  console.error(`launcher.mjs not found: ${LAUNCHER_PATH}`);
  process.exit(2);
}

const src = fs.readFileSync(LAUNCHER_PATH, 'utf8');

// ── Extract function bodies ───────────────────────────────────────────────────

function extractFunctionBody(src, funcName) {
  const start = src.indexOf(`function ${funcName}(`);
  if (start === -1) return null;
  let depth = 0;
  let i = src.indexOf('{', start);
  if (i === -1) return null;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(bodyStart, i + 1); }
  }
  return null;
}

const bootstrapBody = extractFunctionBody(src, 'runWorkflowBootstrap');
const syncBody = extractFunctionBody(src, 'runWorkflowSync');

// ── Check 1: bootstrap env has REVIEW_ASSET_PORT ─────────────────────────────
addRow(
  'bootstrap env: REVIEW_ASSET_PORT injected',
  bootstrapBody && /REVIEW_ASSET_PORT\s*:/.test(bootstrapBody) ? 'PASS' : 'FAIL',
  bootstrapBody ? (bootstrapBody.includes('REVIEW_ASSET_PORT') ? 'found in runWorkflowBootstrap env' : 'NOT found') : 'function body not extracted',
);

// ── Check 2: bootstrap env has WORKSPACE_HOST ─────────────────────────────────
addRow(
  'bootstrap env: WORKSPACE_HOST injected',
  bootstrapBody && /WORKSPACE_HOST\s*:/.test(bootstrapBody) ? 'PASS' : 'FAIL',
  bootstrapBody ? (bootstrapBody.includes('WORKSPACE_HOST') ? 'found in runWorkflowBootstrap env' : 'NOT found') : 'function body not extracted',
);

// ── Check 3: sync env has REVIEW_ASSET_PORT ───────────────────────────────────
addRow(
  'sync env: REVIEW_ASSET_PORT injected',
  syncBody && /REVIEW_ASSET_PORT\s*:/.test(syncBody) ? 'PASS' : 'FAIL',
  syncBody ? (syncBody.includes('REVIEW_ASSET_PORT') ? 'found in runWorkflowSync env' : 'NOT found') : 'function body not extracted',
);

// ── Check 4: sync env has WORKSPACE_HOST ──────────────────────────────────────
addRow(
  'sync env: WORKSPACE_HOST injected',
  syncBody && /WORKSPACE_HOST\s*:/.test(syncBody) ? 'PASS' : 'FAIL',
  syncBody ? (syncBody.includes('WORKSPACE_HOST') ? 'found in runWorkflowSync env' : 'NOT found') : 'function body not extracted',
);

// ── Check 5 & 6: _IS_DIST guard + process.exit(1) after bootstrap failure ────
// Look for the pattern: if (!bootstrap.ok) { if (_IS_DIST) { ... process.exit(1)
{
  const hasDistBootstrapGuard =
    /if\s*\(!bootstrap\.ok\)[\s\S]{0,200}if\s*\(_IS_DIST\)[\s\S]{0,300}process\.exit\(1\)/.test(src);
  addRow(
    'bootstrap fail: _IS_DIST guard exits process (dist-mode)',
    hasDistBootstrapGuard ? 'PASS' : 'FAIL',
    hasDistBootstrapGuard
      ? '_IS_DIST branch calls process.exit(1) on bootstrap failure'
      : 'pattern not found — bootstrap failure may not block dist startup',
  );
}

// ── Check 7: _IS_DIST guard + process.exit(1) after sync failure ─────────────
{
  const hasSyncGuard = /syncOk[\s\S]{0,100}_IS_DIST[\s\S]{0,200}process\.exit\(1\)/.test(src) ||
                       /!syncOk\s*&&\s*_IS_DIST[\s\S]{0,200}process\.exit\(1\)/.test(src);
  addRow(
    'sync fail: _IS_DIST guard exits process (dist-mode)',
    hasSyncGuard ? 'PASS' : 'FAIL',
    hasSyncGuard
      ? '_IS_DIST branch calls process.exit(1) on sync failure'
      : 'pattern not found — sync failure may not block dist startup',
  );
}

// ── Check 8: error messages include LOG_DIR (not hardcoded path) ─────────────
{
  // LOG_DIR variable should appear in the fail() messages near the exit(1) calls
  const bootstrapFailMsg = src.match(/工作流初始化失败[\s\S]{0,300}process\.exit\(1\)/)?.[0] || '';
  const syncFailMsg = src.match(/工作流版本同步失败[\s\S]{0,300}process\.exit\(1\)/)?.[0] || '';

  const bootstrapHasLogDir = bootstrapFailMsg.includes('LOG_DIR');
  const syncHasLogDir = syncFailMsg.includes('LOG_DIR');
  const bootstrapHasDb = bootstrapFailMsg.includes('n8nDbPathForUi');
  const syncHasDb = syncFailMsg.includes('n8nDbPathForUi');

  addRow(
    'bootstrap fail msg: includes LOG_DIR variable',
    bootstrapHasLogDir ? 'PASS' : 'FAIL',
    bootstrapHasLogDir ? 'LOG_DIR referenced in error message' : 'LOG_DIR not found in bootstrap error message',
  );
  addRow(
    'bootstrap fail msg: includes DB path variable',
    bootstrapHasDb ? 'PASS' : 'FAIL',
    bootstrapHasDb ? 'n8nDbPathForUi referenced in error message' : 'n8nDbPathForUi not found in bootstrap error message',
  );
  addRow(
    'sync fail msg: includes LOG_DIR variable',
    syncHasLogDir ? 'PASS' : 'FAIL',
    syncHasLogDir ? 'LOG_DIR referenced in error message' : 'LOG_DIR not found in sync error message',
  );
  addRow(
    'sync fail msg: includes DB path variable',
    syncHasDb ? 'PASS' : 'FAIL',
    syncHasDb ? 'n8nDbPathForUi referenced in error message' : 'n8nDbPathForUi not found in sync error message',
  );
}

// ── Check 9: WORKSPACE_HOST uses UI_URL (dynamic, not hardcoded port 8788) ───
{
  // bootstrap and sync both pass WORKSPACE_HOST: UI_URL
  const bootstrapUsesUiUrl = bootstrapBody && /WORKSPACE_HOST\s*:\s*UI_URL/.test(bootstrapBody);
  const syncUsesUiUrl = syncBody && /WORKSPACE_HOST\s*:\s*UI_URL/.test(syncBody);
  addRow(
    'bootstrap WORKSPACE_HOST: uses UI_URL (not hardcoded port)',
    bootstrapUsesUiUrl ? 'PASS' : 'FAIL',
    bootstrapUsesUiUrl ? 'WORKSPACE_HOST: UI_URL' : 'WORKSPACE_HOST not set to UI_URL variable',
  );
  addRow(
    'sync WORKSPACE_HOST: uses UI_URL (not hardcoded port)',
    syncUsesUiUrl ? 'PASS' : 'FAIL',
    syncUsesUiUrl ? 'WORKSPACE_HOST: UI_URL' : 'WORKSPACE_HOST not set to UI_URL variable',
  );
}

// ── Check 10: source dev path (non-dist) still continues on failure ───────────
{
  // The else branch for non-dist should still warn and not exit
  const hasDevFallback = /if\s*\(_IS_DIST\)[\s\S]{0,400}else\s*\{[\s\S]{0,200}warn\(/.test(src);
  addRow(
    'source dev: bootstrap failure still warns (no hard exit)',
    hasDevFallback ? 'PASS' : 'WARN',
    hasDevFallback ? 'else branch with warn() found for non-dist mode' : 'else/warn pattern not matched — verify manually',
  );
}

// ── Render ────────────────────────────────────────────────────────────────────

const COL = { check: 58, status: 8 };
const header = ['check'.padEnd(COL.check), 'status'.padEnd(COL.status), 'detail'].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-workflow-startup-guard — static analysis, no secrets output ===\n');
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
    String(r.detail).slice(0, 120),
  ].join('  '));
}
console.log(sep);

if (anyFail) {
  console.log('\n❌ RESULT: One or more workflow startup guard checks FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All workflow startup guard checks passed.');
  process.exit(0);
}
