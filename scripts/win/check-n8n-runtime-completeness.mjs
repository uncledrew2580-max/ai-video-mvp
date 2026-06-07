#!/usr/bin/env node
// P14-B1: verify the portable staging tree contains a COMPLETE n8n runtime, so the
// app won't die at startup with "Cannot find module ...breaking-changes.module".
// Checks the real artifact tree (default: the staging node_modules), version-tolerant.
//
// Usage: node check-n8n-runtime-completeness.mjs [targetNodeModulesDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT = path.join(ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001', 'node_modules');
const NM = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT;

const fail = [];
const ok = [];
function need(rel, { dir = false } = {}) {
  const full = path.join(NM, ...rel.split('/'));
  const exists = fs.existsSync(full) && (dir ? fs.statSync(full).isDirectory() : true);
  (exists ? ok : fail).push(rel);
  return exists;
}
// Returns true if dir exists and is non-empty.
function nonEmptyDir(rel) {
  const full = path.join(NM, ...rel.split('/'));
  try { return fs.statSync(full).isDirectory() && fs.readdirSync(full).length > 0; } catch { return false; }
}

if (!fs.existsSync(NM)) { console.error(`[n8n-complete] FAIL: target tree missing: ${NM}`); process.exit(1); }
console.log(`[n8n-complete] checking: ${NM}`);

// 1) core entry + dist
need('n8n/bin/n8n');
need('n8n/dist', { dir: true });
need('n8n/dist/modules', { dir: true });
if (!nonEmptyDir('n8n/dist/modules')) fail.push('n8n/dist/modules (non-empty)');

// 2) the breaking-changes module that broke startup — match either layout
//    (breaking-changes/ or breaking-changes.ee/), and require a .module.js inside.
const modulesDir = path.join(NM, 'n8n', 'dist', 'modules');
let bcDir = null;
try {
  bcDir = fs.readdirSync(modulesDir).find((n) => /^breaking-changes(\.ee)?$/.test(n));
} catch {}
if (!bcDir) {
  fail.push('n8n/dist/modules/breaking-changes[.ee]');
} else {
  ok.push(`n8n/dist/modules/${bcDir}`);
  let hasModuleJs = false;
  try { hasModuleJs = fs.readdirSync(path.join(modulesDir, bcDir)).some((n) => /breaking-changes\.module\.js$/.test(n)); } catch {}
  (hasModuleJs ? ok : fail).push(`n8n/dist/modules/${bcDir}/breaking-changes.module.js`);
}

// 3) key runtime packages
need('@n8n', { dir: true });
need('@n8n/backend-common', { dir: true });
need('n8n-core', { dir: true });
need('n8n-workflow', { dir: true });

console.log(`[n8n-complete] present: ${ok.length}`);
for (const o of ok) console.log('  ✅ ' + o);
if (fail.length) {
  console.error(`[n8n-complete] FAIL: ${fail.length} missing runtime path(s):`);
  for (const f of fail) console.error('  ❌ ' + f);
  process.exit(1);
}
console.log('[n8n-complete] PASS: n8n runtime is complete in the artifact tree.');
