/**
 * P14-B1/B2 nonpaid tests — Windows n8n runtime completeness + zod de-duplication.
 *
 * Root cause (P14-B2): @n8n/api-types and n8n-workflow ship a DIFFERENT nested zod
 * than the top-level one; two zod instances break breaking-changes.module load with a
 * discriminatedUnion error, surfaced as a misleading missing breaking-changes.ee module.
 * Fix: the assemble filter drops those nested zod copies (mirrors the Mac packager).
 *
 * Static/logic only (runnable on macOS); the real n8n launch smoke runs on the runner.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECK = path.join(ROOT, 'scripts', 'win', 'check-n8n-runtime-completeness.mjs');

const PROTECT_N8N = /(^|\/node_modules\/)(@n8n\/|n8n\/|n8n-core\/|n8n-workflow\/|n8n-[^/]+\/)/;
const isN8n = (rel) => PROTECT_N8N.test(rel.split(path.sep).join('/') + '/');
// Mirror of the assemble rule: drop EVERY nested */node_modules/zod, keep top-level.
const NESTED_ZOD = /(^|\/)node_modules\/.+\/node_modules\/zod(\/|$)/;
const dropsZodDup = (p) => NESTED_ZOD.test(p);

test('prune protection covers the n8n runtime family (top-level + nested)', () => {
  for (const p of [
    'n8n/dist/modules/breaking-changes/breaking-changes.module.js', 'n8n/bin/n8n',
    '@n8n/backend-common/index.js', 'n8n-core/dist/index.js', 'n8n-workflow/dist/index.js',
    'somepkg/node_modules/@n8n/config/index.js',
  ]) assert.ok(isN8n(p), `should protect: ${p}`);
  for (const p of ['sharp/build/Release/sharp.node', 'otherpkg/README.md', 'lodash/index.js']) {
    assert.ok(!isN8n(p), `should NOT protect: ${p}`);
  }
});

test('assemble drops ALL nested zod, keeps only the top-level one', () => {
  for (const p of [
    'node_modules/@n8n/api-types/node_modules/zod/index.js',
    'node_modules/n8n-workflow/node_modules/zod/lib/x.js',
    'node_modules/n8n/node_modules/zod/x.js',
    'node_modules/@n8n/config/node_modules/zod',
    'node_modules/n8n-core/node_modules/zod/x.js',
    'node_modules/@n8n/ai-utilities/node_modules/@langchain/core/node_modules/zod',
  ]) {
    assert.ok(dropsZodDup(p), `should drop nested zod: ${p}`);
  }
  for (const p of ['node_modules/zod/index.js', 'node_modules/zod/lib/x.js', 'node_modules/@n8n/api-types/dist/index.js']) {
    assert.ok(!dropsZodDup(p), `should keep: ${p}`);
  }
});

test('win scripts are syntactically valid', () => {
  for (const s of ['check-n8n-runtime-completeness.mjs', 'n8n-launch-smoke.mjs', 'assemble-windows-portable.mjs', 'zip-windows-portable.mjs', 'verify-native-modules.mjs']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'scripts', 'win', s)], { stdio: 'ignore' });
  }
});

test('completeness check FAILS when any nested zod is present', () => {
  // The raw local install ships many nested zod copies — the guard must flag them.
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(path.join(nm, '@n8n', 'api-types', 'node_modules', 'zod'))) { console.log('  (no nested zod locally — skip)'); return; }
  const r = spawnSync(process.execPath, [CHECK, nm], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'should fail on nested zod');
  assert.match(r.stdout + r.stderr, /nested zod present/);
});

test('completeness check PASSES on a clean de-duplicated synthetic tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n8nok-'));
  const nm = path.join(root, 'node_modules');
  const mk = (rel) => { fs.mkdirSync(path.dirname(path.join(nm, rel)), { recursive: true }); fs.writeFileSync(path.join(nm, rel), 'x'); };
  mk('n8n/bin/n8n');
  mk('n8n/dist/commands/start.js');
  mk('n8n/dist/modules/breaking-changes/breaking-changes.module.js');
  mk('@n8n/backend-common/index.js');
  mk('n8n-core/index.js');
  mk('n8n-workflow/index.js');
  mk('zod/index.js');
  // deliberately NO @n8n/api-types/node_modules/zod and NO n8n-workflow/node_modules/zod
  try {
    const r = spawnSync(process.execPath, [CHECK, nm], { encoding: 'utf8' });
    assert.equal(r.status, 0, `expected PASS, got:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /PASS: n8n runtime is complete/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workflow runs completeness check + launch smoke before zip/upload', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'windows-portable.yml'), 'utf8');
  const iComplete = wf.indexOf('check-n8n-runtime-completeness.mjs');
  const iSmoke = wf.indexOf('n8n-launch-smoke.mjs');
  const iZip = wf.indexOf('zip-windows-portable.mjs');
  const iUpload = wf.indexOf('upload-artifact');
  assert.ok(iComplete > 0 && iSmoke > 0, 'completeness + smoke steps must be present');
  assert.ok(iComplete < iZip && iSmoke < iZip, 'completeness + smoke must run before zip');
  assert.ok(iZip < iUpload, 'zip must run before upload');
});
