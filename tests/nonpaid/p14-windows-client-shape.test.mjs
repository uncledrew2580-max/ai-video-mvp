/**
 * P14-B3/B5 nonpaid tests — Windows portable "client shape" guard.
 *
 * Builds mock staging roots in a temp dir and asserts checkClientShape() accepts
 * the B5 desktop-client layout and rejects engineering-dump or legacy layouts.
 *
 * No model calls, no n8n, no paid APIs, no real assemble. Pure filesystem logic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkClientShape, REQUIRED_APP } from '../../scripts/win/check-client-shape.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p14b5-shape-'));
}
function touch(root, rel, content = '') {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function mkdir(root, rel) {
  fs.mkdirSync(path.join(root, ...rel.split('/')), { recursive: true });
}

// Build a valid B5 desktop-client staging root.
function buildValid() {
  const root = mkRoot();
  // Primary entry: Electron exe (non-empty — 1 byte is enough for mock)
  touch(root, 'AI Video.exe', 'MZ');
  // Root-level shortcut helper
  touch(root, '创建桌面快捷方式.cmd', '@echo off\r\n');
  touch(root, '使用说明.txt', '使用说明\r\n');
  touch(root, 'version.json', '{"version":"0.0.0"}\n');
  touch(root, 'runtime-manifest.json', '{}\n');
  // tools/
  touch(root, 'tools/AI Video (命令行模式).cmd', '@echo off\r\n');
  touch(root, 'tools/Start-AI-Video-Debug.cmd', '@echo off\r\n');
  touch(root, 'tools/Export-Diagnostics.cmd', '@echo off\r\n');
  touch(root, 'tools/Open-Logs.cmd', '@echo off\r\n');
  // resources/runtime is the runnable project root (launcher PROJECT_ROOT).
  mkdir(root, 'resources/runtime/node_modules');
  touch(root, 'resources/runtime/client/launcher.mjs', '// launcher\n');
  // resources/app is the Electron app code.
  touch(root, 'resources/app/win-main.cjs', '// win-main\n');
  mkdir(root, 'resources/licenses');
  // Electron runtime file placed in win-unpacked root by electron-builder.
  touch(root, 'vk_swiftshader_icd.json', '{"file_format_version":"1.0.0"}\n');
  return root;
}

test('valid B5 client-shaped staging root passes', () => {
  const root = buildValid();
  const res = checkClientShape(root);
  assert.equal(res.ok, true, `expected ok, got errors: ${res.errors.join('; ')}`);
  assert.equal(res.errors.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('engineering internals exposed at root fail', () => {
  const root = buildValid();
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

test('AI Video.cmd at root is forbidden (replaced by AI Video.exe)', () => {
  const root = buildValid();
  touch(root, 'AI Video.cmd', '@echo off\r\n');
  const res = checkClientShape(root);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('AI Video.cmd')), 'expected an error for AI Video.cmd at root');
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
  for (const rel of ['AI Video.exe', '使用说明.txt', 'version.json', 'runtime-manifest.json', 'tools/Export-Diagnostics.cmd', 'tools/Open-Logs.cmd']) {
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

test('resources/app/win-main.cjs missing fails', () => {
  const root = buildValid();
  fs.rmSync(path.join(root, 'resources', 'app', 'win-main.cjs'), { force: true });
  const res = checkClientShape(root);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('win-main.cjs')), 'expected error for missing win-main.cjs');
  fs.rmSync(root, { recursive: true, force: true });
});

test('AI Video.exe empty (0 bytes) fails', () => {
  const root = buildValid();
  // Overwrite with empty file.
  fs.writeFileSync(path.join(root, 'AI Video.exe'), '');
  const res = checkClientShape(root);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.toLowerCase().includes('empty') || e.toLowerCase().includes('0 bytes')),
    'expected an error about empty exe');
  fs.rmSync(root, { recursive: true, force: true });
});

test('REQUIRED_APP export lists win-main.cjs', () => {
  assert.ok(Array.isArray(REQUIRED_APP));
  assert.ok(REQUIRED_APP.includes('win-main.cjs'));
});

test('missing staging root fails cleanly', () => {
  const res = checkClientShape(path.join(ROOT, 'no-such-staging-root-xyz'));
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 1);
});

test('vk_swiftshader_icd.json at root is allowed (Electron Vulkan ICD manifest)', () => {
  const root = buildValid();
  // vk_swiftshader_icd.json already present via buildValid(); shape check must pass.
  const res = checkClientShape(root);
  assert.equal(res.ok, true, `expected ok with vk_swiftshader_icd.json, got: ${res.errors.join('; ')}`);
  fs.rmSync(root, { recursive: true, force: true });
});
