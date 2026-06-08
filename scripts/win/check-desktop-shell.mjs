#!/usr/bin/env node
// P14-B5: Verify the Windows desktop shell in the staging tree.
// Checks:
//   - AI Video.exe exists and is a valid win32-x64 PE
//   - resources/app/win-main.cjs exists (Electron app code)
//   - resources/app/ directory exists
//   - AI Video.exe is non-zero (> 10 MB — Electron binary is always large)
//
// Usage: node check-desktop-shell.mjs [stagingRoot]
//   default: <repo>/dist-win/AI-Video-Win-x64-Portable-RC-0001
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001');

// PE header check: true for a Windows PE with machine type x64 (0x8664).
function isWin32x64Pe(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) < 64) return false;
    if (!(head[0] === 0x4d && head[1] === 0x5a)) return false; // not "MZ"
    const peOff = head.readUInt32LE(0x3c);
    const peHdr = Buffer.alloc(6);
    if (fs.readSync(fd, peHdr, 0, 6, peOff) < 6) return false;
    if (peHdr.toString('ascii', 0, 4) !== 'PE\0\0') return false;
    return peHdr.readUInt16LE(4) === 0x8664;
  } catch { return false; } finally { fs.closeSync(fd); }
}

export function checkDesktopShell(root) {
  const errors = [];
  const present = [];

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, errors: [`staging root missing: ${root}`], present };
  }

  const exePath = path.join(root, 'AI Video.exe');
  if (!fs.existsSync(exePath)) {
    errors.push('missing AI Video.exe at staging root');
  } else {
    const size = fs.statSync(exePath).size;
    if (size < 10240) {
      errors.push(`AI Video.exe is suspiciously small (${size} bytes)`);
    } else if (!isWin32x64Pe(exePath)) {
      errors.push('AI Video.exe is not a valid win32-x64 PE executable');
    } else {
      present.push(`AI Video.exe  (${(size / 1048576).toFixed(1)} MB, win32-x64 PE)`);
    }
  }

  const appDir = path.join(root, 'resources', 'app');
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    errors.push('missing resources/app/ directory (Electron app code)');
  } else {
    present.push('resources/app/');
    const mainCjs = path.join(appDir, 'win-main.cjs');
    if (!fs.existsSync(mainCjs)) {
      errors.push('missing resources/app/win-main.cjs');
    } else {
      present.push('resources/app/win-main.cjs');
    }
  }

  return { ok: errors.length === 0, errors, present };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
  console.log(`[desktop-shell] checking: ${root}`);
  const { ok, errors, present } = checkDesktopShell(root);
  for (const p of present) console.log('  ✅ ' + p);
  if (!ok) {
    console.error(`[desktop-shell] FAIL:`);
    for (const e of errors) console.error('  ❌ ' + e);
    process.exit(1);
  }
  console.log('[desktop-shell] PASS: AI Video.exe + Electron app code present and valid.');
}
