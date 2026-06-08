/**
 * P14-B4 nonpaid tests — output-dirs helpers (normalizeManualOutputBase,
 * outputSubDirs, ensureOutputDirsWritable).
 *
 * Covers paths with spaces, Chinese characters, and Windows-style backslashes
 * to verify the four canonical subdirs are created and writable.
 *
 * Pure filesystem / stdlib — no server boot, no model calls, no paid APIs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  normalizeManualOutputBase,
  outputSubDirs,
  ensureOutputDirsWritable,
} from '../../版本测试/lib/output-dirs.mjs';

function mkBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p14b4-outdirs-'));
}

// ── normalizeManualOutputBase ────────────────────────────────────────────────

test('normalizeManualOutputBase: empty/null returns empty string', () => {
  assert.equal(normalizeManualOutputBase(''), '');
  assert.equal(normalizeManualOutputBase(null), '');
  assert.equal(normalizeManualOutputBase('   '), '');
});

test('normalizeManualOutputBase: strips wrapping double-quotes', () => {
  const result = normalizeManualOutputBase('"C:/Users/test/my folder"');
  assert.ok(!result.includes('"'), 'quotes should be stripped');
  assert.ok(path.isAbsolute(result));
});

test('normalizeManualOutputBase: converts backslashes to forward slashes', () => {
  const base = mkBase();
  const winStyle = base.replace(/\//g, '\\') + '\\子目录 with spaces';
  const result = normalizeManualOutputBase(winStyle);
  assert.ok(path.isAbsolute(result));
  assert.ok(!result.includes('\\') || process.platform === 'win32');
});

test('normalizeManualOutputBase: path with spaces and Chinese chars resolves', () => {
  const base = mkBase();
  const target = path.join(base, 'AI Video 输出', '视频 2024');
  const result = normalizeManualOutputBase(target);
  assert.equal(result, path.resolve(target));
});

// ── outputSubDirs ────────────────────────────────────────────────────────────

test('outputSubDirs: returns base_dir and four canonical subdirs', () => {
  const base = '/tmp/test base/输出目录';
  const dirs = outputSubDirs(base);
  assert.equal(dirs.base_dir, base);
  assert.equal(dirs.storyboard_dir, path.join(base, 'Storyboards'));
  assert.equal(dirs.video_dir, path.join(base, 'Videos'));
  assert.equal(dirs.voiceover_dir, path.join(base, 'Voiceovers'));
  assert.equal(dirs.final_dir, path.join(base, 'Final'));
});

// ── ensureOutputDirsWritable ─────────────────────────────────────────────────

test('ensureOutputDirsWritable: path with spaces creates all 5 dirs and reports ok', () => {
  const base = mkBase();
  const target = path.join(base, 'AI Video Outputs with spaces');
  const result = ensureOutputDirsWritable(target);
  assert.equal(result.ok, true, result.error);
  assert.ok(fs.statSync(target).isDirectory());
  for (const sub of ['Storyboards', 'Videos', 'Voiceovers', 'Final']) {
    assert.ok(fs.statSync(path.join(target, sub)).isDirectory(), `missing ${sub}`);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('ensureOutputDirsWritable: path with Chinese characters creates all 5 dirs', () => {
  const base = mkBase();
  const target = path.join(base, 'AI视频输出目录');
  const result = ensureOutputDirsWritable(target);
  assert.equal(result.ok, true, result.error);
  assert.ok(fs.statSync(target).isDirectory());
  for (const sub of ['Storyboards', 'Videos', 'Voiceovers', 'Final']) {
    assert.ok(fs.statSync(path.join(target, sub)).isDirectory(), `missing ${sub}`);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('ensureOutputDirsWritable: Windows-style backslash path (normalized) creates all dirs', () => {
  const base = mkBase();
  // Simulate a Windows path pasted into the input — backslashes + spaces + Chinese
  const winPasted = base.replace(/\//g, '\\') + '\\用户 输出\\AI Video';
  const normalized = normalizeManualOutputBase(winPasted);
  assert.ok(path.isAbsolute(normalized), 'should be absolute after normalization');
  const result = ensureOutputDirsWritable(normalized);
  assert.equal(result.ok, true, result.error);
  for (const sub of ['Storyboards', 'Videos', 'Voiceovers', 'Final']) {
    assert.ok(fs.statSync(path.join(normalized, sub)).isDirectory(), `missing ${sub}`);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('ensureOutputDirsWritable: all subdirs are writable (temp file probe succeeds)', () => {
  const base = mkBase();
  const target = path.join(base, '输出 with spaces');
  const result = ensureOutputDirsWritable(target);
  assert.equal(result.ok, true, result.error);
  // Verify writable independently for each subdir
  for (const sub of ['Storyboards', 'Videos', 'Voiceovers', 'Final']) {
    const dir = path.join(target, sub);
    const probe = path.join(dir, '.probe_' + Date.now());
    assert.doesNotThrow(() => { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); },
      `${sub} should be writable`);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('ensureOutputDirsWritable: returns dirs map with correct keys', () => {
  const base = mkBase();
  const target = path.join(base, 'dirs map test');
  const result = ensureOutputDirsWritable(target);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.dirs.base_dir, target);
  assert.equal(result.dirs.storyboard_dir, path.join(target, 'Storyboards'));
  assert.equal(result.dirs.video_dir, path.join(target, 'Videos'));
  assert.equal(result.dirs.voiceover_dir, path.join(target, 'Voiceovers'));
  assert.equal(result.dirs.final_dir, path.join(target, 'Final'));
  fs.rmSync(base, { recursive: true, force: true });
});
