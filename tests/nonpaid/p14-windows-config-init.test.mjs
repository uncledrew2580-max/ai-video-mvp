/**
 * P14-B4 nonpaid tests — first-run config save must not ENOENT.
 *
 * Reproduces the Windows bug: saving local-config.json when its parent dir
 * (e.g. %APPDATA%\AI Video\config) does not yet exist. atomicWriteJson must
 * create the parent dir, write atomically (tmp -> rename), and leave no .tmp.
 *
 * Pure filesystem logic — no server boot, no model calls, no paid APIs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { atomicWriteJson } from '../../版本测试/lib/atomic-write.mjs';

function mkBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p14b4-cfg-'));
}

test('first save creates missing nested config dir (no ENOENT)', () => {
  const base = mkBase();
  // Simulate a fresh profile: AI Video\config does not exist yet.
  const cfgPath = path.join(base, 'AI Video', 'config', 'local-config.json');
  assert.equal(fs.existsSync(path.dirname(cfgPath)), false);

  assert.doesNotThrow(() => atomicWriteJson(cfgPath, { providers: { kie: { api_key: 'k' } } }));

  assert.equal(fs.existsSync(cfgPath), true);
  const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(parsed.providers.kie.api_key, 'k');
  // No leftover temp file from the atomic write.
  assert.equal(fs.existsSync(cfgPath + '.tmp'), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('overwrite replaces content atomically and leaves no tmp', () => {
  const base = mkBase();
  const cfgPath = path.join(base, 'config', 'local-config.json');
  atomicWriteJson(cfgPath, { v: 1 });
  atomicWriteJson(cfgPath, { v: 2, extra: 'x' });
  const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(parsed.v, 2);
  assert.equal(parsed.extra, 'x');
  assert.equal(fs.existsSync(cfgPath + '.tmp'), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('handles spaces and unicode in the config path', () => {
  const base = mkBase();
  // Mimic "AI Video" (space) + a unicode segment like the 版本测试 tree.
  const cfgPath = path.join(base, 'AI Video', '配置目录', 'local-config.json');
  atomicWriteJson(cfgPath, { ok: true });
  assert.equal(fs.existsSync(cfgPath), true);
  fs.rmSync(base, { recursive: true, force: true });
});
