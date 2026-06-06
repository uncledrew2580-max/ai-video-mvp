#!/usr/bin/env node
/**
 * check-n8n-isolation.mjs — Read-only n8n runtime isolation audit
 *
 * Checks (static source analysis only — no processes started):
 *   1. N8N_LISTEN_ADDRESS='127.0.0.1' is set in startN8n() env
 *   2. N8N_USER_FOLDER points to App Support (not global ~/.n8n)
 *   3. N8N_DISABLE_UI='true' is set
 *   4. N8N_HOST='127.0.0.1' is set (webhook URL hostname)
 *
 * NEVER reads or outputs secret values.
 *
 * Usage: node scripts/check-n8n-isolation.mjs
 * Exit 0 = all clear, Exit 1 = issues found
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

// ── Locate startN8n() env block ───────────────────────────────────────────────
// Grab the text of the spawn() env block inside startN8n so checks are scoped
// to the correct function (not an outer process.env spread).
const startN8nMatch = src.match(/async function startN8n[\s\S]*?stdio:\s*\[/);
const startN8nBlock = startN8nMatch ? startN8nMatch[0] : src;

// ── Check 1: N8N_LISTEN_ADDRESS ───────────────────────────────────────────────
{
  const match = startN8nBlock.match(/N8N_LISTEN_ADDRESS\s*:\s*['"]([^'"]+)['"]/);
  if (match) {
    const val = match[1];
    addRow(
      "N8N_LISTEN_ADDRESS in startN8n() env",
      val === '127.0.0.1' ? 'PASS' : 'FAIL',
      `value = '${val}'${val !== '127.0.0.1' ? ' (expected 127.0.0.1)' : ''}`,
    );
  } else {
    addRow('N8N_LISTEN_ADDRESS in startN8n() env', 'FAIL', 'key not found in startN8n() spawn env');
  }
}

// ── Check 2: N8N_USER_FOLDER points to App Support (dist mode) ───────────────
{
  // The variable is defined at top of file as a const referencing APP_SUPPORT_DIR
  const defMatch = src.match(/N8N_USER_FOLDER\s*=\s*process\.env\.N8N_USER_FOLDER\s*\|\|\s*\(_IS_DIST\s*\?([^:]+):/);
  if (defMatch) {
    const distVal = defMatch[1].trim();
    const usesAppSupport = distVal.includes('APP_SUPPORT_DIR');
    addRow(
      'N8N_USER_FOLDER (dist): uses APP_SUPPORT_DIR',
      usesAppSupport ? 'PASS' : 'FAIL',
      usesAppSupport
        ? `dist branch = join(APP_SUPPORT_DIR, 'n8n-user')`
        : `dist branch = ${distVal}`,
    );
  } else {
    addRow('N8N_USER_FOLDER (dist): uses APP_SUPPORT_DIR', 'WARN', 'definition pattern not matched — verify manually');
  }

  // Also confirm APP_SUPPORT_DIR is derived from os.homedir() not hardcoded
  const appSupportDef = src.match(/APP_SUPPORT_DIR\s*=\s*join\(homedir\(\)/);
  addRow(
    'APP_SUPPORT_DIR: uses homedir() (no hardcoded username)',
    appSupportDef ? 'PASS' : 'FAIL',
    appSupportDef ? 'join(homedir(), "Library", "Application Support", "AI Video")' : 'APP_SUPPORT_DIR definition not using homedir()',
  );

  // Confirm N8N_USER_FOLDER is passed into the spawn env
  const passedIn = /N8N_USER_FOLDER,/.test(startN8nBlock) || /N8N_USER_FOLDER\s*:/.test(startN8nBlock);
  addRow(
    'N8N_USER_FOLDER: passed into startN8n() spawn env',
    passedIn ? 'PASS' : 'FAIL',
    passedIn ? 'present in spawn env block' : 'NOT found in spawn env block',
  );
}

// ── Check 3: N8N_DISABLE_UI ───────────────────────────────────────────────────
{
  const match = startN8nBlock.match(/N8N_DISABLE_UI\s*:\s*['"]([^'"]+)['"]/);
  if (match) {
    const val = match[1];
    addRow(
      "N8N_DISABLE_UI in startN8n() env",
      val === 'true' ? 'PASS' : 'FAIL',
      `value = '${val}'${val !== 'true' ? " (expected 'true')" : ''}`,
    );
  } else {
    addRow('N8N_DISABLE_UI in startN8n() env', 'FAIL', 'key not found in startN8n() spawn env');
  }
}

// ── Check 4: N8N_HOST webhook hostname ───────────────────────────────────────
{
  const match = startN8nBlock.match(/N8N_HOST\s*:\s*['"]([^'"]+)['"]/);
  if (match) {
    const val = match[1];
    addRow(
      "N8N_HOST (webhook hostname) in startN8n() env",
      val === '127.0.0.1' ? 'PASS' : 'WARN',
      `value = '${val}'${val !== '127.0.0.1' ? ' (expected 127.0.0.1 for localhost-only webhooks)' : ''}`,
    );
  } else {
    addRow('N8N_HOST (webhook hostname) in startN8n() env', 'WARN', 'key not found — verify manually');
  }
}

// ── Check 5: no N8N_LISTEN_ADDRESS override elsewhere that could widen bind ──
{
  // Count total occurrences; only the one in startN8n env is wanted
  const allOccurrences = [...src.matchAll(/N8N_LISTEN_ADDRESS/g)];
  const count = allOccurrences.length;
  addRow(
    'N8N_LISTEN_ADDRESS: appears exactly once (no conflicting overrides)',
    count === 1 ? 'PASS' : count === 0 ? 'FAIL' : 'WARN',
    `found ${count} occurrence(s) in launcher.mjs`,
  );
}

// ── Render ────────────────────────────────────────────────────────────────────

const COL = { check: 58, status: 8 };
const header = ['check'.padEnd(COL.check), 'status'.padEnd(COL.status), 'detail'].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-n8n-isolation — static analysis, no secrets output ===\n');
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
  console.log('\n❌ RESULT: One or more n8n isolation checks FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All n8n isolation checks passed.');
  process.exit(0);
}
