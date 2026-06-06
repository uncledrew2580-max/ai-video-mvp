#!/usr/bin/env node
/**
 * check-config-secrets.mjs — Read-only secrets audit
 *
 * Checks all local-config.json files (source, 版本测试, dist, RC) for sensitive fields.
 * NEVER outputs field values — only: file path, fieldPath, exists, empty, looksSensitive.
 *
 * Required files (missing = FAIL): source config/ and 版本测试/config/
 * Optional files (missing = SKIP): dist .app and release-candidates
 *
 * Usage: node scripts/check-config-secrets.mjs
 * Exit 0 = all clear, Exit 1 = sensitive values found or required file missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// required: must exist; missing triggers anyFail
// optional: may not exist in all environments (dist build, RC archives)
const TARGET_FILES = [
  { path: path.join(PROJECT_ROOT, 'config', 'local-config.json'),         required: true },
  { path: path.join(PROJECT_ROOT, 'config', 'local-config.example.json'), required: true },
  { path: path.join(PROJECT_ROOT, '版本测试', 'config', 'local-config.json'),         required: true },
  { path: path.join(PROJECT_ROOT, '版本测试', 'config', 'local-config.example.json'), required: true },
  { path: path.join(PROJECT_ROOT, 'dist', 'AI Video.app', 'Contents', 'Resources', 'app', '版本测试', 'config', 'local-config.json'), required: false },
  { path: path.join(PROJECT_ROOT, 'release-candidates', 'AI-Video-Mac-MVP-20260524', 'AI Video.app', 'Contents', 'Resources', 'app', '版本测试', 'config', 'local-config.json'), required: false },
];

// Field name substrings considered sensitive (case-insensitive match on key)
const SENSITIVE_KEY_PATTERNS = ['api_key', 'apikey', 'token', 'secret', 'password', 'encryptionkey'];

// Values that are considered safe placeholders
function looksLikeSafePlaceholder(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return true;
  const v = value.trim();
  if (v === '') return true;
  if (v.startsWith('YOUR_') || v.startsWith('<') || v.startsWith('{{')) return true;
  return false;
}

function isSensitiveKey(key) {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

function collectFields(obj, fieldPath, results) {
  if (typeof obj !== 'object' || obj === null) return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => collectFields(item, `${fieldPath}[${i}]`, results));
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    const cur = fieldPath ? `${fieldPath}.${key}` : key;
    if (isSensitiveKey(key)) {
      const exists = value !== undefined && value !== null;
      const empty = !exists || (typeof value === 'string' && value.trim() === '');
      const looksSensitive = exists && !empty && !looksLikeSafePlaceholder(value);
      results.push({ fieldPath: cur, exists, empty, looksSensitive });
    } else if (typeof value === 'object' && value !== null) {
      collectFields(value, cur, results);
    }
  }
}

const rows = [];
let anyError = false;
let anySensitive = false;
let anyRequiredMissing = false;

for (const { path: filePath, required } of TARGET_FILES) {
  const rel = path.relative(PROJECT_ROOT, filePath);
  if (!fs.existsSync(filePath)) {
    if (required) {
      rows.push({ file: rel, fieldPath: '—', exists: false, empty: '—', looksSensitive: '—', note: '❌ REQUIRED_MISSING' });
      anyRequiredMissing = true;
    } else {
      rows.push({ file: rel, fieldPath: '—', exists: false, empty: '—', looksSensitive: '—', note: 'SKIP (optional, not built)' });
    }
    anyError = true;
    continue;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    rows.push({ file: rel, fieldPath: '—', exists: '—', empty: '—', looksSensitive: '—', note: `PARSE_ERROR: ${e.message}` });
    anyError = true;
    continue;
  }
  const fields = [];
  collectFields(data, '', fields);
  if (fields.length === 0) {
    rows.push({ file: rel, fieldPath: '(none found)', exists: '—', empty: '—', looksSensitive: false, note: '' });
  } else {
    for (const f of fields) {
      rows.push({ file: rel, ...f, note: '' });
      if (f.looksSensitive) anySensitive = true;
    }
  }
}

// Render table — values are NEVER included
const COL = { file: 60, fieldPath: 40, exists: 7, empty: 7, sensitive: 15, note: 20 };
const header = [
  'file'.padEnd(COL.file),
  'fieldPath'.padEnd(COL.fieldPath),
  'exists'.padEnd(COL.exists),
  'empty'.padEnd(COL.empty),
  'looksSensitive'.padEnd(COL.sensitive),
  'note',
].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-config-secrets — field status only, values never shown ===\n');
console.log(header);
console.log(sep);
for (const r of rows) {
  const sensitiveDisplay = r.looksSensitive === true ? '⚠️  TRUE' : r.looksSensitive === false ? '✅ false' : String(r.looksSensitive);
  console.log([
    String(r.file).padEnd(COL.file),
    String(r.fieldPath).padEnd(COL.fieldPath),
    String(r.exists).padEnd(COL.exists),
    String(r.empty).padEnd(COL.empty),
    sensitiveDisplay.padEnd(COL.sensitive),
    r.note || '',
  ].join('  '));
}
console.log(sep);

if (anyRequiredMissing) {
  console.log('\n❌ One or more REQUIRED config files are missing. See REQUIRED_MISSING rows above.');
}
if (anyError && !anyRequiredMissing) {
  console.log('\n⚠️  One or more optional files not found (skipped). See SKIP rows above.');
}

if (anySensitive || anyRequiredMissing) {
  if (anySensitive) console.log('\n❌ RESULT: looksSensitive=true found. Config files must not carry real keys.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All sensitive fields are empty or placeholder. No real keys detected in scanned configs.');
  process.exit(0);
}
