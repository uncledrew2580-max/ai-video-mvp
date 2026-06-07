/**
 * P14-B1 nonpaid tests — Windows n8n runtime completeness guardrails.
 *
 * Static/logic only (runnable on macOS); the real n8n launch smoke runs on the
 * Windows runner. No model calls, no n8n start here.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Mirror of the prune protection in assemble-windows-portable.mjs.
const PROTECT_N8N = /(^|\/node_modules\/)(@n8n\/|n8n\/|n8n-core\/|n8n-workflow\/|n8n-[^/]+\/)/;
const isN8n = (rel) => PROTECT_N8N.test(rel.split(path.sep).join('/') + '/');

test('prune protection covers the n8n runtime family (top-level + nested)', () => {
  for (const p of [
    'n8n/dist/modules/breaking-changes.ee/breaking-changes.module.js',
    'n8n/bin/n8n',
    '@n8n/backend-common/index.js',
    'n8n-core/dist/index.js',
    'n8n-workflow/dist/index.js',
    'n8n-nodes-base/nodes/x.js',
    'somepkg/node_modules/@n8n/config/index.js',
    'somepkg/node_modules/n8n-workflow/x.js',
  ]) {
    assert.ok(isN8n(p), `should protect: ${p}`);
  }
  for (const p of ['sharp/build/Release/sharp.node', 'otherpkg/README.md', 'lodash/index.js', 'n8nlike/x.js']) {
    assert.ok(!isN8n(p), `should NOT protect: ${p}`);
  }
});

test('win scripts are syntactically valid', () => {
  for (const s of ['check-n8n-runtime-completeness.mjs', 'n8n-launch-smoke.mjs', 'assemble-windows-portable.mjs', 'zip-windows-portable.mjs', 'verify-native-modules.mjs']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'scripts', 'win', s)], { stdio: 'ignore' });
  }
});

test('n8n runtime completeness check passes on the installed (complete) n8n', () => {
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(path.join(nm, 'n8n', 'bin', 'n8n'))) { console.log('  (n8n not installed locally — skip)'); return; }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'win', 'check-n8n-runtime-completeness.mjs'), nm], { encoding: 'utf8' });
  assert.equal(r.status, 0, `completeness check failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PASS: n8n runtime is complete/);
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
