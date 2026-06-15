import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERIFY = path.join(ROOT, 'scripts', 'win', 'verify-business-assets.mjs');

function runVerify(args = []) {
  return spawnSync(process.execPath, [VERIFY, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function copyRuntimeBusinessAssets(targetRoot) {
  for (const rel of [
    'prompts',
    path.join('版本测试', 'prompts'),
    path.join('正式导入文件', 'iteration-v1'),
  ]) {
    fs.cpSync(path.join(ROOT, rel), path.join(targetRoot, rel), { recursive: true });
  }
  fs.mkdirSync(path.join(targetRoot, '版本测试'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, '版本测试', 'serve-review-assets.mjs'),
    path.join(targetRoot, '版本测试', 'serve-review-assets.mjs'),
  );
}

test('source business assets match the Windows/Mac 0011 quality gate', () => {
  const result = runVerify();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[business-assets\] OK/);
});

test('staged Windows runtime business assets must match source and carry 0011 sentinels', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-business-assets-'));
  try {
    copyRuntimeBusinessAssets(tmp);
    const result = runVerify([tmp, ROOT]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"compare_to_source": true/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('staged Windows runtime check fails if product identity prompt logic regresses', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-business-assets-stale-'));
  try {
    copyRuntimeBusinessAssets(tmp);
    const wf = path.join(tmp, '正式导入文件', 'iteration-v1', 'n8n02b.json');
    const stale = fs.readFileSync(wf, 'utf8').replace(/PRODUCT IDENTITY REFERENCE/g, 'OLD PRODUCT REFERENCE');
    fs.writeFileSync(wf, stale);

    const result = runVerify([tmp, ROOT]);
    assert.notEqual(result.status, 0, 'stale staged assets should fail verification');
    assert.match(result.stderr, /PRODUCT IDENTITY REFERENCE/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
