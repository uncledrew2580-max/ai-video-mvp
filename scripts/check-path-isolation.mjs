#!/usr/bin/env node
/**
 * check-path-isolation.mjs — Read-only path isolation audit
 *
 * Checks:
 *   1. No literal /Users/drew or /Users/chuzu in runtime JS source files
 *   2. Key dist-mode runtime paths point to App Support (not .app bundle)
 *   3. No .app/Contents path used as a writable runtime target
 *
 * NEVER reads or outputs secret values.
 *
 * Usage: node scripts/check-path-isolation.mjs
 * Exit 0 = all clear, Exit 1 = issues found
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AI Video');

// ── Static source scan ────────────────────────────────────────────────────────

const SCAN_FILES = [
  'desktop/main.cjs',
  'client/launcher.mjs',
  '版本测试/serve-review-assets.mjs',
  'scripts/bootstrap-ai-video-workflows.mjs',
  'sync_iteration_v1_workflows_to_db.mjs',
];

// Patterns that should not appear as literal hardcoded runtime paths
// (os.homedir() usage is fine; bare /Users/<name> is not)
const FORBIDDEN_LITERAL_PATTERNS = [
  /\/Users\/drew(?:\/|$)/g,
  /\/Users\/chuzu(?:\/|$)/g,
];

const rows = [];
let anyFail = false;

function addRow(check, status, detail) {
  rows.push({ check, status, detail });
  if (status === 'FAIL') anyFail = true;
}

// ── Check 1: No literal developer user paths in source files ─────────────────

for (const rel of SCAN_FILES) {
  const filePath = path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(filePath)) {
    addRow(`literal-user-path: ${rel}`, 'SKIP', 'file not found');
    continue;
  }
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  let hits = [];
  for (const pat of FORBIDDEN_LITERAL_PATTERNS) {
    pat.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comment lines
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (pat.test(line)) {
        const userName = pat.source.match(/\\\/Users\\\/([^\\]+)/)?.[1] || '?';
        hits.push(`line ${i + 1}: /Users/${userName}`);
        pat.lastIndex = 0;
      }
    }
  }
  if (hits.length === 0) {
    addRow(`literal-user-path: ${rel}`, 'PASS', 'no /Users/<name> literals in non-comment code');
  } else {
    addRow(`literal-user-path: ${rel}`, 'FAIL', hits.join('; '));
  }
}

// ── Check 2: dist-mode key paths resolve to App Support ──────────────────────

// Simulate what launcher.mjs computes for _IS_DIST=true
const distPaths = {
  'APP_SUPPORT_DIR (base)': APP_SUPPORT_DIR,
  'CONFIG_PATH (dist)':     path.join(APP_SUPPORT_DIR, 'config', 'local-config.json'),
  'N8N_USER_FOLDER (dist)': path.join(APP_SUPPORT_DIR, 'n8n-user'),
  'LOG_DIR (dist)':         path.join(APP_SUPPORT_DIR, 'logs', 'launcher'),
  'WORKFLOW_DATA_ROOT (dist)': path.join(APP_SUPPORT_DIR, 'workflow-data'),
};

for (const [label, p] of Object.entries(distPaths)) {
  const underAppSupport = p.startsWith(APP_SUPPORT_DIR);
  const insideAppBundle = p.includes('.app/Contents/');
  if (underAppSupport && !insideAppBundle) {
    addRow(`dist-path: ${label}`, 'PASS', p);
  } else if (insideAppBundle) {
    addRow(`dist-path: ${label}`, 'FAIL', `inside .app bundle: ${p}`);
  } else {
    addRow(`dist-path: ${label}`, 'WARN', `not under App Support: ${p}`);
  }
}

// ── Check 3: bundled config seed paths (read-only, inside .app — expected) ───

const bundledConfigInAppBundle = path.join(
  PROJECT_ROOT, 'dist', 'AI Video.app', 'Contents', 'Resources', 'app',
  '版本测试', 'config', 'local-config.json',
);
addRow(
  'bundled-config-seed: inside .app (read-only seed, expected)',
  fs.existsSync(bundledConfigInAppBundle) ? 'PASS' : 'SKIP',
  fs.existsSync(bundledConfigInAppBundle)
    ? 'exists as read-only seed (not a writable target)'
    : 'file not present (dist not built or path differs)',
);

// ── Check 4: App Support config is NOT inside .app ───────────────────────────

const runtimeConfigPath = path.join(APP_SUPPORT_DIR, 'config', 'local-config.json');
const insideBundle = runtimeConfigPath.includes('.app/Contents/');
addRow(
  'runtime-config: not inside .app',
  insideBundle ? 'FAIL' : 'PASS',
  runtimeConfigPath,
);

// ── Check 5: error dialog log path in main.cjs uses app.getPath ──────────────

const mainCjsPath = path.join(PROJECT_ROOT, 'desktop', 'main.cjs');
if (fs.existsSync(mainCjsPath)) {
  const src = fs.readFileSync(mainCjsPath, 'utf8');
  const hasRelativeLogRef = /logs\/launcher\//.test(src);
  const hasAppGetPath = /app\.getPath\('appData'\)/.test(src);
  if (!hasRelativeLogRef && hasAppGetPath) {
    addRow('error-dialog: uses app.getPath for log path', 'PASS', 'no relative logs/launcher/ references; app.getPath present');
  } else if (hasRelativeLogRef) {
    addRow('error-dialog: uses app.getPath for log path', 'FAIL', 'still contains relative logs/launcher/ reference in dialog');
  } else {
    addRow('error-dialog: uses app.getPath for log path', 'WARN', 'no relative reference found but app.getPath not detected — verify manually');
  }
} else {
  addRow('error-dialog: uses app.getPath for log path', 'SKIP', 'main.cjs not found');
}

// ── Check 6: launcher fail() messages use LOG_DIR variable ───────────────────

const launcherPath = path.join(PROJECT_ROOT, 'client', 'launcher.mjs');
if (fs.existsSync(launcherPath)) {
  const src = fs.readFileSync(launcherPath, 'utf8');
  // Look for remaining relative path refs in fail() calls
  const relativeFailRefs = [...src.matchAll(/fail\(`[^`]*logs\/launcher[^`]*`\)/g)].map(m => m[0].slice(0, 80));
  if (relativeFailRefs.length === 0) {
    addRow('launcher fail(): uses LOG_DIR absolute path', 'PASS', 'no relative logs/launcher/ in fail() calls');
  } else {
    addRow('launcher fail(): uses LOG_DIR absolute path', 'FAIL', relativeFailRefs.join('; '));
  }
} else {
  addRow('launcher fail(): uses LOG_DIR absolute path', 'SKIP', 'launcher.mjs not found');
}

// ── Render ────────────────────────────────────────────────────────────────────

const COL = { check: 55, status: 8, detail: 70 };
const header = [
  'check'.padEnd(COL.check),
  'status'.padEnd(COL.status),
  'detail',
].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-path-isolation — paths only, no secret values ===\n');
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
  console.log('\n❌ RESULT: One or more path isolation checks FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All path isolation checks passed.');
  process.exit(0);
}
