/**
 * P14-B3 nonpaid tests — Windows portable "client shape" guard.
 *
 * Builds mock staging roots in a temp dir and asserts checkClientShape() accepts
 * the small-user client layout and rejects an engineering-dump layout.
 *
 * No model calls, no n8n, no paid APIs, no real assemble. Pure filesystem logic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkClientShape } from '../../scripts/win/check-client-shape.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p14b3-shape-'));
}
function touch(root, rel, content = '') {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function mkdir(root, rel) {
  fs.mkdirSync(path.join(root, ...rel.split('/')), { recursive: true });
}

// Build a valid small-user client staging root.
function buildValid() {
  const root = mkRoot();
  touch(root, 'AI Video.cmd', '@echo off\r\n');
  touch(root, '使用说明.txt', '说明\r\n');
  touch(root, 'version.json', '{"version":"0.0.0"}\n');
  touch(root, 'runtime-manifest.json', '{}\n');
  touch(root, 'tools/Start-AI-Video-Debug.cmd', '@echo off\r\n');
  touch(root, 'tools/Export-Diagnostics.cmd', '@echo off\r\n');
  // resources/runtime is the runnable project root (launcher PROJECT_ROOT).
  mkdir(root, 'resources/runtime/node_modules');
  touch(root, 'resources/runtime/client/launcher.mjs', '// launcher\n');
  mkdir(root, 'resources/app');
  mkdir(root, 'resources/licenses');
  return root;
}

test('valid client-shaped staging root passes', () => {
  const root = buildValid();
  const res = checkClientShape(root);
  assert.equal(res.ok, true, `expected ok, got errors: ${res.errors.join('; ')}`);
  assert.equal(res.errors.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('engineering internals exposed at root fail', () => {
  const root = buildValid();
  // Dump project internals at the root (the thing we are guarding against).
  mkdir(root, 'node_modules');
  mkdir(root, 'scripts');
  mkdir(root, 'app-server');
  mkdir(root, 'client');
  mkdir(root, 'prompts');
  mkdir(root, '版本测试');
  touch(root, 'package.json', '{}');
  touch(root, 'package-lock.json', '{}');
  const res = checkClientShape(root);
  assert.equal(res.ok, false);
  for (const name of ['node_modules', 'scripts', 'app-server', 'client', 'prompts', '版本测试', 'package.json', 'package-lock.json']) {
    assert.ok(res.errors.some((e) => e.includes(name)), `expected an error mentioning ${name}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('stray workflow JSON at root fails', () => {
  const root = buildValid();
  touch(root, 'WF01-iterative-script.json', '{"nodes":[]}');
  const res = checkClientShape(root);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('WF01-iterative-script.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing required entry/doc/manifest fails', () => {
  for (const rel of ['AI Video.cmd', '使用说明.txt', 'version.json', 'runtime-manifest.json', 'tools/Export-Diagnostics.cmd']) {
    const root = buildValid();
    fs.rmSync(path.join(root, ...rel.split('/')), { force: true });
    const res = checkClientShape(root);
    assert.equal(res.ok, false, `removing ${rel} should fail the shape check`);
    assert.ok(res.errors.some((e) => e.includes(rel.split('/').pop())), `expected an error for missing ${rel}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resources/runtime must still hold the project root', () => {
  const root = buildValid();
  fs.rmSync(path.join(root, 'resources', 'runtime', 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'resources', 'runtime', 'client', 'launcher.mjs'), { force: true });
  const res = checkClientShape(root);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('node_modules')));
  assert.ok(res.errors.some((e) => e.includes('client/launcher.mjs')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing staging root fails cleanly', () => {
  const res = checkClientShape(path.join(ROOT, 'no-such-staging-root-xyz'));
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 1);
});
