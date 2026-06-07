#!/usr/bin/env node
// P14-A1R4: zip the verified portable staging tree FAST. PowerShell
// Compress-Archive is far too slow on a multi-GB node_modules tree (it timed out
// the job). Prefer 7-Zip (preinstalled on windows-2022), fall back to bsdtar.
// Low/fast compression — the payload is mostly already-compressed binaries, so
// finishing the artifact matters more than ratio.
//
// Runs AFTER assemble-windows-portable.mjs and AFTER verify-native-modules.mjs.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = path.join(ROOT, 'dist-win');
const NAME = 'AI-Video-Win-x64-Portable-RC-0001';
const STAGE = path.join(OUT_ROOT, NAME);
const ZIP = path.join(OUT_ROOT, `${NAME}.zip`);

if (!fs.existsSync(STAGE)) { process.stderr.write(`[zip] missing staging tree ${STAGE}\n`); process.exit(1); }
fs.rmSync(ZIP, { force: true });

function have(cmd) {
  const r = spawnSync(cmd, ['--help'], { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}

const t0 = Date.now();
let method = '';
// 1) 7-Zip: -mx=1 (fastest compression), -mmt=on (multithread).
if (have('7z')) {
  method = '7z -mx=1';
  process.stdout.write('[zip] compressing with 7z -mx=1 ...\n');
  execFileSync('7z', ['a', '-tzip', '-mx=1', '-mmt=on', '-bso0', '-bsp0', ZIP, '*'], { cwd: STAGE, stdio: 'inherit' });
} else if (have('tar')) {
  // 2) bsdtar (Windows 10+ ships tar): -a infers zip from extension.
  method = 'bsdtar zip';
  process.stdout.write('[zip] compressing with bsdtar ...\n');
  execFileSync('tar', ['-a', '-c', '-f', ZIP, '-C', STAGE, '.'], { stdio: 'inherit' });
} else {
  process.stderr.write('[zip] no 7z or tar available — refusing slow Compress-Archive fallback\n');
  process.exit(1);
}

if (!fs.existsSync(ZIP) || fs.statSync(ZIP).size === 0) { process.stderr.write('[zip] zip not produced\n'); process.exit(1); }
const sizeMB = (fs.statSync(ZIP).size / 1048576).toFixed(1);
const sha = createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
fs.writeFileSync(`${ZIP}.sha256`, `${sha}  ${path.basename(ZIP)}\n`);
process.stdout.write(`[zip] method: ${method} | ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
process.stdout.write(`[zip] path:   ${ZIP} (${sizeMB} MB)\n`);
process.stdout.write(`[zip] sha256: ${sha}\n`);
