#!/usr/bin/env node
// P14-B3: verify the Windows portable STAGING ROOT has the small-user "client"
// shape, not an engineering project dump. The full runnable project tree must
// live under resources/runtime/ (the launcher's PROJECT_ROOT); the root must
// expose ONLY the friendly entry + docs + tools + manifests.
//
// This is a SHAPE guard (no model calls, no n8n, no paid APIs). It runs in CI
// after assemble and before zip, and is unit-tested against mock temp dirs.
//
// Usage: node check-client-shape.mjs [stagingRoot]
//   default: <repo>/dist-win/AI-Video-Win-x64-Portable-RC-0001
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001');

// Required at the staging root (small-user surface).
const REQUIRED_FILES = [
  'AI Video.cmd',          // RC main entry (TODO: AI Video.exe shell later)
  '使用说明.txt',           // plain-language guide
  'version.json',
  'runtime-manifest.json',
  'tools/Start-AI-Video-Debug.cmd',
  'tools/Export-Diagnostics.cmd',
];
const REQUIRED_DIRS = [
  'resources',
  'resources/runtime', // the full project tree / launcher PROJECT_ROOT
  'tools',
];
// resources/runtime must still look like the runnable project root.
const REQUIRED_RUNTIME = [
  'node_modules',
  'client/launcher.mjs',
];

// Engineering internals that must NOT be exposed at the staging root — they all
// belong under resources/runtime/ now.
const FORBIDDEN_ROOT = [
  'node_modules', 'scripts', 'app-server', 'client', 'config', 'desktop',
  'prompts', '版本测试', '正式导入文件', 'runtime',
  'package.json', 'package-lock.json',
];
// The only top-level .json files allowed at the root. Anything else (workflow
// exports, package manifests, lockfiles) leaking to the root is a shape failure.
const ALLOWED_ROOT_JSON = new Set(['version.json', 'runtime-manifest.json']);

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

export function checkClientShape(root) {
  const errors = [];
  const present = [];

  if (!isDir(root)) {
    return { ok: false, errors: [`staging root missing or not a directory: ${root}`], present };
  }

  for (const rel of REQUIRED_DIRS) {
    const full = path.join(root, ...rel.split('/'));
    if (isDir(full)) present.push(rel + '/');
    else errors.push(`missing required directory: ${rel}/`);
  }
  for (const rel of REQUIRED_FILES) {
    const full = path.join(root, ...rel.split('/'));
    if (isFile(full)) present.push(rel);
    else errors.push(`missing required file: ${rel}`);
  }
  for (const rel of REQUIRED_RUNTIME) {
    const full = path.join(root, 'resources', 'runtime', ...rel.split('/'));
    if (fs.existsSync(full)) present.push('resources/runtime/' + rel);
    else errors.push(`resources/runtime missing project entry: ${rel}`);
  }

  // Forbidden engineering internals directly at the root.
  for (const name of FORBIDDEN_ROOT) {
    if (fs.existsSync(path.join(root, name))) {
      errors.push(`engineering internal exposed at root (move under resources/runtime/): ${name}`);
    }
  }

  // Any stray top-level .json beyond the allowed manifests is a leak
  // (catches workflow JSON exports, package.json, package-lock.json, etc.).
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (e.isDirectory()) continue;
    if (e.name.toLowerCase().endsWith('.json') && !ALLOWED_ROOT_JSON.has(e.name)) {
      errors.push(`unexpected .json at root (only version/runtime-manifest allowed): ${e.name}`);
    }
  }

  return { ok: errors.length === 0, errors, present };
}

// CLI entry (only when run directly, not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
  console.log(`[client-shape] checking: ${root}`);
  const { ok, errors, present } = checkClientShape(root);
  for (const p of present) console.log('  ✅ ' + p);
  if (!ok) {
    console.error(`[client-shape] FAIL: ${errors.length} shape problem(s):`);
    for (const e of errors) console.error('  ❌ ' + e);
    process.exit(1);
  }
  console.log('[client-shape] PASS: staging root has the small-user client shape (engineering tree hidden under resources/runtime/).');
}
