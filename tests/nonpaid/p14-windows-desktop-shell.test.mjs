// P14-B5 nonpaid tests — desktop shell + updated client-shape checks.
// Runs offline with mock temp dirs; zero model calls, zero network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkDesktopShell } from '../../scripts/win/check-desktop-shell.mjs';
import { checkClientShape } from '../../scripts/win/check-client-shape.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p14-b5-test-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Minimal valid win32-x64 PE header (MZ + PE\0\0 + machine 0x8664) padded to 20 KB.
function fakeExe(filePath) {
  const buf = Buffer.alloc(20 * 1024, 0);
  // MZ header
  buf[0] = 0x4d; buf[1] = 0x5a;
  // e_lfanew at offset 0x3c → PE header starts at offset 0x40
  buf.writeUInt32LE(0x40, 0x3c);
  // PE signature
  buf[0x40] = 0x50; buf[0x41] = 0x45; buf[0x42] = 0x00; buf[0x43] = 0x00;
  // Machine: IMAGE_FILE_MACHINE_AMD64 = 0x8664
  buf.writeUInt16LE(0x8664, 0x44);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

function writeFile(p, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Build a staging root that satisfies checkClientShape (P14-B5 layout).
function validStagingRoot(root) {
  fakeExe(path.join(root, 'AI Video.exe'));
  writeFile(path.join(root, '创建桌面快捷方式.cmd'));
  writeFile(path.join(root, '使用说明.txt'));
  writeFile(path.join(root, 'version.json'), '{}');
  writeFile(path.join(root, 'runtime-manifest.json'), '{}');
  writeFile(path.join(root, 'tools', 'AI Video (命令行模式).cmd'));
  writeFile(path.join(root, 'tools', 'Start-AI-Video-Debug.cmd'));
  writeFile(path.join(root, 'tools', 'Export-Diagnostics.cmd'));
  writeFile(path.join(root, 'tools', 'Open-Logs.cmd'));
  fs.mkdirSync(path.join(root, 'resources', 'runtime', 'node_modules'), { recursive: true });
  writeFile(path.join(root, 'resources', 'runtime', 'client', 'launcher.mjs'));
  fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
}

// ── checkDesktopShell ─────────────────────────────────────────────────────────

test('checkDesktopShell: missing staging root fails', () => {
  const { ok, errors } = checkDesktopShell('/tmp/__nonexistent_p14b5__');
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /staging root missing/.test(e)));
});

test('checkDesktopShell: missing AI Video.exe fails', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
    writeFile(path.join(root, 'resources', 'app', 'win-main.cjs'));
    const { ok, errors } = checkDesktopShell(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /missing AI Video\.exe/.test(e)));
  } finally { cleanup(root); }
});

test('checkDesktopShell: non-PE file rejected', () => {
  const root = tmp();
  try {
    writeFile(path.join(root, 'AI Video.exe'), 'not a PE file at all, but large enough padding'.padEnd(20 * 1024, 'x'));
    fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
    writeFile(path.join(root, 'resources', 'app', 'win-main.cjs'));
    const { ok, errors } = checkDesktopShell(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /not a valid win32-x64 PE/.test(e)));
  } finally { cleanup(root); }
});

test('checkDesktopShell: suspiciously small exe rejected', () => {
  const root = tmp();
  try {
    writeFile(path.join(root, 'AI Video.exe'), 'MZ');
    fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
    writeFile(path.join(root, 'resources', 'app', 'win-main.cjs'));
    const { ok, errors } = checkDesktopShell(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /suspiciously small/.test(e)));
  } finally { cleanup(root); }
});

test('checkDesktopShell: missing resources/app/ fails', () => {
  const root = tmp();
  try {
    fakeExe(path.join(root, 'AI Video.exe'));
    const { ok, errors } = checkDesktopShell(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /missing resources\/app/.test(e)));
  } finally { cleanup(root); }
});

test('checkDesktopShell: missing win-main.cjs fails', () => {
  const root = tmp();
  try {
    fakeExe(path.join(root, 'AI Video.exe'));
    fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
    // win-main.cjs intentionally absent
    const { ok, errors } = checkDesktopShell(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /win-main\.cjs/.test(e)));
  } finally { cleanup(root); }
});

test('checkDesktopShell: valid tree passes', () => {
  const root = tmp();
  try {
    fakeExe(path.join(root, 'AI Video.exe'));
    fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
    writeFile(path.join(root, 'resources', 'app', 'win-main.cjs'));
    const { ok, errors, present } = checkDesktopShell(root);
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
    assert.ok(present.some((p) => /AI Video\.exe/.test(p)));
    assert.ok(present.includes('resources/app/'));
    assert.ok(present.includes('resources/app/win-main.cjs'));
  } finally { cleanup(root); }
});

// ── checkClientShape (P14-B5 layout) ─────────────────────────────────────────

test('checkClientShape: valid P14-B5 staging root passes', () => {
  const root = tmp();
  try {
    validStagingRoot(root);
    const { ok, errors } = checkClientShape(root);
    assert.deepEqual(errors, [], `unexpected errors: ${errors.join('; ')}`);
    assert.equal(ok, true);
  } finally { cleanup(root); }
});

test('checkClientShape: AI Video.cmd at root is forbidden', () => {
  const root = tmp();
  try {
    validStagingRoot(root);
    writeFile(path.join(root, 'AI Video.cmd'));
    const { ok, errors } = checkClientShape(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /AI Video\.cmd/.test(e) && /engineering internal exposed at root/.test(e)));
  } finally { cleanup(root); }
});

test('checkClientShape: missing AI Video.exe fails', () => {
  const root = tmp();
  try {
    validStagingRoot(root);
    fs.rmSync(path.join(root, 'AI Video.exe'), { force: true });
    const { ok, errors } = checkClientShape(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /AI Video\.exe/.test(e)));
  } finally { cleanup(root); }
});

test('checkClientShape: missing resources/app fails', () => {
  const root = tmp();
  try {
    validStagingRoot(root);
    fs.rmSync(path.join(root, 'resources', 'app'), { recursive: true, force: true });
    const { ok, errors } = checkClientShape(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /resources\/app/.test(e)));
  } finally { cleanup(root); }
});

test('checkClientShape: missing 创建桌面快捷方式.cmd fails', () => {
  const root = tmp();
  try {
    validStagingRoot(root);
    fs.rmSync(path.join(root, '创建桌面快捷方式.cmd'), { force: true });
    const { ok, errors } = checkClientShape(root);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /创建桌面快捷方式/.test(e)));
  } finally { cleanup(root); }
});
